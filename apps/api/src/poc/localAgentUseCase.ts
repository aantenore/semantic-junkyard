import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { openMemoryDatabase } from "../storage/database.js";
import { generateWithLocalHuggingFace, pickDefaultLocalModel } from "./localHuggingFaceProvider.js";

export interface PocAgentStep {
  step: number;
  tool: string;
  rationale: string;
  observation: string;
}

export interface PocAgentReport {
  useCase: string;
  question: string;
  provider: string;
  model: string;
  autonomyDecision: string;
  steps: PocAgentStep[];
  finalAnswer: string;
  modelReasoningSummary: string;
  citations: Array<{
    sourceName: string;
    chunkId: string;
    excerpt: string;
  }>;
  stopConditionsChecked: string[];
}

export interface RunPocOptions {
  writeReport?: boolean;
  outputPath?: string;
  provider?: "deterministic" | "local-huggingface";
  allowModelFallback?: boolean;
}

const useCaseQuestion =
  "Can an autonomous AI agent answer which governed finance context should be used for failed payment analysis, and what is it allowed to do?";

export async function runLocalAgentUseCase(options: RunPocOptions = {}): Promise<PocAgentReport> {
  const db = openMemoryDatabase();
  const { engine } = createApp(db, { seed: true });
  const steps: PocAgentStep[] = [];

  const permissionCheck = engine.explainPermissions(useCaseQuestion);
  steps.push({
    step: 1,
    tool: "explain_permissions",
    rationale: "The agent must discover its autonomy boundary before touching data.",
    observation: permissionCheck.decision
  });

  const searchResults = engine.search({
    query: "failed payment rate finance semantic contract billing pipeline revenue mart policy",
    topK: 5,
    mode: "hybrid"
  });
  steps.push({
    step: 2,
    tool: "semantic_search",
    rationale: "Find candidate governed context using hybrid lexical, vector, and graph signals.",
    observation: `${searchResults.length} evidence candidates returned. Top source: ${searchResults[0]?.sourceName ?? "none"}.`
  });

  const entityCandidates = engine.entityLookup("Billing Pipeline");
  const primaryEntity = entityCandidates[0] ?? null;
  steps.push({
    step: 3,
    tool: "entity_lookup",
    rationale: "Ground the search result in canonical graph entities before answering.",
    observation: primaryEntity
      ? `Resolved ${primaryEntity.canonicalName} with degree ${primaryEntity.degree}.`
      : "No canonical Billing Pipeline entity was resolved."
  });

  const neighbors = primaryEntity ? engine.graphNeighbors(primaryEntity.id, 1) : { nodes: [], edges: [] };
  steps.push({
    step: 4,
    tool: "graph_neighbors",
    rationale: "Inspect bounded graph context without giving the agent free graph traversal.",
    observation: `${neighbors.nodes.length} nodes and ${neighbors.edges.length} edges in the approved neighborhood.`
  });

  const contextPack = engine.expandContext({
    query: "Finance Semantic Contract Failed Payment Rate Billing Pipeline Revenue Mart",
    entityIds: primaryEntity ? [primaryEntity.id] : []
  });
  steps.push({
    step: 5,
    tool: "expand_context",
    rationale: "Assemble an evidence pack with source spans before producing the final answer.",
    observation: `${contextPack.evidence.length} evidence spans assembled.`
  });

  const citations = contextPack.evidence.slice(0, 4).map((item) => ({
    sourceName: item?.sourceName ?? "unknown",
    chunkId: item?.chunkId ?? "unknown",
    excerpt: compact(item?.text ?? "")
  }));

  const deterministicAnswer = [
    "Yes. The agent can autonomously answer this read-only discovery question because the capability manifest allows semantic search, entity lookup, bounded graph traversal, context expansion, and evidence opening.",
    "For failed payment analysis, the governed finance context is the Finance Semantic Contract plus the Billing Pipeline and Revenue Mart lineage. The local catalog also defines Failed Payment Rate as a governed metric with dimensions such as payment provider, plan, and retry policy.",
    "The agent may discover and cite metadata, graph relationships, metric definitions, policies, and source spans. It may not mutate source systems, execute generated SQL, expose secrets, bypass masking, or access restricted raw customer payloads without an approval-gated adapter."
  ].join(" ");

  const modelResult = maybeGenerateWithLocalModel(options.provider, options.allowModelFallback ?? true, citations);
  const finalAnswer =
    modelResult.provider === "local-huggingface-mlx" && modelResult.text
      ? `${deterministicAnswer} Local Hugging Face model summary: ${modelResult.text}`
      : deterministicAnswer;

  const report: PocAgentReport = {
    useCase: "Local autonomous agent discovery over governed finance semantic context",
    question: useCaseQuestion,
    provider: modelResult.provider,
    model: modelResult.model,
    autonomyDecision: permissionCheck.decision,
    steps,
    finalAnswer,
    modelReasoningSummary: modelResult.text,
    citations,
    stopConditionsChecked: permissionCheck.manifest.stopConditions
  };

  if (options.writeReport ?? false) {
    const outputPath = options.outputPath ?? defaultReportPath();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

function maybeGenerateWithLocalModel(
  provider: RunPocOptions["provider"],
  allowFallback: boolean,
  citations: PocAgentReport["citations"]
): { provider: string; model: string; text: string } {
  if (provider !== "local-huggingface") {
    return {
      provider: "deterministic-local-agent-loop",
      model: "deterministic-rules",
      text: "Deterministic planner selected safe read-only tools and evidence-backed context."
    };
  }

  const model = pickDefaultLocalModel();
  try {
    const evidence = citations.map((citation) => `- ${citation.sourceName}: ${citation.excerpt}`).join("\n");
    const generated = generateWithLocalHuggingFace(
      [
        "You are an agent audit summarizer. Do not reveal chain-of-thought.",
        "Return a concise operational reasoning summary in two bullet points.",
        "Use only the provided evidence. Do not introduce source names, facts, actions, or systems that are absent from the evidence.",
        "Do not repeat sentences.",
        "Question: Which governed finance context should be used for failed payment analysis, and what is the agent allowed to do?",
        "Evidence:",
        evidence
      ].join("\n"),
      model
    );
    return {
      provider: generated.provider,
      model: generated.model.id,
      text: generated.text
    };
  } catch (error) {
    if (!allowFallback) throw error;
    return {
      provider: "local-huggingface-mlx-unavailable-fallback",
      model: model?.id ?? "none",
      text: `Local Hugging Face generation failed, so deterministic fallback was used. Error: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function defaultReportPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../../../artifacts/poc/local-agent-use-case-report.json");
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const report = await runLocalAgentUseCase({
    writeReport: true,
    provider: process.argv.includes("--local-hf") ? "local-huggingface" : "deterministic",
    allowModelFallback: !process.argv.includes("--no-fallback")
  });
  console.log(JSON.stringify(report, null, 2));
}
