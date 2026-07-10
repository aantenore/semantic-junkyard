# Semantic Junkyard

Semantic Junkyard is a local-first reference implementation of an **agent-safe semantic federation and verified change-control plane**.

It is not another data catalog and it does not become the authority for connected data. It observes configured sources, preserves evidence and source identity, separates authoritative facts from reviewable semantic proposals, exposes bounded context to agents, and permits a change only through an exact capability contract:

```text
business intent
  -> typed source target and exact diff
  -> source-version preconditions
  -> policy and optional human approval
  -> idempotent write
  -> authoritative source reread
  -> postcondition
  -> semantic refresh only after verification
```

The repository proves this contract against real local filesystem, SQLite, and Git sources. It is deliberately not presented as a production-ready multi-tenant platform.

## What The Product Is

Semantic Junkyard combines two responsibilities that are usually split across several systems:

1. **Semantic federation for agents.** Discover physical and semantic resources across configured sources, materialize provenance-linked evidence, expose lexical/vector/graph retrieval, and retain source authority.
2. **Verified change control.** Resolve a business request to one configured write capability, bind its exact target and preconditions into a fingerprint, enforce policy and approval, execute idempotently, reread the authoritative source, and publish reflection evidence only when the postcondition passes.

The control plane stores observations, proposals, evidence, decisions, plans, approvals, runs, and audit events. The filesystem, operational SQLite database, and Git repository remain the authoritative sources.

Source-local catalog identifiers are namespaced by connection before entering the federated read model. The original identifier remains provenance metadata, so equal IDs from different domains cannot overwrite one another and deleting a connection removes only its owned assets, metrics, policies, lineage, contracts, and ontology classes.

See [Product definition](docs/product-definition.md) for scope and non-goals and [Reference workflow](docs/reference-workflow.md) for an end-to-end acceptance path.

## Local Reference Product

A persistent development start creates a supply-chain reference environment when no source connections exist:

| Source | Discovery | Governed write behavior |
| --- | --- | --- |
| `Supply Chain Knowledge` | Real local files: Markdown policy, CSV reference data, OpenLineage JSON, and supported documents. | Read-only. The filesystem connector has no write method. |
| `Operations Database` | Real SQLite schema, columns, primary/foreign keys, row counts, optional samples, sensitivity signals, and evidence. | One allowlisted `orders.status` update selected by key. A source-row hash is the optimistic precondition; readback uses a new read-only connection and exact field equality. |
| `Semantic Contract Repository` | Real committed Git tree and YAML semantic contracts with commit/blob provenance. | Only configured semantic-contract paths. Approval is required; HEAD and blob hashes are preconditions; the connector commits only the planned path and verifies committed content and fields with `git show`. |

The filesystem connector supports `txt`, `md`, `html`, `json`, `jsonl`, `csv`, `yaml`, `yml`, and `pdf`, with file-count/size bounds and symlink rejection. `metadata_only` and `external_reference` ingestion retain no submitted payload text in the control-plane source record; they index a registration note instead.

There is no generic SQL executor, shell tool, arbitrary file writer, or write path for an unknown source. A write is possible only when a compiled connector resolves exactly one target that is exposed by explicit configuration.

## Semantic Proposal Lifecycle

Source synchronization distinguishes observation from interpretation:

- **Authoritative source facts** such as SQLite columns, foreign keys, and declared contract-to-metric relations are accepted automatically, tagged `source_fact`, and cannot be rejected in the semantic layer. They must be changed at the source or in its authority mapping.
- **Deterministic inferences** and **local-model candidates** are stored as `proposed` assertions with confidence, explanation, origin, resource IDs, and evidence chunk IDs.
- Operators accept or reject non-authoritative proposals with a rationale in the product UI or REST API.
- A later source sync marks assertions that are no longer emitted as `superseded` and removes them from active navigation.

The optional Hugging Face path can suggest concepts, classifications, relations, and conflicts from a bounded list of observed resources. Strict schemas discard malformed output, invented resource IDs, self-relations, duplicates, and over-limit candidates. A model proposal never becomes an authoritative source fact.

## Product And Agent Surfaces

