import type { AppSnapshot, CuratedRelationReport, IngestPreviewReport, PocAgentReport, SearchEnvelope } from "../types/app";
import type { BusinessActionPlan, BusinessActionRun, CatalogSnapshot, DiscoveryRun, GraphSnapshot, IngestResponse, ProviderConfig, SourceSystem, SourceSystemRecord, SystemStatus } from "@semantic-junkyard/shared";

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

export async function loadSnapshot(): Promise<AppSnapshot> {
  const [status, catalog, graph, discoveryRuns, manifest, provider, mcp, actionRuns, sourceSystemsEnvelope] = await Promise.all([
    request<SystemStatus>("/api/status"),
    request<CatalogSnapshot>("/api/catalog"),
    request<GraphSnapshot>("/api/graph"),
    request<DiscoveryRun[]>("/api/discovery/runs"),
    request<AppSnapshot["manifest"]>("/api/agent/manifest"),
    request<ProviderConfig>("/api/providers"),
    request<AppSnapshot["mcp"]>("/api/mcp/capabilities"),
    request<BusinessActionRun[]>("/api/business/actions/runs"),
    request<{ systems: SourceSystem[]; records: SourceSystemRecord[] }>("/api/source-systems")
  ]);
  return { status, catalog, graph, discoveryRuns, manifest, provider, mcp, actionRuns, sourceSystems: sourceSystemsEnvelope.systems, sourceRecords: sourceSystemsEnvelope.records };
}

export async function ingestText(input: { name: string; text: string; mimeType: string; ingestionMode: "full_data" | "metadata_only" | "external_reference" }) {
  return request<IngestResponse>("/api/ingest", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function previewIngest(input: { name: string; text: string; mimeType: string; ingestionMode: "full_data" | "metadata_only" | "external_reference" }) {
  return request<IngestPreviewReport>("/api/ingest/preview", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function curateRelation(input: { sourceName: string; sourceType: string; targetName: string; targetType: string; relationType: string; rationale?: string }) {
  return request<CuratedRelationReport>("/api/semantic/relations", {
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

export async function semanticSearch(query: string, mode: "hybrid" | "lexical" | "vector" | "graph" = "hybrid") {
  return request<SearchEnvelope>("/api/tools/semantic_search", {
    method: "POST",
    body: JSON.stringify({ query, mode, topK: 8 })
  });
}

export async function runLocalAgentPoc(provider: "deterministic" | "local-huggingface" = "deterministic") {
  return request<PocAgentReport>(`/api/poc/local-agent?provider=${provider}`);
}
