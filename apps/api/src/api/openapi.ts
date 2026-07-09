export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Semantic Junkyard API",
    version: "0.1.0",
    description: "Agent-native semantic layer API for ingestion, discovery, governance-aware retrieval, and graph navigation."
  },
  paths: {
    "/api/status": { get: { summary: "Get system status and active modules" } },
    "/api/catalog": { get: { summary: "Get semantic assets, metrics, policies, lineage, ontology, and contracts" } },
    "/api/catalog/import": { post: { summary: "Import a semantic catalog snapshot" } },
    "/api/ingest": { post: { summary: "Ingest unstructured text into the semantic fabric" } },
    "/api/discovery/run": { post: { summary: "Run the discovery agent over current corpus and catalog" } },
    "/api/discovery/runs": { get: { summary: "List recent discovery runs" } },
    "/api/graph": { get: { summary: "Get graph snapshot" } },
    "/api/agent/manifest": { get: { summary: "Get capability manifest for autonomous agents" } },
    "/api/providers": { get: { summary: "Get active model/provider configuration" } },
    "/api/tools/semantic_search": { post: { summary: "Hybrid search across lexical, vector, graph, and policy signals" } },
    "/api/tools/entity_lookup": { post: { summary: "Resolve entities with evidence and graph degree" } },
    "/api/tools/graph_neighbors": { post: { summary: "Inspect bounded graph neighborhoods" } },
    "/api/tools/find_paths": { post: { summary: "Find graph paths between entities" } },
    "/api/tools/expand_context": { post: { summary: "Build a citation-ready evidence pack" } },
    "/api/tools/explain_permissions": { post: { summary: "Explain allowed and disallowed actions for an intent" } },
    "/api/evidence/{chunkId}": { get: { summary: "Open a source-spanned evidence chunk" } },
    "/api/mcp/tools": { get: { summary: "List MCP-style tool descriptors" } }
  }
};
