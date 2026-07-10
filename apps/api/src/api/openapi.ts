import {
  BusinessActionApprovalRequestSchema,
  BusinessActionExecutionRequestSchema,
  BusinessActionRequestSchema,
  CatalogSnapshotSchema,
  CreateSourceConnectionRequestSchema,
  CuratedRelationRequestSchema,
  DiscoveryRequestSchema,
  EntityLookupRequestSchema,
  ExpandContextRequestSchema,
  ExplainPermissionsRequestSchema,
  FindPathsRequestSchema,
  GraphNeighborsRequestSchema,
  IngestRequestSchema,
  SearchRequestSchema,
  SemanticProposalDecisionRequestSchema,
  SourceResourceSearchRequestSchema,
  SyncSourceConnectionRequestSchema,
  AgentIntentRequestSchema
} from "@semantic-junkyard/shared";
import { z } from "zod";

const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema: z.toJSONSchema(schema, { target: "draft-07" }) } }
});

const jsonResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } }
});

const errors = {
  "400": { description: "Invalid request" },
  "401": { description: "Bearer token required when API authentication is configured" },
  "403": { description: "Origin, policy, or approval denied" },
  "409": { description: "Plan fingerprint changed, idempotency key conflicts, or another state transition conflicts" },
  "422": { description: "A connector, semantic proposal, or model result could not satisfy the requested operation" },
  "503": { description: "Configured connector or local model runtime unavailable" },
  "500": { description: "Unexpected server error" }
};

