import { describe, expect, it } from "vitest";
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

    const run = engine.executeBusinessAction({
      intent: "Align Failed Payment Rate definition across Finance and Billing, then reflect it in source systems.",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });

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

    const run = engine.executeBusinessAction({
      intent: "Make Billing Pipeline to Revenue Mart traceable end-to-end",
      mode: "autonomous",
      maxAutonomousRisk: "low"
    });

    expect(run.status).toBe("approval_required");
    expect(run.plan.targets.some((target) => target.risk === "medium" && target.autonomy === "approval_required")).toBe(true);
    expect(run.writes).toHaveLength(0);
    expect(repository.listSourceSystemRecords()).toHaveLength(0);
  });
});
