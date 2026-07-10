# Adapter Contracts

This document separates contracts that exist in code from proposed contracts for future production adapters. The repository is organized into capability modules, but it does not yet have a configuration-driven adapter registry or a common provider interface for every capability.

## Implemented Composition

`SemanticEngine` currently constructs these implementations directly:

| Capability | Implementation | Effective contract |
| --- | --- | --- |
| Source input | `InlineTextConnector` | `createSource(IngestRequest) -> SourceArtifact` |
| Parsing | `LocalTextParser` | `supports(mimeType)` and `parse({ sourceId, text, mimeType }) -> DocumentElement[]` |
| Chunking | `SemanticWindowChunker` | `chunk(sourceId, elements) -> Chunk[]` |
| Extraction | `DeterministicSemanticExtractor` | `extract(chunks) -> { entities, relations, claims }` |
| Embeddings | `embedText` | `string -> number[128]` |
| Retrieval | `HybridQueryPlanner` | `search(SearchRequest) -> SearchResult[]` |
| Policy | `PolicyEngine` | Filter and mask repository-backed results and direct reads. |
| Persistence | `SemanticRepository` | Concrete SQLite CRUD, transactions, graph snapshots, action records, approvals, and audit events. |
| Discovery | `DiscoveryAgent` | Deterministic repository profiling and capability manifest. |
| Business actions | `SemanticEngine` private methods | Regex routing, risk/autonomy calculation, local writes, and reflection. |
| Agent protocol | Express routes and `apps/mcp` | REST/OpenAPI metadata plus a real MCP stdio server. |

Only the parser has a small exported TypeScript interface today. The other rows are concrete APIs, not interchangeable runtime registrations.

## Shared Data Contracts

`packages/shared/src/index.ts` contains the Zod contracts used by REST clients and the engine. HTTP request objects are strict, so unknown keys are rejected.

Important limits include:

- Ingest text: 1 to 5,000,000 characters.
- Search query: 1 to 4,000 characters; `topK` 1 to 25.
- Graph neighbors: depth 1 to 2.
- Path finding: maximum depth 1 to 4.
- Context expansion: at most 25 chunk IDs and 25 entity IDs.
- Action intent: 1 to 4,000 characters.
- Plan fingerprint: exactly 64 lowercase hexadecimal characters.
- Idempotency key: 8 to 128 characters.

The OpenAPI document is generated from these request schemas. The real MCP server now imports the same Zod request schemas for its tools; the REST-only MCP descriptor snapshot is still derived separately from the agent manifest. Contract changes must therefore be tested against REST, the real MCP server, and the descriptor snapshot.

## Ingestion Contract

`IngestRequest` contains:

- Required `name` and `text`.
- Optional `uri`.
- `mimeType`, defaulting to `text/plain`.
- `ingestionMode`: `full_data`, `metadata_only`, or `external_reference`.
- Arbitrary metadata.

The current connector always creates an inline source and always stores the submitted text. For non-full modes, the engine substitutes a generated registration note only for parsing and indexing. This is a behavioral mode, not a storage-enforcement adapter.

A production connector contract should make payload access explicit:

```text
listSources(scope)
describeSource(uri)
readFullData(uri)            only in full_data mode
readMetadata(uri)            only in metadata_only mode
describeExternalReference(uri) without payload access
```

The composition root must prevent a connector from reading a payload when the selected mode does not allow it. That protection does not exist in the current inline connector.

## Parser Contract

The local parser supports plain text, Markdown, HTML, and JSON. It emits source-spanned elements after whitespace normalization; simple HTML is stripped before offsets are computed. Unsupported MIME types fail ingestion.

A production parser adapter should expose:

```text
id
supports(mimeType)
parse(sourceArtifact) -> DocumentElement[]
```

It must document offset semantics, normalization, maximum input, embedded-object handling, sandboxing, and failure behavior. Docling, Apache Tika, and Unstructured are candidate adapters only; none is installed or called.

## Semantic Provider Contract

`ProviderConfig` is an implemented configuration schema:

```text
id
kind: deterministic | ollama | openai-compatible
baseUrl?
model
embeddingModel?
enabled
runtimeUsage: semantic-runtime | configuration-only
```

This is not an inference interface. `loadProviderConfig()` reads environment variables and `GET /api/providers` returns the result. The semantic engine does not receive that configuration.

Current behavior:

- `deterministic` is the active semantic runtime.
- `ollama` is configuration-only.
- `openai-compatible` is configuration-only.
- The local Hugging Face MLX runner is a separate PoC summarizer and is not represented by `ProviderConfig`.

A real provider interface should separate capabilities rather than assume one provider implements all of them:

```text
embed(texts)
extract(schema, chunks)
rerank(query, candidates)
summarize(context)
classifyPolicyRisk(input)
```

Each capability needs typed timeouts, retries, batch limits, model identity, provenance, deterministic-test substitutes, and data-egress policy. Adding an environment variable without injecting and calling an implementation is not a provider integration.

## Store Contracts

