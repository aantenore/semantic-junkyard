import fs from "node:fs";
import os from "node:os";
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
  orchestrationProvider: "deterministic-policy-harness";
  modelRole: "audit-fact-selector" | "deterministic-summary";
  overallStatus: "completed" | "degraded" | "blocked" | "failed";
  autonomyDecision: string;
  steps: PocAgentStep[];
  businessAction: {
    intent: string;
    status: string;
    writes: number;
    verifiedReflections: number;
    semanticChunksRefreshed: number;
  };
  finalAnswer: string;
  modelReasoningSummary: string;
  modelSummaryStatus: "deterministic" | "grounded" | "rejected" | "fallback";
  citations: Array<{
    sourceName: string;
    chunkId: string;
    excerpt: string;
  }>;
  stopConditionsChecked: string[];
  stopConditionEvaluations: Array<{
    condition: string;
    status: "passed" | "triggered" | "not_evaluated";
    detail: string;
  }>;
}

export interface RunPocOptions {
  writeReport?: boolean;
  outputPath?: string;
  provider?: "deterministic" | "local-huggingface";
  allowModelFallback?: boolean;
  temporaryRoot?: string;
}

const useCaseQuestion =
  "Which governed data and policy control order dispatch, and can the agent set order ORD-1001 to dispatched with verified source reflection?";

