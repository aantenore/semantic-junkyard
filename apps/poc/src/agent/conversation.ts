import {
  entityLookup,
  executeBusinessAction,
  expandContext,
  explainPermissions,
  getEvidence,
  getSourceSystems,
  graphNeighbors,
  interpretAgentIntent,
  planBusinessAction,
  runDiscovery,
  searchSourceResources,
  semanticSearch
} from "../api/client";
import type {
  AgentIntentPlan,
  BusinessActionPlan,
  BusinessActionRun,
  ContextEnvelope,
  DiscoveryRun,
  EntityLookupEnvelope,
  EvidenceSpan,
  GraphSnapshot,
  IntentInterpreterProvider,
  PermissionEnvelope,
  SearchResult,
  SourceResource,
  SourceSystemsEnvelope
} from "../types/app";

export const CONVERSATION_LIMITS = Object.freeze({
  maxToolCalls: 18,
  sourceResources: 12,
  searchResults: 8,
  entityCandidates: 3,
  contextChunks: 6,
  contextEntities: 3,
  minimumGroundingTokenLength: 3
});

const GROUNDING_STOP_WORDS = new Set([
  "the", "and", "for", "from", "into", "with", "that", "this", "what", "which", "where", "when", "how", "why",
  "are", "was", "were", "has", "have", "had", "can", "could", "would", "should", "please", "tell", "show", "current",
  "set", "update", "change", "create", "make", "mark", "get", "read", "find", "about",
  "che", "chi", "cosa", "come", "dove", "quando", "quale", "quali", "della", "dello", "delle", "degli", "dei", "del",
  "con", "per", "nel", "nella", "nelle", "sul", "sulla", "imposta", "aggiorna", "mostra", "trova"
]);

export type ConversationMode = "read_only" | "plan_only" | "autonomous";
export type ConversationStatus =
  | "idle"
  | "running"
  | "answered"
  | "plan_ready"
  | "approval_required"
  | "reconciliation_required"
  | "blocked"
  | "insufficient_evidence"
  | "verified"
  | "failed";
export type MessageKind = "user" | "assistant" | "tool" | "audit" | "write" | "stop" | "error";
export type ToolStatus = "running" | "completed" | "failed";
export type EvidencePhase = "initial" | "refreshed";

