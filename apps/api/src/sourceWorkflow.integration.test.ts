import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createSemanticRuntime } from "./app.js";
import { openMemoryDatabase } from "./storage/database.js";
import type { SourceConnector } from "./sources/connector.js";

const temporaryPaths: string[] = [];
const TEST_TEMP_ROOT = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "semantic-junkyard-tests");
const TEST_GIT_CONFIG = [
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false"
];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) fs.rmSync(temporaryPath, { recursive: true, force: true });
});

describe("real source workflow", () => {
  it("discovers, grounds, writes, rereads, and reflects an external SQLite row", async () => {
    const root = temporaryDirectory();
    const sourcePath = path.join(root, "operations.sqlite");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE orders (order_id TEXT PRIMARY KEY, dispatch_eligible INTEGER NOT NULL, status TEXT NOT NULL)");
    source.prepare("INSERT INTO orders VALUES (?, ?, ?)").run("ORD-1", 1, "ready");
    source.close();

    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: false });
    const connection = runtime.engine.createSourceConnection({
      name: "Test Operations",
      description: "External SQLite source",
      config: {
        kind: "sqlite",
        databasePath: sourcePath,
        includeTables: [],
        sampleRows: 0,
        writeMode: "autonomous",
        writeRules: [{ table: "orders", aliases: ["order"], keyColumn: "order_id", allowedColumns: ["status"], risk: "low" }]
      }
    });

    const sync = await runtime.engine.syncSourceConnection(connection.id, {
      objective: "Discover orders, dispatch eligibility, and safe status actions.",
      provider: "deterministic"
    });
    expect(sync.status).toBe("completed");
    expect(sync.resourcesDiscovered).toBeGreaterThanOrEqual(4);
    expect(runtime.engine.sourceResources(connection.id).some((resource) => resource.qualifiedName.includes("orders.status") && resource.writable)).toBe(true);
    const agentResources = runtime.engine.sourceResourcesForActor(
      { actor: "fixture-agent", roles: ["semantic-reader", "business-action-planner"], clearance: "confidential" },
      connection.id
    );
    const operatorResources = runtime.engine.sourceResourcesForActor(
      { actor: "fixture-operator", roles: ["semantic-reader", "semantic-operator"], clearance: "confidential" },
      connection.id
    );
    expect(JSON.stringify(agentResources)).not.toContain(sourcePath);
    expect(agentResources.every((resource) => resource.uri.startsWith("semantic-junkyard://resource/"))).toBe(true);
    expect(JSON.stringify(operatorResources)).toContain(sourcePath);

    const plan = runtime.engine.planBusinessAction({
      intent: "Set order ORD-1 status to dispatched",
      mode: "autonomous",
      maxAutonomousRisk: "medium",
      context: {}
    });
    expect(plan.status).toBe("planned");
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ systemId: connection.id, technicalOperation: "sqlite.record.update" });

    const run = runtime.engine.executeBusinessAction({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      intent: plan.intent,
      mode: plan.mode,
      maxAutonomousRisk: plan.maxAutonomousRisk,
      idempotencyKey: `sqlite-${plan.fingerprint}`,
      context: {}
    });
    expect(run.status).toBe("verified");
    expect(run.reflections).toHaveLength(1);
    expect(run.reflections[0]?.status).toBe("verified");

    const readback = new Database(sourcePath, { readonly: true });
    expect(readback.prepare("SELECT status FROM orders WHERE order_id = ?").pluck().get("ORD-1")).toBe("dispatched");
    readback.close();
    expect(runtime.engine.search({ query: "Set order ORD-1 status dispatched", mode: "hybrid", topK: 10 }).some((result) => result.text.includes("ORD-1"))).toBe(true);
  });

  it("blocks a connector action when its target evidence is restricted", async () => {
    const root = temporaryDirectory();
    const sourcePath = path.join(root, "restricted.sqlite");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT NOT NULL, secret_token TEXT NOT NULL)");
    source.prepare("INSERT INTO users VALUES (?, ?, ?)").run(1, "active", "private-value");
    source.close();

    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: false });
    const connection = runtime.engine.createSourceConnection({
      name: "Restricted operations",
      description: "Fixture proving connector allowlists do not bypass semantic policy.",
      config: {
        kind: "sqlite",
        databasePath: sourcePath,
        includeTables: [],
        sampleRows: 1,
        writeMode: "autonomous",
        writeRules: [{ table: "users", aliases: ["user"], keyColumn: "id", allowedColumns: ["secret_token"], risk: "low" }]
      }
    });
    await runtime.engine.syncSourceConnection(connection.id, {
      objective: "Discover user operations and sensitivity.",
      provider: "deterministic"
    });

    const plan = runtime.engine.planBusinessAction({
      intent: 'Set user id = 1 secret_token to "replacement"',
      mode: "autonomous",
      maxAutonomousRisk: "high",
      context: {}
    });

    expect(plan.status).toBe("blocked");
    expect(plan.risk).toBe("blocked");
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.autonomy).toBe("blocked");
    expect(plan.warnings.join(" ")).toMatch(/restricted.*not authorized/i);
  });

  it("publishes an exact semantic-contract change through Git after approval", async () => {
    const repositoryPath = temporaryDirectory();
    const relativePath = "contracts/late-dispatch-rate.yaml";
    fs.mkdirSync(path.join(repositoryPath, "contracts"), { recursive: true });
    fs.writeFileSync(path.join(repositoryPath, relativePath), stringify(contractFixture()), "utf8");
    git(repositoryPath, ["init", "--initial-branch=main"]);
    git(repositoryPath, ["add", "--", "."]);
    git(repositoryPath, ["commit", "-m", "Initial contract"]);

    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: false });
    const connection = runtime.engine.createSourceConnection({
      name: "Test Contracts",
      description: "External Git semantic contracts",
      config: {
        kind: "git",
        repositoryPath,
        includePaths: ["contracts"],
        maxFiles: 20,
        maxFileBytes: 200_000,
        writeMode: "approval_required",
        semanticContractPaths: [relativePath]
      }
    });
    await runtime.engine.syncSourceConnection(connection.id, {
      objective: "Discover Late Dispatch Rate and its denominator conflict.",
      provider: "deterministic"
    });

    const request = {
      intent: "Use dispatch eligible orders as the denominator for Late Dispatch Rate and publish version 2",
      mode: "autonomous" as const,
      maxAutonomousRisk: "medium" as const,
      context: {}
    };
    const plan = runtime.engine.planBusinessAction(request);
    expect(plan.status).toBe("approval_required");
    expect(plan.targets[0]).toMatchObject({ systemId: connection.id, technicalOperation: "git.semantic_contract.commit" });
    const approval = runtime.engine.approveBusinessAction(
      {
        planId: plan.id,
        planFingerprint: plan.fingerprint,
        intent: request.intent,
        mode: request.mode,
        maxAutonomousRisk: request.maxAutonomousRisk,
        rationale: "Reviewed the exact contract diff and source version.",
        context: {}
      },
      "test-steward"
    );
    const run = runtime.engine.executeBusinessAction({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      intent: request.intent,
      mode: request.mode,
      maxAutonomousRisk: request.maxAutonomousRisk,
      approvalId: approval.id,
      idempotencyKey: `git-${plan.fingerprint}`,
      context: {}
    });
    expect(run.status).toBe("verified");
    expect(git(repositoryPath, ["show", `HEAD:${relativePath}`])).toContain("version: \"2\"");
    expect(git(repositoryPath, ["log", "-1", "--pretty=%an"])).toBe("Semantic Junkyard");
  }, 90_000);

  it("fails closed for an unrelated domain instead of selecting fallback objects", () => {
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: true });
    const plan = runtime.engine.planBusinessAction({
      intent: "Update Employee Attrition Rate for Human Resources",
      mode: "autonomous",
      maxAutonomousRisk: "medium",
      context: {}
    });
    expect(plan.status).toBe("blocked");
    expect(plan.targets).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("No fallback object was selected");
  });

  it("does not retain submitted content for no-copy ingestion modes", () => {
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: false });
    const secret = "NO_COPY_SECRET_PAYLOAD";
    const ingested = runtime.engine.ingest({
      name: "restricted-reference.txt",
      uri: "external://restricted/reference",
      mimeType: "text/plain",
      ingestionMode: "external_reference",
      text: secret,
      metadata: { sensitivity: "restricted" }
    });
    expect(ingested.source.text).toBe("");
    expect(JSON.stringify(runtime.repository.getSources())).not.toContain(secret);
    expect(JSON.stringify(runtime.repository.getChunks())).not.toContain(secret);
  });

  it("keeps deterministic source facts available when local enrichment fails", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "dispatch-policy.md"), "# Dispatch policy\nOnly eligible orders may be dispatched.\n", "utf8");
    const runtime = createSemanticRuntime(openMemoryDatabase(), {
      seed: false,
      semanticEnricher: {
        async enrich() {
          throw Object.assign(new Error("model process unavailable"), { code: "LOCAL_MODEL_UNAVAILABLE" });
        }
      }
    });
    const connection = runtime.engine.createSourceConnection({
      name: "Degraded enrichment fixture",
      description: "Filesystem remains authoritative when optional enrichment fails.",
      config: {
        kind: "filesystem",
        rootPath: root,
        recursive: true,
        maxFiles: 20,
        maxFileBytes: 200_000,
        ingestionMode: "full_data"
      }
    });

    const run = await runtime.engine.syncSourceConnection(connection.id, {
      objective: "Discover dispatch policy semantics.",
      provider: "local-huggingface"
    });

    expect(run.status).toBe("partial");
    expect(run.resourcesDiscovered).toBeGreaterThan(0);
    expect(run.events).toContainEqual(
      expect.objectContaining({
        title: "Local model enrichment failed",
        severity: "warning",
        metadata: { errorCode: "LOCAL_MODEL_UNAVAILABLE" }
      })
    );
    expect(runtime.engine.listSourceConnections()[0]).toMatchObject({ status: "degraded", lastError: null });
    expect(runtime.engine.sourceResources(connection.id).some((resource) => resource.evidenceChunkIds.length > 0)).toBe(true);
  });

  it("namespaces equal source-local semantic IDs and deletes only their owning observations", async () => {
    const connector: SourceConnector = {
      kind: "filesystem",
      test: () => ({ ok: true, message: "Fixture source available.", details: {} }),
      discover(connection) {
        const asset = {
          id: "shared-asset",
          kind: "dataset" as const,
          name: `${connection.name} dataset`,
          domain: "Shared Domain",
          owner: connection.name,
          description: "Source-local asset ID fixture.",
          sensitivity: "internal" as const,
          freshness: "fresh" as const,
          qualityScore: 1,
          metadata: {}
        };
        const policy = {
          id: "shared-policy",
          name: `${connection.name} policy`,
          effect: "review" as const,
          appliesTo: ["shared term"],
          condition: "fixture",
          rationale: "Proves policy ownership.",
          metadata: {}
        };
        const ontologyClass = {
          id: "shared-class",
          label: `${connection.name} class`,
          description: "Source-local ontology ID fixture.",
          parentId: null,
          constraints: []
        };
        return {
          resources: [],
          documents: [],
          assets: [asset],
          metrics: [],
          lineage: [],
          contracts: [{
            id: "shared-contract",
            name: `${connection.name} contract`,
            version: "1",
            domain: "Shared Domain",
            status: "active" as const,
            assets: [asset],
            metrics: [],
            policies: [policy],
            ontologyClasses: [ontologyClass],
            metadata: {}
          }],
          ontologyClasses: [],
          relations: [],
          warnings: [],
          checkpoint: {}
        };
      }
    };
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: false, connectors: [connector] });
    const roots = [temporaryDirectory(), temporaryDirectory()];
    const connections = roots.map((rootPath, index) => runtime.engine.createSourceConnection({
      name: `Domain ${index + 1}`,
      description: "Federated identity fixture.",
      config: { kind: "filesystem", rootPath, recursive: true, maxFiles: 10, maxFileBytes: 10_000, ingestionMode: "metadata_only" }
    }));
    for (const connection of connections) {
      await runtime.engine.syncSourceConnection(connection.id, { objective: "Publish source-local semantics.", provider: "deterministic" });
    }

    const federated = runtime.repository.catalog();
    expect(federated.assets).toHaveLength(2);
    expect(federated.contracts).toHaveLength(2);
    expect(federated.policies).toHaveLength(2);
    expect(federated.ontologyClasses).toHaveLength(2);
    expect(new Set(federated.assets.map((asset) => asset.id)).size).toBe(2);
    expect(new Set(federated.contracts.map((contract) => contract.id)).size).toBe(2);
    expect(federated.contracts.every((contract) => contract.assets.length === 1 && contract.policies.length === 1 && contract.ontologyClasses.length === 1)).toBe(true);

    runtime.engine.deleteSourceConnection(connections[0]!.id, "fixture-operator");
    const retained = runtime.repository.catalog();
    expect(retained.assets.map((asset) => asset.name)).toEqual(["Domain 2 dataset"]);
    expect(retained.contracts.map((contract) => contract.name)).toEqual(["Domain 2 contract"]);
    expect(retained.policies.map((policy) => policy.name)).toEqual(["Domain 2 policy"]);
    expect(retained.ontologyClasses.map((item) => item.label)).toEqual(["Domain 2 class"]);
  });

  it("rejects a second in-process synchronization for the same connection", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "dispatch-policy.md"), "# Dispatch policy\nBounded evidence.\n", "utf8");
    let releaseEnrichment!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseEnrichment = resolve; });
    const runtime = createSemanticRuntime(openMemoryDatabase(), {
      seed: false,
      semanticEnricher: {
        async enrich() {
          markStarted();
          await release;
          return {
            provider: "local-huggingface",
            modelId: "fixture/model",
            summary: "No additional proposals.",
            candidates: []
          };
        }
      }
    });
    const connection = runtime.engine.createSourceConnection({
      name: "Concurrent sync fixture",
      description: "One active synchronization per runtime.",
      config: {
        kind: "filesystem",
        rootPath: root,
        recursive: true,
        maxFiles: 20,
        maxFileBytes: 200_000,
        ingestionMode: "full_data"
      }
    });
    const request = { objective: "Discover dispatch semantics.", provider: "local-huggingface" as const };
    const first = runtime.engine.syncSourceConnection(connection.id, request);
    await started;

    await expect(runtime.engine.syncSourceConnection(connection.id, request)).rejects.toMatchObject({ code: "SYNC_ALREADY_RUNNING" });
    releaseEnrichment();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("replaces stale evidence on resync and removes connection-owned observations on delete", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "dispatch-policy.md");
    const obsolete = "OBSOLETE_QUASAR_POLICY";
    const current = "CURRENT_NOVA_POLICY";
    fs.writeFileSync(filePath, `# Dispatch policy\n${obsolete} applies to the legacy queue.`, "utf8");

    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: false });
    const connection = runtime.engine.createSourceConnection({
      name: "Policy Files",
      description: "Replaceable filesystem evidence",
      config: {
        kind: "filesystem",
        rootPath: root,
        recursive: true,
        maxFiles: 20,
        maxFileBytes: 200_000,
        ingestionMode: "full_data"
      }
    });
    const syncRequest = { objective: "Discover dispatch policy evidence.", provider: "deterministic" as const };
    await runtime.engine.syncSourceConnection(connection.id, syncRequest);
    expect(JSON.stringify(runtime.repository.getChunks())).toContain(obsolete);
    const inferred = runtime.engine.semanticProposals({ connectionId: connection.id, status: "proposed" })[0];
    expect(inferred).toBeDefined();
    runtime.engine.decideSemanticProposal(inferred!.id, { decision: "rejected", rationale: "The file-to-document relation is not part of the governed business model." }, "test-steward");
    expect(() => runtime.engine.decideSemanticProposal(inferred!.id, { decision: "accepted", rationale: "Attempted silent reversal." }, "test-steward")).toThrow(/already rejected/i);

    const annotatedResource = runtime.engine.sourceResources(connection.id).find((resource) => resource.kind === "document")!;
    const currentRun = runtime.engine.sourceSyncRuns(connection.id)[0]!;
    const annotationProposal = runtime.connectionRepository.saveProposal({
      id: "proposal.test.classification",
      connectionId: connection.id,
      runId: currentRun.id,
      kind: "classification",
      subjectId: annotatedResource.id,
      predicate: "CLASSIFIED_AS",
      objectId: null,
      value: { label: "Dispatch governance" },
      confidence: 0.9,
      explanation: "The document explicitly describes dispatch governance.",
      origin: "local_model",
      authoritative: false,
      status: "proposed",
      evidenceResourceIds: [annotatedResource.id],
      evidenceChunkIds: annotatedResource.evidenceChunkIds,
      createdAt: "2026-07-10T00:00:00.000Z",
      decidedAt: null,
      decidedBy: null,
      decisionRationale: null
    });
    runtime.engine.decideSemanticProposal(annotationProposal.id, { decision: "accepted", rationale: "The evidence supports this business classification." }, "test-steward");
    expect(runtime.repository.getEntities().find((entity) => entity.metadata.resourceId === annotatedResource.id)?.metadata.semanticAnnotations).toEqual([
      expect.objectContaining({ proposalId: annotationProposal.id, predicate: "CLASSIFIED_AS" })
    ]);
    expect(runtime.repository.graphSnapshot().nodes.find((node) => node.id === runtime.repository.getEntities().find((entity) => entity.metadata.resourceId === annotatedResource.id)?.id)?.annotations).toEqual([
      expect.objectContaining({ proposalId: annotationProposal.id, predicate: "CLASSIFIED_AS" })
    ]);

    fs.writeFileSync(filePath, `# Dispatch policy\n${current} applies to the active queue.`, "utf8");
    await runtime.engine.syncSourceConnection(connection.id, syncRequest);
    const synchronizedEvidence = JSON.stringify(runtime.repository.getChunks());
    expect(synchronizedEvidence).toContain(current);
    expect(synchronizedEvidence).not.toContain(obsolete);
    expect(runtime.repository.getSources().filter((source) => source.metadata.connectionId === connection.id)).toHaveLength(1);
    expect(runtime.engine.semanticProposals({ connectionId: connection.id }).find((proposal) => proposal.id === inferred!.id)?.status).toBe("rejected");
    expect(runtime.repository.getRelations().find((relation) => relation.id === inferred!.value.relationId)?.metadata.lifecycle).toBe("rejected");
    expect(runtime.engine.semanticProposals({ connectionId: connection.id }).find((proposal) => proposal.id === annotationProposal.id)?.status).toBe("superseded");
    expect(runtime.repository.getEntities().find((entity) => entity.metadata.resourceId === annotatedResource.id)?.metadata.semanticAnnotations).toEqual([]);
    expect(runtime.repository.graphSnapshot().nodes.find((node) => node.id === runtime.repository.getEntities().find((entity) => entity.metadata.resourceId === annotatedResource.id)?.id)?.annotations).toEqual([]);

    runtime.engine.deleteSourceConnection(connection.id, "test-operator");
    expect(runtime.engine.listSourceConnections()).toHaveLength(0);
    expect(runtime.repository.getSources().some((source) => source.metadata.connectionId === connection.id)).toBe(false);
    expect(runtime.repository.catalog().assets.some((asset) => asset.metadata.connectionId === connection.id)).toBe(false);
    expect(runtime.repository.getEntities().some((entity) => entity.metadata.connectionId === connection.id)).toBe(false);
    expect(runtime.repository.getRelations().some((relation) => relation.metadata.connectionId === connection.id)).toBe(false);
  });
});

function temporaryDirectory(): string {
  fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(TEST_TEMP_ROOT, "semantic-junkyard-workflow-"));
  temporaryPaths.push(directory);
  return directory;
}

function git(repositoryPath: string, args: string[]): string {
  return execFileSync("git", [...TEST_GIT_CONFIG, "-C", repositoryPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  }).trim();
}

function contractFixture() {
  return {
    id: "contract.late-dispatch",
    name: "Late Dispatch Contract",
    version: "1",
    domain: "Supply Chain",
    status: "draft",
    assets: [],
    metrics: [
      {
        id: "metric.late-dispatch-rate",
        name: "late_dispatch_rate",
        label: "Late Dispatch Rate",
        description: "Late dispatches divided by all orders.",
        expression: "late_dispatch_orders / all_orders",
        dimensions: [],
        owner: "Logistics",
        domain: "Supply Chain",
        contractVersion: "1",
        metadata: {}
      }
    ],
    policies: [],
    ontologyClasses: [],
    metadata: {}
  };
}
