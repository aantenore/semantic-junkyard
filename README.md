# Semantic Junkyard

Semantic Junkyard is a local-first prototype for turning inline text into policy-filtered lexical, vector, and graph context for agents. The current repository contains a deterministic semantic runtime, a product workbench, a separate proof-of-concept (PoC) client, and an MCP stdio server.

This is not yet a production connector platform. SQLite is the only implemented store, ingestion is limited to an inline-text connector, and the named catalog, OpenMetadata, dbt, and ticketing integrations are simulated as local SQLite source records.

## Applications

The repository has two independent React applications over the same REST API:

| Surface | Default URL | Current role |
| --- | --- | --- |
| Product workbench (`apps/web`) | `http://localhost:5173` | Ingestion preview and persistence, search, graph inspection, curation, discovery, action planning, local approval, execution, and reflected readback. |
| PoC cockpit (`apps/poc`) | `http://localhost:5174` | External REST client that displays a deterministic, evidence-first tool trace. It can run read-only, plan-only, or autonomous flows and stops when approval is required. |
| API (`apps/api`) | `http://127.0.0.1:8787` | Express API and in-process semantic runtime. |
| MCP server (`apps/mcp`) | stdio | A real MCP server over the same engine and SQLite schema. It does not proxy the REST API. |

The product and PoC applications do not share frontend state. The PoC is not embedded in the product and is not the MCP client; it calls the product REST API through its own client module.

## Runtime Boundary

The default semantic runtime is deterministic and offline:

- Local parsing for plain text, Markdown, simple HTML, and JSON.
- Stable window chunking and extractive summaries.
- Pattern-based entity, relation, and claim extraction.
- 128-dimensional hash embeddings and cosine similarity.
- SQLite FTS5 lexical retrieval, vectors stored as JSON, and graph tables.
- Deterministic score fusion, discovery profiling, action routing, risk checks, writeback simulation, and reflection checks.

`SEMANTIC_JUNKYARD_MODEL_PROVIDER=ollama` and `openai-compatible` change the configuration returned by `GET /api/providers`; they do not replace extraction, embeddings, reranking, planning, or policy logic. Those providers are explicitly reported as `runtimeUsage: "configuration-only"`.

The optional Hugging Face path is different: `npm run poc:agent:hf` performs real local generation through MLX, but only after the deterministic tool sequence has completed. The model receives a bounded evidence prompt and produces an audit summary. It does not choose tools, approve actions, execute writes, or change the final policy decision. See [Local models](docs/local-models.md).

## Quick Start

Prerequisites are Node.js 20 or later and npm. Use the lockfile for a reproducible install:

```bash
npm ci
npm run dev
```

`npm run dev` builds the shared package, then starts the API, product workbench, and PoC cockpit. The API seeds a demo catalog and corpus only when their corresponding tables are empty.

Focused development commands:

```bash
npm run dev:product  # API and product workbench
npm run dev:poc      # API and PoC cockpit
npm run seed         # seed the configured API database
npm start            # built API only
```

Runtime variables must be exported into the API process or supplied by a process manager. The API does not load a root `.env` file itself. Vite does load root environment files for the two frontend dev servers.

## Product API

The generated OpenAPI document is available at `GET /api/openapi.json`. Principal routes are:

- State: `GET /api/status`, `/api/catalog`, `/api/sources`, `/api/source-systems`, `/api/graph`, `/api/providers`.
- Ingestion and curation: `POST /api/ingest/preview`, `/api/ingest`, `/api/catalog/import`, `/api/semantic/relations`.
- Discovery: `POST /api/discovery/run`, `GET /api/discovery/runs`.
- Agent reads: `POST /api/tools/explain_permissions`, `/semantic_search`, `/entity_lookup`, `/graph_neighbors`, `/find_paths`, `/expand_context`; `GET /api/evidence/:chunkId`.
- Actions: `POST /api/business/actions/plan`, `/approve`, `/execute`; `GET /api/business/actions/runs`, `/approvals`.
- Audit and protocol metadata: `GET /api/audit/events`, `/api/agent/manifest`, `/api/mcp/tools`, `/api/mcp/capabilities`.
- Bundled PoC runner: `POST /api/poc/local-agent` with `{ "provider": "deterministic" }` or `{ "provider": "local-huggingface" }`.

Request schemas are strict. Unknown fields, including the former caller-supplied `approved` flag, are rejected.

## Exact Action Protocol

Business actions use a plan-review-execute protocol. Execution is not accepted from an intent alone.

1. Plan with `POST /api/business/actions/plan`:

```json
{
  "intent": "Align Failed Payment Rate definition across Finance and Billing",
  "mode": "autonomous",
  "maxAutonomousRisk": "medium",
  "context": {}
}
```

