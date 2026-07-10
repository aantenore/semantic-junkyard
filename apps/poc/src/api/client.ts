import type {
  BusinessActionPlan,
  BusinessActionRun,
  ContextEnvelope,
  EntityLookupEnvelope,
  GraphSnapshot,
  PermissionEnvelope,
  PocAgentReport,
  PocSnapshot,
  SearchEnvelope,
  ToolProvider
} from "../types/app";

import type { AuditEvent, DiscoveryRun, ProviderConfig, SourceSystem, SourceSystemRecord, SystemStatus } from "@semantic-junkyard/shared";
import { createJsonRequester, resolveApiUrl } from "@semantic-junkyard/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const request = createJsonRequester(API_BASE);
const longRequest = createJsonRequester(API_BASE, 150_000);

export function apiHref(path: string): string {
  return resolveApiUrl(API_BASE, path);
}

export async function loadPocSnapshot(): Promise<PocSnapshot> {
  const [status, provider, actionRuns, sourceSystemsEnvelope, auditEvents] = await Promise.all([
    request<SystemStatus>("/api/status"),
    request<ProviderConfig>("/api/providers"),
    request<BusinessActionRun[]>("/api/business/actions/runs"),
    request<{ systems: SourceSystem[]; records: SourceSystemRecord[] }>("/api/source-systems"),
    request<AuditEvent[]>("/api/audit/events?limit=40")
  ]);

  return {
    status,
    provider,
    actionRuns,
    sourceSystems: sourceSystemsEnvelope.systems,
    sourceRecords: sourceSystemsEnvelope.records,
    auditEvents
  };
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

export async function planBusinessAction(input: { intent: string; mode?: "autonomous" | "approval_required" | "dry_run"; maxAutonomousRisk?: "low" | "medium" | "high" }) {
  return request<BusinessActionPlan>("/api/business/actions/plan", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function executeBusinessAction(input: { plan: BusinessActionPlan; idempotencyKey: string }) {
  const { plan, idempotencyKey } = input;
  return request<BusinessActionRun>("/api/business/actions/execute", {
    method: "POST",
    body: JSON.stringify({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      intent: plan.intent,
      mode: plan.mode,
      maxAutonomousRisk: plan.maxAutonomousRisk,
      idempotencyKey
    })
  });
}

export async function runDiscovery(objective: string) {
  return request<DiscoveryRun>("/api/discovery/run", {
    method: "POST",
    body: JSON.stringify({ objective })
  });
}

export async function runLocalAgentPoc(provider: ToolProvider = "deterministic") {
  return longRequest<PocAgentReport>("/api/poc/local-agent", {
    method: "POST",
    body: JSON.stringify({ provider })
  });
}
