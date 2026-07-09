import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLocalAgentUseCase } from "./localAgentUseCase.js";

describe("local autonomous agent PoC", () => {
  it("runs an evidence-backed agent loop over the semantic layer", async () => {
    const report = await runLocalAgentUseCase();

    expect(report.provider).toBe("deterministic-local-agent-loop");
    expect(report.autonomyDecision).toContain("read-only autonomous access");
    expect(report.steps.map((step) => step.tool)).toEqual([
      "explain_permissions",
      "semantic_search",
      "entity_lookup",
      "graph_neighbors",
      "expand_context"
    ]);
    expect(report.citations.length).toBeGreaterThan(0);
    expect(report.finalAnswer).toMatch(/Finance Semantic Contract/);
    expect(report.finalAnswer).toMatch(/may not mutate source systems/);
    expect(report.stopConditionsChecked.length).toBeGreaterThan(0);
  });

  it("writes a reproducible PoC report", async () => {
    const outputPath = path.join(os.tmpdir(), `semantic-junkyard-poc-${Date.now()}.json`);
    const report = await runLocalAgentUseCase({ writeReport: true, outputPath });
    const saved = JSON.parse(fs.readFileSync(outputPath, "utf8")) as typeof report;

    expect(saved.useCase).toBe(report.useCase);
    expect(saved.steps.length).toBe(5);
    expect(saved.citations[0]?.chunkId).toBeTruthy();
  });
});
