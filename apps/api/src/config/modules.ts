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
    id: "connector.filesystem",
    kind: "connector",
    label: "Filesystem Discovery Connector",
    status: "active",
    description: "Discovers bounded local files, profiles structured formats, extracts PDF text, and enforces configured no-copy ingestion modes.",
    interchangeableWith: ["S3", "MinIO", "Azure Blob", "GCS"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "connector.sqlite-source",
    kind: "connector",
    label: "SQLite Source Connector",
    status: "active",
    description: "Profiles real SQLite schemas and foreign keys and exposes only configured parameterized record-update capabilities.",
    interchangeableWith: ["PostgreSQL", "MySQL", "DuckDB", "warehouse metadata APIs"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "connector.git-contracts",
    kind: "connector",
    label: "Git Semantic Contract Connector",
    status: "active",
    description: "Discovers tracked semantic contracts and applies exact version-guarded changes with commit and git-show readback.",
    interchangeableWith: ["GitHub", "GitLab", "Bitbucket", "dbt Cloud"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "parser.local-text-markdown-html",
    kind: "parser",
    label: "Local Parser",
    status: "active",
    description: "Parses supported text, structured-text, extracted PDF, and simple HTML content with an explicit transformed-text offset basis.",
    interchangeableWith: ["Docling", "Apache Tika", "Unstructured"],
    externalizable: true,
    risk: "medium"
  }),
  defineModule({
    id: "chunker.semantic-window",
    kind: "chunker",
    label: "Semantic Window Chunker",
    status: "active",
    description: "Builds stable chunks with transformed-text offsets, token counts, and extractive summaries.",
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
    description: "Imports the job, run, input, and output identity subset from real OpenLineage event JSON and stores observed lineage edges.",
    interchangeableWith: ["OpenLineage", "Marquez", "DataHub lineage", "OpenMetadata lineage"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "ontology.local-json-constraints",
    kind: "ontology-validator",
    label: "Local Ontology Constraints",
    status: "available",
    description: "Stores ontology classes and constraints. Runtime SHACL, OWL, or rule validation is not yet constructed.",
    interchangeableWith: ["SHACL", "OWL", "RDFS", "Apache Jena", "GraphDB"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "policy.local-sensitivity",
    kind: "policy-engine",
    label: "Local Sensitivity Policy Filter",
    status: "active",
    description: "Enforces actor-clearance filtering for governed assets, resources, graph nodes, evidence, and search, plus configured term masking.",
    interchangeableWith: ["OPA", "Apache Ranger", "Permit.io", "OpenFGA", "custom PDP"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "reranker.score-fusion",
    kind: "reranker",
    label: "Score Fusion Reranker",
    status: "active",
    description: "Combines lexical, local hash-vector, and graph-degree signals without external calls; governance is applied after candidate retrieval.",
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
    id: "writeback.connector-gateway",
    kind: "writeback-gateway",
    label: "Connector Writeback Gateway",
    status: "active",
    description: "Executes fingerprinted writes through real SQLite and Git adapters or explicitly configured additional capabilities.",
    interchangeableWith: ["OpenMetadata API", "DataHub API", "GitHub PRs", "Jira", "PostgreSQL comments", "ServiceNow"],
    externalizable: true,
    risk: "high"
  }),
  defineModule({
    id: "reflection.source-readback",
    kind: "reflection-engine",
    label: "Source Reflection Engine",
    status: "active",
    description: "Requires connector-level authoritative readback and deterministic postconditions before refreshing the semantic read model.",
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