export interface NarrationEvent {
  kind: MessageKind;
  title: string;
  body: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  endpoint: string;
  status: ToolStatus;
  summary: string;
  request: unknown;
  response?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface GroundedAnswer {
  answer: string;
  claims: Array<{ text: string; citationChunkIds: string[] }>;
  citations: Array<{ chunkId: string; sourceName: string }>;
  boundary: string;
}

export type ConversationArtifact =
  | { type: "intent"; value: AgentIntentPlan }
  | { type: "resources"; value: SourceResource[] }
  | { type: "discovery"; value: DiscoveryRun }
  | { type: "search"; phase: EvidencePhase; value: SearchResult[] }
  | { type: "entities"; value: EntityLookupEnvelope["entities"] }
  | { type: "graph"; value: GraphSnapshot }
  | { type: "context"; phase: EvidencePhase; value: ContextEnvelope }
  | { type: "evidence"; phase: EvidencePhase; value: EvidenceSpan }
  | { type: "permissions"; value: PermissionEnvelope }
  | { type: "answer"; value: GroundedAnswer }
  | { type: "plan"; value: BusinessActionPlan }
  | { type: "run"; value: BusinessActionRun }
  | { type: "source_state"; value: SourceSystemsEnvelope };

export type ConversationEvent =
  | { type: "narration"; value: NarrationEvent }
  | { type: "tool_started"; value: ToolEvent }
  | { type: "tool_finished"; value: ToolEvent }
  | { type: "artifact"; value: ConversationArtifact }
  | { type: "status"; value: ConversationStatus };

export interface ConversationInput {
  message: string;
  provider: IntentInterpreterProvider;
  mode: ConversationMode;
}

interface ToolCall<T> {
  name: string;
  endpoint: string;
  request: unknown;
  runningTitle: string;
  runningBody: string;
  run: () => Promise<T>;
  describe: (result: T) => string;
}

type ConversationSink = (event: ConversationEvent) => void;

export async function runProductConversation(input: ConversationInput, emit: ConversationSink): Promise<void> {
  let toolCalls = 0;

  const callTool = async <T,>(call: ToolCall<T>): Promise<T> => {
    toolCalls += 1;
    if (toolCalls > CONVERSATION_LIMITS.maxToolCalls) {
      throw new Error(`The external client reached its ${CONVERSATION_LIMITS.maxToolCalls}-call safety bound.`);
    }

    const event: ToolEvent = {
      id: globalThis.crypto.randomUUID(),
      name: call.name,
      endpoint: call.endpoint,
      status: "running",
      summary: call.runningBody,
      request: call.request,
      startedAt: new Date().toISOString()
    };
    emit({ type: "tool_started", value: event });
    emit({
      type: "narration",
      value: { kind: "tool", title: call.runningTitle, body: call.runningBody }
    });

    try {
      const result = await call.run();
      const summary = call.describe(result);
      emit({
        type: "tool_finished",
        value: {
          ...event,
          status: "completed",
          summary,
          response: result,
          completedAt: new Date().toISOString()
        }
      });
      emit({
        type: "narration",
        value: { kind: "audit", title: `${call.name} observed`, body: summary }
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : `${call.name} failed`;
      emit({
        type: "tool_finished",
        value: {
          ...event,
          status: "failed",
          summary: message,
          error: message,
          completedAt: new Date().toISOString()
        }
      });
      emit({
        type: "narration",
        value: { kind: "error", title: `${call.name} failed`, body: message }
      });
      throw error;
    }
  };

  const stop = (status: Exclude<ConversationStatus, "idle" | "running" | "failed">, title: string, body: string) => {
    emit({ type: "narration", value: { kind: "stop", title, body } });
    emit({ type: "status", value: status });
  };

  emit({ type: "status", value: "running" });

  try {
    const interpretationRequest = { message: input.message, provider: input.provider };
    const intent = await callTool({
      name: "agent_interpret",
      endpoint: "POST /api/agent/interpret",
      request: interpretationRequest,
      runningTitle: input.provider === "local-huggingface" ? "Local model interpretation" : "Deterministic interpretation",
      runningBody:
        input.provider === "local-huggingface"
          ? "The selected local Hugging Face interpreter is producing a bounded intent contract."
          : "Deterministic rules are extracting the intent contract; no model is involved.",
      run: () => interpretAgentIntent(input.message, input.provider),
      describe: (result) =>
        result.provider === "local-huggingface-mlx"
          ? `Local model ${result.modelId ?? "unreported"} returned ${percent(result.confidence)} confidence. Harness summary: ${result.summary}${warningSuffix(result.warnings)}`
          : `Deterministic rules classified the request with ${percent(result.confidence)} confidence. ${result.summary}`
    });
    emit({ type: "artifact", value: { type: "intent", value: intent } });

    if (intent.confidence < 0.35) {
      stop(
        "insufficient_evidence",
        "Stopped on interpretation uncertainty",
        `The intent contract confidence was ${percent(intent.confidence)}, below the client safety threshold. No discovery, plan, or write was attempted.`
      );
      return;
    }

    const resourceRequest = { query: intent.resourceQuery, topK: CONVERSATION_LIMITS.sourceResources };
    const resourceSearch = await callTool({
      name: "source_resource_search",
      endpoint: "POST /api/tools/source_resource_search",
      request: resourceRequest,
      runningTitle: "Searching the source registry",
      runningBody: `Looking for observed resources matching "${intent.resourceQuery}".`,
      run: () => searchSourceResources(resourceRequest),
      describe: (result) => describeResources(result.resources)
    });
    emit({ type: "artifact", value: { type: "resources", value: resourceSearch.resources } });

    const discoveryRequest = { objective: intent.objective };
    const discovery = await callTool({
      name: "discovery_run",
      endpoint: "POST /api/discovery/run",
      request: discoveryRequest,
      runningTitle: "Running objective-aware discovery",
      runningBody: `The product is discovering governed context for "${intent.objective}".`,
      run: () => runDiscovery(intent.objective),
      describe: (result) => {
        const lastEvent = result.events.at(-1);
        return `${result.events.length} discovery events were recorded; status ${result.status}.${lastEvent ? ` Latest observation: ${lastEvent.title}.` : ""}`;
      }
    });
    emit({ type: "artifact", value: { type: "discovery", value: discovery } });

    const searchRequest = { query: intent.searchQuery, mode: "hybrid" as const, topK: CONVERSATION_LIMITS.searchResults, scope: "domain" as const };
    const search = await callTool({
      name: "semantic_search",
      endpoint: "POST /api/tools/semantic_search",
      request: searchRequest,
      runningTitle: "Retrieving semantic evidence",
      runningBody: `Searching the governed semantic layer for "${intent.searchQuery}".`,
      run: () => semanticSearch(searchRequest.query, searchRequest.mode, searchRequest.topK, searchRequest.scope),
      describe: (result) =>
        result.results.length > 0
          ? `${result.results.length} governed candidates were returned. Top source: ${result.results[0]?.sourceName}; hybrid score ${result.results[0]?.hybridScore.toFixed(3)}.`
          : "No governed semantic candidates were returned."
    });
    emit({ type: "artifact", value: { type: "search", phase: "initial", value: search.results } });

    const entities = await resolveEntities(intent, search.results, callTool);
    emit({ type: "artifact", value: { type: "entities", value: entities } });
    const primaryEntity = entities[0];
    let graph: GraphSnapshot | null = null;
    if (primaryEntity) {
      const graphRequest = { entityId: primaryEntity.id, depth: 1 };
      graph = await callTool({
        name: "graph_neighbors",
        endpoint: "POST /api/tools/graph_neighbors",
        request: graphRequest,
        runningTitle: "Reading bounded graph context",
        runningBody: `Opening one graph hop around ${primaryEntity.canonicalName}.`,
        run: () => graphNeighbors(graphRequest.entityId, graphRequest.depth),
        describe: (result) => `${result.nodes.length} nodes and ${result.edges.length} edges were returned inside the one-hop boundary.`
      });
      emit({ type: "artifact", value: { type: "graph", value: graph } });
    } else {
      emit({
        type: "narration",
        value: {
          kind: "audit",
          title: "Graph expansion skipped",
          body: "No canonical entity was resolved from the interpreted entity query or search evidence, so the client did not invent a graph anchor."
        }
      });
    }

    const contextRequest = {
      query: intent.searchQuery,
      chunkIds: search.results.slice(0, CONVERSATION_LIMITS.contextChunks).map((result) => result.chunkId),
      entityIds: entities.slice(0, CONVERSATION_LIMITS.contextEntities).map((entity) => entity.id),
      scope: "domain" as const
    };
    const rawContext = await callTool({
      name: "expand_context",
      endpoint: "POST /api/tools/expand_context",
      request: contextRequest,
      runningTitle: "Assembling the evidence pack",
      runningBody: "The product is applying policy and assembling bounded context before any answer or action plan.",
      run: () => expandContext(contextRequest),
      describe: (result) => `${result.evidence.length} evidence spans and ${result.entities.length} entities were assembled. ${result.guidance}`
    });
    const context = { ...rawContext, evidence: rankEvidenceForAnswer(input.message, rawContext.evidence) };
    emit({ type: "artifact", value: { type: "context", phase: "initial", value: context } });

    const initialEvidence = await openTopEvidence(context, "initial", callTool, emit);
    const groundedResource = resourceSearch.resources.some((resource) =>
      hasMeaningfulOverlap(intent.resourceQuery, [resource.name, resource.qualifiedName, resource.description, JSON.stringify(resource.profile)])
    );
    const groundedSearch = search.results.some((result) =>
      hasMeaningfulOverlap(intent.searchQuery, [result.sourceName, result.summary, result.text])
    );
    const hasDomainGrounding = groundedResource || groundedSearch;
    const originalRequestGrounded = hasMeaningfulOverlap(input.message, [
      ...resourceSearch.resources.flatMap((resource) => [resource.name, resource.qualifiedName, resource.description, JSON.stringify(resource.profile)]),
      ...search.results.flatMap((result) => [result.sourceName, result.summary, result.text]),
      ...context.evidence.flatMap((evidence) => [evidence.sourceName, evidence.text])
    ]);
    if (!initialEvidence || context.evidence.length === 0 || !hasDomainGrounding || !originalRequestGrounded) {
      stop(
        "insufficient_evidence",
        "Stopped for insufficient evidence",
        `The bounded run found ${resourceSearch.resources.length} matching source resources, ${search.results.length} search candidates, and ${context.evidence.length} context spans, but it could not ground both the interpreted queries and the original request in governed evidence. No plan or write was created.`
      );
      return;
    }

    if (!intent.requestedAction || !intent.actionIntent) {
      const answer = buildGroundedAnswer(input.message, context.evidence);
      emit({ type: "artifact", value: { type: "answer", value: answer } });
      emit({
        type: "narration",
        value: {
          kind: "assistant",
          title: "Grounded read-only result",
          body: `${answer.answer} Citations: ${answer.citations.map((citation) => `${citation.sourceName} [${citation.chunkId}]`).join("; ")}. ${answer.boundary} No business-action plan was created.`
        }
      });
      emit({ type: "status", value: "answered" });
      return;
    }

    if (!resourceSearch.resources.some((resource) => resource.writable)) {
      stop(
        "insufficient_evidence",
        "Stopped without a writable source",
        "The interpreter requested a mutation, but the source registry returned no matching writable resource. The client will not ask the product to plan against an inferred fallback."
      );
      return;
    }

    if (input.mode === "read_only") {
      stop(
        "blocked",
        "Stopped at the read-only boundary",
        "The request contains an explicit mutation, but this conversation is read-only. Evidence was collected; no business-action plan or write was created."
      );
      return;
    }

    const permissions = await callTool({
      name: "explain_permissions",
      endpoint: "POST /api/tools/explain_permissions",
      request: { intent: intent.actionIntent },
      runningTitle: "Checking the autonomy boundary",
      runningBody: "Asking the product which governed next steps are allowed before requesting an exact action plan.",
      run: () => explainPermissions(intent.actionIntent as string),
      describe: (result) => `${result.decision}. ${result.safeNextSteps[0] ?? "No safe next step was returned."}`
    });
    emit({ type: "artifact", value: { type: "permissions", value: permissions } });

    const actionContext = {
      interpreter: {
        provider: intent.provider,
        modelId: intent.modelId,
        confidence: intent.confidence
      },
      sourceResourceIds: resourceSearch.resources.map((resource) => resource.id),
      evidenceChunkIds: context.evidence.map((evidence) => evidence.chunkId)
    };
    const planRequest = {
      intent: intent.actionIntent,
      mode: input.mode === "plan_only" ? ("approval_required" as const) : ("autonomous" as const),
      maxAutonomousRisk: "medium" as const,
      context: actionContext
    };
    const plan = await callTool({
      name: "business_action_plan",
      endpoint: "POST /api/business/actions/plan",
      request: planRequest,
      runningTitle: "Requesting the exact business plan",
      runningBody: "The product is resolving authoritative targets, source diffs, risk, evidence, and autonomy.",
      run: () => planBusinessAction(planRequest),
      describe: (result) =>
        `${result.targets.length} exact target${result.targets.length === 1 ? "" : "s"}; risk ${result.risk}; status ${result.status}.${warningSuffix(result.warnings)}`
    });
    emit({ type: "artifact", value: { type: "plan", value: plan } });

    if (plan.status === "blocked" || plan.targets.length === 0 || plan.targets.some((target) => target.autonomy === "blocked")) {
      stop(
        "blocked",
        "Product plan blocked",
        `${plan.summary}${plan.warnings.length > 0 ? ` ${plan.warnings.join(" ")}` : ""} No write was attempted.`
      );
      return;
    }

    if (input.mode === "plan_only") {
      emit({
        type: "narration",
        value: {
          kind: "assistant",
          title: "Exact plan ready for review",
          body: `${plan.title}. Fingerprint ${plan.fingerprint.slice(0, 12)}. Review-only mode stopped before execution.`
        }
      });
      emit({ type: "status", value: "plan_ready" });
      return;
    }

    const approvalRequired = plan.status === "approval_required" || plan.targets.some((target) => target.autonomy === "approval_required");
    if (approvalRequired) {
      stop(
        "approval_required",
        "Stopped for approval",
        `${plan.title} requires approval for ${plan.targets.filter((target) => target.autonomy === "approval_required").length} target${plan.targets.filter((target) => target.autonomy === "approval_required").length === 1 ? "" : "s"}. No write was attempted.`
      );
      return;
    }

    const allTargetsAutonomous = plan.status === "planned" && plan.targets.every((target) => target.autonomy === "autonomous");
    if (!allTargetsAutonomous) {
      stop(
        "blocked",
        "Stopped on a non-autonomous plan",
        `The product returned plan status ${plan.status}; not every exact target is autonomous. No write was attempted.`
      );
      return;
    }

    const idempotencyKey = `${plan.id}-${plan.fingerprint.slice(0, 16)}-external-poc`;
    const executeRequest = {
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      intent: plan.intent,
      mode: plan.mode,
      maxAutonomousRisk: plan.maxAutonomousRisk,
      idempotencyKey,
      context: actionContext
    };
    const run = await callTool({
      name: "business_action_execute",
      endpoint: "POST /api/business/actions/execute",
      request: executeRequest,
      runningTitle: "Executing through product writeback",
      runningBody: "Every exact target is autonomous. The product writeback gateway is executing and independently verifying source reflection.",
      run: () => executeBusinessAction({ plan, idempotencyKey, context: actionContext }),
      describe: (result) =>
        `${result.writes.length} write${result.writes.length === 1 ? "" : "s"}; ${result.reflections.filter((reflection) => reflection.status === "verified").length}/${result.reflections.length} reflections verified; status ${result.status}.`
    });
    emit({ type: "artifact", value: { type: "run", value: run } });

    const fullyVerified =
      run.status === "verified" &&
      run.writes.length > 0 &&
      run.reflections.length === run.writes.length &&
      run.reflections.every((reflection) => reflection.status === "verified");
    if (!fullyVerified) {
      const stopStatus: ConversationStatus =
        run.status === "approval_required"
          ? "approval_required"
          : run.status === "reconciliation_required"
            ? "reconciliation_required"
            : "blocked";
      stop(
        stopStatus,
        `Stopped on ${run.status}`,
        run.status === "reconciliation_required"
          ? "The authoritative source outcome is ambiguous. The client stopped and requires operator reconciliation before any retry."
          : `The product returned ${run.status} with ${run.reflections.filter((reflection) => reflection.status === "verified").length}/${run.reflections.length} verified reflections. The client will not claim completion.`
      );
      return;
    }

    const sourceState = await callTool({
      name: "source_readback",
      endpoint: "GET /api/source-systems",
      request: null,
      runningTitle: "Reading reflected source state",
      runningBody: "The external client is rereading product source records after the verified gateway response.",
      run: getSourceSystems,
      describe: (result) => describeReadback(run, result)
    });
    emit({ type: "artifact", value: { type: "source_state", value: sourceState } });

    const reflectionQuery = run.semanticUpdates.find((update) => update.searchQuery.trim().length > 0)?.searchQuery ?? `Business Action Reflection ${intent.actionIntent}`;
    const refreshedSearchRequest = {
      query: reflectionQuery,
      mode: "hybrid" as const,
      topK: CONVERSATION_LIMITS.searchResults,
      scope: "operational" as const
    };
    const refreshedSearch = await callTool({
      name: "semantic_search",
      endpoint: "POST /api/tools/semantic_search",
      request: refreshedSearchRequest,
      runningTitle: "Searching refreshed semantic evidence",
      runningBody: "The source postcondition passed. The client is now retrieving evidence rebuilt from reflected source state.",
      run: () => semanticSearch(refreshedSearchRequest.query, refreshedSearchRequest.mode, refreshedSearchRequest.topK, refreshedSearchRequest.scope),
      describe: (result) =>
        result.results.length > 0
          ? `${result.results.length} refreshed candidates were returned. Top source: ${result.results[0]?.sourceName}.`
          : "No refreshed semantic candidate was returned."
    });
    emit({ type: "artifact", value: { type: "search", phase: "refreshed", value: refreshedSearch.results } });

    const reflectedChunkIds = unique([
      ...run.semanticUpdates.flatMap((update) => update.chunkIds),
      ...refreshedSearch.results.slice(0, CONVERSATION_LIMITS.contextChunks).map((result) => result.chunkId)
    ]).slice(0, 25);
    const refreshedContextRequest = { query: reflectionQuery, chunkIds: reflectedChunkIds, scope: "operational" as const };
    const refreshedContext = await callTool({
      name: "expand_context",
      endpoint: "POST /api/tools/expand_context",
      request: refreshedContextRequest,
      runningTitle: "Opening the refreshed evidence pack",
      runningBody: "The client is assembling post-write context from the reflected semantic chunks.",
      run: () => expandContext(refreshedContextRequest),
      describe: (result) => `${result.evidence.length} post-write evidence spans were assembled. ${result.guidance}`
    });
    emit({ type: "artifact", value: { type: "context", phase: "refreshed", value: refreshedContext } });

    const refreshedEvidence = await openTopEvidence(refreshedContext, "refreshed", callTool, emit);
    if (!refreshedEvidence) {
      stop(
        "insufficient_evidence",
        "Source verified, evidence refresh incomplete",
        "The source postcondition passed, but no refreshed evidence span could be opened. The client reports the verified write without claiming end-to-end semantic completion."
      );
      return;
    }

    emit({
      type: "narration",
      value: {
        kind: "write",
        title: "Verified with reflected readback",
        body: `${describeReadback(run, sourceState)} Refreshed evidence: ${refreshedEvidence.sourceName} - ${compact(refreshedEvidence.text, 280)}`
      }
    });
    emit({ type: "status", value: "verified" });
  } catch (error) {
    emit({ type: "status", value: "failed" });
    throw error;
  }
}

async function resolveEntities(
  intent: AgentIntentPlan,
  searchResults: SearchResult[],
  callTool: <T>(call: ToolCall<T>) => Promise<T>
): Promise<EntityLookupEnvelope["entities"]> {
  let entities: EntityLookupEnvelope["entities"] = [];
  if (intent.entityQuery) {
    const request = { name: intent.entityQuery, topK: CONVERSATION_LIMITS.entityCandidates };
    const response = await callTool({
      name: "entity_lookup",
      endpoint: "POST /api/tools/entity_lookup",
      request,
      runningTitle: "Resolving the interpreted entity",
      runningBody: `Looking up the canonical entity "${intent.entityQuery}".`,
      run: () => entityLookup(request),
      describe: (result) => describeEntities(result.entities)
    });
    entities = response.entities;
  }

  const evidenceEntityId = searchResults.flatMap((result) => result.entityIds)[0];
  if (entities.length === 0 && evidenceEntityId) {
    const request = { entityId: evidenceEntityId, topK: CONVERSATION_LIMITS.entityCandidates };
    const response = await callTool({
      name: "entity_lookup",
      endpoint: "POST /api/tools/entity_lookup",
      request,
      runningTitle: "Resolving an evidence entity",
      runningBody: `The interpreted entity did not resolve; using canonical ID ${evidenceEntityId} returned by semantic search.`,
      run: () => entityLookup(request),
      describe: (result) => describeEntities(result.entities)
    });
    entities = response.entities;
  }
  return entities;
}

async function openTopEvidence(
  context: ContextEnvelope,
  phase: EvidencePhase,
  callTool: <T>(call: ToolCall<T>) => Promise<T>,
  emit: ConversationSink
): Promise<EvidenceSpan | null> {
  const candidate = context.evidence[0];
  if (!candidate) return null;
  const evidence = await callTool({
    name: "get_evidence",
    endpoint: `GET /api/evidence/${encodeURIComponent(candidate.chunkId)}`,
    request: null,
    runningTitle: phase === "refreshed" ? "Opening refreshed evidence" : "Opening primary evidence",
    runningBody: `Reading governed evidence chunk ${candidate.chunkId} from ${candidate.sourceName}.`,
    run: () => getEvidence(candidate.chunkId),
    describe: (result) => `Opened ${result.sourceName} / ${result.chunkId}; ${result.text.length} characters of governed evidence.`
  });
  emit({ type: "artifact", value: { type: "evidence", phase, value: evidence } });
  return evidence;
}

function describeResources(resources: SourceResource[]): string {
  if (resources.length === 0) {
    return "The source registry returned no direct match. Discovery and evidence retrieval will continue within the bounded workflow.";
  }
  const writable = resources.filter((resource) => resource.writable).length;
  const top = resources[0];
  return `${resources.length} observed resources matched; ${writable} writable. Top match: ${top?.qualifiedName} (${top?.kind}, ${top?.sensitivity}).`;
}

function describeEntities(entities: EntityLookupEnvelope["entities"]): string {
  const primary = entities[0];
  return primary
    ? `${entities.length} canonical candidate${entities.length === 1 ? "" : "s"} resolved. ${primary.canonicalName} has graph degree ${primary.degree}.`
    : "No canonical entity candidate was resolved.";
}

function describeReadback(run: BusinessActionRun, sourceState: SourceSystemsEnvelope): string {
  return run.writes
    .map((write) => {
      const reflection = run.reflections.find((candidate) => candidate.writeId === write.id);
      const record = sourceState.records.find((candidate) => candidate.id === reflection?.sourceRecordId);
      const connectorVersion = scalar(write.payload.connectorSourceVersion) ?? scalar(write.payload.version) ?? "unreported";
      const postcondition = scalar(write.payload.connectorPostcondition) ?? "postcondition not reported";
      const passed = write.payload.externalPostconditionPassed === true && reflection?.status === "verified";
      return `${write.systemName} ${write.objectType}:${write.objectKey} reflects source version ${connectorVersion}; reflection record v${record?.version ?? "?"}; postcondition ${passed ? "passed" : "not verified"}: ${postcondition}`;
    })
    .join(" ");
}

function buildGroundedAnswer(question: string, evidence: EvidenceSpan[]): GroundedAnswer {
  const selected = rankEvidenceForAnswer(question, evidence).slice(0, 3);
  const claims = selected.map((item) => ({
    text: evidenceClaim(question, item.text),
    citationChunkIds: [item.chunkId]
  }));
  const primarySource = selected[0]?.sourceName;
  const supportingSources = unique(selected.slice(1).map((item) => item.sourceName));
  return {
    answer: claims.length > 0
      ? `The strongest governed evidence for "${compact(question, 120)}" is ${primarySource}: ${claims[0]?.text}${supportingSources.length > 0 ? ` Supporting evidence comes from ${supportingSources.join(", ")}.` : ""}`
      : "No governed claim could be assembled for this request.",
    claims,
    citations: selected.map((item) => ({ chunkId: item.chunkId, sourceName: item.sourceName })),
    boundary: `This answer is limited to ${selected.length} policy-filtered evidence span${selected.length === 1 ? "" : "s"}; it does not infer facts outside those sources.`
  };
}

function rankEvidenceForAnswer(question: string, evidence: EvidenceSpan[]): EvidenceSpan[] {
  const queryTerms = semanticTerms(question);
  return evidence
    .map((item, index) => {
      const claim = evidenceClaim(question, item.text);
      const claimTerms = semanticTerms(claim);
      const sourceTerms = semanticTerms(item.sourceName);
      const claimOverlap = overlapCount(queryTerms, claimTerms);
      const sourceOverlap = overlapCount(queryTerms, sourceTerms);
      const authorityOverlap = overlapCount(expandAuthorityTerms(queryTerms), new Set([...claimTerms, ...sourceTerms]));
      return { item, index, score: claimOverlap * 2 + sourceOverlap + authorityOverlap * 0.75 };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.sourceName === item.sourceName) === index);
}

function evidenceClaim(question: string, text: string): string {
  const queryTerms = semanticTerms(question);
  const candidates = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[-#*\s]+/, "").replace(/^[a-zA-Z0-9_.-]+:\s*/, "").trim())
    .filter((line) => line.length >= 24 && !/^```/.test(line));
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, score: overlapCount(queryTerms, semanticTerms(candidate)) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return compact(ranked[0]?.candidate ?? text, 240);
}

function semanticTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .split(/[^a-z0-9]+/)
      .map(semanticRoot)
      .filter((term) => term.length >= CONVERSATION_LIMITS.minimumGroundingTokenLength && !GROUNDING_STOP_WORDS.has(term))
  );
}

function semanticRoot(term: string): string {
  if (term.startsWith("eligib")) return "eligib";
  if (term.startsWith("defin")) return "defin";
  if (term.startsWith("govern")) return "govern";
  if (term.endsWith("ies") && term.length > 5) return `${term.slice(0, -3)}y`;
  if (term.endsWith("ed") && term.length > 5) return term.slice(0, -2);
  if (term.endsWith("s") && term.length > 4) return term.slice(0, -1);
  return term;
}

function expandAuthorityTerms(queryTerms: Set<string>): Set<string> {
  const expanded = new Set(queryTerms);
  if (queryTerms.has("defin") || queryTerms.has("govern") || queryTerms.has("eligib")) {
    for (const term of ["policy", "contract", "rule", "standard", "ontology"]) expanded.add(term);
  }
  return expanded;
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const term of left) if (right.has(term)) count += 1;
  return count;
}

function warningSuffix(warnings: string[]): string {
  return warnings.length > 0 ? ` Warnings: ${warnings.join(" ")}` : "";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function scalar(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasMeaningfulOverlap(query: string, observedValues: string[]): boolean {
  const terms = semanticTerms(query);
  if (terms.size === 0) return false;
  const matchingTerms = overlapCount(terms, semanticTerms(observedValues.join(" ")));
  return matchingTerms >= Math.min(2, terms.size);
}