export async function runLocalAgentUseCase(options: RunPocOptions = {}): Promise<PocAgentReport> {
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const sourceRoot = fs.mkdtempSync(path.join(temporaryRoot, "semantic-junkyard-agent-"));
  const db = openMemoryDatabase();
  try {
    const { engine, ready } = createApp(db, {
      seed: false,
      bootstrapReferenceSources: true,
      referenceSourcesRoot: sourceRoot
    });
    await ready;
    return await executeLocalAgentUseCase(engine, options);
  } finally {
    db.close();
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

async function executeLocalAgentUseCase(
  engine: ReturnType<typeof createApp>["engine"],
  options: RunPocOptions
): Promise<PocAgentReport> {
  const steps: PocAgentStep[] = [];

  const permissionCheck = engine.explainPermissions(useCaseQuestion);
  steps.push({
    step: 1,
    tool: "explain_permissions",
    rationale: "The agent must discover its autonomy boundary before touching data.",
    observation: permissionCheck.decision
  });

  const searchResults = engine.search({
    query: "order dispatch status carrier SLA policy operations database",
    topK: 5,
    mode: "hybrid"
  });
  steps.push({
    step: 2,
    tool: "semantic_search",
    rationale: "Find candidate governed context using hybrid lexical, vector, and graph signals.",
    observation: `${searchResults.length} evidence candidates returned. Top source: ${searchResults[0]?.sourceName ?? "none"}.`
  });

  const entityCandidates = engine.entityLookup({ name: "Operations Database.orders", topK: 5 });
  const primaryEntity = entityCandidates[0] ?? null;
  steps.push({
    step: 3,
    tool: "entity_lookup",
    rationale: "Ground the search result in canonical graph entities before answering.",
    observation: primaryEntity
      ? `Resolved ${primaryEntity.canonicalName} with degree ${primaryEntity.degree}.`
      : "No canonical orders entity was resolved."
  });

  const neighbors = primaryEntity ? engine.graphNeighbors({ entityId: primaryEntity.id, depth: 1 }) : { nodes: [], edges: [] };
  steps.push({
    step: 4,
    tool: "graph_neighbors",
    rationale: "Inspect bounded graph context without giving the agent free graph traversal.",
    observation: `${neighbors.nodes.length} nodes and ${neighbors.edges.length} edges in the approved neighborhood.`
  });

  const contextPack = engine.expandContext({
    query: "order dispatch policy status carrier SLA Operations Database orders",
    entityIds: primaryEntity ? [primaryEntity.id] : []
  });
  steps.push({
    step: 5,
    tool: "expand_context",
    rationale: "Assemble an evidence pack with source spans before producing the final answer.",
    observation: `${contextPack.evidence.length} evidence spans assembled.`
  });

  const businessIntent = "Set order ORD-1001 status to dispatched.";
  const actionPlan = engine.planBusinessAction({
    intent: businessIntent,
    mode: "autonomous",
    maxAutonomousRisk: "medium"
  });
  steps.push({
    step: 6,
    tool: "business_action_plan",
    rationale: "Translate a business request into target source systems, diffs, evidence, risk, and autonomy before writing.",
    observation: `${actionPlan.targets.length} write targets planned: ${actionPlan.targets.map((target) => target.systemName).join(", ")}.`
  });

  const actionRun = engine.executeBusinessAction({
    planId: actionPlan.id,
    planFingerprint: actionPlan.fingerprint,
    intent: businessIntent,
    mode: "autonomous",
    maxAutonomousRisk: "medium",
    idempotencyKey: actionPlan.fingerprint
  });
  steps.push({
    step: 7,
    tool: "business_action_execute",
    rationale: "Execute only through the writeback gateway, reread source records, and refresh the semantic read model from reflection evidence.",
    observation: `${actionRun.writes.filter((write) => write.status === "executed").length} source mutations and ${actionRun.writes.filter((write) => write.status === "skipped").length} verified no-ops; ${actionRun.reflections.filter((reflection) => reflection.status === "verified").length} reflections verified; status ${actionRun.status}.`
  });

  const reflectedSearch = engine.search({
    query: "ORD-1001 dispatched Business Action Reflection Operations Database",
    topK: 3,
    mode: "hybrid"
  });
  steps.push({
    step: 8,
    tool: "semantic_search",
    rationale: "Confirm the reflected source state is now visible through the semantic read model.",
    observation: `${reflectedSearch.length} reflected evidence candidates returned.`
  });

  const citations = contextPack.evidence.slice(0, 4).map((item) => ({
    sourceName: item?.sourceName ?? "unknown",
    chunkId: item?.chunkId ?? "unknown",
    excerpt: compact(item?.text ?? "")
  }));

  const verifiedReflections = actionRun.reflections.filter((reflection) => reflection.status === "verified").length;
  const writebackVerified = actionRun.status === "verified" && actionRun.writes.length > 0 && verifiedReflections === actionRun.writes.length;
  const deterministicAnswer = [
    writebackVerified
      ? "Yes. This run found authorized evidence and completed the configured business action with verified source reflection."
      : `No completed writeback can be claimed for this run. The product returned action status ${actionRun.status} with ${verifiedReflections}/${actionRun.reflections.length} verified reflections.`,
    "The governed dispatch context combines the Operations Database orders table, dispatch policy, carrier SLA reference data, and discovered lineage. The write changed only the allowlisted status field for ORD-1001.",
    "The agent may discover and cite metadata, graph relationships, policies, and source spans. It may execute a configured low-risk record update through the source writeback gateway, but completion is valid only after an independent source reread verifies the exact value and the semantic read model is refreshed. It may not execute generated SQL, expose secrets, bypass masking, or write outside configured connector capabilities."
  ].join(" ");

  const verifiedAuditFacts = [
    "The plan targeted Operations Database.orders and changed only status for ORD-1001.",
    `The writeback run status was ${actionRun.status} after ${verifiedReflections} authoritative source reflection passed.`,
    "Dispatch eligibility evidence came from dispatch-policy.md and Operations Database.orders."
  ];
  const modelResult = await maybeGenerateWithLocalModel(options.provider, options.allowModelFallback ?? true, citations, verifiedAuditFacts);
  const baseStatus: PocAgentReport["overallStatus"] =
    actionPlan.status === "blocked" || actionRun.status === "blocked" || actionRun.status === "approval_required" || actionRun.status === "reconciliation_required"
      ? "blocked"
      : writebackVerified
        ? "completed"
        : "failed";
  const overallStatus = baseStatus === "completed" && modelResult.degraded ? "degraded" : baseStatus;
  const finalAnswer =
    modelResult.summaryStatus === "grounded" && modelResult.text
      ? `${deterministicAnswer} Grounded local model summary: ${modelResult.text}`
      : deterministicAnswer;

  const report: PocAgentReport = {
    useCase: "Local autonomous agent discovery and verified order writeback",
    question: useCaseQuestion,
    provider: modelResult.provider,
    model: modelResult.model,
    orchestrationProvider: "deterministic-policy-harness",
    modelRole: modelResult.provider === "local-huggingface-mlx" ? "audit-fact-selector" : "deterministic-summary",
    overallStatus,
    autonomyDecision: permissionCheck.decision,
    steps,
    businessAction: {
      intent: businessIntent,
      status: actionRun.status,
      writes: actionRun.writes.length,
      verifiedReflections,
      semanticChunksRefreshed: actionRun.semanticUpdates.reduce((total, update) => total + update.chunkIds.length, 0)
    },
    finalAnswer,
    modelReasoningSummary: modelResult.text,
    modelSummaryStatus: modelResult.summaryStatus,
    citations,
    stopConditionsChecked: permissionCheck.manifest.stopConditions,
    stopConditionEvaluations: evaluateStopConditions(permissionCheck.manifest.stopConditions, {
      evidenceCount: contextPack.evidence.length,
      actionPlan,
      actionRun,
      writebackVerified
    })
  };

  if (options.writeReport ?? false) {
    const outputPath = options.outputPath ?? defaultReportPath();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function maybeGenerateWithLocalModel(
  provider: RunPocOptions["provider"],
  allowFallback: boolean,
  citations: PocAgentReport["citations"],
  verifiedAuditFacts: string[]
): Promise<{
  provider: string;
  model: string;
  text: string;
  degraded: boolean;
  summaryStatus: PocAgentReport["modelSummaryStatus"];
}> {
  if (provider !== "local-huggingface") {
    return {
      provider: "deterministic-local-agent-loop",
      model: "deterministic-rules",
      text: "Deterministic planner selected evidence-backed discovery tools, policy-governed writeback, and source reflection.",
      degraded: false,
      summaryStatus: "deterministic"
    };
  }

  const model = pickDefaultLocalModel();
  try {
    const evidence = citations.map((citation) => `- ${citation.sourceName}: ${citation.excerpt}`).join("\n");
    const generated = await generateWithLocalHuggingFace(
      [
        "You select evidence-backed audit facts. Do not reveal chain-of-thought.",
        'Return exactly one JSON object: {"selectedFactIds":["FACT_1","FACT_2"]}.',
        "Select exactly two different IDs. Do not add markdown, explanation, or any other key.",
        "VERIFIED FACTS:",
        ...verifiedAuditFacts.map((fact, index) => `FACT_${index + 1}: ${fact}`),
        "SUPPORTING EVIDENCE:",
        evidence
      ].join("\n"),
      model
    );
    const groundedSummary = validateModelFactSelection(generated.text, verifiedAuditFacts);
    return {
      provider: generated.provider,
      model: generated.model.id,
      text: groundedSummary ?? "Local model narration was rejected because it did not exactly match verified audit facts.",
      degraded: groundedSummary === null,
      summaryStatus: groundedSummary === null ? "rejected" : "grounded"
    };
  } catch (error) {
    if (!allowFallback) throw error;
    return {
      provider: "local-huggingface-mlx-unavailable-fallback",
      model: model?.id ?? "none",
      text: `Local Hugging Face generation was unavailable, so the deterministic summary was used. Error code: ${localModelErrorCode(error)}.`,
      degraded: true,
      summaryStatus: "fallback"
    };
  }
}

export function validateModelFactSelection(text: string, verifiedFacts: string[]): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { selectedFactIds?: unknown };
    if (!Array.isArray(parsed.selectedFactIds) || parsed.selectedFactIds.length !== 2) return null;
    const ids = parsed.selectedFactIds.filter((id): id is string => typeof id === "string");
    if (ids.length !== 2 || new Set(ids).size !== 2) return null;
    const selected = ids.map((id) => {
      const match = /^FACT_([1-9]\d*)$/.exec(id);
      return match ? verifiedFacts[Number(match[1]) - 1] : undefined;
    });
    return selected.every((fact): fact is string => typeof fact === "string")
      ? selected.map((fact) => `- ${fact}`).join("\n")
      : null;
  } catch {
    return null;
  }
}

function evaluateStopConditions(
  conditions: string[],
  state: {
    evidenceCount: number;
    actionPlan: ReturnType<ReturnType<typeof createApp>["engine"]["planBusinessAction"]>;
    actionRun: ReturnType<ReturnType<typeof createApp>["engine"]["executeBusinessAction"]>;
    writebackVerified: boolean;
  }
): PocAgentReport["stopConditionEvaluations"] {
  return conditions.map((condition) => {
    const normalized = condition.toLowerCase();
    if (normalized.includes("authorized evidence")) {
      return state.evidenceCount > 0
        ? { condition, status: "passed", detail: `${state.evidenceCount} authorized evidence spans were available.` }
        : { condition, status: "triggered", detail: "No authorized evidence span was available." };
    }
    if (normalized.includes("freshness") || normalized.includes("quality")) {
      const policyWarnings = state.actionPlan.warnings.filter((warning) => /asset .* (requires human review|not authorized)/i.test(warning));
      return policyWarnings.length === 0
        ? { condition, status: "passed", detail: "Mapped action assets passed freshness, quality, and sensitivity gates." }
        : { condition, status: "triggered", detail: policyWarnings.join(" ") };
    }
    if (normalized.includes("source reflection") || normalized.includes("verify")) {
      return state.actionRun.writes.length === 0
        ? { condition, status: "not_evaluated", detail: `No write was attempted because the action status was ${state.actionRun.status}.` }
        : state.writebackVerified
          ? { condition, status: "passed", detail: "Every source write was reread and its expected hash was verified." }
          : { condition, status: "triggered", detail: "One or more source writes lacked verified reflection." };
    }
    if (normalized.includes("autonomy") || normalized.includes("human approval") || normalized.includes("policy")) {
      const paused = state.actionPlan.status === "approval_required" || state.actionPlan.status === "blocked";
      return {
        condition,
        status: paused ? "triggered" : "passed",
        detail: paused ? `Execution boundary triggered with plan status ${state.actionPlan.status}.` : "The exact fingerprinted plan stayed inside the configured autonomy ceiling."
      };
    }
    if (normalized.includes("direct source mutation") || normalized.includes("outside configured capabilities") || normalized.includes("privileged access")) {
      const prohibited = state.actionPlan.status === "blocked";
      return prohibited
        ? { condition, status: "triggered", detail: state.actionPlan.warnings.join(" ") || "The product blocked an unsupported or privileged action." }
        : {
            condition,
            status: "passed",
            detail: "Every write target resolved to a configured capability and executed through the governed writeback gateway."
          };
    }
    if (normalized.includes("contradict") || normalized.includes("confidence")) {
      return { condition, status: "not_evaluated", detail: "This deterministic use case does not run a contradiction adjudicator." };
    }
    return { condition, status: "not_evaluated", detail: "This condition was declared but has no dedicated evaluator in the bundled use case." };
  });
}

function localModelErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "LOCAL_MODEL_FAILED";
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
