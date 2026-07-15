import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessActionPlan } from "@semantic-junkyard/shared";
import { createApp } from "./app.js";
import { openMemoryDatabase } from "./storage/database.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const temporaryPath of temporaryPaths.splice(0)) fs.rmSync(temporaryPath, { recursive: true, force: true });
});

describe("Semantic Junkyard engine", () => {
  it("seeds catalog, corpus, graph, discovery, and search", () => {
    const db = openMemoryDatabase();
    const { engine, repository } = createApp(db, { seed: true });

    const status = repository.status();
    expect(status.sources).toBeGreaterThan(0);
    expect(status.assets).toBeGreaterThan(0);
    expect(status.metrics).toBeGreaterThan(0);
    expect(status.policies).toBeGreaterThan(0);

    const results = engine.search({ query: "Which semantic contract governs failed payment rate?", topK: 5, mode: "hybrid" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].summary.toLowerCase()).toMatch(/semantic|payment|contract|metric/);

    const graph = repository.graphSnapshot();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.every((node) => !node.label.includes("\n"))).toBe(true);

    const discovery = engine.runDiscovery("Test discovery");
    expect(discovery.events.some((event) => event.tool === "agent.plan")).toBe(true);
  });

  it("publishes an agent-readable capability boundary", () => {
    const db = openMemoryDatabase();
    const { engine } = createApp(db, { seed: true });
    const permissions = engine.explainPermissions("answer an undefined finance data question");

    expect(permissions.manifest.modelAgnostic).toBe(true);
    expect(permissions.manifest.capabilities.map((capability) => capability.name)).toContain("semantic_search");
    expect(permissions.manifest.capabilities.map((capability) => capability.name)).toContain("business_action_execute");
    expect(permissions.decision).toContain("business-action planning");
    expect(permissions.safeNextSteps.length).toBeGreaterThan(2);
  });

  it("does not claim objective grounding when no authoritative source resources exist", () => {
    const { engine } = createApp(openMemoryDatabase(), { seed: false });
    const run = engine.runDiscovery("Discover order dispatch semantics");
    const grounding = run.events.find((event) => event.tool === "grounding.check");

    expect(grounding).toMatchObject({ title: "Objective could not be grounded", severity: "warning" });
    expect(grounding?.detail).toContain("No observed source resources");
  });

  it("previews ingestion without persisting and supports manual semantic curation", () => {
    const db = openMemoryDatabase();
    const { engine, repository } = createApp(db, { seed: false });

    const before = repository.status();
    const preview = engine.previewIngest({
      name: "curation-sample.md",
      mimeType: "text/markdown",
      ingestionMode: "full_data",
      text: "Payments API depends on Billing Pipeline. Billing Pipeline writes Revenue Mart."
    });

    expect(preview.profile.entityCount).toBeGreaterThan(0);
    expect(preview.profile.chunkCount).toBeGreaterThan(0);
    expect(repository.status()).toEqual(before);

    const ingested = engine.ingest({
      name: "curation-sample.md",
      mimeType: "text/markdown",
      ingestionMode: "full_data",
      text: "Payments API depends on Billing Pipeline. Billing Pipeline writes Revenue Mart."
    });
    const curated = engine.curateRelation({
      sourceName: "Payments API",
      sourceType: "System",
      targetName: "Revenue Mart",
      targetType: "Dataset",
      relationType: "DEPENDS_ON",
      evidenceChunkId: ingested.chunks[0]?.id,
      rationale: "Business owner confirmed the dependency."
    });

    expect(curated.relation.type).toBe("DEPENDS_ON");
    expect(curated.evidence.chunkId).toBe(ingested.chunks[0]?.id);
    expect(repository.graphSnapshot().edges.some((edge) => edge.id === curated.relation.id)).toBe(true);

    engine.ingest({
      name: "curation-sample.md",
      mimeType: "text/markdown",
      ingestionMode: "full_data",
      text: "Payments API depends on Billing Pipeline. Billing Pipeline writes Revenue Mart."
    });
    expect(repository.graphSnapshot().edges.some((edge) => edge.id === curated.relation.id)).toBe(true);
  });

  it("bounds high-degree graph neighborhoods before returning agent context", () => {
    const { engine, repository } = createApp(openMemoryDatabase(), { seed: true });
    const evidenceChunkId = repository.getChunks()[0]!.id;
    const center = {
      id: "ent_budget_center",
      canonicalName: "Budget Center",
      type: "Concept",
      aliases: [],
      confidence: 1,
      evidenceChunkIds: [evidenceChunkId],
      metadata: {}
    };
    const leaves = Array.from({ length: 320 }, (_, index) => ({
      id: `ent_budget_leaf_${index}`,
      canonicalName: `Budget Leaf ${index}`,
      type: "Concept",
      aliases: [],
      confidence: 1,
      evidenceChunkIds: [evidenceChunkId],
      metadata: {}
    }));
    repository.saveEntities([center, ...leaves]);
    repository.saveRelations(
      leaves.map((leaf, index) => ({
        id: `rel_budget_${index}`,
        sourceEntityId: center.id,
        targetEntityId: leaf.id,
        type: "RELATED_TO",
        confidence: 1,
        evidenceChunkId,
        metadata: {}
      }))
    );

    const neighborhood = engine.graphNeighbors({ entityId: center.id, depth: 1 });
    expect(neighborhood.nodes.length).toBeLessThanOrEqual(250);
    expect(neighborhood.edges.length).toBeLessThanOrEqual(500);
    expect(neighborhood.nodes.some((node) => node.id === center.id)).toBe(true);
  });

  it("excludes rejected and superseded relations from graph-aware retrieval boosts", () => {
    const { engine, repository } = createApp(openMemoryDatabase(), { seed: false });
    const ingested = engine.ingest({
      name: "graph-lifecycle.txt",
      mimeType: "text/plain",
      ingestionMode: "full_data",
      text: "ZephyrBoundary"
    });
    const chunkId = ingested.chunks[0]!.id;
    const entityId = repository.getEntityIdsByChunk().get(chunkId)?.[0];
    expect(entityId).toBeDefined();
    repository.saveEntities([{
      id: "ent_graph_lifecycle_leaf",
      canonicalName: "Lifecycle Leaf",
      type: "Concept",
      aliases: [],
      confidence: 1,
      evidenceChunkIds: [chunkId],
      metadata: {}
    }]);
    const graphBoost = () => engine.search({ query: "ZephyrBoundary", topK: 5, mode: "graph" })
      .find((result) => result.chunkId === chunkId)!.graphBoost;
    const baseline = graphBoost();
    repository.saveRelations([{
      id: "rel_graph_proposed",
      sourceEntityId: entityId!,
      targetEntityId: "ent_graph_lifecycle_leaf",
      type: "RELATED_TO",
      confidence: 1,
      evidenceChunkId: chunkId,
      metadata: { lifecycle: "proposed" }
    }]);
    expect(graphBoost()).toBe(baseline);
    repository.saveRelations([{
      id: "rel_graph_rejected",
      sourceEntityId: entityId!,
      targetEntityId: "ent_graph_lifecycle_leaf",
      type: "RELATED_TO",
      confidence: 1,
      evidenceChunkId: chunkId,
      metadata: { lifecycle: "rejected" }
    }]);
    expect(graphBoost()).toBe(baseline);
    repository.saveRelations([{
      id: "rel_graph_active",
      sourceEntityId: entityId!,
      targetEntityId: "ent_graph_lifecycle_leaf",
      type: "RELATED_TO",
      confidence: 1,
      evidenceChunkId: chunkId,
      metadata: { lifecycle: "accepted" }
    }]);
    expect(graphBoost()).toBeGreaterThan(baseline);
  });

  it("routes business actions through an authoritative connector and reflects them into the semantic read model", async () => {
    const { engine, repository } = await writableSqliteRuntime();
    const before = repository.status();

    const plan = engine.planBusinessAction({
      intent: "Set order ORD-ENGINE status to dispatched",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });

    expect(plan.targets.map((target) => target.systemName)).toEqual(["Engine Operations"]);
    expect(repository.listSourceSystemRecords()).toHaveLength(0);

    const run = engine.executeBusinessAction(executionFor(plan));

    expect(run.status).toBe("verified");
    expect(run.writes.length).toBeGreaterThan(0);
    expect(run.reflections.every((reflection) => reflection.status === "verified")).toBe(true);
    expect(run.semanticUpdates[0]?.chunkIds.length).toBeGreaterThan(0);
    expect(repository.listSourceSystemRecords().length).toBe(run.writes.length);
    expect(repository.listBusinessActionRuns()[0]?.id).toBe(run.id);
    expect(repository.status().sources).toBeGreaterThan(before.sources);

    const domainResults = engine.search({ query: "Business Action Reflection ORD-ENGINE dispatched", topK: 5, mode: "hybrid" });
    expect(domainResults.every((result) => result.evidenceClass === "domain")).toBe(true);
    expect(domainResults.some((result) => result.sourceName.includes("business-action-reflection"))).toBe(false);

    const reflectedResults = engine.search({
      query: "Business Action Reflection ORD-ENGINE dispatched",
      topK: 5,
      mode: "hybrid",
      scope: "operational"
    });
    expect(reflectedResults.some((result) => result.sourceName.includes("business-action-reflection"))).toBe(true);
    expect(reflectedResults.every((result) => result.evidenceClass === "operational")).toBe(true);
    expect(reflectedResults.every((result) => result.graphBoost <= 0.35)).toBe(true);
    const reflectedChunkId = reflectedResults[0]?.chunkId;
    expect(reflectedChunkId).toBeTruthy();
    const domainContext = engine.expandContext({
      query: "ORD-ENGINE dispatch eligibility",
      chunkIds: [reflectedChunkId!],
      scope: "domain"
    });
    expect(domainContext.evidence.some((item) => item.chunkId === reflectedChunkId)).toBe(false);
    const operationalContext = engine.expandContext({ chunkIds: [reflectedChunkId!], scope: "operational" });
    expect(operationalContext.evidence.map((item) => item.chunkId)).toContain(reflectedChunkId);
  });

  it("holds higher-risk connector writes for approval when autonomy policy is stricter", async () => {
    const { engine, repository } = await writableSqliteRuntime({ risk: "medium" });

    const plan = engine.planBusinessAction({
      intent: "Set order ORD-ENGINE status to dispatched",
      mode: "autonomous",
      maxAutonomousRisk: "low"
    });
    const run = engine.executeBusinessAction(executionFor(plan));

    expect(run.status).toBe("approval_required");
    expect(run.plan.targets.some((target) => target.risk === "medium" && target.autonomy === "approval_required")).toBe(true);
    expect(run.writes).toHaveLength(0);
    expect(repository.listSourceSystemRecords()).toHaveLength(0);
  });

  it("binds a persisted plan to the exact actor, roles, clearance, and policy version", async () => {
    const { engine, repository } = await writableSqliteRuntime();
    const planner = {
      actor: "planner-a",
      roles: ["semantic-reader", "business-action-planner"],
      clearance: "confidential" as const
    };
    const plan = engine.planBusinessAction(
      { intent: "Set order ORD-ENGINE status to dispatched", mode: "autonomous", maxAutonomousRisk: "medium" },
      planner
    );

    expect(plan.principal).toMatchObject({ actor: "planner-a", clearance: "confidential", policyVersion: "business-action-policy-v2" });
    expect(() =>
      engine.executeBusinessAction(executionFor(plan), {
        ...planner,
        actor: "planner-b"
      })
    ).toThrow(/different principal or authorization context/i);
    expect(repository.listSourceSystemRecords()).toHaveLength(0);
  });

  it("treats configured source-system templates as non-executable until a connector is installed", () => {
    const runtime = createApp(openMemoryDatabase(), { seed: true });
    const plan = runtime.engine.planBusinessAction({
      intent: "Align Failed Payment Rate definition across Finance and Billing",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    expect(plan.status).toBe("blocked");
    expect(plan.targets.length).toBeGreaterThan(0);
    expect(plan.targets.every((target) => target.autonomy === "blocked")).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes("no authoritative connector"))).toBe(true);
    expect(runtime.engine.executeBusinessAction(executionFor(plan)).writes).toHaveLength(0);
  });

  it("separates human approval from execution and consumes an exact connector plan approval once", async () => {
    const { engine, repository } = await writableSqliteRuntime({ writeMode: "approval_required" });
    const request = {
      intent: "Set order ORD-ENGINE status to dispatched",
      mode: "approval_required" as const,
      maxAutonomousRisk: "low" as const
    };
    const plan = engine.planBusinessAction(request);

    const paused = engine.executeBusinessAction(executionFor(plan));
    expect(paused.status).toBe("approval_required");
    expect(paused.writes).toHaveLength(0);

    const approval = engine.approveBusinessAction(
      {
        ...request,
        planId: plan.id,
        planFingerprint: plan.fingerprint,
        rationale: "Reviewed target systems and diffs."
      },
      "antonio"
    );
    const run = engine.executeBusinessAction({ ...executionFor(plan), approvalId: approval.id });

    expect(run.status).toBe("verified");
    expect(repository.getBusinessActionApproval(approval.id)?.status).toBe("consumed");
  });

  it("rejects reuse of one consumed approval with a different execution key", async () => {
    const { engine, repository } = await writableSqliteRuntime({ writeMode: "approval_required" });
    const request = {
      intent: "Set order ORD-ENGINE status to dispatched",
      mode: "approval_required" as const,
      maxAutonomousRisk: "low" as const
    };
    const plan = engine.planBusinessAction(request);
    const approval = engine.approveBusinessAction(
      {
        ...request,
        planId: plan.id,
        planFingerprint: plan.fingerprint,
        rationale: "Owner-review target checked."
      },
      "antonio"
    );

    const first = engine.executeBusinessAction({ ...executionFor(plan, "first-approved"), approvalId: approval.id });
    expect(first.status).toBe("verified");
    expect(() => engine.executeBusinessAction({ ...executionFor(plan, "second-approved"), approvalId: approval.id })).toThrow(/plan no longer matches current source state/i);
    expect(repository.getBusinessActionApproval(approval.id)?.status).toBe("consumed");
    expect(repository.listSourceSystemRecords()).toHaveLength(first.writes.length);
  });

  it("requires reconciliation and consumes approval when a source outcome is ambiguous", async () => {
    const { engine, repository } = await writableSqliteRuntime({ writeMode: "approval_required" });
    const request = {
      intent: "Set order ORD-ENGINE status to dispatched",
      mode: "approval_required" as const,
      maxAutonomousRisk: "medium" as const
    };
    const plan = engine.planBusinessAction(request);
    const approval = engine.approveBusinessAction(
      {
        ...request,
        planId: plan.id,
        planFingerprint: plan.fingerprint,
        rationale: "Approved for rollback test."
      },
      "antonio"
    );
    const originalSave = repository.saveSourceSystemRecord.bind(repository);
    vi.spyOn(repository, "saveSourceSystemRecord").mockImplementation((record) => {
      originalSave(record);
      throw new Error("injected reflection persistence failure");
    });

    const run = engine.executeBusinessAction({ ...executionFor(plan, "rollback"), approvalId: approval.id });
    expect(run.status).toBe("reconciliation_required");
    expect(run.writes).toHaveLength(0);
    expect(repository.listSourceSystemRecords()).toHaveLength(0);
    expect(repository.getBusinessActionApproval(approval.id)?.status).toBe("consumed");
    expect(run.plan.warnings.join(" ")).toContain("Reconcile authoritative sources before retrying");
    expect(() => engine.executeBusinessAction({ ...executionFor(plan, "second-after-ambiguous"), approvalId: approval.id })).toThrow(
      /plan no longer matches current source state/i
    );
  });

  it("blocks destructive or unsupported actions and refuses evidence-free writeback", () => {
    const seeded = createApp(openMemoryDatabase(), { seed: true });
    const destructive = seeded.engine.planBusinessAction({
      intent: "Delete all production customer records and rotate API secrets",
      mode: "autonomous",
      maxAutonomousRisk: "high"
    });
    expect(destructive.status).toBe("blocked");
    expect(seeded.engine.executeBusinessAction(executionFor(destructive)).writes).toHaveLength(0);

    const empty = createApp(openMemoryDatabase(), { seed: false });
    const evidenceFree = empty.engine.planBusinessAction({
      intent: "Align Customer Churn definition",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    expect(evidenceFree.status).toBe("blocked");
    expect(empty.engine.executeBusinessAction(executionFor(evidenceFree)).writes).toHaveLength(0);
  });

  it("does not publish drifted readback and replays duplicate execution idempotently", async () => {
    const { engine, repository } = await writableSqliteRuntime();
    const plan = engine.planBusinessAction({
      intent: "Set order ORD-ENGINE status to dispatched",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    const originalRead = repository.getSourceSystemRecord.bind(repository);
    vi.spyOn(repository, "getSourceSystemRecord").mockImplementation((systemId, objectType, objectKey) => {
      const record = originalRead(systemId, objectType, objectKey);
      return record ? { ...record, payload: { ...record.payload, diff: { tampered: true } } } : null;
    });

    const drifted = engine.executeBusinessAction(executionFor(plan));
    expect(drifted.status).toBe("reflected");
    expect(drifted.reflections.every((reflection) => reflection.status === "drift")).toBe(true);
    expect(drifted.semanticUpdates).toHaveLength(0);

    vi.restoreAllMocks();
    const replayRuntime = await writableSqliteRuntime();
    const secondPlan = replayRuntime.engine.planBusinessAction({
      intent: "Set order ORD-ENGINE status to dispatched",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    const request = executionFor(secondPlan);
    const first = replayRuntime.engine.executeBusinessAction(request);
    const replay = replayRuntime.engine.executeBusinessAction(request);
    expect(replay.id).toBe(first.id);
    expect(replayRuntime.repository.listSourceSystemRecords()).toHaveLength(1);
    expect(replayRuntime.repository.listSourceSystemRecords()[0]?.version).toBe(1);
  });

  it("rolls back ingestion when a later persistence stage fails", () => {
    const { engine, repository } = createApp(openMemoryDatabase(), { seed: false });
    vi.spyOn(repository, "saveEntities").mockImplementation(() => {
      throw new Error("injected entity failure");
    });

    expect(() =>
      engine.ingest({ name: "atomic.md", mimeType: "text/markdown", text: "Payments API depends on Billing Pipeline." })
    ).toThrow(/injected entity failure/);
    expect(repository.status().sources).toBe(0);
    expect(repository.status().chunks).toBe(0);
    vi.restoreAllMocks();
  });

  it("applies the same masking policy to direct evidence and source reads", () => {
    const { engine, repository } = createApp(openMemoryDatabase(), { seed: true });
    const rawChunk = repository.getChunks().find((chunk) => chunk.text.includes("customer_id"));
    expect(rawChunk).toBeTruthy();
    const evidence = engine.getEvidence(rawChunk!.id);
    expect(evidence?.text).not.toContain("customer_id");
    expect(evidence?.text).toContain("[masked]");
    const source = engine.getSources().find((item) => item.name === "billing-context.html");
    expect(source?.text).not.toContain("customer_id");
    expect(engine.redactOperationalData({ text: "Never expose secrets or customer_id values." })).toEqual({
      text: "Never expose [denied] or [masked] values."
    });
  });
});

function executionFor(plan: BusinessActionPlan, suffix = "primary") {
  return {
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    intent: plan.intent,
    mode: plan.mode,
    maxAutonomousRisk: plan.maxAutonomousRisk,
    idempotencyKey: `${plan.id}-${suffix}`
  };
}

async function writableSqliteRuntime(
  options: {
    writeMode?: "autonomous" | "approval_required";
    risk?: "low" | "medium" | "high";
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-engine-source-"));
  temporaryPaths.push(root);
  const databasePath = path.join(root, "operations.sqlite");
  const source = new Database(databasePath);
  source.exec("CREATE TABLE orders (order_id TEXT PRIMARY KEY, dispatch_eligible INTEGER NOT NULL, status TEXT NOT NULL)");
  source.prepare("INSERT INTO orders VALUES (?, ?, ?)").run("ORD-ENGINE", 1, "ready");
  source.close();

  const runtime = createApp(openMemoryDatabase(), { seed: false });
  const connection = runtime.engine.createSourceConnection({
    name: "Engine Operations",
    description: "Authoritative semantic-engine test source",
    config: {
      kind: "sqlite",
      databasePath,
      includeTables: ["orders"],
      sampleRows: 1,
      writeMode: options.writeMode ?? "autonomous",
      writeRules: [
        {
          table: "orders",
          aliases: ["order"],
          keyColumn: "order_id",
          allowedColumns: ["status"],
          risk: options.risk ?? "low"
        }
      ]
    }
  });
  await runtime.engine.syncSourceConnection(connection.id, {
    objective: "Discover order dispatch eligibility and governed status actions.",
    provider: "deterministic"
  });
  return runtime;
}
