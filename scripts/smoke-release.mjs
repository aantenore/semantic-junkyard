#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const controlPlaneRoot = path.join(repositoryRoot, "apps", "api", "data");
fs.mkdirSync(controlPlaneRoot, { recursive: true, mode: 0o700 });
const scratchRoot = fs.mkdtempSync(path.join(controlPlaneRoot, "release-smoke-"));

try {
  assertBuiltArtifact("apps/api/dist/server.js");
  assertBuiltArtifact("apps/mcp/dist/server.js");

  const api = await smokeApi();
  const mcp = await smokeMcp();

  console.log(
    JSON.stringify(
      {
        status: "passed",
        api,
        mcp,
        isolation: "temporary storage removed after verification"
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 3 });
}

async function smokeApi() {
  const port = await availableLoopbackPort();
  const databaseRelativePath = path.join(path.basename(scratchRoot), "state", "control-plane.sqlite");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("SEMANTIC_JUNKYARD_") && name !== "HOST" && name !== "PORT"
    )
  );
  const environment = {
    ...inheritedEnvironment,
    HOST: "127.0.0.1",
    PORT: String(port),
    SEMANTIC_JUNKYARD_DB: databaseRelativePath,
    SEMANTIC_JUNKYARD_BOOTSTRAP_REFERENCE_SOURCES: "false",
    SEMANTIC_JUNKYARD_ENABLE_LOCAL_POC: "false"
  };

  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [path.join(repositoryRoot, "apps/api/dist/server.js")], {
    cwd: scratchRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(child, `${baseUrl}/api/health`, output);
    assert.equal(health.status, 200, "health must return HTTP 200");
    assert.equal(health.body.ok, true, "health body must report ok");

    const ready = await fetchJson(`${baseUrl}/api/ready`);
    assert.equal(ready.status, 200, "ready must return HTTP 200");
    assert.deepEqual(ready.body, { ok: true, bootstrap: "disabled" });

    const openApi = await fetchJson(`${baseUrl}/api/openapi.json`);
    assert.equal(openApi.status, 200, "OpenAPI must return HTTP 200");
    assert.equal(openApi.body.openapi, "3.1.0");
    assert.ok(openApi.body.paths?.["/api/health"], "OpenAPI must describe health");

    const expectedDatabase = path.join(controlPlaneRoot, databaseRelativePath);
    assert.equal(fs.existsSync(expectedDatabase), true, "API must create its database inside the temporary root");

    return {
      health: health.status,
      ready: ready.status,
      openapi: openApi.body.openapi,
      storage: "confined relative database path"
    };
  } finally {
    await stopChild(child, output);
  }
}

async function smokeMcp() {
  const client = new Client({ name: "semantic-junkyard-release-smoke", version: "0.1.0-alpha.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repositoryRoot, "apps/mcp/dist/server.js"), "--memory", "--no-seed"],
    cwd: scratchRoot,
    stderr: "pipe"
  });

  try {
    await withTimeout(client.connect(transport), "MCP handshake");
    const result = await withTimeout(client.listTools(), "MCP tool discovery");
    const names = result.tools.map((tool) => tool.name);
    for (const required of [
      "explain_permissions",
      "semantic_search",
      "source_resource_search",
      "business_action_plan"
    ]) {
      assert.ok(names.includes(required), `MCP must advertise ${required}`);
    }
    assert.equal(names.includes("business_action_execute"), false, "MCP must not advertise writes by default");

    return {
      handshake: "connected",
      toolsAdvertised: names.length,
      defaultWriteTool: "absent"
    };
  } finally {
    await client.close().catch(() => transport.close());
  }
}

function assertBuiltArtifact(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  assert.equal(
    fs.existsSync(absolutePath),
    true,
    `Missing ${relativePath}; run npm run build before the release smoke.`
  );
}

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "could not reserve a loopback port");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForJson(child, url, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited before becoming healthy.${formatChildOutput(output)}`);
    }
    try {
      return await fetchJson(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`API did not become healthy within 20 seconds.${formatChildOutput(output)}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  const body = await response.json();
  return { status: response.status, body };
}

async function stopChild(child, output) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`API exited with code ${child.exitCode}.${formatChildOutput(output)}`);
    return;
  }

  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const terminationRequested = child.kill();
  const outcome = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5_000))
  ]);
  if ("timeout" in outcome) {
    child.kill("SIGKILL");
    await exit;
  } else if (outcome.code !== 0 && !(terminationRequested && outcome.signal === "SIGTERM")) {
    throw new Error(
      `API shutdown returned code ${String(outcome.code)} and signal ${String(outcome.signal)}.${formatChildOutput(output)}`
    );
  }
}

async function withTimeout(operation, label) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded 15 seconds.`)), 15_000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function formatChildOutput(output) {
  const combined = [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n");
  return combined ? `\n${combined}` : "";
}
