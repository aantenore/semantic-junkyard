import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSemanticRuntime, openMemoryDatabase } from "@semantic-junkyard/api";
import { describe, expect, it } from "vitest";
import { createSemanticJunkyardMcpServer } from "./mcpServer.js";

describe("Semantic Junkyard MCP server", () => {
  it("exposes agent tools, resources, and prompts over MCP", async () => {
    const runtime = createSemanticRuntime(openMemoryDatabase(), { seed: true });
    const server = createSemanticJunkyardMcpServer(runtime);
    const client = new Client({ name: "semantic-junkyard-mcp-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["semantic_search", "entity_lookup", "expand_context", "get_evidence", "run_discovery"])
      );

      const search = await client.callTool({
        name: "semantic_search",
        arguments: { query: "failed payment semantic contract", topK: 3, mode: "hybrid" }
      });
      const searchContent = search.structuredContent as { results: Array<{ chunkId: string; sourceName: string }> };
      expect(searchContent.results.length).toBeGreaterThan(0);
      expect(searchContent.results[0]?.sourceName).toBeTruthy();

      const manifest = await client.readResource({ uri: "semantic-junkyard://manifest" });
      const manifestContent = manifest.contents[0];
      expect(manifestContent && "text" in manifestContent ? manifestContent.text : "").toContain("Semantic Junkyard Agent Access Layer");

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
});
