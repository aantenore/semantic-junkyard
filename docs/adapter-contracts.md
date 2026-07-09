# Adapter Contracts

Semantic Junkyard is built around small capability contracts. Adapters can be implemented in-process, via REST, via MCP, or by SDK.

## Connector Adapter

Purpose: discover or ingest source systems.

Required operations:

- `listSources(scope)`
- `describeSource(uri)`
- `readSource(uri)` for full-data ingestion
- `readMetadata(uri)` for metadata-only ingestion
- `externalToolDescriptor(uri)` for external-reference mode

Recommended adapters: filesystem, S3/MinIO, Git, web crawler, Airbyte, Meltano, database schema introspection, DataHub, OpenMetadata.

## Parser Adapter

Purpose: convert source payloads into source-spanned elements.

Required operations:

- `supports(mimeType)`
- `parse(sourceArtifact) -> DocumentElement[]`

Recommended adapters: Docling for PDFs and layout-heavy documents, Apache Tika for broad MIME coverage, Unstructured for ETL-style document processing.

## Model Provider Adapter

Purpose: provide embeddings, extraction, reranking, summarization, and optional planning.

Required operations are capability-specific:

- `embed(texts)`
- `extract(schema, chunks)`
- `rerank(query, candidates)`
- `summarize(context)`
- `classifyPolicyRisk(input)`

The local product uses deterministic rules and local hash embeddings. Production deployments can use Ollama or any OpenAI-compatible endpoint without changing the rest of the system.

## Store Adapters

Metadata store:

- `saveSource`, `saveChunk`, `saveEntity`, `saveRelation`, `saveClaim`
- `saveAsset`, `saveMetric`, `savePolicy`, `saveLineage`
- `audit`

Vector store:

- `upsertVectors`
- `queryVector`
- `deleteBySource`

Graph store:

- `upsertEntity`
- `upsertRelation`
- `neighbors`
- `findPaths`
- `openEvidence`

Lexical store:

- `indexChunk`
- `searchText`

## Policy Adapter

Purpose: decide if a tool, asset, source span, query, or generated action is allowed.

Required operations:

- `evaluateTool(actor, tool, args)`
- `evaluateAsset(actor, asset)`
- `filterResults(actor, results)`
- `explainDecision(decision)`

Local default: ABAC-style rules with allow, mask, deny, and review outcomes.

External options: OPA, Apache Ranger, OpenFGA, custom PDP.

## Agent Protocol Adapter

Purpose: expose the semantic layer to agents in controlled ways.

Current interfaces:

- REST API
- OpenAPI JSON
- MCP-style tool descriptors at `/api/mcp/tools`
- MCP capability snapshot at `/api/mcp/capabilities`
- MCP stdio server in `apps/mcp`
- Agent capability manifest at `/api/agent/manifest`

Future interfaces:

- GraphQL
- Python and TypeScript SDKs
- Federated context packages for distributed semantic layers

## Curation Adapter

Purpose: let a human or approval workflow turn candidate semantics into authoritative graph facts.

Required operations:

- `previewIngest(source) -> chunks, entities, relations, claims, warnings`
- `curateRelation(source, relationType, target, evidence, rationale)`
- `rejectRelation(relationId, rationale)` for future review queues
- `upsertOntologyRule(rule)` for future controlled extraction

Local default: `POST /api/ingest/preview` and `POST /api/semantic/relations`.

Production options: approval queue, Git-backed semantic contracts, dbt semantic manifests, OpenLineage imports, ontology/SHACL validation, or stewardship workflows in DataHub/OpenMetadata.
