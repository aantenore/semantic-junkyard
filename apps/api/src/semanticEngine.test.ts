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
    expect(permissions.decision).toContain("read-only autonomous access");
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
});
