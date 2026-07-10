import type { SourceResource } from "@semantic-junkyard/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateWithLocalHuggingFace } = vi.hoisted(() => ({ generateWithLocalHuggingFace: vi.fn() }));
vi.mock("../poc/localHuggingFaceProvider.js", () => ({ generateWithLocalHuggingFace }));

import { interpretAgentIntent } from "./localIntentInterpreter.js";

describe("local intent interpreter", () => {
  beforeEach(() => generateWithLocalHuggingFace.mockReset());

  it("produces a deterministic bounded plan without invoking a model", async () => {
    const plan = await interpretAgentIntent(
      { message: "Set order ORD-1 status to dispatched", provider: "deterministic" },
      [resource]
    );
    expect(plan).toMatchObject({ provider: "deterministic", requestedAction: true, actionIntent: "Set order ORD-1 status to dispatched" });
    expect(generateWithLocalHuggingFace).not.toHaveBeenCalled();
  });

  it("uses local-model queries but does not let the model invent a mutation", async () => {
    generateWithLocalHuggingFace.mockResolvedValue({
      provider: "local-huggingface-mlx",
      model: { id: "mlx-community/Qwen3-1.7B-4bit" },
      text: JSON.stringify({
        objective: "Find dispatch policy evidence",
        resourceQuery: "dispatch eligible orders",
        searchQuery: "Late Dispatch Rate denominator",
        entityQuery: "orders",
        requestedAction: true,
        confidence: 0.88,
        summary: "I will inspect source evidence before answering.",
        warnings: []
      })
    });
    const plan = await interpretAgentIntent(
      { message: "Which denominator defines Late Dispatch Rate?", provider: "local-huggingface" },
      [resource]
    );
    expect(plan).toMatchObject({ provider: "local-huggingface-mlx", requestedAction: false, actionIntent: null });
    expect(plan.resourceQuery).toContain("Which denominator defines Late Dispatch Rate?");
    expect(plan.searchQuery).toContain("Which denominator defines Late Dispatch Rate?");
    expect(plan.summary).toContain("verify them against governed source evidence");
    expect(plan.warnings.join(" ")).toContain("forced read-only");
  });

  it("regrounds off-topic model queries in the original request and does not expose a factual model answer", async () => {
    generateWithLocalHuggingFace.mockResolvedValue({
      provider: "local-huggingface-mlx",
      model: { id: "mlx-community/Qwen3-1.7B-4bit" },
      text: JSON.stringify({
        objective: "Inspect supply-chain evidence",
        resourceQuery: "carrier service levels",
        searchQuery: "shipment route",
        entityQuery: null,
        requestedAction: false,
        confidence: 0.9,
        summary: "The YAML contract is authoritative.",
        warnings: []
      })
    });

    const plan = await interpretAgentIntent(
      { message: "Which denominator defines Late Dispatch Rate?", provider: "local-huggingface" },
      [resource]
    );

    expect(plan.resourceQuery).toContain("Which denominator defines Late Dispatch Rate?");
    expect(plan.searchQuery).toContain("Which denominator defines Late Dispatch Rate?");
    expect(plan.summary).not.toContain("YAML contract");
    expect(plan.warnings.join(" ")).toContain("did not overlap the original request");
  });

  it("fails closed when local model output is malformed", async () => {
    generateWithLocalHuggingFace.mockResolvedValue({
      provider: "local-huggingface-mlx",
      model: { id: "local-model" },
      text: "not-json"
    });
    await expect(
      interpretAgentIntent({ message: "Update something", provider: "local-huggingface" }, [resource])
    ).rejects.toThrow(/No tools or writes were executed/);
  });
});

const resource: SourceResource = {
  id: "resource.orders",
  connectionId: "connection.operations",
  externalId: "table:orders",
  parentId: null,
  kind: "table",
  name: "orders",
  qualifiedName: "Operations.orders",
  dataType: "sqlite-table",
  description: "Authoritative orders table",
  uri: "sqlite:///operations.sqlite#table=orders",
  sensitivity: "internal",
  writable: true,
  profile: {},
  evidenceChunkIds: [],
  metadata: {},
  observedAt: "2026-07-10T00:00:00.000Z"
};