| Surface | Default | Responsibility |
| --- | --- | --- |
| Product workbench (`apps/web`) | `http://localhost:5173` | Operator-facing source registry, connection test/sync, proposal review, retrieval/graph inspection, exact plan review, approval, execution, readback, and audit. |
| External conversational PoC (`apps/poc`) | `http://localhost:5174` | Independent REST client with bounded read-only, plan-only, and autonomous workflows. It stops for missing evidence, no writable source, policy blocks, or required approval. |
| API (`apps/api`) | `http://127.0.0.1:8787` | The complete HTTP control plane and generated OpenAPI document. |
| MCP server (`apps/mcp`) | stdio | External agent surface over the same engine contracts. It opens the selected control-plane SQLite database directly and intentionally cannot create approvals or decide proposals. |

The two React applications do not share frontend state. The browser PoC is not an MCP client; it calls the product API through its own client module. `npm run poc:agent:mcp` is the separate real MCP client/server proof of concept.

## Deterministic And Local-HF Enrichment

The default semantic path is deterministic and offline:

- local parsing and stable chunking;
- extractive summaries and pattern-based entities/relations/claims;
- 128-dimensional signed hash embeddings;
- SQLite FTS5 plus deterministic vector and graph score fusion;
- deterministic source profiling, policy checks, target resolution, and postcondition evaluation.

Local Hugging Face generation through MLX is optional and has three bounded roles: source-enrichment proposals, conversational intent interpretation, and a bundled trace summary. It does not approve actions, bypass connector rules, choose arbitrary targets, or decide whether a postcondition passed. Prompts explicitly request typed output without chain-of-thought; the product records evidence, tool observations, concise explanations, and decisions, not hidden reasoning traces.

`ollama` and `openai-compatible` values currently affect provider configuration reporting only. They are not injected into discovery, extraction, embeddings, planning, or policy. See [Local models](docs/local-models.md).

## Quick Start

Prerequisites: Node.js 20 or later, npm, SQLite support supplied by the lockfile, and Git for the reference contract repository.

```bash
npm ci
npm run dev
```

`npm run dev` builds the shared contracts and starts the API, product workbench, and conversational PoC. The persistent API start creates and synchronizes the local reference sources only when the source registry is empty.

Focused commands:

```bash
npm run dev:product       # API + operator workbench
npm run dev:poc           # API + external REST PoC
npm run build
npm run mcp               # built MCP stdio server
npm run poc:agent:mcp     # real MCP client/server reference run
```

The API reads environment variables from its process. It does not automatically load the root `.env` file. The complete template is [.env.example](.env.example).

## Reference Actions

The seeded SQLite action is autonomous and low-risk:

```text
Set order ORD-1001 status to dispatched
```

The seeded Git action resolves to a configured YAML contract and requires approval:

```text
Use dispatch eligible orders as the denominator for Late Dispatch Rate and publish version 2
```

For both paths, planning is read-only. Execution recomputes the plan against current source state; a changed target, row hash, Git HEAD, blob, diff, risk decision, or warning changes the fingerprint or fails a connector precondition. Only an exact reread that satisfies the connector postcondition can produce `verified` reflection evidence.

If the SQLite row already has the requested allowlisted value, the plan is marked as a no-op and execution performs only the precondition and authoritative reread; it does not issue a redundant `UPDATE`.

## Principal HTTP Contracts

The generated OpenAPI document is at `GET /api/openapi.json`. Principal route groups are:

- Source federation: `GET/POST /api/source-connections`, connection `test` and `sync`, `GET /api/source-resources`, and `GET /api/source-sync-runs`.
- Proposal governance: `GET /api/semantic/proposals` and `POST /api/semantic/proposals/:proposalId/decision`.
- Retrieval: `semantic_search`, `source_resource_search`, `entity_lookup`, `graph_neighbors`, `find_paths`, `expand_context`, and direct evidence reads.
- Change control: `POST /api/business/actions/plan`, `/approve`, and `/execute`; run and approval listings are separate.
- Agent integration: intent interpretation, manifest, MCP descriptors, discovery runs, audit events, and the bundled local PoC route.

Request bodies are strict Zod contracts. Unknown keys, including a caller-supplied `approved` flag, are rejected.