const post = (operationId: string, summary: string, schema: z.ZodType, success = "Request completed") => ({
  operationId,
  summary,
  requestBody: jsonBody(schema),
  responses: { "200": jsonResponse(success), ...errors }
});

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Semantic Junkyard API",
    version: "0.1.0",
    description: "Agent-native semantic layer API. Write execution is bound to an exact plan fingerprint, server-side risk ceiling, idempotency key, and optional separately issued approval."
  },
  servers: [{ url: "http://127.0.0.1:8787", description: "Default local API" }],
  security: [{}, { bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Agent/API token. Required when SEMANTIC_JUNKYARD_API_TOKEN is configured." },
      approvalBearer: { type: "http", scheme: "bearer", description: "Distinct operator/approver token. The agent/API token cannot configure sources, ingest, curate semantics, or issue approvals." }
    }
  },
  paths: {
    "/api/health": { get: { operationId: "health", summary: "Check API process health", responses: { "200": jsonResponse("Healthy") } } },
    "/api/status": { get: { operationId: "getStatus", summary: "Get semantic fabric counts and modules", responses: { "200": jsonResponse("System status"), ...errors } } },
    "/api/catalog": { get: { operationId: "getCatalog", summary: "Get governed catalog", responses: { "200": jsonResponse("Catalog snapshot"), ...errors } } },
    "/api/catalog/import": { post: { ...post("importCatalog", "Validate and import a catalog snapshot atomically", CatalogSnapshotSchema), security: [{ approvalBearer: [] }] } },
    "/api/sources": { get: { operationId: "listSources", summary: "List policy-filtered source artifacts", responses: { "200": jsonResponse("Source artifacts"), ...errors } } },
    "/api/source-systems": { get: { operationId: "listSourceSystems", summary: "List writeback capabilities and reflected records", responses: { "200": jsonResponse("Source systems"), ...errors } } },
    "/api/source-connections": {
      get: { operationId: "listSourceConnections", summary: "List operator-configured source connectors", security: [{ approvalBearer: [] }], responses: { "200": jsonResponse("Source connections"), ...errors } },
      post: { ...post("createSourceConnection", "Create or update a typed source connection", CreateSourceConnectionRequestSchema), security: [{ approvalBearer: [] }], responses: { "201": jsonResponse("Source connection"), ...errors } }
    },
    "/api/source-connections/{connectionId}/test": {
      post: {
        operationId: "testSourceConnection",
        summary: "Test a source connector without synchronizing it",
        security: [{ approvalBearer: [] }],
        parameters: [{ name: "connectionId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": jsonResponse("Connector test result"), ...errors }
      }
    },
    "/api/source-connections/{connectionId}/sync": {
      post: {
        ...post("syncSourceConnection", "Discover source resources, publish source facts, and create semantic proposals", SyncSourceConnectionRequestSchema),
        security: [{ approvalBearer: [] }],
        parameters: [{ name: "connectionId", in: "path", required: true, schema: { type: "string" } }]
      }
    },
    "/api/source-connections/{connectionId}": {
      delete: {
        operationId: "deleteSourceConnection",
        summary: "Delete a source connection and all connection-owned observations",
        security: [{ approvalBearer: [] }],
        parameters: [{ name: "connectionId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Connection deleted" }, ...errors }
      }
    },
    "/api/source-resources": { get: { operationId: "listSourceResources", summary: "List policy-filtered observed source resources", responses: { "200": jsonResponse("Source resources"), ...errors } } },
    "/api/source-sync-runs": { get: { operationId: "listSourceSyncRuns", summary: "List connector synchronization traces", responses: { "200": jsonResponse("Source sync runs"), ...errors } } },
    "/api/semantic/proposals": { get: { operationId: "listSemanticProposals", summary: "List semantic assertion review states", security: [{ approvalBearer: [] }], responses: { "200": jsonResponse("Semantic proposals"), ...errors } } },
    "/api/semantic/proposals/{proposalId}/decision": {
      post: {
        ...post("decideSemanticProposal", "Accept or reject one non-authoritative semantic proposal", SemanticProposalDecisionRequestSchema),
        security: [{ approvalBearer: [] }],
        parameters: [{ name: "proposalId", in: "path", required: true, schema: { type: "string" } }]
      }
    },
    "/api/ingest": { post: { ...post("ingest", "Ingest unstructured text atomically", IngestRequestSchema), security: [{ approvalBearer: [] }], responses: { "201": jsonResponse("Ingested semantic objects"), ...errors } } },
    "/api/ingest/preview": { post: { ...post("previewIngest", "Preview extraction without persistence", IngestRequestSchema), security: [{ approvalBearer: [] }] } },
    "/api/semantic/relations": { post: { ...post("curateRelation", "Create an evidence-backed curated relation", CuratedRelationRequestSchema), security: [{ approvalBearer: [] }], responses: { "201": jsonResponse("Curated relation"), ...errors } } },
    "/api/business/actions/plan": { post: post("planBusinessAction", "Resolve intent into a fingerprinted source write plan", BusinessActionRequestSchema) },
    "/api/business/actions/approve": { post: { ...post("approveBusinessAction", "Approve one exact plan through the separately authenticated human-facing channel", BusinessActionApprovalRequestSchema), security: [{ approvalBearer: [] }], responses: { "201": jsonResponse("Approval record"), ...errors } } },
    "/api/business/actions/execute": { post: { ...post("executeBusinessAction", "Execute an exact plan idempotently and verify source readback", BusinessActionExecutionRequestSchema), responses: { "201": jsonResponse("Business action run"), ...errors } } },
    "/api/business/actions/runs": { get: { operationId: "listBusinessActionRuns", summary: "List action runs", responses: { "200": jsonResponse("Action runs"), ...errors } } },
    "/api/business/actions/approvals": { get: { operationId: "listBusinessActionApprovals", summary: "List approval records through the approver channel", security: [{ approvalBearer: [] }], responses: { "200": jsonResponse("Approval records"), ...errors } } },
    "/api/audit/events": { get: { operationId: "listAuditEvents", summary: "List server-side audit events", responses: { "200": jsonResponse("Audit events"), ...errors } } },
    "/api/discovery/run": { post: post("runDiscovery", "Profile the repository and persist a discovery run with events", DiscoveryRequestSchema) },
    "/api/discovery/runs": { get: { operationId: "listDiscoveryRuns", summary: "List discovery traces", responses: { "200": jsonResponse("Discovery runs"), ...errors } } },
    "/api/graph": { get: { operationId: "getGraph", summary: "Get graph snapshot", responses: { "200": jsonResponse("Graph snapshot"), ...errors } } },
    "/api/agent/manifest": { get: { operationId: "getAgentManifest", summary: "Get agent capability and policy manifest", responses: { "200": jsonResponse("Agent manifest"), ...errors } } },
    "/api/agent/interpret": { post: post("interpretAgentIntent", "Interpret a conversation request with deterministic logic or a real local Hugging Face model", AgentIntentRequestSchema) },
    "/api/providers": { get: { operationId: "getProvider", summary: "Get configured provider and its actual runtime role", responses: { "200": jsonResponse("Provider configuration"), ...errors } } },
    "/api/models/local": { get: { operationId: "listLocalModels", summary: "List sanitized local Hugging Face model metadata and the selected default", responses: { "200": jsonResponse("Local model inventory"), ...errors } } },
    "/api/tools/semantic_search": { post: post("semanticSearch", "Run policy-filtered hybrid search", SearchRequestSchema) },
    "/api/tools/source_resource_search": { post: post("sourceResourceSearch", "Resolve observed source resources before evidence retrieval or actions", SourceResourceSearchRequestSchema) },
    "/api/tools/entity_lookup": { post: post("entityLookup", "Resolve one bounded entity query", EntityLookupRequestSchema) },
    "/api/tools/graph_neighbors": { post: post("graphNeighbors", "Traverse a bounded graph neighborhood", GraphNeighborsRequestSchema) },
    "/api/tools/find_paths": { post: post("findPaths", "Find a bounded relation path", FindPathsRequestSchema) },
    "/api/tools/expand_context": { post: post("expandContext", "Build a bounded policy-filtered evidence pack", ExpandContextRequestSchema) },
    "/api/tools/explain_permissions": { post: post("explainPermissions", "Explain runtime autonomy boundaries", ExplainPermissionsRequestSchema) },
    "/api/evidence/{chunkId}": {
      get: {
        operationId: "getEvidence",
        summary: "Open one policy-filtered evidence span",
        parameters: [{ name: "chunkId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": jsonResponse("Evidence span"), "404": { description: "Evidence absent or denied" }, ...errors }
      }
    },
    "/api/mcp/tools": { get: { operationId: "listMcpTools", summary: "List strict MCP-style descriptors", responses: { "200": jsonResponse("MCP tools"), ...errors } } },
    "/api/mcp/capabilities": { get: { operationId: "getMcpCapabilities", summary: "List MCP server tools, resources, and prompts", responses: { "200": jsonResponse("MCP capabilities"), ...errors } } },
    "/api/poc/local-agent": {
      post: {
        operationId: "runLocalAgentPoc",
        summary: "Run the deterministic audit harness with an optional local Hugging Face trace summarizer",
        requestBody: jsonBody(z.object({ provider: z.enum(["deterministic", "local-huggingface"]).default("deterministic") }).strict()),
        responses: { "200": jsonResponse("PoC audit report"), ...errors }
      }
    }
  }
} as const;
