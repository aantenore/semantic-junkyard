# Adapter Contracts

This document distinguishes implemented local adapters from requirements for future production connectors. The current runtime has a typed source connector registry, but it is compiled into the API/MCP composition root rather than loaded dynamically from plugins.

## Implemented Composition

| Capability | Implementation | Current contract |
| --- | --- | --- |
| Source registry | `SourceManager` + `SourceConnectionRepository` | Create/test/sync/delete typed connections; persist resources, runs, events, and proposals. |
| Source connectors | `FilesystemConnector`, `SqliteConnector`, `GitConnector` | Test/discover; SQLite and Git also plan/execute/read actions. |
| Evidence materialization | `InlineTextConnector` + `LocalTextParser` | Persist full text or no-copy registration note, then parse/chunk/index. |
| Semantic enrichment | deterministic connector facts plus optional `LocalSourceSemanticEnrichmentProvider` | Publish source facts; validate model output into proposals. |
| Retrieval | `SemanticWindowChunker`, hash embeddings, FTS5, `HybridQueryPlanner` | Deterministic bounded lexical/vector/graph retrieval. |
| Policy | `PolicyEngine` | Filter/mask local reads and contribute action review/deny decisions. |
| Control-plane store | `SemanticRepository` and `SourceConnectionRepository` | One SQLite transaction domain for derived state, plans/runs, approvals, and audit. |
| Agent protocols | Express REST and `apps/mcp` stdio | Shared strict Zod contracts over separate process/auth boundaries. |

## Source Connector Interface

The implemented conceptual interface is:

```ts
interface SourceConnector {
  readonly kind: "filesystem" | "sqlite" | "git";
  test(connection): ConnectorTestResult;
  discover(connection): ConnectorSnapshot;
  planAction?(connection, businessRequest, observedResources): ConnectorActionCandidate | null;
  executeAction?(connection, exactCandidate): ConnectorWriteResult;
  readAction?(connection, exactCandidate): ConnectorWriteResult;
}
```

`ConnectorSnapshot` contains resources, evidence documents, assets, metrics, lineage, contracts, ontology classes, structural relations, warnings, and a source checkpoint. Discovery must be bounded and must preserve stable external/resource identity.

`ConnectorActionCandidate` contains one typed source target, evidence, exact before/after state, risk/approval requirements, and connector parameters. `ConnectorWriteResult` contains the source version, expected state, authoritative readback, explicit postcondition text/result, and connector metadata.

## Connection Configuration

All connection requests are strict discriminated unions.

### Filesystem

```text
kind: filesystem
rootPath
recursive
maxFiles
maxFileBytes
ingestionMode: full_data | metadata_only | external_reference
```

Filesystem is read-only. The connector rejects a symlink root, skips symlink entries, and reads only supported formats inside the resolved root.

### SQLite

```text
kind: sqlite
databasePath
includeTables[]
sampleRows: 0..20
writeMode: read_only | approval_required | autonomous
writeRules[]:
  table
  aliases[]
  keyColumn
  allowedColumns[]
  risk
```

The configuration is capability exposure, not a generic database credential. Ambiguous duplicate table rules disable writes for that table. Missing tables/columns fail validation. Identifiers come from validated schema/rules; values are bound parameters.

### Git

```text
kind: git
repositoryPath
includePaths[]
maxFiles
maxFileBytes
writeMode: read_only | approval_required | autonomous
semanticContractPaths[]
```

Only committed supported text blobs are discovered. Only configured YAML semantic-contract paths can become writable, and the target must be clean and parseable.

## Filesystem Discovery Contract

Implemented format behavior:

| Format | Materialized behavior |
| --- | --- |
| Text/Markdown/HTML | Evidence document with local parser normalization. |
| JSON/JSONL/CSV | Evidence plus deterministic record/field profiling. |
| YAML | Evidence plus semantic-contract parsing when required fields are declared. |
| PDF | Bounded text extraction in a worker with timeout/output limits. |
| OpenLineage-shaped JSON | Job/dataset resources and explicit READS/WRITES lineage. |

Declared contract facts such as `DEFINES_METRIC` are authoritative. A typed resource derived from a file may also have non-authoritative representation relations such as `INDEXED_FROM`, which enter proposal lifecycle rather than source-fact authority.

## SQLite Discovery And Write Contract

Discovery opens the source read-only, enables foreign keys and `query_only`, performs a quick check, and inspects the real schema. It may profile bounded sample rows when configured. Table/column resources carry sensitivity, writability, schema source, row/column counts, primary keys, and foreign keys.

Planning accepts only bounded update-like intent and rejects delete/drop/truncate/insert/create/alter/attach/detach/pragma patterns. It must resolve:

1. exactly one valid configured write rule;
2. exactly one source row by the configured key;
3. one or more updates entirely inside `allowedColumns`;
4. evidence linked to the table/key/updated columns;
5. a canonical full-row hash as the source-version precondition.

Execution repeats configuration and candidate validation, verifies the row hash in an immediate transaction, performs one parameterized update, requires one changed row, then rereads through an independent read-only connection. The postcondition is exact value equality for every changed field.

## Git Discovery And Write Contract

