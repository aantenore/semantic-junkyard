import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSemanticRuntime, openMemoryDatabase } from "@semantic-junkyard/api";
import { describe, expect, it } from "vitest";
import { createSemanticJunkyardMcpServer } from "./mcpServer.js";

describe("Semantic Junkyard MCP server", () => {
  it("exposes agent tools, resources, and prompts over MCP", async () => {
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: true });
    runtime.repository.upsertCatalog({
      assets: [{
        id: "asset.restricted.mcp-test",
        kind: "dataset",
        name: "MCP_RESTRICTED_SENTINEL",
        domain: "Security",
        owner: "Security",
        description: "Must not be exposed to a confidential-clearance MCP actor.",
        sensitivity: "restricted",
        freshness: "fresh",
        qualityScore: 1,
        metadata: {}
      }],
      metrics: [],
      policies: [],
      lineage: [],
      contracts: [],
      ontologyClasses: []
    });
    const server = createSemanticJunkyardMcpServer(runtime, {
      allowDiscoveryRuns: true,
      allowSourceSync: true,
      allowBusinessWrites: true
    });
    const client = new Client({ name: "semantic-junkyard-mcp-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["semantic_search", "entity_lookup", "expand_context", "get_evidence", "run_discovery", "business_action_plan", "business_action_execute"])
      );
      const searchDescriptor = tools.tools.find((tool) => tool.name === "semantic_search");
      expect(searchDescriptor?.inputSchema.additionalProperties).toBe(false);
      const discoveryDescriptor = tools.tools.find((tool) => tool.name === "run_discovery");
      expect(discoveryDescriptor?.annotations?.readOnlyHint).toBe(false);
      expect(discoveryDescriptor?.annotations?.idempotentHint).toBe(false);

      let unknownArgumentRejected = false;
      try {
        const invalid = await client.callTool({
          name: "semantic_search",
          arguments: { query: "failed payment", topK: 3, mode: "hybrid", discloseEverything: true }
        });
        unknownArgumentRejected = invalid.isError === true;
      } catch {
        unknownArgumentRejected = true;
      }
      expect(unknownArgumentRejected).toBe(true);

      const search = await client.callTool({
        name: "semantic_search",
        arguments: { query: "failed payment semantic contract", topK: 3, mode: "hybrid" }
      });
      const searchContent = search.structuredContent as { results: Array<{ chunkId: string; sourceName: string }> };
      expect(searchContent.results.length).toBeGreaterThan(0);
      expect(searchContent.results[0]?.sourceName).toBeTruthy();

      const resourceSearch = await client.callTool({
        name: "source_resource_search",
        arguments: { query: "failed payment", topK: 3, kinds: [] }
      });
      const resourceSearchContent = resourceSearch.structuredContent as { resources: Array<{ governance: { decision: string } }> };
      expect(resourceSearchContent.resources.every((resource) => resource.governance.decision !== "deny")).toBe(true);

      const plan = await client.callTool({
        name: "business_action_plan",
        arguments: { intent: "Align Failed Payment Rate definition across Finance and Billing", mode: "autonomous", maxAutonomousRisk: "medium" }
      });
      const planContent = plan.structuredContent as {
        id: string;
        fingerprint: string;
        intent: string;
        mode: "autonomous";
        maxAutonomousRisk: "medium";
        targets: Array<{ systemName: string }>;
      };
      expect(planContent.targets.map((target) => target.systemName)).toContain("Data Catalog");

      const run = await client.callTool({
        name: "business_action_execute",
        arguments: {
          planId: planContent.id,
          planFingerprint: planContent.fingerprint,
          intent: planContent.intent,
          mode: planContent.mode,
          maxAutonomousRisk: planContent.maxAutonomousRisk,
          idempotencyKey: `${planContent.id}-mcp-test`
        }
      });
      const runContent = run.structuredContent as { status: string; reflections: Array<{ status: string }> };
      expect(runContent.status).toBe("verified");
      expect(runContent.reflections.every((reflection) => reflection.status === "verified")).toBe(true);

      const sensitiveIntent = "Align Failed Payment Rate customer_id definition across Finance and Billing";
      const sensitivePlan = await client.callTool({
        name: "business_action_plan",
        arguments: { intent: sensitiveIntent, mode: "autonomous", maxAutonomousRisk: "medium" }
      });
      const sensitivePlanContent = sensitivePlan.structuredContent as typeof planContent;
      await client.callTool({
        name: "business_action_execute",
        arguments: {
          planId: sensitivePlanContent.id,
          planFingerprint: sensitivePlanContent.fingerprint,
          intent: sensitiveIntent,
          mode: sensitivePlanContent.mode,
          maxAutonomousRisk: sensitivePlanContent.maxAutonomousRisk,
          idempotencyKey: `${sensitivePlanContent.id}-redaction`
        }
      });
      const sourceSystems = await client.readResource({ uri: "semantic-junkyard://source-systems" });
      const sourceSystemsText = sourceSystems.contents[0] && "text" in sourceSystems.contents[0] ? sourceSystems.contents[0].text : "";
      expect(sourceSystemsText).not.toContain("customer_id");
      expect(sourceSystemsText).toContain("[masked]");

      const manifest = await client.readResource({ uri: "semantic-junkyard://manifest" });
      const manifestContent = manifest.contents[0];
      expect(manifestContent && "text" in manifestContent ? manifestContent.text : "").toContain("Semantic Junkyard Agent Access Layer");

      const catalog = await client.readResource({ uri: "semantic-junkyard://catalog" });
      const catalogText = catalog.contents[0] && "text" in catalog.contents[0] ? catalog.contents[0].text : "{}";
      const catalogContent = JSON.parse(catalogText) as { counts: { assets: number }; truncated: boolean; catalog: { assets: unknown[] } };
      expect(catalogContent.counts.assets).toBeGreaterThan(0);
      expect(catalogContent.catalog.assets.length).toBeLessThanOrEqual(500);
      expect(catalogContent.truncated).toBe(false);
      expect(catalogText).not.toContain("MCP_RESTRICTED_SENTINEL");

      const graph = await client.readResource({ uri: "semantic-junkyard://graph" });
      const graphText = graph.contents[0] && "text" in graph.contents[0] ? graph.contents[0].text : "{}";
      expect(graphText).not.toContain("MCP_RESTRICTED_SENTINEL");

      const prompt = await client.getPrompt({
        name: "governed_context_answer",
        arguments: { question: "Which governed context should be used for failed payment analysis?" }
      });
      expect(prompt.messages[0]?.content.type).toBe("text");
      expect(prompt.messages[0]?.content.type === "text" ? prompt.messages[0].content.text : "").toContain("explain_permissions");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("applies the server autonomous-risk ceiling inside MCP", async () => {
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: true, maxAutonomousRisk: "low" });
    const server = createSemanticJunkyardMcpServer(runtime);
    const client = new Client({ name: "semantic-junkyard-risk-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const plan = await client.callTool({
        name: "business_action_plan",
        arguments: {
          intent: "Make Billing Pipeline to Revenue Mart traceable end-to-end",
          mode: "autonomous",
          maxAutonomousRisk: "medium"
        }
      });
      const content = plan.structuredContent as { status: string; targets: Array<{ risk: string; autonomy: string }> };
      expect(content.status).toBe("approval_required");
      expect(content.targets.some((target) => target.risk === "medium" && target.autonomy === "approval_required")).toBe(true);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["run_discovery", "sync_source", "business_action_execute"])
      );
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["semantic_search", "business_action_plan"]));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
