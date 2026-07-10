import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BusinessActionPlanSchema,
  BusinessActionRunSchema,
  EvidenceSpanSchema,
  GraphSnapshotSchema,
  SearchResultSchema
} from "@semantic-junkyard/shared";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const MCP_CALL_TIMEOUT_MS = 15_000;
const PermissionResultSchema = z.object({ decision: z.string() }).passthrough();
const SearchEnvelopeSchema = z.object({ results: z.array(SearchResultSchema) }).strict();
const EntityEnvelopeSchema = z.object({
  entities: z.array(z.object({ id: z.string(), canonicalName: z.string(), degree: z.number() }).passthrough())
}).strict();
const ContextEnvelopeSchema = z.object({
  evidence: z.array(EvidenceSpanSchema),
  guidance: z.string()
}).passthrough();

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
  overallStatus: "completed" | "blocked" | "failed";
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

  await withTimeout(client.connect(transport), "MCP connection");
  try {
    const [tools, resources, prompts] = await withTimeout(Promise.all([client.listTools(), client.listResources(), client.listPrompts()]), "MCP capability discovery");
    const prompt = await withTimeout(client.getPrompt({ name: "governed_context_answer", arguments: { question } }), "MCP prompt retrieval");
    const promptPreview = prompt.messages[0]?.content.type === "text" ? prompt.messages[0].content.text.slice(0, 260) : "";

    const permissions = await callStructured(client, "explain_permissions", { intent: question }, PermissionResultSchema);
    steps.push({ step: 1, tool: "explain_permissions", observation: permissions.decision });

    const search = await callStructured(client, "semantic_search", {
      query: "failed payment rate finance semantic contract billing pipeline revenue mart policy",
      topK: 5,
      mode: "hybrid"
    }, SearchEnvelopeSchema);
    steps.push({ step: 2, tool: "semantic_search", observation: `${search.results.length} candidates. Top source: ${search.results[0]?.sourceName ?? "none"}.` });

    const entities = await callStructured(client, "entity_lookup", { name: "Billing Pipeline" }, EntityEnvelopeSchema);
    const primaryEntity = entities.entities[0];
    steps.push({ step: 3, tool: "entity_lookup", observation: primaryEntity ? `Resolved ${primaryEntity.canonicalName} with degree ${primaryEntity.degree}.` : "No Billing Pipeline entity resolved." });

    const neighbors = primaryEntity
      ? await callStructured(client, "graph_neighbors", { entityId: primaryEntity.id, depth: 1 }, GraphSnapshotSchema)
      : { nodes: [], edges: [] };
    steps.push({ step: 4, tool: "graph_neighbors", observation: `${neighbors.nodes.length} nodes and ${neighbors.edges.length} edges returned.` });

    const context = await callStructured(client, "expand_context", {
      query: "Finance Semantic Contract Failed Payment Rate Billing Pipeline Revenue Mart",
      entityIds: primaryEntity ? [primaryEntity.id] : []
    }, ContextEnvelopeSchema);
    steps.push({ step: 5, tool: "expand_context", observation: `${context.evidence.length} evidence spans assembled. ${context.guidance}` });

    const openedEvidence = context.evidence[0]
      ? await callStructured(client, "get_evidence", { chunkId: context.evidence[0].chunkId }, z.object({ evidence: EvidenceSpanSchema }).strict())
      : null;
    if (openedEvidence) {
      steps.push({ step: 6, tool: "get_evidence", observation: `Opened ${openedEvidence.evidence.sourceName} / ${openedEvidence.evidence.chunkId}.` });
    }

    const businessIntent = "Align Failed Payment Rate definition across Finance and Billing, then reflect it in source systems.";
    const actionPlan = await callStructured(client, "business_action_plan", {
      intent: businessIntent,
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    }, BusinessActionPlanSchema);
    steps.push({ step: steps.length + 1, tool: "business_action_plan", observation: `${actionPlan.targets.length} write targets planned: ${actionPlan.targets.map((target) => target.systemName).join(", ")}.` });

    const actionRun = await callStructured(client, "business_action_execute", {
      planId: actionPlan.id,
      planFingerprint: actionPlan.fingerprint,
      intent: actionPlan.intent,
      mode: actionPlan.mode,
      maxAutonomousRisk: actionPlan.maxAutonomousRisk,
      idempotencyKey: `${actionPlan.id}-mcp-poc`
    }, BusinessActionRunSchema);
    steps.push({ step: steps.length + 1, tool: "business_action_execute", observation: `${actionRun.writes.length} source writes executed; ${actionRun.reflections.filter((reflection) => reflection.status === "verified").length} reflected; status ${actionRun.status}.` });

    const citations = context.evidence.slice(0, 4).map((item) => ({
      sourceName: item.sourceName,
      chunkId: item.chunkId,
      excerpt: compact(item.text)
    }));

    const writebackVerified = actionRun.status === "verified" && actionRun.writes.length > 0 && actionRun.reflections.every((reflection) => reflection.status === "verified");
    const overallStatus: McpPocReport["overallStatus"] = actionRun.status === "blocked" || actionRun.status === "approval_required" ? "blocked" : writebackVerified ? "completed" : "failed";
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
      overallStatus,
      finalAnswer: writebackVerified
        ? "The MCP client found governed finance evidence and completed the configured business writeback with verified source reflection. The governed context is the Finance Semantic Contract with Billing Pipeline and Revenue Mart lineage."
        : `The MCP client found governed finance evidence, but no completed writeback can be claimed because the product returned ${actionRun.status}.`,
      citations,
      promptPreview
    };

    if (options.writeReport ?? false) {
      const outputPath = options.outputPath ?? path.join(repoRoot, "artifacts/poc/mcp-agent-use-case-report.json");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    return report;
  } finally {
    await client.close();
  }
}

async function callStructured<T>(client: Client, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await withTimeout(client.callTool({ name, arguments: args }), `MCP tool ${name}`);
  let value: unknown;
  if ("toolResult" in result) {
    value = result.toolResult;
  } else if ("structuredContent" in result && result.structuredContent) {
    value = result.structuredContent;
  } else {
    value = JSON.parse(textFromToolResult(result));
  }
  return schema.parse(value);
}

function textFromToolResult(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function resolveServerCommand(repoRoot: string): { command: string; args: string[] } {
  const tsxCli = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
  return { command: process.execPath, args: [tsxCli, path.join(repoRoot, "apps/mcp/src/server.ts"), "--memory"] };
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${MCP_CALL_TIMEOUT_MS}ms.`)), MCP_CALL_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  const report = await runMcpAgentUseCase({ writeReport: process.argv.includes("--write-report") });
  console.log(JSON.stringify(report, null, 2));
}