Discovery reads the committed Git tree at `HEAD`, validates blob sizes/text, and records path, commit SHA, blob SHA, and composite version. YAML documents that satisfy the semantic-contract schema publish contracts/assets/metrics with provenance.

Planning understands only the implemented semantic-contract mutations, currently version/status publication and metric denominator/version changes. It resolves one configured clean path and places exact before/after YAML, expected HEAD/blob, expected parsed fields, and commit message in the target.

Execution must:

- confirm the path remains allowlisted and inside the repository;
- verify expected HEAD/blob and unchanged target state;
- verify planned YAML fields before writing;
- stage content whose blob hash equals the planned content;
- commit only the target path;
- verify parent commit and changed path set;
- reread committed content and verify exact content plus parsed fields.

The connector restores the target/index when an error occurs before a commit. Once a Git commit exists, there is no distributed rollback with the control-plane database.

## Evidence Ingestion Contract

Direct operator ingestion and connector materialization share `IngestRequest`:

```text
name
text
uri?
mimeType
ingestionMode
metadata
```

`full_data` requires non-empty text and retains it. `metadata_only` and `external_reference` may carry text in the request for compatibility, but `InlineTextConnector` stores an empty payload and computes identity from the source descriptor instead. The parser indexes a generated registration note containing name, URI, and metadata.

No-copy here means the submitted payload is not retained in the control-plane `sources`, elements, or chunks. It does not prove that an upstream connector never read the file in memory; the filesystem connector must read supported files to profile/identify them before deciding what to materialize.

## Semantic Enrichment Contract

Deterministic connector output and model candidates are separate:

- connector-declared structural facts can set `authoritative: true`;
- deterministic representation/inference relations are proposals;
- local-HF receives at most 24 bounded resource summaries and returns strict candidate arrays;
- every model resource ID must come from the supplied set;
- malformed, invented, duplicate, self-referential, or over-limit candidates are discarded;
- model candidates always use origin `local_model` and status `proposed`.

The enrichment provider does not update source data, accept proposals, or alter policy.

## Business Action Adapter Contract

The public engine contract is:

```text
planBusinessAction(request) -> BusinessActionPlan
approveBusinessAction(exactPlanRequest, actor) -> BusinessActionApproval
executeBusinessAction(exactPlanRequest + idempotencyKey, actor) -> BusinessActionRun
```

Connector invariants:

- planning has no source-write side effect;
- target identity and all execution-relevant parameters are fingerprinted;
- candidate resolution fails closed on zero/multiple matches;
- execution revalidates allowlist, candidate shape, and source preconditions;
- connector readback comes from the authoritative source, not the planned object;
- a postcondition is typed enough to evaluate deterministically;
- only verified results can refresh semantic evidence;
- no connector accepts raw generated SQL, shell commands, arbitrary paths, or generic JSON patches as its business intent.

## Policy Contract

The local policy engine is a reference implementation. A production policy decision point should provide consistent decisions over:

```text
evaluateTool(actor, tool, args)
evaluateResource(actor, resource)
evaluateEvidence(actor, chunk)
evaluateGraph(actor, nodes, edges)
evaluateAction(actor, exactTarget)
filterAndMask(actor, output)
explainDecision(decision)
```

It must fail closed when unavailable and carry source-native ACL/identity context. The current static roles and sensitivity clearance do not satisfy that requirement.

## Store And Delivery Contracts

The reference product relies on one SQLite control plane and synchronous in-process jobs. Splitting metadata, lexical, vector, graph, policy, jobs, and audit into services requires an explicit consistency protocol.

A production write adapter needs more than `execute`:

```text
capabilities(identity) -> typed capabilities
plan(intent, observedState) -> target + preconditions + postcondition
reserve(idempotencyKey, fingerprint) -> durable intent
execute(reservation) -> source operation identity
readAuthoritative(operation) -> observed state/version
verify(expected, observed) -> postcondition result
reconcile(reservation) -> terminal outcome
```

The platform also needs a durable queue/outbox, retries, dead-letter handling, leases, crash recovery, and auditable reconciliation. None is implemented.

## Protocol Contract

REST and MCP reuse shared Zod schemas for core inputs/outputs. The HTTP routes `/api/mcp/tools` and `/api/mcp/capabilities` are descriptors, not an MCP transport. The real MCP server is stdio and calls the engine directly.

Any future SDK, GraphQL surface, remote MCP transport, or connector plugin must preserve:

- strict unknown-field rejection;
- evidence and authority lifecycle;
- exact plan identity and approval binding;
- idempotency conflict behavior;
- connector preconditions and authoritative reread;
- no semantic publication before postcondition verification.

## Extension Requirements

Before calling an adapter production-ready, add and test:

- explicit credentials/secrets ownership and least privilege;
- tenant/actor identity and source ACL propagation;
- bounded discovery with checkpoints and incremental resume;
- stable source/object/version identity;
- schema evolution and deletion semantics;
- remote rate limits, timeouts, retries, and circuit breaking;
- remote idempotency and reconciliation after ambiguous failures;
- approval expiry/revocation/delegation;
- structured redaction and data-egress policy;
- contract, integration, failure-injection, and recovery tests.

Names such as DataHub, OpenMetadata, Ossie, object stores, warehouses, GitHub/GitLab, Jira, and ServiceNow are product-direction candidates only. No such remote adapter is implemented in this repository.
