# Contributing

Semantic Junkyard is intended to become modular, but the current runtime still constructs concrete local implementations directly. Contributions should distinguish implemented behavior from proposed extension points and should not describe a named integration as available until it is exercised by code and tests.

## Principles

- Keep request and response contracts in `packages/shared` and validate untrusted input with strict Zod schemas.
- Preserve source IDs, offsets, evidence links, policy filtering, audit events, and transactional behavior.
- Keep planning read-only. A mutation must be bound to a server-generated plan ID and fingerprint.
- Do not add caller-controlled approval flags or bypass the separate approval role.
- Preserve idempotent execution and verified readback before publishing semantic updates.
- Treat retrieved content as data, not instructions.
- Prefer configuration and injected interfaces when introducing a real adapter; avoid adding another provider-specific branch to the semantic engine.
- Keep the product workbench and PoC cockpit as separate clients. Shared contracts belong in the shared package, not duplicated UI state.

## Local Development

Node.js 20 or later is required. Install exactly from the lockfile:

```bash
npm ci
```

Start all local applications:

```bash
npm run dev
```

The product runs on port 5173, the PoC on 5174, and the loopback API on 8787. `npm run dev:product` and `npm run dev:poc` start smaller combinations.

The API reads `process.env`; it does not load a root `.env` file. Vite reads root environment files for frontend development and proxy configuration. Never add secrets to `VITE_*` variables.

## Required Checks

Run from the repository root:

```bash
npm run typecheck
npm test
npm run build
```

`npm run check` runs the same sequence. Root `npm test` builds shared and API outputs before running the API and MCP Vitest suites, which is important because workspace packages resolve through `dist` exports.

For focused test iteration after prerequisites have been built:

```bash
npm run test -w apps/api
npm run test -w apps/mcp
```

Tests should scale with the changed boundary:

- Shared schema changes need valid, invalid, unknown-field, and limit cases.
- Ingestion changes need preview non-persistence, atomic failure, provenance, and policy-read tests.
- Action changes need plan mismatch, risk ceiling, separate approval, approval consumption, idempotent replay, rollback, drift, and reflection tests.
- MCP changes need an SDK client test, not only descriptor snapshots.
- Network or production adapters need contract tests against a controlled fake and an opt-in integration suite against the real service.
- Model changes need deterministic fallback tests and a separate opt-in real-generation test.

See [Evaluation](docs/evaluation.md) for the current coverage boundary.

## Contract Changes

The REST API, MCP tools, frontend clients, OpenAPI document, and documentation describe the same action protocol. When one changes, audit all five surfaces.

For business execution, preserve these invariants:

- `planId`, `planFingerprint`, `intent`, `mode`, `maxAutonomousRisk`, and `idempotencyKey` are required.
- Approval IDs come only from the human-facing approval endpoint.
- The plan is recomputed at approval and execution time.
- Terminal idempotency replays perform no second write.
- An `approval_required` run may resume with the same key after approval.
- Unverified source readback must not become semantic evidence.

Document any intentional compatibility break. Do not keep stale request examples that omit fingerprint or idempotency fields.

## Adapter Contributions

There is no generic runtime adapter registry yet. The contracts in [Adapter contracts](docs/adapter-contracts.md) describe both current concrete boundaries and the requirements for extracting them into replaceable implementations.

A production adapter contribution should include:

- Capability kind and stable adapter ID.
- Typed configuration with secret fields identified explicitly.
- Construction and dependency-injection path.
- Supported read, write, dry-run, approval, rollback, and reflection operations.
- Risk and policy implications.
- Timeout, retry, idempotency, and partial-failure behavior.
- Redaction and audit behavior.
- Unit, contract, and opt-in integration tests.
- Documentation that clearly differentiates simulation from real external effects.

Do not let an adapter bypass the capability manifest, policy checks, exact-plan validation, approval role, audit log, or reflected readback.

## Documentation

Documentation must describe the working tree, not the intended roadmap. In particular:

- Call Ollama and OpenAI-compatible providers `configuration-only` until runtime calls exist.
- Describe the three bounded MLX roles accurately: intent interpretation, source-semantic proposals, and trace summary; none is the policy or write orchestrator.
- Call filesystem, SQLite, and Git local connectors real local integrations, while keeping remote/enterprise connector claims out of scope.
- State that metadata-only and external-reference requests discard submitted payload text in the control-plane store.
- Keep loopback, CORS, token, approval, and MCP filesystem boundaries explicit.

Do not edit or remove historical incident reports to rewrite history. Add a new dated incident or follow-up when the facts change.
