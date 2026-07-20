#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createSemanticRuntime,
  ensureDefaultControlPlaneRoot,
  loadRuntimeConfig,
  loadSourceSystems,
  openControlPlaneDatabase,
  openMemoryDatabase
} from "@semantic-junkyard/api";
import { parseMcpLaunchOptions } from "./launchOptions.js";
import { createSemanticJunkyardMcpServer } from "./mcpServer.js";

let db: ReturnType<typeof openMemoryDatabase> | null = null;
let server: ReturnType<typeof createSemanticJunkyardMcpServer> | null = null;
let shuttingDown = false;

try {
  const runtimeConfig = loadRuntimeConfig(process.env, { validateHttpSecurity: false });
  const launch = parseMcpLaunchOptions(process.argv.slice(2), runtimeConfig.databaseRelativePath);
  db = launch.memory
    ? openMemoryDatabase()
    : openControlPlaneDatabase({
        authorizedRoot: ensureDefaultControlPlaneRoot(),
        databasePath: launch.databaseRelativePath
      }).db;
  const runtime = createSemanticRuntime(db, {
    seed: launch.seed,
    maxAutonomousRisk: runtimeConfig.maxAutonomousRisk,
    sourceSystems: runtimeConfig.sourceSystemsFile ? loadSourceSystems(runtimeConfig.sourceSystemsFile) : []
  });
  server = createSemanticJunkyardMcpServer(runtime, {
    allowDiscoveryRuns: launch.allowDiscoveryRuns,
    allowSourceSync: launch.allowSourceSync,
    allowBusinessWrites: launch.allowBusinessWrites
  });
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.stdin.once("end", () => void shutdown(0));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  await shutdown(1);
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  try {
    await server?.close();
  } finally {
    db?.close();
  }
}
