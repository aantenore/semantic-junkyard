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

import type { DiscoveryRun, ProviderConfig, SourceSystem, SourceSystemRecord, SystemStatus } from "@semantic-junkyard/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(payload.error ?? response.statusText);
  }
  return (await response.json()) as T;
}

export async function loadPocSnapshot(): Promise<PocSnapshot> {
  const [status, provider, actionRuns, sourceSystemsEnvelope] = await Promise.all([
    request<SystemStatus>("/api/status"),
    request<ProviderConfig>("/api/providers"),
    request<BusinessActionRun[]>("/api/business/actions/runs"),
    request<{ systems: SourceSystem[]; records: SourceSystemRecord[] }>("/api/source-systems")
  ]);

  return {
    status,
    provider,
    actionRuns,
    sourceSystems: sourceSystemsEnvelope.systems,
    sourceRecords: sourceSystemsEnvelope.records
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

export async function entityLookup(name: string) {
  return request<EntityLookupEnvelope>("/api/tools/entity_lookup", {
    method: "POST",
    body: JSON.stringify({ name })
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

export async function executeBusinessAction(input: { intent: string; mode?: "autonomous" | "approval_required" | "dry_run"; approved?: boolean; maxAutonomousRisk?: "low" | "medium" | "high" }) {
  return request<BusinessActionRun>("/api/business/actions/execute", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function runDiscovery(objective: string) {
  return request<DiscoveryRun>("/api/discovery/run", {
    method: "POST",
    body: JSON.stringify({ objective })
  });
}

export async function runLocalAgentPoc(provider: ToolProvider = "deterministic") {
  return request<PocAgentReport>(`/api/poc/local-agent?provider=${provider}`);
}
