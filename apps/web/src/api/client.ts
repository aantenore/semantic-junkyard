import type { AppSnapshot, CuratedRelationReport, IngestPreviewReport, SearchEnvelope } from "../types/app";
import { createJsonRequester, resolveApiUrl } from "@semantic-junkyard/shared";
import type { BusinessActionApproval, BusinessActionPlan, BusinessActionRun, CatalogSnapshot, DiscoveryRun, GraphSnapshot, IngestResponse, ProviderConfig, SourceSystem, SourceSystemRecord, SystemStatus } from "@semantic-junkyard/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const request = createJsonRequester(API_BASE);

export function apiHref(path: string): string {
  return resolveApiUrl(API_BASE, path);
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  const [status, catalog, graph] = await Promise.all([
    request<SystemStatus>("/api/status"),
    request<CatalogSnapshot>("/api/catalog"),
    request<GraphSnapshot>("/api/graph")
  ]);
  const degraded: string[] = [];
  const optional = <T>(label: string, promise: Promise<T>, fallback: T) =>
    promise.catch(() => {
      degraded.push(label);
      return fallback;
    });
  const [discoveryRuns, manifest, provider, mcp, actionRuns, sourceSystemsEnvelope] = await Promise.all([
    optional("discovery runs", request<DiscoveryRun[]>("/api/discovery/runs"), []),
    optional<AppSnapshot["manifest"]>("agent manifest", request<NonNullable<AppSnapshot["manifest"]>>("/api/agent/manifest"), null),
    optional<ProviderConfig | null>("provider", request<ProviderConfig>("/api/providers"), null),
    optional<AppSnapshot["mcp"]>("MCP capabilities", request<NonNullable<AppSnapshot["mcp"]>>("/api/mcp/capabilities"), null),
    optional("business action runs", request<BusinessActionRun[]>("/api/business/actions/runs"), []),
    optional("source systems", request<{ systems: SourceSystem[]; records: SourceSystemRecord[] }>("/api/source-systems"), { systems: [], records: [] })
  ]);
  return { status, catalog, graph, discoveryRuns, manifest, provider, mcp, actionRuns, sourceSystems: sourceSystemsEnvelope.systems, sourceRecords: sourceSystemsEnvelope.records, degraded };
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

export async function approveBusinessAction(plan: BusinessActionPlan, rationale: string) {
  return request<BusinessActionApproval>("/api/business/actions/approve", {
    method: "POST",
    body: JSON.stringify({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      intent: plan.intent,
      mode: plan.mode,
      maxAutonomousRisk: plan.maxAutonomousRisk,
      rationale
    })
  });
}

export async function executeBusinessAction(input: { plan: BusinessActionPlan; approvalId?: string; idempotencyKey: string }) {
  const { plan, approvalId, idempotencyKey } = input;
  return request<BusinessActionRun>("/api/business/actions/execute", {
    method: "POST",
    body: JSON.stringify({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      intent: plan.intent,
      mode: plan.mode,
      maxAutonomousRisk: plan.maxAutonomousRisk,
      approvalId,
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

export async function semanticSearch(query: string, mode: "hybrid" | "lexical" | "vector" | "graph" = "hybrid") {
  return request<SearchEnvelope>("/api/tools/semantic_search", {
    method: "POST",
    body: JSON.stringify({ query, mode, topK: 8 })
  });
}