The response contains the server-generated `id`, 64-character SHA-256 `fingerprint`, targets, diffs, evidence IDs, risk, autonomy, and status. Planning does not persist the plan or write source records.

2. If the returned status is `approval_required`, an approver calls `POST /api/business/actions/approve` with the exact plan fields:

```json
{
  "planId": "<plan.id>",
  "planFingerprint": "<plan.fingerprint>",
  "intent": "<plan.intent>",
  "mode": "<plan.mode>",
  "maxAutonomousRisk": "<plan.maxAutonomousRisk>",
  "rationale": "Reviewed target systems, diffs, evidence, and autonomy.",
  "context": {}
}
```

Approval requires the HTTP approver role. It creates an active approval bound to one plan ID and fingerprint. MCP deliberately has no approval-creation tool.

3. Execute with `POST /api/business/actions/execute`:

```json
{
  "planId": "<plan.id>",
  "planFingerprint": "<plan.fingerprint>",
  "intent": "<plan.intent>",
  "mode": "<plan.mode>",
  "maxAutonomousRisk": "<plan.maxAutonomousRisk>",
  "approvalId": "<approval.id when required>",
  "idempotencyKey": "<unique key for this exact plan>",
  "context": {}
}
```

The server rebuilds the plan from the submitted request and current local state. Both `planId` and `planFingerprint` must match; otherwise it returns `409 PLAN_CHANGED`. The plan ID is a stable truncated hash of the intent, resolved action type, and target object keys. The fingerprint is SHA-256 over the plan ID, intent, action type, mode, requested autonomy ceiling, resolved risk, full targets, and warnings. `createdAt` is not fingerprinted.

The idempotency key is a caller-owned string of 8 to 128 characters and is globally unique in the SQLite action-run table. A terminal run (`planned` dry run, `blocked`, `verified`, `reflected`, or `failed`) is returned unchanged when the same exact request retries the key. An `approval_required` run is the exception: the same request and key may resume after an exact approval is supplied. Reusing a key with another plan ID, fingerprint, intent, mode, or autonomy ceiling returns `409 IDEMPOTENCY_CONFLICT`.

Execution writes all targets in one SQLite transaction, rereads each local source record, and verifies record identity, version, write ID, intent, plan ID, target, operation, diff, and expected hash. Only verified records produce reflection evidence and semantic updates. The run is `verified` only when every write verifies; partial or drifted readback is `reflected`. An approval is consumed after the executing transaction completes, including a transaction whose readback status is `reflected`.

## Local Source Simulation

The action router currently recognizes a small, regex-driven set of intents and maps them to four local capability shapes. The default capability catalog is built in, and `SEMANTIC_JUNKYARD_SOURCE_SYSTEMS_FILE` can replace it with a validated JSON array. That file configures capability metadata, risk, and autonomy; it does not install connector code or add new routing/write implementations.

| Displayed source | Simulated capability | Local effect |
| --- | --- | --- |
| Data Catalog | Metric or asset description update | Updates local catalog rows and saves a versioned source record. |
| OpenMetadata Mirror | Lineage publication | Updates local lineage rows and saves a versioned source record. |
| dbt Semantic Repository | Contract pull-request proposal | Saves a source record only; no Git provider is called. |
| Governance Ticketing | Owner-review task | Saves a source record only; no ticketing provider is called. |

These are not network connectors and require no external credentials. Names such as OpenMetadata, dbt, Git, Jira, and ServiceNow describe intended adapter shapes, not installed integrations. See [Adapter contracts](docs/adapter-contracts.md).

## MCP

Build the workspaces, then start the stdio server:

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

The MCP server exposes these tools:

`explain_permissions`, `semantic_search`, `entity_lookup`, `graph_neighbors`, `find_paths`, `expand_context`, `get_evidence`, `run_discovery`, `business_action_plan`, and `business_action_execute`.

Resources are `semantic-junkyard://status`, `semantic-junkyard://manifest`, `semantic-junkyard://catalog`, `semantic-junkyard://graph`, `semantic-junkyard://source-systems`, and `semantic-junkyard://evidence/{chunkId}`. Catalog and graph resources are bounded snapshots with total counts and a `truncated` flag; agents should use bounded tools for deeper navigation. Prompts are `agent_discovery_brief`, `governed_context_answer`, and `semantic_mapping_review`.

Use `--db <path>` or `SEMANTIC_JUNKYARD_DB=<path>` to select a database, `--memory` for an in-memory runtime, and `--no-seed` to suppress startup seeding. With no override, MCP resolves `apps/api/data/semantic-junkyard.sqlite` from the installed MCP module location, independent of the client's working directory.

MCP opens SQLite directly and does not inherit REST authentication or CORS. The spawning agent therefore has the MCP process's filesystem authority.

Run the MCP integration PoC with:

```bash
npm run poc:agent:mcp
```

