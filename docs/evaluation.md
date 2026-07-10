# Evaluation

The current repository has deterministic API/MCP tests and browser end-to-end tests. It does not yet evaluate production connectors, external model providers, or remote policy systems. Real local MLX generation is available as an opt-in platform-dependent check, but it is not part of the deterministic release suite.

## Commands

Install from the lockfile and run the complete non-browser check:

```bash
npm ci
npm run check
```

`npm run check` expands to:

```bash
npm run typecheck
npm test
npm run build
```

Root `npm test` first builds `packages/shared` and `apps/api`, then runs:

```bash
npm run test -w apps/api
npm run test -w apps/mcp
```

Build prerequisites matter because the MCP package imports API and shared workspace packages through their `dist` exports.

For browser tests, install Chromium once and run Playwright:

```bash
npx playwright install chromium
npm run test:e2e
```

CI uses `npx playwright install --with-deps chromium` before the same e2e command.

## API And Engine Coverage

The API Vitest suite currently verifies:

- Demo catalog, corpus, graph, discovery, and hybrid search seeding.
- Agent manifest and permission explanation.
- Ingestion preview without persistence.
- Atomic ingestion rollback on persistence failure.
- Manual evidence-backed semantic curation.
- Re-ingestion preserving evidence-backed manual relations.
- Local source writeback, readback verification, reflection evidence, and refreshed search.
- Server and caller risk ceilings.
- Paused approval-required runs.
- Separate exact-plan approval and approval consumption.
- Conditional single-consumption behavior and rollback preserving an active approval.
- Blocking destructive, unsupported, and evidence-free actions.
- Drift detection without semantic publication.
- Idempotent replay without incrementing source-record versions.
- Policy masking across search, evidence, and source reads.
- JSON validation, unknown-field rejection, body-size errors, request IDs, Helmet headers, and hidden Express fingerprint.
- CORS rejection and optional bearer authentication.
- Loopback runtime defaults plus required, distinct API/approval token pairing.
- Exact plan ID/fingerprint enforcement and rejection of the former `approved` bypass.
- The local PoC endpoint's POST-only boundary.
- Deterministic PoC tool sequence and report writing.
- Local Hugging Face cache discovery and model preference without running inference.
- Local-model startup failures that do not echo prompt contents or model paths.

Most engine/API tests use in-memory SQLite. Drift is injected with a repository spy rather than an external source.

## MCP Coverage

The MCP Vitest suite uses the official SDK's linked in-memory transport. It verifies that a real MCP server/client pair can:

- List the expected tools.
- Reject unknown MCP tool arguments through strict shared schemas.
- Search seeded evidence with structured content.
- Plan an action and receive a fingerprint.
- Execute the exact plan idempotently.
- Receive verified reflection results.
- Redact configured sensitive terms from operational MCP resources.
- Enforce a lower server autonomous-risk ceiling inside MCP.
- Read the manifest resource.
- Resolve the governed-context prompt.

The test does not exercise stdio process startup, persistent database sharing, HTTP-created approval IDs, or filesystem permissions. The `poc:agent:mcp` command covers stdio manually and prints a report; artifact writing is opt-in, and the command is not part of the Vitest assertion suite.

## Browser Coverage

`playwright.config.ts` starts `npm run dev` and runs four single-worker projects:

- Product desktop at 1440 x 900.
- PoC desktop at 1440 x 900.
- Product mobile at 390 x 844.
- PoC mobile at 390 x 844.

The tests verify:

- Both applications return a meaningful rendered root without Vite overlays, console errors, or page errors.
- The product navigates to Actions and creates an executable plan.
- The PoC read-only mode performs no plan or execute request.
- The PoC autonomous mode plans once, executes once, and claims completion only after every reflection verifies.
- Both mobile surfaces avoid horizontal overflow.

Browser fixtures block non-deterministic `/api/poc/local-agent` requests. The e2e suite therefore cannot accidentally start local Hugging Face generation.

The Playwright server uses a dedicated SQLite path and sets the reported semantic provider to deterministic. Tests run serially with one worker because action flows share that server state.

## What Is Not Evaluated

- Real Ollama or OpenAI-compatible calls; those providers are configuration-only.
- Automated real MLX generation, model faithfulness, hallucination rate, or cross-platform compatibility. A no-fallback local run can verify one installed model on demand.
- Real catalog, OpenMetadata, DataHub, Git, dbt, Jira, ServiceNow, database, or application connectors.
- Remote idempotency, retries after process crashes, partial remote writes, or rollback.
- Concurrent writers and high-volume SQLite behavior.
- Database migration from every historical schema version.
- Custom source-system routing behavior beyond the validated capability registry; tests cover valid loading plus duplicate and cross-system reference rejection.
- Multi-tenant authorization, source ACL propagation, token rotation, rate limiting, or policy-engine outages.
- Parser sandboxing, hostile document formats, or payload malware scanning.
- Retrieval quality against a labeled benchmark.
- Entity-resolution and relation-extraction precision outside the seeded demo domain.
- Accessibility beyond role-based test selection and basic responsive rendering.

## Recommended Evaluation Layers

A production evaluation program should add:

1. Contract tests for every adapter, including timeouts, redaction, retries, and malformed responses.
2. Opt-in integration tests against controlled real services.
3. Crash-recovery tests around remote idempotency and local run persistence.
4. Labeled retrieval recall, ranking, citation accuracy, entity resolution, and relation precision datasets.
5. Policy tests spanning search, graph, source, evidence, action, REST, and MCP paths.
6. Approval expiry/revocation and role-separation tests.
7. Real MLX generation tests gated by platform/model availability plus deterministic faithfulness checks.
8. Load, concurrency, migration, backup, and restore tests for each supported store.
9. Browser accessibility, keyboard, failure-state, and authenticated deployment tests.
10. Clean-checkout CI that installs only from committed files and the lockfile.

When adding a non-deterministic evaluator, keep deterministic invariants as the release gate. Model-based scoring can supplement but should not replace exact checks for evidence, fingerprints, idempotency, approval, and reflected readback.
