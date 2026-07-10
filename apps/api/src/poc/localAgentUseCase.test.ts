import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLocalAgentUseCase } from "./localAgentUseCase.js";

describe("local autonomous agent PoC", () => {
  it("runs an evidence-backed agent loop and writes a reproducible report", async () => {
    const outputPath = path.join(os.tmpdir(), `semantic-junkyard-poc-${Date.now()}.json`);
    const temporaryRoot = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "semantic-junkyard-tests");
    const report = await runLocalAgentUseCase({ writeReport: true, outputPath, temporaryRoot });
    const saved = JSON.parse(fs.readFileSync(outputPath, "utf8")) as typeof report;

    expect(report.provider).toBe("deterministic-local-agent-loop");
    expect(report.model).toBe("deterministic-rules");
    expect(report.autonomyDecision).toContain("business-action planning");
    expect(report.steps.map((step) => step.tool)).toEqual([
      "explain_permissions",
      "semantic_search",
      "entity_lookup",
      "graph_neighbors",
      "expand_context",
      "business_action_plan",
      "business_action_execute",
      "semantic_search"
    ]);
    expect(report.businessAction.status).toBe("verified");
    expect(report.businessAction.writes).toBeGreaterThan(0);
    expect(report.businessAction.verifiedReflections).toBe(report.businessAction.writes);
    expect(report.citations.length).toBeGreaterThan(0);
    expect(report.finalAnswer).toMatch(/Operations Database orders table/);
    expect(report.finalAnswer).toMatch(/ORD-1001/);
    expect(report.finalAnswer).toMatch(/source writeback gateway/);
    expect(report.modelReasoningSummary).toContain("Deterministic planner");
    expect(report.overallStatus).toBe("completed");
    expect(report.stopConditionsChecked.length).toBeGreaterThan(0);
    expect(report.stopConditionEvaluations).toHaveLength(report.stopConditionsChecked.length);
    expect(report.stopConditionEvaluations.some((evaluation) => evaluation.status === "passed")).toBe(true);
    expect(saved.useCase).toBe(report.useCase);
    expect(saved.steps.length).toBe(8);
    expect(saved.businessAction.status).toBe("verified");
    expect(saved.citations[0]?.chunkId).toBeTruthy();
  }, 90_000);
});