It starts a real stdio MCP client/server pair, uses an in-memory seeded database, and prints the report. Artifact writing is opt-in with `npm run poc:agent:mcp -w apps/mcp -- --write-report`.

## Configuration

Active API variables are:

- `HOST` (`127.0.0.1`), `PORT` (`8787`), and `SEMANTIC_JUNKYARD_DB` (`data/semantic-junkyard.sqlite`).
- `SEMANTIC_JUNKYARD_SOURCE_SYSTEMS_FILE` (optional validated JSON capability catalog; built-in defaults when unset).
- `SEMANTIC_JUNKYARD_CORS_ORIGINS` (the localhost and `127.0.0.1` origins for ports 5173 and 5174).
- `SEMANTIC_JUNKYARD_REQUEST_BODY_LIMIT` (`5mb`).
- `SEMANTIC_JUNKYARD_MAX_AUTONOMOUS_RISK` (`medium`).
- `SEMANTIC_JUNKYARD_ENABLE_LOCAL_POC` (`true`).
- `SEMANTIC_JUNKYARD_API_TOKEN` and `SEMANTIC_JUNKYARD_APPROVAL_TOKEN`.

Active frontend variables are `VITE_API_URL`, `VITE_PRODUCT_URL`, `VITE_POC_URL`, and `VITE_DEV_API_TARGET`. During Vite development, both `/api` proxies read `SEMANTIC_JUNKYARD_API_TOKEN` server-side; the product proxy uses the distinct `SEMANTIC_JUNKYARD_APPROVAL_TOKEN` only for approval routes. No token is exposed through a `VITE_` variable, and no frontend variable exists for entity hints.

Provider and MLX variables are documented in [Local models](docs/local-models.md). The complete inventory is in `.env.example`; that file is a template, not an automatic API configuration loader.

## Network Defaults

- The API binds to loopback at `127.0.0.1:8787` by default.
- Browser CORS defaults allow only `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:5174`, and `http://127.0.0.1:5174`.
- Requests without an `Origin` header are allowed. `*` is accepted when explicitly configured.
- With no API token, HTTP routes are unauthenticated and requests receive the local approver role. This is for loopback development only.
- A non-loopback `HOST` requires an API token. Whenever an API token is configured, a different approval token is also required. Both must contain at least 32 characters.
- `OPTIONS` and `GET /api/health` bypass bearer authentication. Other routes accept either token; only the approval token may call the approval route in authenticated mode.

See [Security](SECURITY.md) before exposing any process beyond a developer workstation.

## Tests

Run the repository checks from the root:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm run check` runs type checking, Vitest, and the production build in sequence; it does not include Playwright. Root `npm test` builds the shared and API packages, then runs the API and MCP Vitest suites. `npm run test:e2e` starts the local stack through Playwright and exercises both frontends at desktop and mobile viewports. See [Evaluation](docs/evaluation.md) for coverage and gaps.

## Current Limitations

- The runtime uses concrete local classes; there is no runtime adapter registry or dependency-injection mechanism yet.
- Ollama and OpenAI-compatible provider settings are configuration-only and make no model calls.
- The MLX model is a PoC summarizer, not an autonomous planner, extractor, embedding provider, or policy engine.
- Only inline text is ingested. `metadata_only` and `external_reference` index a registration note, but the submitted `text` is still stored in the `sources` table; these modes are not a no-copy security boundary.
- Source-system capability metadata can be loaded from JSON, but action routing and write implementations remain fixed to the demo systems and operations. All writebacks are local SQLite simulations.
- SQLite, in-process execution, static bearer tokens, and the local policy engine are not multi-tenant production controls.
- Plans are recomputed rather than stored as first-class records. The accepted `context` object is currently not used by routing and is not part of the fingerprint.
- Approvals have no expiry or revocation endpoint. The trusted development proxy can route the separate approver token, but a production browser deployment still needs a human-authenticated backend channel and must not expose either token to client JavaScript.
- The automated suites use in-memory SQLite and mock drift. Real connector, deployment, concurrency, migration, and model-faithfulness tests are not implemented; MLX generation is an opt-in platform-dependent verification command.

## Repository Layout

```text
apps/api           Express API, deterministic semantic engine, SQLite repository, local PoC runner
apps/mcp           MCP stdio server and MCP client PoC
apps/poc           Separate React PoC cockpit
apps/web           React product workbench
packages/shared    Zod request/response contracts and shared API client helpers
docs               Architecture, contracts, security-adjacent guidance, evaluation, and research notes
examples/data      Demo input
assets/design      Design and verification images
```

## Documentation

- [Architecture](docs/architecture.md)
- [Agent contract](docs/agent-contract.md)
- [Adapter contracts](docs/adapter-contracts.md)
- [Local models](docs/local-models.md)
- [Evaluation](docs/evaluation.md)
- [Market scan](docs/market-scan.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
