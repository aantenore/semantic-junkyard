export const demoDocuments = [
  {
    name: "semantic-layer-for-agents.md",
    mimeType: "text/markdown",
    text: `# Semantic Layer For AI Agents

Semantic Junkyard connects data catalogs, metadata graphs, semantic contracts, vector search, and knowledge graphs into an agent-safe context layer.

An AI agent should not query raw systems without guidance. It needs governed metadata about asset ownership, freshness, quality, sensitivity, lineage, and business definitions.

The platform exposes semantic_search, entity_lookup, graph_neighbors, find_paths, expand_context, open_source_span, and explain_permissions as evidence-first tools. It also exposes business_action_plan and business_action_execute for policy-governed source writeback with required source reflection. Generated SQL, destructive changes, and privileged source mutations require approval-gated adapters.

Open Semantic Interchange helps make metrics, dimensions, datasets, and relationships portable across analytics tools. MetricFlow-style metric definitions can be imported as semantic contracts.

DataHub, OpenMetadata, and Apache Atlas provide metadata graph patterns. OpenLineage and Marquez provide lineage event patterns. GraphRAG, Neo4j, Kuzu, Qdrant, Docling, and Apache Tika can be used as interchangeable backend modules.`
  },
  {
    name: "agentic-discovery-playbook.txt",
    mimeType: "text/plain",
    text: `Agentic discovery starts by profiling available sources, catalog assets, lineage, quality signals, and policies.

When an undefined problem arrives, the agent first asks what data assets are relevant, whether the assets are authorized, whether the metric definitions are governed, and what evidence supports each candidate answer.

The discovery loop should identify duplicate concepts, stale datasets, missing owners, ambiguous metrics, broken lineage, low-confidence relationships, and unsafe access paths.

Policy-aware retrieval must distinguish available data from authorized data and reliable data. Evidence is mandatory for every claim, relation, entity, and recommendation.`
  },
  {
    name: "billing-context.html",
    mimeType: "text/html",
    text: `<h1>Billing Pipeline Context</h1>
<p>The Billing Pipeline writes to the Revenue Mart and uses Retry Policy to handle failed payments.</p>
<p>Failed Payment Rate depends on payment attempts, failed payment attempts, payment provider, plan, and retry policy.</p>
<p>The Finance Semantic Contract governs revenue_mart and defines Net Revenue and Failed Payment Rate.</p>
<p>Agents can inspect Billing Pipeline lineage, but direct customer identifiers such as email and customer_id must be masked unless clearance is confidential.</p>`
  }
];
