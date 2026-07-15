# Market Scan

**Reviewed: 2026-07-15.** This scan uses official project/product documentation and repositories. It is a positioning aid, not a procurement scorecard. Capabilities, editions, and licenses should be revalidated before making an adoption decision.

## Product Hypothesis

Semantic Junkyard is not differentiated by having search, a graph, an MCP server, semantic metadata, or proposals. Established products already provide those capabilities at much greater breadth and production maturity.

The narrower hypothesis is that agentic systems need a reusable **verified change-control protocol across authoritative sources**:

```text
business intent -> typed target -> source preconditions -> policy/approval
-> idempotent source write -> authoritative reread -> postcondition
```

The semantic federation exists to ground that protocol in source identity and evidence. It is not the product's claim to be a better general catalog.

## Primary Comparisons

| Project | Officially documented center of gravity | Overlap | Semantic Junkyard differentiation and limit |
| --- | --- | --- | --- |
| [DataHub Agent Context Kit](https://docs.datahub.com/docs/dev-guides/agent-context/agent-context) | A broad context platform and agent kit exposing business definitions, documents, ownership, lineage, quality, sample queries, MCP/SDK integrations, and mutation tools for tags, descriptions, glossary terms, domains, owners, and documents. | Governed context, search, lineage, agent tools, proposals/stewardship, metadata mutation. | Semantic Junkyard focuses on source-native SQLite/Git changes with fingerprinted preconditions, separate exact approval, local idempotency, and authoritative postcondition readback. It has nowhere near DataHub's connector, catalog, IAM, scale, or operational maturity. A production direction should integrate with DataHub rather than rebuild its context platform. |
| [OpenMetadata MCP tools](https://docs.open-metadata.org/v1.12.x/how-to-guides/mcp/reference) | An authenticated MCP surface over OpenMetadata's knowledge graph with search/details/lineage plus create/patch tools for lineage, glossary, classifications, tags, domains, data products, tests, metrics, and entities. [MCP authentication](https://docs.open-metadata.org/v1.12.x/how-to-guides/mcp/oauth) uses the OpenMetadata identity boundary. | Catalog/graph context, semantic search, governance metadata, MCP reads and writes. | Semantic Junkyard does not claim that OpenMetadata is read-only. The distinction is the explicit cross-source plan/precondition/approval/idempotency/reread/postcondition protocol demonstrated against an operational SQLite row and Git contract. The cited MCP reference does not define that same source-native completion protocol. OpenMetadata is the stronger choice for a production metadata platform. |
| [Apache Ossie (incubating)](https://github.com/apache/ossie) ([Apache incubation status](https://incubator.apache.org/clutch/ossie.html)) | Formerly Open Semantic Interchange (OSI): a vendor-neutral JSON/YAML specification, validation, and converters for semantic models, datasets, fields, relationships, metrics, and AI context. The project entered Apache incubation in June 2026 and currently lists no release. | Portable semantic definitions and Git-managed semantic model artifacts. | Ossie standardizes the artifact; Semantic Junkyard governs observation, proposal lifecycle, and source changes. They are complementary. The current reference contract format is not claimed to be Ossie-compatible; an Ossie parser/validator/converter should replace custom format handling before production interoperability claims. |
| [TrustGraph](https://docs.trustgraph.ai/) | An agent intelligence/runtime platform centered on context graphs, vector/graph retrieval, GraphRAG, orchestration, and inference. Its [explainability model](https://docs.trustgraph.ai/overview/explainability) traces extraction and query behavior through named RDF graphs and PROV-O; its [MCP integration](https://docs.trustgraph.ai/guides/mcp-integration/) connects agent tools. | Graph/vector context, provenance, agent runtime, MCP integration, local deployment. | Semantic Junkyard is much narrower: source federation plus verified business changes. It records evidence, typed artifacts, decisions, diffs, and readbacks and deliberately does not capture hidden chain-of-thought. TrustGraph is the stronger fit for a general GraphRAG/context-graph runtime; the cited docs do not present Semantic Junkyard's exact source mutation protocol as their central contract. |

## What Already Exists

The market clearly contains mature answers for:

- enterprise metadata ingestion, catalogs, ownership, lineage, quality, governance, and context activation;
- MCP access to catalog/knowledge-graph reads and metadata mutations;
- semantic model interchange standards;
- graph/vector retrieval, GraphRAG, agent orchestration, provenance, and explainability;
- human proposal/review workflows for metadata enrichment.

Building those capabilities from scratch would be strategically weak. Semantic Junkyard should reuse them through adapters when moving beyond the local reference.

## Remaining Product Question

The potentially distinct product surface is not "context for agents" in general. It is a source-agnostic control contract with these combined invariants:

1. An agent starts from business intent and observed evidence, not a generic mutation tool.
2. Resolution produces a typed authoritative target and complete exact diff.
3. Source-version preconditions are part of the reviewed fingerprint.
4. Policy and human approval are separate from the agent and bound to that fingerprint.
5. Retries are identity-checked and idempotent.
6. Completion requires an authoritative source reread and explicit postcondition.
7. Only verified state refreshes semantic evidence.

The reference repository proves this locally for one SQLite update shape and one Git semantic-contract commit shape. It does not yet prove that the abstraction survives remote APIs, partial failures, long-running approvals, multi-target workflows, or production identity systems.

## Buy, Integrate, Or Build

| Need | Better default |
| --- | --- |
| Production catalog, connectors, context graph, governance, IAM | Adopt/evaluate DataHub or OpenMetadata; do not rebuild them here. |
| Portable semantic model definitions | Track and adopt Apache Ossie rather than invent another interchange standard. |
| General GraphRAG, context graphs, agent orchestration/inference | Evaluate TrustGraph and other established runtimes. |
| Verified source change protocol across heterogeneous systems | Continue validating Semantic Junkyard's narrow contract, ideally as an integration layer over the systems above. |

## Validation Risks

- DataHub/OpenMetadata may add stronger proposal, approval, or source-action protocols that close the gap.
- Existing workflow/orchestration products may provide idempotency, approval, and reconciliation more robustly when paired with catalog context.
- Source-specific semantics may prevent a useful common target/postcondition abstraction.
- A separate control plane may add more consistency and security burden than embedding the contract in each authoritative platform.
- Without durable jobs/outbox/reconciliation and production IAM, the local protocol is a demonstration rather than a deployable category.
- Customers may value read-only governed context much more than cross-source agent writes.

## Next Validation

1. Implement one remote metadata connector and one remote operational connector without weakening plan/readback semantics.
2. Add durable intent/outcome storage, outbox, retry, and reconciliation before expanding write breadth.
3. Use an existing catalog for identity/context rather than duplicating catalog ingestion.
4. Parse and validate Apache Ossie artifacts instead of extending a proprietary semantic-contract format.
5. Test buyer demand for verified reflection versus ordinary connector success responses.
6. Re-run this official-source scan before each product milestone.
