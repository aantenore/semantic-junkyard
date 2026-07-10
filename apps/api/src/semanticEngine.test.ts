import { describe, expect, it, vi } from "vitest";
import type { BusinessActionPlan } from "@semantic-junkyard/shared";
import { createApp } from "./app.js";
import { openMemoryDatabase } from "./storage/database.js";

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

  it("routes business actions to source writeback and reflects them into the semantic read model", () => {
    const db = openMemoryDatabase();
    const { engine, repository } = createApp(db, { seed: true });
    const before = repository.status();

    const plan = engine.planBusinessAction({
      intent: "Align Failed Payment Rate definition across Finance and Billing, then reflect it in source systems.",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });

    expect(plan.targets.map((target) => target.systemName)).toEqual(
      expect.arrayContaining(["Data Catalog", "dbt Semantic Repository", "Governance Ticketing"])
    );
    expect(repository.listSourceSystemRecords()).toHaveLength(0);

    const run = engine.executeBusinessAction(executionFor(plan));

    expect(run.status).toBe("verified");
    expect(run.writes.length).toBeGreaterThan(0);
    expect(run.reflections.every((reflection) => reflection.status === "verified")).toBe(true);
    expect(run.semanticUpdates[0]?.chunkIds.length).toBeGreaterThan(0);
    expect(repository.listSourceSystemRecords().length).toBe(run.writes.length);
    expect(repository.listBusinessActionRuns()[0]?.id).toBe(run.id);
    expect(repository.status().sources).toBeGreaterThan(before.sources);

    const reflectedResults = engine.search({ query: "Business Action Reflection source systems Failed Payment Rate", topK: 5, mode: "hybrid" });
    expect(reflectedResults.some((result) => result.sourceName.includes("business-action-reflection"))).toBe(true);
  });

  it("holds higher-risk source writes for approval when autonomy policy is stricter", () => {
    const db = openMemoryDatabase();
    const { engine, repository } = createApp(db, { seed: true });

    const plan = engine.planBusinessAction({
      intent: "Make Billing Pipeline to Revenue Mart traceable end-to-end",
      mode: "autonomous",
      maxAutonomousRisk: "low"
    });
    const run = engine.executeBusinessAction(executionFor(plan));

    expect(run.status).toBe("approval_required");
    expect(run.plan.targets.some((target) => target.risk === "medium" && target.autonomy === "approval_required")).toBe(true);
    expect(run.writes).toHaveLength(0);
    expect(repository.listSourceSystemRecords()).toHaveLength(0);
  });

  it("mechanically gates actions on mapped asset sensitivity, freshness, and quality", () => {
    const reviewRuntime = createApp(openMemoryDatabase(), { seed: true });
    const reviewCatalog = reviewRuntime.repository.catalog();
    reviewRuntime.engine.importCatalog({
      ...reviewCatalog,
      assets: reviewCatalog.assets.map((asset) => ({ ...asset, freshness: "stale" as const, qualityScore: 0.1 }))
    });
    const reviewPlan = reviewRuntime.engine.planBusinessAction({
      intent: "Align Failed Payment Rate definition across Finance and Billing",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    expect(reviewPlan.status).toBe("approval_required");
    expect(reviewPlan.targets.every((target) => target.autonomy === "approval_required")).toBe(true);
    expect(reviewPlan.warnings.some((warning) => warning.includes("requires human review"))).toBe(true);
    expect(reviewRuntime.engine.executeBusinessAction(executionFor(reviewPlan)).writes).toHaveLength(0);

    const blockedRuntime = createApp(openMemoryDatabase(), { seed: true });
    const blockedCatalog = blockedRuntime.repository.catalog();
    blockedRuntime.engine.importCatalog({
      ...blockedCatalog,
      assets: blockedCatalog.assets.map((asset) => ({ ...asset, sensitivity: "restricted" as const }))
    });
    const blockedPlan = blockedRuntime.engine.planBusinessAction({
      intent: "Align Failed Payment Rate definition across Finance and Billing",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    expect(blockedPlan.status).toBe("blocked");
    expect(blockedPlan.targets).toHaveLength(0);
    expect(blockedPlan.warnings.some((warning) => warning.includes("not authorized"))).toBe(true);
  });

  it("separates human approval from execution and consumes an exact plan approval once", () => {
    const db = openMemoryDatabase();
    const { engine, repository } = createApp(db, { seed: true });
    const request = {
      intent: "Align Failed Payment Rate definition across Finance and Billing",
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

  it("rejects reuse of one consumed approval with a different execution key", () => {
    const { engine, repository } = createApp(openMemoryDatabase(), { seed: true });
    const stableEvidence = engine.search({ query: "Request owner review for Failed Payment Rate", topK: 5, mode: "hybrid" });
    vi.spyOn(engine, "search").mockReturnValue(stableEvidence);
    const request = {
      intent: "Request owner review for Failed Payment Rate",
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
    expect(() => engine.executeBusinessAction({ ...executionFor(plan, "second-approved"), approvalId: approval.id })).toThrow(/Approval is missing, consumed, or does not match/);
    expect(repository.listSourceSystemRecords()).toHaveLength(first.writes.length);
    vi.restoreAllMocks();
  });

  it("requires reconciliation and consumes approval when a source outcome is ambiguous", () => {
    const { engine, repository } = createApp(openMemoryDatabase(), { seed: true });
    const request = {
      intent: "Align Failed Payment Rate definition across Finance and Billing",
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
    let writes = 0;
    vi.spyOn(repository, "saveSourceSystemRecord").mockImplementation((record) => {
      writes += 1;
      if (writes === 2) throw new Error("injected source failure");
      return originalSave(record);
    });

    const run = engine.executeBusinessAction({ ...executionFor(plan, "rollback"), approvalId: approval.id });
    expect(run.status).toBe("reconciliation_required");
    expect(run.writes).toHaveLength(0);
    expect(repository.listSourceSystemRecords()).toHaveLength(0);
    expect(repository.getBusinessActionApproval(approval.id)?.status).toBe("consumed");
    expect(run.plan.warnings.join(" ")).toContain("Reconcile authoritative sources before retrying");
    expect(() => engine.executeBusinessAction({ ...executionFor(plan, "second-after-ambiguous"), approvalId: approval.id })).toThrow(
      /Approval is missing, consumed, or does not match/
    );
    vi.restoreAllMocks();
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

  it("does not publish drifted readback and replays duplicate execution idempotently", () => {
    const { engine, repository } = createApp(openMemoryDatabase(), { seed: true });
    const plan = engine.planBusinessAction({
      intent: "Align Failed Payment Rate definition across Finance and Billing",
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
    const secondPlan = engine.planBusinessAction({
      intent: "Make Billing Pipeline to Revenue Mart traceable end-to-end",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    const request = executionFor(secondPlan);
    const first = engine.executeBusinessAction(request);
    const replay = engine.executeBusinessAction(request);
    expect(replay.id).toBe(first.id);
    expect(repository.listSourceSystemRecords().every((record) => record.version === 1)).toBe(true);
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
