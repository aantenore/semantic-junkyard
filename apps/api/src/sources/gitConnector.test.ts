import type { ConnectorActionCandidate } from "./connector.js";
import type { SourceConnection } from "@semantic-junkyard/shared";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitConnector } from "./gitConnector.js";

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.test"
};
const REAL_GIT_TEST_TIMEOUT_MS = 90_000;
const TEST_TEMP_ROOT = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "semantic-junkyard-tests");
const TEST_GIT_CONFIG = [
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false"
];

describe("GitConnector", () => {
  const tempDirectories: string[] = [];
  let sharedFixture: ReturnType<typeof createRepository>;

  beforeAll(() => {
    sharedFixture = createRepository(tempDirectories);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  beforeEach(() => {
    resetRepository(sharedFixture);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  afterAll(() => {
    for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("tests the worktree and discovers only tracked supported files with Git and contract provenance", () => {
    const fixture = sharedFixture;
    const connector = new GitConnector();
    const initialTest = connector.test(fixture.connection);
    expect(initialTest).toMatchObject({
      ok: true,
      details: { head: fixture.initialHead, clean: true, dirty: false, status: [] }
    });

    fs.writeFileSync(path.join(fixture.repositoryPath, "docs", "untracked.txt"), "not discoverable\n", "utf8");
    fs.writeFileSync(path.join(fixture.repositoryPath, "docs", "ignored.bin"), Buffer.from([0, 1, 2, 3]));

    const dirtyTest = connector.test(fixture.connection);
    expect(dirtyTest.ok).toBe(true);
    expect(dirtyTest.details).toMatchObject({
      head: fixture.initialHead,
      commitSha: fixture.initialHead,
      clean: false,
      dirty: true
    });
    expect(dirtyTest.details.status).toEqual(expect.arrayContaining([expect.stringContaining("docs/untracked.txt")]));

    const snapshot = connector.discover(fixture.connection);
    expect(snapshot.resources.map((resource) => resource.externalId)).toEqual([
      "contracts/orders.yaml",
      "docs/README.md"
    ]);
    expect(snapshot.documents.map((document) => document.resourceExternalId)).toEqual([
      "contracts/orders.yaml",
      "docs/README.md"
    ]);
    expect(snapshot.documents.find((document) => document.resourceExternalId === "docs/README.md")?.request.text)
      .toBe("# Fulfillment documentation\n");

    const contractResource = snapshot.resources.find((resource) => resource.externalId === "contracts/orders.yaml");
    expect(contractResource).toMatchObject({
      kind: "semantic_contract",
      writable: true,
      metadata: {
        commitSha: fixture.initialHead,
        version: expect.stringContaining(fixture.initialHead)
      }
    });
    expect(contractResource?.metadata.blobSha).toBe(git(fixture.repositoryPath, ["rev-parse", "HEAD:contracts/orders.yaml"]));
    expect(snapshot.contracts).toHaveLength(1);
    expect(snapshot.contracts[0]).toMatchObject({ id: "contract_orders", version: "1", status: "active" });
    expect(snapshot.metrics).toEqual([
      expect.objectContaining({ id: "metric_dispatch_rate", expression: "dispatched_orders / all_orders", contractVersion: "1" })
    ]);
    expect(snapshot.assets).toEqual([expect.objectContaining({ id: "asset_orders", name: "orders" })]);
    expect(snapshot.checkpoint).toMatchObject({
      head: fixture.initialHead,
      commitSha: fixture.initialHead,
      version: fixture.initialHead,
      dirty: true,
      blobs: { "contracts/orders.yaml": contractResource?.metadata.blobSha }
    });
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("plans exact YAML and commits/readbacks the requested denominator and contract version", () => {
    const fixture = sharedFixture;
    const connector = new GitConnector({ authorName: "Semantic Contract Bot", authorEmail: "contracts@example.test" });
    const hookMarker = path.join(fixture.repositoryPath, "post-commit-hook-ran");
    const postCommitHook = path.join(fixture.repositoryPath, ".git", "hooks", "post-commit");
    fs.writeFileSync(postCommitHook, "#!/bin/sh\ntouch \"$PWD/post-commit-hook-ran\"\n", { mode: 0o755 });
    const snapshot = connector.discover(fixture.connection);
    const resourcesWithEvidence = snapshot.resources.map((resource) =>
      resource.externalId === "contracts/orders.yaml" ? { ...resource, evidenceChunkIds: ["chunk_contract_orders"] } : resource
    );
    const candidate = connector.planAction(
      fixture.connection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      resourcesWithEvidence
    );

    expect(candidate).not.toBeNull();
    const planned = candidate!;
    expect(planned.capability).toBe("semantic_contract.publish");
    expect(planned.evidenceChunkIds).toEqual(["chunk_contract_orders"]);
    expect(planned.requiresApproval).toBe(false);
    expect(planned.parameters).toMatchObject({
      path: "contracts/orders.yaml",
      beforeContent: fixture.contractContent,
      expectedHead: fixture.initialHead,
      expectedBlob: git(fixture.repositoryPath, ["rev-parse", "HEAD:contracts/orders.yaml"]),
      expectedVersion: "2",
      expectedMetricExpression: "dispatched_orders / dispatch_eligible_orders",
      expectedMetricContractVersion: "2"
    });
    expect(planned.before?.content).toBe(fixture.contractContent);
    expect(planned.after.content).toBe(planned.parameters.afterContent);
    const plannedYaml = parse(String(planned.parameters.afterContent)) as Record<string, unknown>;
    expect(plannedYaml).toMatchObject({ version: "2", status: "active" });
    expect((plannedYaml.metrics as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "metric_dispatch_rate",
      expression: "dispatched_orders / dispatch_eligible_orders",
      contractVersion: "2"
    });

    const result = connector.executeAction(fixture.connection, planned);
    expect(result.postconditionPassed).toBe(true);
    expect(result.sourceVersion).not.toBe(fixture.initialHead);
    expect(result.readback).toMatchObject({
      path: "contracts/orders.yaml",
      content: planned.parameters.afterContent,
      commitSha: result.sourceVersion,
      contract: { id: "contract_orders", version: "2" },
      metric: {
        id: "metric_dispatch_rate",
        expression: "dispatched_orders / dispatch_eligible_orders",
        contractVersion: "2"
      }
    });
    expect(gitRaw(fixture.repositoryPath, ["show", `${result.sourceVersion}:contracts/orders.yaml`]))
      .toBe(planned.parameters.afterContent);
    expect(git(fixture.repositoryPath, ["show", "-s", "--format=%an <%ae>", result.sourceVersion]))
      .toBe("Semantic Contract Bot <contracts@example.test>");
    expect(gitNul(fixture.repositoryPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", result.sourceVersion]))
      .toEqual(["contracts/orders.yaml"]);
    expect(fs.existsSync(hookMarker)).toBe(false);

    const readback = connector.readAction(fixture.connection, planned);
    expect(readback.postconditionPassed).toBe(true);
    expect(readback.sourceVersion).toBe(result.sourceVersion);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("allows dirty unrelated files and commits only the planned target", () => {
    const fixture = sharedFixture;
    const connector = new GitConnector();
    const snapshot = connector.discover(fixture.connection);
    const candidate = requiredCandidate(connector.planAction(
      fixture.connection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      snapshot.resources
    ));

    const unrelatedContent = "# Locally staged documentation change\n";
    fs.writeFileSync(path.join(fixture.repositoryPath, "docs", "README.md"), unrelatedContent, "utf8");
    git(fixture.repositoryPath, ["add", "--", "docs/README.md"]);

    const result = connector.executeAction(fixture.connection, candidate);
    expect(result.postconditionPassed).toBe(true);
    expect(gitNul(fixture.repositoryPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", result.sourceVersion]))
      .toEqual(["contracts/orders.yaml"]);
    expect(fs.readFileSync(path.join(fixture.repositoryPath, "docs", "README.md"), "utf8")).toBe(unrelatedContent);
    expect(git(fixture.repositoryPath, ["status", "--porcelain=v1", "--", "docs/README.md"]))
      .toBe("M  docs/README.md");
    expect(gitRaw(fixture.repositoryPath, ["show", `${result.sourceVersion}:docs/README.md`]))
      .toBe("# Fulfillment documentation\n");
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("rejects stale HEAD and stale blob preconditions without changing the target", () => {
    const headFixture = sharedFixture;
    const connector = new GitConnector();
    const headCandidate = requiredCandidate(connector.planAction(
      headFixture.connection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      connector.discover(headFixture.connection).resources
    ));
    fs.writeFileSync(path.join(headFixture.repositoryPath, "docs", "README.md"), "external commit\n", "utf8");
    git(headFixture.repositoryPath, ["add", "--", "docs/README.md"]);
    git(headFixture.repositoryPath, ["commit", "-m", "External concurrent change"], gitIdentity);

    expect(() => connector.executeAction(headFixture.connection, headCandidate)).toThrow(/Stale Git HEAD precondition/u);
    expect(fs.readFileSync(path.join(headFixture.repositoryPath, "contracts", "orders.yaml"), "utf8"))
      .toBe(headFixture.contractContent);

    resetRepository(sharedFixture);
    const blobFixture = sharedFixture;
    const blobCandidate = requiredCandidate(connector.planAction(
      blobFixture.connection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      connector.discover(blobFixture.connection).resources
    ));
    const staleBlobCandidate: ConnectorActionCandidate = {
      ...blobCandidate,
      parameters: {
        ...blobCandidate.parameters,
        expectedBlob: "0000000000000000000000000000000000000000",
        expectedBlobSha: "0000000000000000000000000000000000000000"
      }
    };

    expect(() => connector.executeAction(blobFixture.connection, staleBlobCandidate)).toThrow(/Stale Git blob precondition/u);
    expect(fs.readFileSync(path.join(blobFixture.repositoryPath, "contracts", "orders.yaml"), "utf8"))
      .toBe(blobFixture.contractContent);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("restores only the target before content when Git fails before commit", () => {
    const fixture = sharedFixture;
    const connector = new GitConnector();
    const candidate = requiredCandidate(connector.planAction(
      fixture.connection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      connector.discover(fixture.connection).resources
    ));
    const unrelatedPath = path.join(fixture.repositoryPath, "docs", "README.md");
    const unrelatedContent = "unrelated worktree edit\n";
    fs.writeFileSync(unrelatedPath, unrelatedContent, "utf8");
    const indexLockPath = path.join(fixture.repositoryPath, ".git", "index.lock");
    fs.writeFileSync(indexLockPath, "locked by test\n", "utf8");

    expect(() => connector.executeAction(fixture.connection, candidate)).toThrow(/Git action failed/u);
    fs.rmSync(indexLockPath, { force: true });

    expect(fs.readFileSync(path.join(fixture.repositoryPath, "contracts", "orders.yaml"), "utf8"))
      .toBe(fixture.contractContent);
    expect(git(fixture.repositoryPath, ["status", "--porcelain=v1", "--", "contracts/orders.yaml"])).toBe("");
    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe(unrelatedContent);
    expect(gitRaw(fixture.repositoryPath, ["status", "--porcelain=v1", "--", "docs/README.md"]).trimEnd())
      .toBe(" M docs/README.md");
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("rejects repository path traversal in discovery and execution", () => {
    const fixture = sharedFixture;
    const connector = new GitConnector();
    if (fixture.connection.config.kind !== "git") throw new Error("Expected a Git fixture connection.");
    const unsafeConnection: SourceConnection = {
      ...fixture.connection,
      config: { ...fixture.connection.config, includePaths: ["../outside"] }
    };
    expect(() => connector.discover(unsafeConnection)).toThrow(/Unsafe repository-relative path/u);

    const candidate = requiredCandidate(connector.planAction(
      fixture.connection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      connector.discover(fixture.connection).resources
    ));
    const outsidePath = path.join(path.dirname(fixture.repositoryPath), "outside.yaml");
    const traversalCandidate: ConnectorActionCandidate = {
      ...candidate,
      objectKey: "../outside.yaml",
      parameters: {
        ...candidate.parameters,
        path: "../outside.yaml",
        relativePath: "../outside.yaml"
      }
    };
    expect(() => connector.executeAction(fixture.connection, traversalCandidate)).toThrow(/Unsafe repository-relative path/u);
    expect(fs.existsSync(outsidePath)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.repositoryPath, "contracts", "orders.yaml"), "utf8"))
      .toBe(fixture.contractContent);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("returns null when a denominator request does not identify one metric unambiguously", () => {
    const fixture = configureSecondMetricFixture(sharedFixture);
    const connector = new GitConnector();
    const resources = connector.discover(fixture.connection).resources;

    expect(connector.planAction(
      fixture.connection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      resources
    )).toBeNull();
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("does not plan semantic-contract writes for a read-only connection", () => {
    const fixture = sharedFixture;
    const connector = new GitConnector();
    if (fixture.connection.config.kind !== "git") throw new Error("Expected a Git fixture connection.");
    const readOnlyConnection: SourceConnection = {
      ...fixture.connection,
      config: { ...fixture.connection.config, writeMode: "read_only" }
    };
    expect(connector.planAction(
      readOnlyConnection,
      actionRequest("Use dispatch-eligible orders as the denominator and publish version 2"),
      connector.discover(readOnlyConnection).resources
    )).toBeNull();
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

function createRepository(tempDirectories: string[], options: { secondMetric?: boolean } = {}) {
  fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
  const repositoryPath = fs.mkdtempSync(path.join(TEST_TEMP_ROOT, "semantic-junkyard-git-"));
  tempDirectories.push(repositoryPath);
  fs.mkdirSync(path.join(repositoryPath, "contracts"), { recursive: true });
  fs.mkdirSync(path.join(repositoryPath, "docs"), { recursive: true });
  const contractContent = semanticContractYaml(options.secondMetric ?? false);
  fs.writeFileSync(path.join(repositoryPath, "contracts", "orders.yaml"), contractContent, "utf8");
  fs.writeFileSync(path.join(repositoryPath, "docs", "README.md"), "# Fulfillment documentation\n", "utf8");
  fs.writeFileSync(path.join(repositoryPath, "ignored.log"), "unsupported extension\n", "utf8");

  git(repositoryPath, ["init"]);
  git(repositoryPath, ["add", "--", "contracts/orders.yaml", "docs/README.md", "ignored.log"]);
  git(repositoryPath, ["commit", "-m", "Initial semantic contract"], gitIdentity);
  const initialHead = git(repositoryPath, ["rev-parse", "HEAD"]);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const connection: SourceConnection = {
    id: "connection_git_fixture",
    name: "Fixture semantic repository",
    description: "Local Git fixture.",
    kind: "git",
    config: {
      kind: "git",
      repositoryPath,
      includePaths: ["contracts", "docs"],
      maxFiles: 20,
      maxFileBytes: 1_000_000,
      writeMode: "autonomous",
      semanticContractPaths: ["contracts/orders.yaml"]
    },
    status: "ready",
    lastTestedAt: null,
    lastSyncAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return { repositoryPath, contractContent, initialHead, connection };
}

function resetRepository(fixture: ReturnType<typeof createRepository>): void {
  fs.rmSync(path.join(fixture.repositoryPath, ".git", "index.lock"), { force: true });
  fs.rmSync(path.join(fixture.repositoryPath, ".git", "hooks", "post-commit"), { force: true });
  fs.rmSync(path.join(fixture.repositoryPath, "post-commit-hook-ran"), { force: true });
  fs.rmSync(path.join(fixture.repositoryPath, "docs", "untracked.txt"), { force: true });
  fs.rmSync(path.join(fixture.repositoryPath, "docs", "ignored.bin"), { force: true });
  git(fixture.repositoryPath, ["reset", "--hard", fixture.initialHead]);
}

function configureSecondMetricFixture(fixture: ReturnType<typeof createRepository>) {
  const contractContent = semanticContractYaml(true);
  fs.writeFileSync(path.join(fixture.repositoryPath, "contracts", "orders.yaml"), contractContent, "utf8");
  git(fixture.repositoryPath, ["add", "--", "contracts/orders.yaml"]);
  git(fixture.repositoryPath, ["commit", "-m", "Add second metric fixture"], gitIdentity);
  return {
    ...fixture,
    contractContent,
    initialHead: git(fixture.repositoryPath, ["rev-parse", "HEAD"])
  };
}

function semanticContractYaml(secondMetric: boolean): string {
  const additionalMetric = secondMetric
    ? `
  - id: metric_cancellation_rate
    name: cancellation_rate
    label: Cancellation Rate
    description: Share of orders cancelled before dispatch.
    expression: cancelled_orders / all_orders
    dimensions:
      - warehouse
    owner: fulfillment
    domain: logistics
    contractVersion: "1"
    metadata: {}
`
    : "";
  return `id: contract_orders
name: Orders Semantic Contract
version: "1"
domain: logistics
status: active
assets:
  - id: asset_orders
    kind: dataset
    name: orders
    domain: logistics
    owner: fulfillment
    description: Governed order lifecycle dataset.
    sensitivity: internal
    freshness: fresh
    qualityScore: 0.95
    uri: warehouse://orders
    metadata: {}
metrics:
  - id: metric_dispatch_rate
    name: dispatch_rate
    label: Dispatch Rate
    description: Share of orders dispatched.
    expression: dispatched_orders / all_orders
    dimensions:
      - warehouse
    owner: fulfillment
    domain: logistics
    contractVersion: "1"
    metadata: {}
${additionalMetric}policies: []
ontologyClasses: []
metadata: {}
`;
}

function actionRequest(intent: string) {
  return {
    intent,
    mode: "autonomous" as const,
    maxAutonomousRisk: "medium" as const,
    context: {}
  };
}

function requiredCandidate(candidate: ConnectorActionCandidate | null): ConnectorActionCandidate {
  if (!candidate) throw new Error("Expected GitConnector to produce an action candidate.");
  return candidate;
}

function git(repositoryPath: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return gitRaw(repositoryPath, args, env).trim();
}

function gitRaw(repositoryPath: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("git", [...TEST_GIT_CONFIG, "-C", repositoryPath, ...args], {
    cwd: repositoryPath,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Git failed with ${String(result.status)}.`);
  return result.stdout;
}

function gitNul(repositoryPath: string, args: string[]): string[] {
  return gitRaw(repositoryPath, args).split("\0").filter(Boolean);
}
