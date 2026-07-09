import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SearchResult } from "@semantic-junkyard/shared";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface McpPocStep {
  step: number;
  tool: string;
  observation: string;
}

interface McpPocReport {
  useCase: string;
  transport: "mcp-stdio";
  serverCommand: string;
  toolsAdvertised: string[];
  resourcesAdvertised: string[];
  promptsAdvertised: string[];
  question: string;
  steps: McpPocStep[];
  businessAction: {
    intent: string;
    status: string;
    writes: number;
    verifiedReflections: number;
  };
  finalAnswer: string;
  citations: Array<{ sourceName: string; chunkId: string; excerpt: string }>;
  promptPreview: string;
}

const question = "Which governed finance context should be used for failed payment analysis, and can the agent perform a reflected business writeback?";

export async function runMcpAgentUseCase(options: { writeReport?: boolean; outputPath?: string } = {}): Promise<McpPocReport> {
  const repoRoot = findRepoRoot();
  const server = resolveServerCommand(repoRoot);
  const client = new Client({ name: "semantic-junkyard-mcp-poc-agent", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: repoRoot,
    stderr: "pipe"
  });
  const steps: McpPocStep[] = [];

  await client.connect(transport);
  try {
    const [tools, resources, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listPrompts()]);
    const prompt = await client.getPrompt({ name: "governed_context_answer", arguments: { question } });
    const promptPreview = prompt.messages[0]?.content.type === "text" ? prompt.messages[0].content.text.slice(0, 260) : "";

    const permissions = await callStructured<{ decision: string }>(client, "explain_permissions", { intent: question });
    steps.push({ step: 1, tool: "explain_permissions", observation: permissions.decision });

    const search = await callStructured<{ results: SearchResult[] }>(client, "semantic_search", {
      query: "failed payment rate finance semantic contract billing pipeline revenue mart policy",
      topK: 5,
      mode: "hybrid"
    });
    steps.push({ step: 2, tool: "semantic_search", observation: `${search.results.length} candidates. Top source: ${search.results[0]?.sourceName ?? "none"}.` });

    const entities = await callStructured<{ entities: Array<{ id: string; canonicalName: string; degree: number }> }>(client, "entity_lookup", { name: "Billing Pipeline" });
    const primaryEntity = entities.entities[0];
    steps.push({ step: 3, tool: "entity_lookup", observation: primaryEntity ? `Resolved ${primaryEntity.canonicalName} with degree ${primaryEntity.degree}.` : "No Billing Pipeline entity resolved." });

    const neighbors = primaryEntity
      ? await callStructured<{ nodes: unknown[]; edges: unknown[] }>(client, "graph_neighbors", { entityId: primaryEntity.id, depth: 1 })
      : { nodes: [], edges: [] };
    steps.push({ step: 4, tool: "graph_neighbors", observation: `${neighbors.nodes.length} nodes and ${neighbors.edges.length} edges returned.` });

    const context = await callStructured<{
      evidence: Array<{ sourceName: string; chunkId: string; text: string }>;
      guidance: string;
    }>(client, "expand_context", {
      query: "Finance Semantic Contract Failed Payment Rate Billing Pipeline Revenue Mart",
      entityIds: primaryEntity ? [primaryEntity.id] : []
    });
    steps.push({ step: 5, tool: "expand_context", observation: `${context.evidence.length} evidence spans assembled. ${context.guidance}` });

    const openedEvidence = context.evidence[0]
      ? await callStructured<{ evidence: { sourceName: string; chunkId: string; text: string } }>(client, "get_evidence", { chunkId: context.evidence[0].chunkId })
      : null;
    if (openedEvidence) {
      steps.push({ step: 6, tool: "get_evidence", observation: `Opened ${openedEvidence.evidence.sourceName} / ${openedEvidence.evidence.chunkId}.` });
    }

    const businessIntent = "Align Failed Payment Rate definition across Finance and Billing, then reflect it in source systems.";
    const actionPlan = await callStructured<{ targets: Array<{ systemName: string }> }>(client, "business_action_plan", {
      intent: businessIntent,
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    steps.push({ step: steps.length + 1, tool: "business_action_plan", observation: `${actionPlan.targets.length} write targets planned: ${actionPlan.targets.map((target) => target.systemName).join(", ")}.` });

    const actionRun = await callStructured<{ status: string; writes: unknown[]; reflections: Array<{ status: string }> }>(client, "business_action_execute", {
      intent: businessIntent,
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    steps.push({ step: steps.length + 1, tool: "business_action_execute", observation: `${actionRun.writes.length} source writes executed; ${actionRun.reflections.filter((reflection) => reflection.status === "verified").length} reflected; status ${actionRun.status}.` });

    const citations = context.evidence.slice(0, 4).map((item) => ({
      sourceName: item.sourceName,
      chunkId: item.chunkId,
      excerpt: compact(item.text)
    }));

    const report: McpPocReport = {
      useCase: "MCP agent discovery over Semantic Junkyard governed finance context",
      transport: "mcp-stdio",
      serverCommand: formatServerCommand(repoRoot, server),
      toolsAdvertised: tools.tools.map((tool) => tool.name),
      resourcesAdvertised: resources.resources.map((resource) => resource.uri),
      promptsAdvertised: prompts.prompts.map((item) => item.name),
      question,
      steps,
      businessAction: {
        intent: businessIntent,
        status: actionRun.status,
        writes: actionRun.writes.length,
        verifiedReflections: actionRun.reflections.filter((reflection) => reflection.status === "verified").length
      },
      finalAnswer:
        "The MCP agent can answer this governed discovery question and execute a configured business writeback using Semantic Junkyard tools. The governed finance context is the Finance Semantic Contract with Billing Pipeline and Revenue Mart lineage, supported by cited evidence. The agent may search metadata, resolve entities, traverse bounded graph neighborhoods, expand context, open evidence, plan source writes, execute policy-governed low/medium-risk writebacks, and rely on the result only after source reflection verifies it. It must not execute generated SQL, expose secrets, bypass masking, mutate restricted production data, or perform destructive changes without approval.",
      citations,
      promptPreview
    };

    if (options.writeReport ?? true) {
      const outputPath = options.outputPath ?? path.join(repoRoot, "artifacts/poc/mcp-agent-use-case-report.json");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    return report;
  } finally {
    await client.close();
  }
}

async function callStructured<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if ("toolResult" in result) {
    return result.toolResult as T;
  }
  if ("structuredContent" in result && result.structuredContent) {
    return result.structuredContent as T;
  }
  return JSON.parse(textFromToolResult(result));
}

function textFromToolResult(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function resolveServerCommand(repoRoot: string): { command: string; args: string[] } {
  const distServer = path.join(repoRoot, "apps/mcp/dist/server.js");
  if (fs.existsSync(distServer)) {
    return { command: process.execPath, args: [distServer, "--memory"] };
  }
  const tsxCli = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
  return { command: process.execPath, args: [tsxCli, path.join(repoRoot, "apps/mcp/src/server.ts"), "--memory"] };
}

function formatServerCommand(repoRoot: string, server: { command: string; args: string[] }): string {
  const command = server.command === process.execPath ? "node" : server.command;
  const args = server.args.map((arg) => (arg.startsWith(repoRoot) ? path.relative(repoRoot, arg) : arg));
  return `${command} ${args.join(" ")}`;
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string };
      if (packageJson.name === "semantic-junkyard") return current;
    }
    current = path.dirname(current);
  }
  throw new Error("Could not locate Semantic Junkyard repository root.");
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const report = await runMcpAgentUseCase();
  console.log(JSON.stringify(report, null, 2));
}