## MCP Contract

Build before starting the stdio server:

```bash
npm run build
npm run mcp
```

Example client configuration:

```json
{
  "mcpServers": {
    "semantic-junkyard": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-junkyard/apps/mcp/dist/server.js"]
    }
  }
}
```

The MCP server exposes bounded tools for permission explanation, resource/semantic search, entity and graph navigation, context/evidence retrieval, discovery, configured-source synchronization, proposal listing, action planning, and action execution. It exposes no tool for connection creation, proposal decisions, or approval creation. An `approvalId` may be consumed only if a human-facing API channel created it for the exact plan.

Use `--db <path>` or `SEMANTIC_JUNKYARD_DB=<path>` to select the control-plane database, `--memory` for an in-memory seeded runtime, and `--no-seed` to disable that memory seed. MCP does not inherit REST authentication or CORS. The spawned process has its operating-system filesystem authority, including access to local source paths stored in the selected database.

See [Agent contract](docs/agent-contract.md).

## Trust Boundaries

- Connected content is untrusted data. It cannot redefine tool policy or connector configuration.
- The local source is authoritative for source facts and postconditions; the control-plane read model is derived.
- Non-authoritative semantic assertions require review and remain distinguishable by lifecycle and origin.
- The browser API boundary and the MCP process boundary are different. REST tokens do not constrain a local MCP process.
- The default tokenless loopback profile grants a development-only local approver role. A non-loopback API requires distinct API and approval bearer tokens, but these static tokens are not production IAM.
- Local idempotency is enforced in the control-plane SQLite database. It is not a distributed transaction or durable exactly-once guarantee across crashes.

## Current Limitations

- Single-node SQLite is the only control-plane store. There is no production clustering, tenancy, migration service, backup orchestration, or high-availability design.
- Only local filesystem, SQLite, and Git connectors are implemented. There are no production DataHub, OpenMetadata, cloud object-store, warehouse, ticketing, or remote Git-provider connectors.
- There is no production IAM, tenant isolation, source-ACL propagation, approval delegation/expiry/revocation workflow, or secrets manager.
- Synchronization and actions run in process. There is no durable job queue, scheduler, retry service, outbox, or crash-recovery reconciler.
- Control-plane transactions and source-native writes are not one distributed transaction. A process failure after a source commit but before control-plane persistence requires reconciliation that is not yet implemented.
- Arbitrary unknown-source writes are intentionally unsupported. SQLite updates require an allowlisted table, key, and columns; Git writes require an allowlisted semantic-contract path; filesystem is read-only.
- Deterministic extraction, entity resolution, intent parsing, and hash embeddings are reference-quality implementations, not production semantic quality.
- Local-HF execution is Apple Silicon/MLX-oriented, depends on a pre-cached compatible model and runtime packages, and has no model-faithfulness release gate.
- The product does not request or persist hidden chain-of-thought. Auditability is based on observable evidence, typed artifacts, policy decisions, tool events, diffs, and source readback.
- Legacy in-memory demo capabilities remain for deterministic compatibility tests. They are not the reference product and must not be described as external integrations.

See [Architecture](docs/architecture.md) for the full boundary analysis.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm run check` runs type checking, Vitest, and the production build; Playwright remains a separate command. See [Evaluation](docs/evaluation.md) and the acceptance checklist in [Reference workflow](docs/reference-workflow.md).

## Repository Layout

```text
apps/api           HTTP control plane, semantic runtime, source connectors, local model harness
apps/mcp           MCP stdio server and external MCP PoC client
apps/poc           independent conversational REST client
apps/web           operator product workbench
packages/shared    strict shared Zod contracts
docs               product, architecture, contracts, workflow, evaluation, and market context
```

## Documentation

- [Product definition](docs/product-definition.md)
- [Reference workflow](docs/reference-workflow.md)
- [Architecture](docs/architecture.md)
- [Agent contract](docs/agent-contract.md)
- [Adapter contracts](docs/adapter-contracts.md)
- [Local models](docs/local-models.md)
- [Evaluation](docs/evaluation.md)
- [Market scan](docs/market-scan.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
