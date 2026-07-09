import type { FabricModule } from "@semantic-junkyard/shared";

type ModuleInput = Omit<FabricModule, "config"> & Partial<Pick<FabricModule, "config">>;

function defineModule(module: ModuleInput): FabricModule {
  return {
    config: {},
    ...module
  };
}

export const defaultModules: FabricModule[] = [
  defineModule({
    id: "business-action-router.semantic",
    kind: "business-action-router",
    label: "Semantic Action Router",
    status: "active",
    description: "Resolves business intents into source-system targets, diffs, risk, autonomy, and evidence-backed execution plans.",
    interchangeableWith: ["LangGraph planner", "Temporal workflow router", "custom policy planner"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "connector.inline-text",
    kind: "connector",
    label: "Inline Text Connector",
    status: "active",
    description: "Accepts pasted text and API-submitted content as immutable source artifacts.",
    interchangeableWith: ["filesystem", "s3", "git", "web-crawl", "database-dump", "Airbyte", "Meltano"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "parser.local-text-markdown-html",
    kind: "parser",
    label: "Local Parser",
    status: "active",
    description: "Parses plain text, Markdown, and simple HTML into source-spanned elements.",
    interchangeableWith: ["Docling", "Apache Tika", "Unstructured"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "chunker.semantic-window",
    kind: "chunker",
    label: "Semantic Window Chunker",
    status: "active",
    description: "Builds stable chunks with source offsets, token counts, and summaries.",
    interchangeableWith: ["recursive", "heading-aware", "table-aware", "code-aware"],
    externalizable: true,
    risk: "low"
  }),
  defineModule({
    id: "embedding.local-hash",
    kind: "embedding",
    label: "Local Hash Embeddings",
    status: "active",
    description: "Deterministic local embeddings for offline demos and tests.",
    interchangeableWith: ["OpenAI-compatible", "Ollama", "SentenceTransformers", "Jina", "Cohere"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "metadata.sqlite",
    kind: "metadata-store",
    label: "SQLite Metadata Store",
    status: "active",
    description: "Stores sources, chunks, entities, claims, lineage, policies, contracts, and audit events.",
    interchangeableWith: ["PostgreSQL", "DataHub", "OpenMetadata", "Apache Atlas"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "store.sqlite-fts",
    kind: "lexical-store",
    label: "SQLite FTS",
    status: "active",
    description: "SQLite FTS5 lexical index used for BM25-style retrieval.",
    interchangeableWith: ["OpenSearch", "PostgreSQL full text", "Elasticsearch"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "store.local-vector",
    kind: "vector-store",
    label: "Local Vector Index",
    status: "active",
    description: "Stores vectors in SQLite and ranks with cosine similarity.",
    interchangeableWith: ["Qdrant", "pgvector", "Milvus", "Weaviate", "LanceDB"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "store.sqlite-graph",
    kind: "graph-store",
    label: "SQLite Graph Tables",
    status: "active",
    description: "Stores entities, relations, claims, and evidence as property-graph-like tables.",
    interchangeableWith: ["Neo4j", "Kuzu", "Memgraph", "Apache AGE", "FalkorDB", "Apache Jena", "RDFLib"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "object-store.inline",
    kind: "object-store",
    label: "Inline Object Store",
    status: "active",
    description: "Stores source text inside the local metadata database for zero-ops usage.",
    interchangeableWith: ["filesystem", "S3", "MinIO", "Azure Blob", "GCS"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "metric-layer.local-contracts",
    kind: "metric-layer",
    label: "Local Semantic Contracts",
    status: "active",
    description: "Stores governed metric definitions, dimensions, owners, and contract versions.",
    interchangeableWith: ["dbt MetricFlow", "Cube", "Open Semantic Interchange", "LookML import"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "lineage.local-openlineage-shape",
    kind: "lineage-collector",
    label: "Local Lineage Store",
    status: "active",
    description: "Stores lineage edges using an OpenLineage-compatible conceptual model.",
    interchangeableWith: ["OpenLineage", "Marquez", "DataHub lineage", "OpenMetadata lineage"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "ontology.local-json-constraints",
    kind: "ontology-validator",
    label: "Local Ontology Constraints",
    status: "active",
    description: "Validates semantic objects with pragmatic JSON constraints and ontology class rules.",
    interchangeableWith: ["SHACL", "OWL", "RDFS", "Apache Jena", "GraphDB"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "policy.local-abac",
    kind: "policy-engine",
    label: "Local ABAC Policy Engine",
    status: "active",
    description: "Applies read-time deny, mask, and review rules to retrieved context.",
    interchangeableWith: ["OPA", "Apache Ranger", "Permit.io", "OpenFGA", "custom PDP"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "reranker.score-fusion",
    kind: "reranker",
    label: "Score Fusion Reranker",
    status: "active",
    description: "Combines lexical, vector, graph, quality, and policy signals without external calls.",
    interchangeableWith: ["Cohere Rerank", "Jina Reranker", "cross-encoder", "LLM judge"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "scheduler.inline",
    kind: "scheduler",
    label: "Inline Job Runner",
    status: "active",
    description: "Runs ingestion, indexing, and discovery synchronously for the local product.",
    interchangeableWith: ["Temporal", "Dagster", "Ray", "BullMQ", "Celery"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "query-planner.hybrid",
    kind: "query-planner",
    label: "Hybrid Query Planner",
    status: "active",
    description: "Fuses lexical score, vector similarity, and graph evidence boosts.",
    interchangeableWith: ["RRF", "DBSF", "reranker-enhanced", "graph-first"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "agent-tools.rest",
    kind: "agent-tool",
    label: "REST Agent Tools",
    status: "active",
    description: "Exposes semantic search, entity lookup, graph traversal, path finding, context expansion, and evidence opening.",
    interchangeableWith: ["MCP", "GraphQL", "Python SDK", "TypeScript SDK"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "agent-protocol.manifest",
    kind: "agent-protocol",
    label: "Agent Capability Manifest",
    status: "active",
    description: "Publishes capabilities, schemas, risk classes, autonomy boundaries, and stop conditions.",
    interchangeableWith: ["MCP resources", "OpenAPI", "A2A", "custom agent registry"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "writeback.local-source-gateway",
    kind: "writeback-gateway",
    label: "Local Source Writeback Gateway",
    status: "active",
    description: "Writes governed business actions into source-system records through capability-specific adapters and autonomy policy.",
    interchangeableWith: ["OpenMetadata API", "DataHub API", "GitHub PRs", "Jira", "PostgreSQL comments", "ServiceNow"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "reflection.source-readback",
    kind: "reflection-engine",
    label: "Source Reflection Engine",
    status: "active",
    description: "Rereads source-system records after writeback and refreshes the semantic read model only when reflection verifies the write.",
    interchangeableWith: ["CDC", "webhooks", "catalog harvesters", "OpenLineage events", "Temporal activities"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "observability.local-audit",
    kind: "observability",
    label: "Local Audit Log",
    status: "active",
    description: "Records tool use, policy decisions, ingestion, and discovery events.",
    interchangeableWith: ["OpenTelemetry", "Langfuse", "Phoenix", "Arize", "custom SIEM"],
    externalizable: true,
    risk: "high"
  })
];
