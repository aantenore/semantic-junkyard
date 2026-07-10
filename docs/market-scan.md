# Market And Design Context

This document records the product hypothesis and adjacent technology categories. It is not a dependency inventory, a current vendor comparison, or evidence that any named external system is integrated. Licensing, maintenance status, protocol support, and product capabilities must be revalidated before an adapter is selected.

## Product Hypothesis

Semantic Junkyard explores a layer between data/knowledge systems and agents: a governed context substrate that combines evidence spans, lexical and vector retrieval, graph navigation, catalog metadata, policy signals, explicit action capabilities, and verified writeback.

The hypothesis is that teams otherwise assemble these concerns from several categories:

- Document parsing and ingestion.
- Enterprise search and RAG.
- Vector databases.
- Knowledge graphs and GraphRAG.
- Data catalogs, lineage, and governance.
- Metric and semantic layers.
- Policy decision points.
- Agent protocols and tool runtimes.
- Workflow, approval, and writeback systems.

The proposed differentiation is not a new database. It is one explicit contract for how an agent discovers evidence, learns its autonomy boundary, plans a business-level action, obtains approval when needed, executes through configured capabilities, and verifies source readback.

## Reference Projects And Categories

Projects considered as design references include:

- Microsoft GraphRAG, Neo4j GraphRAG, Kuzu, Memgraph, Apache Jena, and RDFLib for graph-oriented retrieval and semantic structures.
- Qdrant, pgvector, Milvus, Weaviate, and LanceDB for vector retrieval.
- Docling, Apache Tika, and Unstructured for document parsing.
- DataHub, OpenMetadata, Apache Atlas, OpenLineage, and Marquez for metadata, governance, and lineage.
- dbt MetricFlow, Cube, and Open Semantic Interchange for governed semantic definitions.
- RAGFlow, R2R, Onyx, Cognee, Graphiti, and Zep for retrieval, context, or memory patterns.
- OPA, Apache Ranger, and OpenFGA for policy concepts.
- MCP for agent tool/resource/prompt interoperability.

These names describe adjacent capabilities and possible future adapters. None of them is called by the current runtime. In particular, the local source names `OpenMetadata Mirror` and `dbt Semantic Repository` are SQLite simulations.

## Current Prototype Evidence

The repository currently demonstrates:

- Deterministic inline-text ingestion with provenance and stable IDs.
- SQLite FTS, hash-vector similarity, and a relational graph read model.
- Policy-filtered REST and MCP read tools.
- Separate product and PoC applications over the REST contract.
- Explicit action plans with target diffs, risk, autonomy, ID, and fingerprint.
- Separate exact-plan approval and idempotent execution.
- Versioned local source records and hash-checked reflection before semantic refresh.
- A real MCP stdio server.
- Optional real local MLX generation used only to summarize a deterministic PoC trace.

This is enough to test the interaction contract. It does not demonstrate production interoperability, scale, connector reliability, model-provider interchangeability, or enterprise authorization.

## Current Versus Target

| Concern | Current repository | Product direction |
| --- | --- | --- |
| Ingestion | Inline text; four MIME types | Files, object stores, catalogs, databases, APIs, and external references with enforced no-copy modes. |
| Semantic processing | Deterministic patterns and hash embeddings | Capability-specific local or hosted providers selected through injected contracts. |
| Stores | One SQLite database | Independently replaceable metadata, lexical, vector, graph, and object stores with an explicit consistency model. |
| Policy | Local rule filtering/masking | Identity- and source-ACL-aware policy decision point. |
| Agent access | REST and MCP stdio | Stable SDKs and optional additional protocols without changing action semantics. |
| Writeback | Configurable capability declarations over fixed SQLite source simulations | Real least-privilege connectors with remote idempotency and remote readback. |
| Approval | Static HTTP approver role, no expiry | Identity-backed workflow, expiry, revocation, delegation, and audit retention. |
| Evaluation | Deterministic API/MCP and browser tests | Labeled retrieval/evidence benchmarks plus adapter, security, load, and failure-recovery suites. |

## Validation Questions

Before treating the hypothesis as a product gap, validate with users and a refreshed market review:

1. Do teams need one agent-facing contract across catalog, retrieval, graph, policy, and writeback, or do existing orchestration platforms already satisfy it?
2. Is verified reflection materially safer than connector success responses for the target workflows?
3. Which business actions are common enough to justify stable cross-system capabilities?
4. Which systems remain authoritative, and what latency is acceptable before the semantic read model reflects them?
5. Can policy and evidence semantics remain portable across different stores and agent protocols?
6. Is the operational cost of another control plane lower than direct integration inside existing catalog or workflow products?

The next market scan should be dated, source-linked, and scoped to a concrete buyer, workflow, and deployment model. The current file is design context, not market validation.
