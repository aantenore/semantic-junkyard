import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./runtime.js";

describe("runtime configuration", () => {
  it("defaults to loopback without authentication", () => {
    const config = loadRuntimeConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.apiToken).toBeUndefined();
    expect(config.approvalToken).toBeUndefined();
  });

  it("requires distinct agent and approver credentials whenever token auth is enabled", () => {
    const agentToken = "a".repeat(32);
    const approvalToken = "b".repeat(32);

    expect(() => loadRuntimeConfig({ SEMANTIC_JUNKYARD_API_TOKEN: agentToken })).toThrow(/APPROVAL_TOKEN is required/);
    expect(() => loadRuntimeConfig({ SEMANTIC_JUNKYARD_APPROVAL_TOKEN: approvalToken })).toThrow(/API_TOKEN is required/);
    expect(() => loadRuntimeConfig({ SEMANTIC_JUNKYARD_API_TOKEN: agentToken, SEMANTIC_JUNKYARD_APPROVAL_TOKEN: agentToken })).toThrow(/must be different/);

    const config = loadRuntimeConfig({
      HOST: "0.0.0.0",
      SEMANTIC_JUNKYARD_API_TOKEN: agentToken,
      SEMANTIC_JUNKYARD_APPROVAL_TOKEN: approvalToken
    });
    expect(config.apiToken).toBe(agentToken);
    expect(config.approvalToken).toBe(approvalToken);

    const mcpConfig = loadRuntimeConfig({ SEMANTIC_JUNKYARD_API_TOKEN: agentToken }, { validateHttpSecurity: false });
    expect(mcpConfig.apiToken).toBe(agentToken);
    expect(mcpConfig.approvalToken).toBeUndefined();
  });
});
