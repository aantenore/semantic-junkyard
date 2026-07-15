import type { AppSnapshot, CuratedRelationReport, IngestPreviewReport, SearchEnvelope, SnapshotSurface, SourceResourceSearchEnvelope } from "../types/app";
import { createJsonRequester, resolveApiUrl, retryApiStartup } from "@semantic-junkyard/shared";
import type {
  AuditEvent,
  BusinessActionApproval,
  BusinessActionPlan,
  BusinessActionRun,
  CatalogSnapshot,
  CreateSourceConnectionRequest,
  DiscoveryRun,
  EvidenceSpan,
  GraphSnapshot,
  IngestResponse,
  ProviderConfig,
  SemanticProposal,
  SourceDiscoveryMissionReport,
  SemanticProposalDecisionRequest,
  SourceConnection,
  SourceConnectionTestResult,
  SourceResource,
  SourceSyncRun,
  SyncSourceConnectionRequest,
  SourceSystem,
  SourceSystemRecord,
  SystemStatus
} from "@semantic-junkyard/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const request = createJsonRequester(API_BASE);
const longRequest = createJsonRequester(API_BASE, 150_000);

export function apiHref(path: string): string {
  return resolveApiUrl(API_BASE, path);
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  return retryApiStartup(loadSnapshotOnce);
}

async function loadSnapshotOnce(): Promise<AppSnapshot> {
  const degraded: string[] = [];
  const surfaceErrors: AppSnapshot["surfaceErrors"] = {};
  const snapshotRequest = <T>(path: string) => request<T>(path);
  const optional = <T>(surface: SnapshotSurface, label: string, promise: Promise<T>, fallback: T) =>
    promise.catch((error: unknown) => {
      degraded.push(label);
      surfaceErrors[surface] = error instanceof Error ? error.message : `${label} could not be loaded.`;
      return fallback;
    });
  const required = <T>(label: string, promise: Promise<T>) =>
    promise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown API error.";
      throw new Error(`${label} unavailable: ${message}`, { cause: error });
    });
  const [status, catalog, graph, discoveryRuns, manifest, provider, mcp, actionRuns, auditEvents, discoveryMissions, sourceSystemsEnvelope, sourceConnections, sourceResources, sourceSyncRuns, semanticProposals] = await Promise.all([
    required("System status", snapshotRequest<SystemStatus>("/api/status")),
    required("Catalog", snapshotRequest<CatalogSnapshot>("/api/catalog")),
    required("Graph", snapshotRequest<GraphSnapshot>("/api/graph")),
    optional("discoveryRuns", "discovery runs", snapshotRequest<DiscoveryRun[]>("/api/discovery/runs"), []),
    optional<AppSnapshot["manifest"]>("manifest", "agent manifest", snapshotRequest<NonNullable<AppSnapshot["manifest"]>>("/api/agent/manifest"), null),
    optional<ProviderConfig | null>("provider", "provider", snapshotRequest<ProviderConfig>("/api/providers"), null),
    optional<AppSnapshot["mcp"]>("mcp", "MCP capabilities", snapshotRequest<NonNullable<AppSnapshot["mcp"]>>("/api/mcp/capabilities"), null),
    optional("actionRuns", "business action runs", snapshotRequest<BusinessActionRun[]>("/api/business/actions/runs"), []),
    optional("auditEvents", "audit events", snapshotRequest<AuditEvent[]>("/api/audit/events?limit=20&actions=source_discovery.mission,source_connection.sync,semantic_proposal.decide,business_action.approve,business_action.execute,business_action.dry_run"), []),
    optional("discoveryMissions", "source discovery missions", snapshotRequest<SourceDiscoveryMissionReport[]>("/api/discovery/missions"), []),
    optional("sourceSystems", "source systems", snapshotRequest<{ systems: SourceSystem[]; records: SourceSystemRecord[] }>("/api/source-systems"), { systems: [], records: [] }),
    optional("sourceConnections", "source connections", snapshotRequest<SourceConnection[]>("/api/source-connections"), []),
    optional("sourceResources", "source resources", snapshotRequest<SourceResource[]>("/api/source-resources"), []),
    optional("sourceSyncRuns", "source sync runs", snapshotRequest<SourceSyncRun[]>("/api/source-sync-runs"), []),
    optional("semanticProposals", "semantic proposals", snapshotRequest<SemanticProposal[]>("/api/semantic/proposals"), [])
  ]);
  return {
    status,
    catalog,
    graph,
    discoveryRuns,
    manifest,
    provider,
    mcp,
    actionRuns,
    auditEvents,
    discoveryMissions,
    sourceSystems: sourceSystemsEnvelope.systems,
    sourceRecords: sourceSystemsEnvelope.records,
    sourceConnections,
    sourceResources,
    sourceSyncRuns,
    semanticProposals,
    degraded,
    surfaceErrors
  };
}

export async function createSourceConnection(input: CreateSourceConnectionRequest) {
  return request<SourceConnection>("/api/source-connections", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function testSourceConnection(connectionId: string) {
  return request<SourceConnectionTestResult>(`/api/source-connections/${encodeURIComponent(connectionId)}/test`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function syncSourceConnection(connectionId: string, input: SyncSourceConnectionRequest) {
  return longRequest<SourceSyncRun>(`/api/source-connections/${encodeURIComponent(connectionId)}/sync`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function runSourceDiscoveryMission(input: {
  objective: string;
  provider: "deterministic" | "local-huggingface";
  connectionIds?: string[];
  continueOnError?: boolean;
}) {
  return longRequest<SourceDiscoveryMissionReport>("/api/discovery/missions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function deleteSourceConnection(connectionId: string): Promise<void> {
  const response = await fetch(apiHref(`/api/source-connections/${encodeURIComponent(connectionId)}`), {
    method: "DELETE",
    headers: { Accept: "application/json" }
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? `Connection deletion failed with status ${response.status}.`);
}

export async function decideSemanticProposal(proposalId: string, input: SemanticProposalDecisionRequest) {
  return request<SemanticProposal>(`/api/semantic/proposals/${encodeURIComponent(proposalId)}/decision`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getEvidence(chunkId: string) {
  return request<EvidenceSpan>(`/api/evidence/${encodeURIComponent(chunkId)}`);
}

export async function searchSourceResources(input: { query: string; connectionId?: string; topK?: number }) {
  return request<SourceResourceSearchEnvelope>("/api/tools/source_resource_search", {
    method: "POST",
    body: JSON.stringify({
      query: input.query,
      connectionId: input.connectionId,
      kinds: [],
      topK: input.topK ?? 12
    })
  });
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

export async function curateRelation(input: { sourceName: string; sourceType: string; targetName: string; targetType: string; relationType: string; rationale: string }) {
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
