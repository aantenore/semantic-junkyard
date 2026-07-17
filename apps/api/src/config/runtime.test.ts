import { describe, expect, it } from "vitest";
import { DEFAULT_HTML_TEXT_LIMITS } from "../core/text.js";
import { loadRuntimeConfig } from "./runtime.js";

describe("runtime configuration", () => {
  it("defaults to loopback without authentication", () => {
    const config = loadRuntimeConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.bootstrapReferenceSources).toBe(true);
    expect(config.htmlTextLimits).toEqual(DEFAULT_HTML_TEXT_LIMITS);
    expect(config.apiToken).toBeUndefined();
    expect(config.approvalToken).toBeUndefined();
  });

  it("accepts only bounded HTML parser limits", () => {
    const config = loadRuntimeConfig({
      SEMANTIC_JUNKYARD_HTML_MAX_INPUT_LENGTH: "1000000",
      SEMANTIC_JUNKYARD_HTML_MAX_DEPTH: "64",
      SEMANTIC_JUNKYARD_HTML_MAX_CHILD_NODES: "5000"
    });

    expect(config.htmlTextLimits).toEqual({ maxInputLength: 1_000_000, maxDepth: 64, maxChildNodes: 5_000 });
    expect(() => loadRuntimeConfig({ SEMANTIC_JUNKYARD_HTML_MAX_DEPTH: "513" })).toThrow();
    expect(() => loadRuntimeConfig({ SEMANTIC_JUNKYARD_HTML_MAX_CHILD_NODES: "50001" })).toThrow();
  });

  it("requires distinct agent and approver credentials whenever token auth is enabled", () => {
    const agentToken = "a".repeat(32);
    const approvalToken = "b".repeat(32);

    const operatorToken = "c".repeat(32);
    expect(() => loadRuntimeConfig({ SEMANTIC_JUNKYARD_API_TOKEN: agentToken })).toThrow(/all required/);
    expect(() => loadRuntimeConfig({ SEMANTIC_JUNKYARD_APPROVAL_TOKEN: approvalToken })).toThrow(/all required/);
    expect(() => loadRuntimeConfig({
      SEMANTIC_JUNKYARD_API_TOKEN: agentToken,
      SEMANTIC_JUNKYARD_OPERATOR_TOKEN: agentToken,
      SEMANTIC_JUNKYARD_APPROVAL_TOKEN: approvalToken
    })).toThrow(/must be different/);

    const config = loadRuntimeConfig({
      HOST: "0.0.0.0",
      SEMANTIC_JUNKYARD_API_TOKEN: agentToken,
      SEMANTIC_JUNKYARD_OPERATOR_TOKEN: operatorToken,
      SEMANTIC_JUNKYARD_APPROVAL_TOKEN: approvalToken
    });
    expect(config.apiToken).toBe(agentToken);
    expect(config.operatorToken).toBe(operatorToken);
    expect(config.approvalToken).toBe(approvalToken);

    const mcpConfig = loadRuntimeConfig({ SEMANTIC_JUNKYARD_API_TOKEN: agentToken }, { validateHttpSecurity: false });
    expect(mcpConfig.apiToken).toBe(agentToken);
    expect(mcpConfig.approvalToken).toBeUndefined();
  });
});
