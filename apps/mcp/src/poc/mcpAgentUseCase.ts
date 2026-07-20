import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BusinessActionPlanSchema,
  BusinessActionRunSchema,
  EvidenceSpanSchema,
  GovernedSourceResourceSchema,
  GraphSnapshotSchema,
  SearchResultSchema,
  SEMANTIC_JUNKYARD_VERSION
} from "@semantic-junkyard/shared";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const MCP_CALL_TIMEOUT_MS = 15_000;
const PermissionResultSchema = z.object({ decision: z.string() }).passthrough();
const SearchEnvelopeSchema = z.object({ results: z.array(SearchResultSchema) }).strict();
const EntityEnvelopeSchema = z.object({
  entities: z.array(z.object({ id: z.string(), canonicalName: z.string(), type: z.string(), degree: z.number() }).passthrough())
}).strict();
const ContextEnvelopeSchema = z.object({
  evidence: z.array(EvidenceSpanSchema),
  guidance: z.string()
}).passthrough();
const ResourceEnvelopeSchema = z.object({ resources: z.array(GovernedSourceResourceSchema) }).strict();

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
    mutations: number;
    verifiedNoOps: number;
    verifiedReflections: number;
  };
  overallStatus: "completed" | "blocked" | "failed";
  finalAnswer: string;
  citations: Array<{ sourceName: string; chunkId: string; excerpt: string }>;
  promptPreview: string;
}

const question = "Which governed source defines dispatch eligibility, and can the agent update order ORD-1001 through verified source writeback?";

export async function runMcpAgentUseCase(options: { writeReport?: boolean; outputPath?: string } = {}): Promise<McpPocReport> {
  const repoRoot = findRepoRoot();
  const server = resolveServerCommand(repoRoot);
  const client = new Client({ name: "semantic-junkyard-mcp-poc-agent", version: SEMANTIC_JUNKYARD_VERSION });
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

    const sourceResources = await callStructured(client, "source_resource_search", {
      query: "ORD-1001 orders dispatch_eligible status Operations Database",
      topK: 8,
      kinds: ["table", "column", "document", "metric", "semantic_contract"]
    }, ResourceEnvelopeSchema);
    const actionResources = sourceResources.resources.filter((resource) => /orders|dispatch_eligible|status/i.test(`${resource.name} ${resource.qualifiedName} ${resource.description}`));
    const groundedChunkIds = [...new Set(actionResources.flatMap((resource) => resource.evidenceChunkIds))];
    if (groundedChunkIds.length === 0) throw new Error("No source-linked evidence chunks were resolved for the operations action.");
    steps.push({ step: 2, tool: "source_resource_search", observation: `${sourceResources.resources.length} governed resources matched; ${actionResources.length} directly grounded ${groundedChunkIds.length} evidence chunks.` });

    const search = await callStructured(client, "semantic_search", {
      query: "ORD-1001 orders dispatch_eligible status Operations Database",
      topK: 5,
      mode: "hybrid"
    }, SearchEnvelopeSchema);
    steps.push({ step: 3, tool: "semantic_search", observation: `${search.results.length} candidates. Top source: ${search.results[0]?.sourceName ?? "none"}.` });

    const entities = await callStructured(client, "entity_lookup", { name: "orders" }, EntityEnvelopeSchema);
    const primaryEntity = entities.entities[0];
    steps.push({ step: 4, tool: "entity_lookup", observation: primaryEntity ? `Resolved ${primaryEntity.canonicalName} with degree ${primaryEntity.degree}.` : "No operations table entity resolved." });

    const neighbors = primaryEntity
      ? await callStructured(client, "graph_neighbors", { entityId: primaryEntity.id, depth: 1 }, GraphSnapshotSchema)
      : { nodes: [], edges: [] };
    steps.push({ step: 5, tool: "graph_neighbors", observation: `${neighbors.nodes.length} nodes and ${neighbors.edges.length} edges returned.` });

    const context = await callStructured(client, "expand_context", {
      query: "ORD-1001 orders dispatch_eligible status Operations Database",
      chunkIds: groundedChunkIds,
      entityIds: primaryEntity ? [primaryEntity.id] : []
    }, ContextEnvelopeSchema);
    steps.push({ step: 6, tool: "expand_context", observation: `${context.evidence.length} evidence spans assembled. ${context.guidance}` });

    const openedEvidence = context.evidence[0]
      ? await callStructured(client, "get_evidence", { chunkId: context.evidence[0].chunkId }, z.object({ evidence: EvidenceSpanSchema }).strict())
      : null;
    if (openedEvidence) {
      steps.push({ step: steps.length + 1, tool: "get_evidence", observation: `Opened ${openedEvidence.evidence.sourceName} / ${openedEvidence.evidence.chunkId}.` });
    }

    const businessIntent = "Set order ORD-1001 status to dispatched";
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
      idempotencyKey: `${actionPlan.id}-${actionPlan.fingerprint.slice(0, 16)}-mcp-poc`
    }, BusinessActionRunSchema);
    steps.push({
      step: steps.length + 1,
      tool: "business_action_execute",
      observation: `${actionRun.writes.filter((write) => write.status === "executed").length} source mutations and ${actionRun.writes.filter((write) => write.status === "skipped").length} verified no-ops; ${actionRun.reflections.filter((reflection) => reflection.status === "verified").length} reflected; status ${actionRun.status}.`
    });

    const groundedChunkSet = new Set(groundedChunkIds);
    const citations = context.evidence.filter((item) => groundedChunkSet.has(item.chunkId)).slice(0, 4).map((item) => ({
      sourceName: item.sourceName,
      chunkId: item.chunkId,
      excerpt: compact(item.text)
    }));

    const writebackVerified = actionRun.status === "verified" && actionRun.writes.length > 0 && actionRun.reflections.every((reflection) => reflection.status === "verified");
    const evidenceVerified = citations.length > 0;
    const mutations = actionRun.writes.filter((write) => write.status === "executed").length;
    const verifiedNoOps = actionRun.writes.filter((write) => write.status === "skipped").length;
    const overallStatus: McpPocReport["overallStatus"] =
      actionRun.status === "blocked" || actionRun.status === "approval_required" || actionRun.status === "reconciliation_required"
        ? "blocked"
        : writebackVerified && evidenceVerified
          ? "completed"
          : "failed";
    const report: McpPocReport = {
      useCase: "MCP agent discovery and verified writeback over real supply-chain sources",
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
        mutations,
        verifiedNoOps,
        verifiedReflections: actionRun.reflections.filter((reflection) => reflection.status === "verified").length
      },
      overallStatus,
      finalAnswer: writebackVerified && evidenceVerified
        ? mutations > 0
          ? "The MCP client grounded the request in the real operations SQLite source and supply-chain semantic evidence, updated ORD-1001, reread the authoritative row, and refreshed the semantic read model only after the postcondition passed."
          : "The MCP client grounded the request in the real operations SQLite source and supply-chain semantic evidence, found ORD-1001 already dispatched, verified that no source mutation was needed, and refreshed the semantic read model only after authoritative readback passed."
        : `The MCP client cannot claim end-to-end completion: action status ${actionRun.status}, grounded citations ${citations.length}.`,
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
  return {
    command: process.execPath,
    args: [tsxCli, path.join(repoRoot, "apps/mcp/src/server.ts"), "--db", "semantic-junkyard.sqlite", "--allow-write"]
  };
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