The current repository is one SQLite implementation and one transaction boundary. Conceptual production boundaries are:

Metadata store:

```text
saveSource / saveElements / saveChunks
saveEntities / saveRelations / saveClaims
upsertCatalog
saveDiscoveryRun / saveBusinessActionRun / saveApproval
audit
transaction
```

Lexical store:

```text
indexChunks
searchText
deleteBySource
```

Vector store:

```text
upsertVectors
queryVector
deleteBySource
```

Graph store:

```text
upsertEntities / upsertRelations
neighbors / findPaths / graphSnapshot
openEvidence
```

Splitting these stores requires an explicit consistency model. The current engine relies on one SQLite transaction for ingestion and action execution; independent services cannot silently preserve that guarantee.

PostgreSQL, OpenSearch, Qdrant, pgvector, Milvus, Weaviate, LanceDB, Neo4j, Kuzu, Memgraph, Apache AGE, DataHub, and OpenMetadata are design candidates, not implemented adapters.

## Policy Contract

The implemented local policy engine applies simple catalog rules to retrieval and direct source/evidence reads. It is not a general ABAC service and does not propagate per-user source ACLs.

A replaceable policy decision point should support:

```text
evaluateTool(actor, tool, args)
evaluateAsset(actor, asset)
filterAndMask(actor, results)
evaluateAction(actor, plan)
explainDecision(decision)
```

OPA, Apache Ranger, OpenFGA, and custom policy services are external options only. Any policy adapter must fail closed for unavailable decisions and preserve the same filtering on search, evidence, source, graph, and action paths.

## Business Action Contract

The implemented public methods are:

```text
planBusinessAction(BusinessActionRequest) -> BusinessActionPlan
approveBusinessAction(BusinessActionApprovalRequest, actor) -> BusinessActionApproval
executeBusinessAction(BusinessActionExecutionRequest, actor) -> BusinessActionRun
```

Required invariants are stronger than the method signatures:

- Planning has no source-write side effect.
- Approval and execution recompute and compare plan ID and fingerprint.
- Server and caller autonomy ceilings are both enforced.
- Destructive, privileged, unsupported, and evidence-free plans are blocked.
- An approval is separately issued, exact-plan-bound, and single-use after execution.
- A terminal idempotency replay cannot perform another write.
- Writes and local effects occur in one transaction.
- Semantic updates come only from verified source readback.

The current `context` object is accepted but ignored by the router and fingerprint. A future router must define whether context is trusted, how it affects identity, and whether it is fingerprinted.

## Source Writeback And Reflection

The current source-system capability catalog has validated built-in defaults and can be replaced with a JSON array through `SEMANTIC_JUNKYARD_SOURCE_SYSTEMS_FILE`. Validation enforces at least one system, unique system/capability IDs, and matching capability `systemId` values. This configuration changes declared capability metadata, risk, autonomy, and availability; it does not load executable adapters or teach the router new target shapes.

`executeSourceWrite` upserts versioned records into `source_system_records`. Data Catalog and OpenMetadata-shaped targets also mutate local catalog/lineage rows; dbt and ticket targets create only local records. The routing and write branches still depend on the built-in system IDs and operations.

There is no connector interface or external I/O. The following production contract is proposed:

```text
capabilities(system) -> SourceSystemCapability[]
dryRun(target) -> diff
execute(target, exactPlan, approvalContext, idempotencyKey) -> SourceWrite
readBack(write) -> SourceSystemRecord
rollbackHint(write) -> string
```

Reflection should then provide:

```text
reflect(write) -> ReflectionResult
detectDrift(expected, observed)
buildReflectionEvidence(verifiedResults)
refreshReadModel(evidence)
```

Real OpenMetadata/DataHub updates, GitHub/GitLab pull requests, Jira/ServiceNow tickets, database comments, and application APIs need their own remote idempotency and permission models. A local SQLite idempotency key does not prevent a duplicate remote side effect after a crash.

## Agent Protocol Contract

Current protocol surfaces are:

- REST endpoints with generated OpenAPI request schemas.
- Agent manifest at `GET /api/agent/manifest`.
- MCP-style descriptor snapshots at `GET /api/mcp/tools` and `/api/mcp/capabilities`.
- A real MCP stdio server in `apps/mcp`.

The HTTP descriptor routes are not an MCP transport. The MCP process uses direct engine calls and direct database access. It exposes no approval-creation tool.

Future GraphQL or SDK surfaces should reuse shared contracts and preserve strict validation, evidence, policy, exact-plan execution, and idempotency semantics rather than introduce a second business protocol.

## Configuration-Driven Target

A production composition root should load a typed configuration such as:

```text
connectors[]
parsers[]
embeddingProvider
extractionProvider
metadataStore
lexicalStore
vectorStore
graphStore
policyEngine
businessActionRouter
writebackGateways[]
reflectionEngine
```

It should validate capability compatibility before startup and publish only successfully constructed modules in status and agent manifests. The current `defaultModules` list is descriptive and does not perform this composition.
