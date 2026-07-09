# Market Scan

Semantic Junkyard sits at the intersection of data catalog, metadata graph, semantic layer, ontology, vector search, GraphRAG, lineage, policy, and agent tool access.

## Closest Open-Source References

- Microsoft GraphRAG: graph-based indexing and query-time augmentation over unstructured corpora.
- Cognee: memory and graph-oriented context for agents.
- Graphiti/Zep: temporal knowledge graph memory.
- R2R and RAGFlow: production RAG platforms with ingestion and retrieval.
- Onyx: open-source enterprise AI search and connectors.
- DataHub, OpenMetadata, Apache Atlas: metadata catalog, discovery, governance, lineage.
- OpenLineage and Marquez: standard lineage event capture.
- dbt MetricFlow and Cube: governed metrics and semantic definitions.
- Open Semantic Interchange: portable semantic model definitions.
- Neo4j GraphRAG, Kuzu, Memgraph, Apache Jena, RDFLib: graph and semantic-web backends.
- Qdrant, pgvector, Milvus, Weaviate, LanceDB: vector backends.
- Docling, Apache Tika, Unstructured: parsing backends.

## Product Gap

Existing tools are usually one of these:

- RAG-first.
- Graph-first.
- Memory-first.
- Catalog-first.
- BI semantic-layer-first.
- Enterprise closed-source context layer.

The gap is a modular OSS context substrate that agents can inspect safely and that can federate with existing systems instead of replacing them.

## Differentiation

1. Capability-agnostic control plane: every major function can be local or external.
2. Agent-readable autonomy boundary: capabilities, schemas, risk, evidence, and stop conditions are explicit.
3. Connection modes: full data, metadata-only, and external-reference ingestion are first-class.
4. Provenance-first graph: every entity, relation, claim, and result points to source evidence.
5. Distributed semantic contracts: domains can publish versioned context packages rather than forcing one central ontology.
6. Policy-aware retrieval: available, authorized, and reliable data are distinct.
7. Built-in evaluation path: retrieval, graph usefulness, citation quality, policy compliance, and drift can be tested.

