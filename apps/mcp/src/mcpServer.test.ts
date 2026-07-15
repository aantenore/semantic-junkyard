import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSemanticRuntime, openMemoryDatabase } from "@semantic-junkyard/api";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSemanticJunkyardMcpServer } from "./mcpServer.js";

describe("Semantic Junkyard MCP server", () => {
  it("exposes agent tools, resources, and prompts over MCP", async () => {
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: true });
    const missionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-mcp-mission-"));
    fs.writeFileSync(path.join(missionRoot, "metric.md"), "Late Dispatch Rate uses dispatch eligible orders as its denominator.");
    const missionConnection = runtime.engine.createSourceConnection({
      name: "MCP mission source",
      description: "Temporary MCP source",
      config: { kind: "filesystem", rootPath: missionRoot }
    });
    const actionDatabasePath = path.join(missionRoot, "operations.sqlite");
    const actionDatabase = new Database(actionDatabasePath);
    actionDatabase.exec("CREATE TABLE orders (order_id TEXT PRIMARY KEY, dispatch_eligible INTEGER NOT NULL, status TEXT NOT NULL)");
    actionDatabase.prepare("INSERT INTO orders VALUES (?, ?, ?)").run("ORD-MCP", 1, "ready");
    actionDatabase.close();
    const actionConnection = runtime.engine.createSourceConnection({
      name: "MCP Operations",
      description: "Authoritative MCP writeback source",
      config: {
        kind: "sqlite",
        databasePath: actionDatabasePath,
        includeTables: ["orders"],
        sampleRows: 1,
        writeMode: "autonomous",
        writeRules: [{ table: "orders", aliases: ["order"], keyColumn: "order_id", allowedColumns: ["status"], risk: "low" }]
      }
    });
    await runtime.engine.syncSourceConnection(actionConnection.id, {
      objective: "Discover order dispatch eligibility and safe status actions.",
      provider: "deterministic"
    });
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
        expect.arrayContaining(["semantic_search", "entity_lookup", "expand_context", "get_evidence", "run_discovery", "discover_sources", "business_action_plan", "business_action_execute"])
      );
      const searchDescriptor = tools.tools.find((tool) => tool.name === "semantic_search");
      expect(searchDescriptor?.inputSchema.additionalProperties).toBe(false);
      const discoveryDescriptor = tools.tools.find((tool) => tool.name === "run_discovery");
      expect(discoveryDescriptor?.annotations?.readOnlyHint).toBe(false);
      expect(discoveryDescriptor?.annotations?.idempotentHint).toBe(false);

      const sourceMission = await client.callTool({
        name: "discover_sources",
        arguments: {
          objective: "Discover the Late Dispatch Rate denominator.",
          provider: "deterministic",
          connectionIds: [missionConnection.id],
          continueOnError: true
        }
      });
      const sourceMissionContent = sourceMission.structuredContent as { status: string; summary: { completedSyncs: number; resourcesDiscovered: number } };
      expect(sourceMissionContent.status).toBe("completed");
      expect(sourceMissionContent.summary.completedSyncs).toBe(1);
      expect(sourceMissionContent.summary.resourcesDiscovered).toBeGreaterThan(0);

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
        arguments: { query: "orders status", topK: 3, kinds: [] }
      });
      const resourceSearchContent = resourceSearch.structuredContent as { resources: Array<{ governance: { decision: string } }> };
      expect(resourceSearchContent.resources.every((resource) => resource.governance.decision !== "deny")).toBe(true);

      const plan = await client.callTool({
        name: "business_action_plan",
        arguments: { intent: "Set order ORD-MCP status to dispatched", mode: "autonomous", maxAutonomousRisk: "medium" }
      });
      const planContent = plan.structuredContent as {
        id: string;
        fingerprint: string;
        intent: string;
        mode: "autonomous";
        maxAutonomousRisk: "medium";
        targets: Array<{ systemName: string }>;
        principal: { actor: string };
      };
      expect(planContent.targets.map((target) => target.systemName)).toEqual(["MCP Operations"]);
      expect(planContent.principal.actor).toBe("mcp-agent");

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

      const domainEvidence = await client.callTool({
        name: "semantic_search",
        arguments: { query: "Business Action Reflection ORD-MCP dispatched", topK: 5, mode: "hybrid" }
      });
      const domainEvidenceContent = domainEvidence.structuredContent as { results: Array<{ sourceName: string; evidenceClass: string }> };
      expect(domainEvidenceContent.results.every((result) => result.evidenceClass === "domain")).toBe(true);
      expect(domainEvidenceContent.results.some((result) => result.sourceName.includes("business-action-reflection"))).toBe(false);

      const operationalEvidence = await client.callTool({
        name: "semantic_search",
        arguments: { query: "Business Action Reflection ORD-MCP dispatched", topK: 5, mode: "hybrid", scope: "operational" }
      });
      const operationalEvidenceContent = operationalEvidence.structuredContent as { results: Array<{ sourceName: string; evidenceClass: string }> };
      expect(operationalEvidenceContent.results.some((result) => result.sourceName.includes("business-action-reflection"))).toBe(true);
      expect(operationalEvidenceContent.results.every((result) => result.evidenceClass === "operational")).toBe(true);

      const sourceSystems = await client.readResource({ uri: "semantic-junkyard://source-systems" });
      const sourceSystemsText = sourceSystems.contents[0] && "text" in sourceSystems.contents[0] ? sourceSystems.contents[0].text : "";
      expect(sourceSystemsText).not.toContain(actionDatabasePath);
      expect(sourceSystemsText).toContain("ORD-MCP");

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
      fs.rmSync(missionRoot, { recursive: true, force: true });
    }
  });

  it("applies the server autonomous-risk ceiling inside MCP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-mcp-risk-"));
    const databasePath = path.join(root, "operations.sqlite");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE orders (order_id TEXT PRIMARY KEY, dispatch_eligible INTEGER NOT NULL, status TEXT NOT NULL)");
    database.prepare("INSERT INTO orders VALUES (?, ?, ?)").run("ORD-RISK", 1, "ready");
    database.close();
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: false, maxAutonomousRisk: "low" });
    const connection = runtime.engine.createSourceConnection({
      name: "MCP Risk Operations",
      description: "Medium-risk MCP planning fixture",
      config: {
        kind: "sqlite",
        databasePath,
        includeTables: ["orders"],
        sampleRows: 1,
        writeMode: "autonomous",
        writeRules: [{ table: "orders", aliases: ["order"], keyColumn: "order_id", allowedColumns: ["status"], risk: "medium" }]
      }
    });
    await runtime.engine.syncSourceConnection(connection.id, {
      objective: "Discover medium-risk order status actions.",
      provider: "deterministic"
    });
    const server = createSemanticJunkyardMcpServer(runtime);
    const client = new Client({ name: "semantic-junkyard-risk-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const plan = await client.callTool({
        name: "business_action_plan",
        arguments: {
          intent: "Set order ORD-RISK status to dispatched",
          mode: "autonomous",
          maxAutonomousRisk: "medium"
        }
      });
      const content = plan.structuredContent as { status: string; targets: Array<{ risk: string; autonomy: string }> };
      expect(content.status).toBe("approval_required");
      expect(content.targets.some((target) => target.risk === "medium" && target.autonomy === "approval_required")).toBe(true);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["run_discovery", "discover_sources", "sync_source", "business_action_execute"])
      );
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["semantic_search", "business_action_plan"]));
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
