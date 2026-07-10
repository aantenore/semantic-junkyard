import {
  BusinessActionApprovalRequestSchema,
  BusinessActionExecutionRequestSchema,
  BusinessActionRequestSchema,
  CatalogSnapshotSchema,
  CuratedRelationRequestSchema,
  DiscoveryRequestSchema,
  EntityLookupRequestSchema,
  ExpandContextRequestSchema,
  ExplainPermissionsRequestSchema,
  FindPathsRequestSchema,
  GraphNeighborsRequestSchema,
  IngestRequestSchema,
  SearchRequestSchema
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
      approvalBearer: { type: "http", scheme: "bearer", description: "Distinct human-approver token. The agent/API token cannot issue approvals." }
    }
  },
  paths: {
    "/api/health": { get: { operationId: "health", summary: "Check API process health", responses: { "200": jsonResponse("Healthy") } } },
    "/api/status": { get: { operationId: "getStatus", summary: "Get semantic fabric counts and modules", responses: { "200": jsonResponse("System status"), ...errors } } },
    "/api/catalog": { get: { operationId: "getCatalog", summary: "Get governed catalog", responses: { "200": jsonResponse("Catalog snapshot"), ...errors } } },
    "/api/catalog/import": { post: post("importCatalog", "Validate and import a catalog snapshot atomically", CatalogSnapshotSchema) },
    "/api/sources": { get: { operationId: "listSources", summary: "List policy-filtered source artifacts", responses: { "200": jsonResponse("Source artifacts"), ...errors } } },
    "/api/source-systems": { get: { operationId: "listSourceSystems", summary: "List writeback capabilities and reflected records", responses: { "200": jsonResponse("Source systems"), ...errors } } },
    "/api/ingest": { post: { ...post("ingest", "Ingest unstructured text atomically", IngestRequestSchema), responses: { "201": jsonResponse("Ingested semantic objects"), ...errors } } },
    "/api/ingest/preview": { post: post("previewIngest", "Preview extraction without persistence", IngestRequestSchema) },
    "/api/semantic/relations": { post: { ...post("curateRelation", "Create an evidence-backed curated relation", CuratedRelationRequestSchema), responses: { "201": jsonResponse("Curated relation"), ...errors } } },
    "/api/business/actions/plan": { post: post("planBusinessAction", "Resolve intent into a fingerprinted source write plan", BusinessActionRequestSchema) },
    "/api/business/actions/approve": { post: { ...post("approveBusinessAction", "Approve one exact plan through the separately authenticated human-facing channel", BusinessActionApprovalRequestSchema), security: [{}, { approvalBearer: [] }], responses: { "201": jsonResponse("Approval record"), ...errors } } },
    "/api/business/actions/execute": { post: { ...post("executeBusinessAction", "Execute an exact plan idempotently and verify source readback", BusinessActionExecutionRequestSchema), responses: { "201": jsonResponse("Business action run"), ...errors } } },
    "/api/business/actions/runs": { get: { operationId: "listBusinessActionRuns", summary: "List action runs", responses: { "200": jsonResponse("Action runs"), ...errors } } },
    "/api/business/actions/approvals": { get: { operationId: "listBusinessActionApprovals", summary: "List approval records through the approver channel", security: [{}, { approvalBearer: [] }], responses: { "200": jsonResponse("Approval records"), ...errors } } },
    "/api/audit/events": { get: { operationId: "listAuditEvents", summary: "List server-side audit events", responses: { "200": jsonResponse("Audit events"), ...errors } } },
    "/api/discovery/run": { post: post("runDiscovery", "Profile the repository and persist a discovery run with events", DiscoveryRequestSchema) },
    "/api/discovery/runs": { get: { operationId: "listDiscoveryRuns", summary: "List discovery traces", responses: { "200": jsonResponse("Discovery runs"), ...errors } } },
    "/api/graph": { get: { operationId: "getGraph", summary: "Get graph snapshot", responses: { "200": jsonResponse("Graph snapshot"), ...errors } } },
    "/api/agent/manifest": { get: { operationId: "getAgentManifest", summary: "Get agent capability and policy manifest", responses: { "200": jsonResponse("Agent manifest"), ...errors } } },
    "/api/providers": { get: { operationId: "getProvider", summary: "Get configured provider and its actual runtime role", responses: { "200": jsonResponse("Provider configuration"), ...errors } } },
    "/api/tools/semantic_search": { post: post("semanticSearch", "Run policy-filtered hybrid search", SearchRequestSchema) },
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
