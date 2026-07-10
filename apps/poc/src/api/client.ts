import type {
  AgentIntentPlan,
  BusinessActionPlan,
  BusinessActionRun,
  ContextEnvelope,
  EntityLookupEnvelope,
  EvidenceSpan,
  GraphSnapshot,
  IntentInterpreterProvider,
  PermissionEnvelope,
  PocSnapshot,
  SearchEnvelope,
  SourceResource,
  SourceResourceSearchEnvelope,
  SourceSyncRun,
  SourceSystemsEnvelope
} from "../types/app";

import type { AuditEvent, DiscoveryRun, ProviderConfig, SystemStatus } from "@semantic-junkyard/shared";
import { createJsonRequester, resolveApiUrl, retryApiStartup } from "@semantic-junkyard/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const request = createJsonRequester(API_BASE);
const longRequest = createJsonRequester(API_BASE, 150_000);

export function apiHref(path: string): string {
  return resolveApiUrl(API_BASE, path);
}

export async function loadPocSnapshot(): Promise<PocSnapshot> {
  return retryApiStartup(loadPocSnapshotOnce);
}

async function loadPocSnapshotOnce(): Promise<PocSnapshot> {
  const [status, provider, actionRuns, sourceSystemsEnvelope, sourceResources, sourceSyncRuns, auditEvents] = await Promise.all([
    request<SystemStatus>("/api/status"),
    request<ProviderConfig>("/api/providers"),
    request<BusinessActionRun[]>("/api/business/actions/runs"),
    getSourceSystems(),
    request<SourceResource[]>("/api/source-resources"),
    request<SourceSyncRun[]>("/api/source-sync-runs"),
    request<AuditEvent[]>("/api/audit/events?limit=40")
  ]);

  return {
    status,
    provider,
    actionRuns,
    sourceSystems: sourceSystemsEnvelope.systems,
    sourceRecords: sourceSystemsEnvelope.records,
    sourceResources,
    sourceSyncRuns,
    auditEvents
  };
}

export async function interpretAgentIntent(message: string, provider: IntentInterpreterProvider) {
  return longRequest<AgentIntentPlan>("/api/agent/interpret", {
    method: "POST",
    body: JSON.stringify({ message, provider })
  });
}

export async function searchSourceResources(input: { query: string; connectionId?: string; topK?: number }) {
  return request<SourceResourceSearchEnvelope>("/api/tools/source_resource_search", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getSourceSystems() {
  return request<SourceSystemsEnvelope>("/api/source-systems");
}

export async function explainPermissions(intent: string) {
  return request<PermissionEnvelope>("/api/tools/explain_permissions", {
    method: "POST",
    body: JSON.stringify({ intent })
  });
}

export async function semanticSearch(query: string, mode: "hybrid" | "lexical" | "vector" | "graph" = "hybrid", topK = 8) {
  return request<SearchEnvelope>("/api/tools/semantic_search", {
    method: "POST",
    body: JSON.stringify({ query, mode, topK })
  });
}

export async function entityLookup(input: { name?: string; entityId?: string; topK?: number }) {
  return request<EntityLookupEnvelope>("/api/tools/entity_lookup", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function graphNeighbors(entityId: string, depth = 1) {
  return request<GraphSnapshot>("/api/tools/graph_neighbors", {
    method: "POST",
    body: JSON.stringify({ entityId, depth })
  });
}

export async function expandContext(input: { query?: string; chunkIds?: string[]; entityIds?: string[] }) {
  return request<ContextEnvelope>("/api/tools/expand_context", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getEvidence(chunkId: string) {
  return request<EvidenceSpan>(`/api/evidence/${encodeURIComponent(chunkId)}`);
}

export async function planBusinessAction(input: {
  intent: string;
  mode: "autonomous" | "approval_required" | "dry_run";
  maxAutonomousRisk?: "low" | "medium" | "high";
  context?: Record<string, unknown>;
}) {
  return request<BusinessActionPlan>("/api/business/actions/plan", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function executeBusinessAction(input: {
  plan: BusinessActionPlan;
  idempotencyKey: string;
  context?: Record<string, unknown>;
}) {
  const { plan, idempotencyKey, context = {} } = input;
  return request<BusinessActionRun>("/api/business/actions/execute", {
    method: "POST",
    body: JSON.stringify({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      intent: plan.intent,
      mode: plan.mode,
      maxAutonomousRisk: plan.maxAutonomousRisk,
      idempotencyKey,
      context
    })
  });
}

export async function runDiscovery(objective: string) {
  return request<DiscoveryRun>("/api/discovery/run", {
    method: "POST",
    body: JSON.stringify({ objective })
  });
}
