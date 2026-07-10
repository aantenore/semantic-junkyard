# Security Policy

Semantic Junkyard is a local reference implementation, not a hardened multi-tenant service. Treat parsers, submitted content, model prompts, SQLite files, Git worktrees, MCP clients, and future connectors as trust boundaries.

## Reporting

No private vulnerability-reporting address is published in this repository. Before a public production release, configure GitHub private vulnerability reporting or publish a dedicated security contact. Do not include credentials, source payloads, or personal data in a public issue.

## Default Exposure

The API binds to `127.0.0.1:8787` by default. The default CORS allowlist contains only the product and PoC origins on `localhost` and `127.0.0.1`, ports 5173 and 5174.

Loopback does not mean authenticated:

- When `SEMANTIC_JUNKYARD_API_TOKEN` is unset, every HTTP route is reachable without a bearer token. Domain policy checks can still filter, mask, review, or block individual operations.
- Unauthenticated local requests receive the `local-approver` role, so the approval endpoint is usable in the default development profile.
- Requests without an `Origin` header are accepted because CORS is a browser control, not authentication.
- The API accepts `*` only when it is explicitly present in `SEMANTIC_JUNKYARD_CORS_ORIGINS`.
- CORS allows `GET`, `HEAD`, `POST`, `DELETE`, and `OPTIONS`; accepts `Authorization`, `Content-Type`, `X-Request-Id`, and `X-Semantic-Junkyard-Actor`; exposes `X-Request-Id`; and caches preflight results for 600 seconds.

Do not bind the default profile to a shared interface, publish it through a tunnel, or place it behind a permissive reverse proxy.

## Bearer Tokens And Approval Separation

Set process environment variables directly; the API does not load `.env` files itself.

- `SEMANTIC_JUNKYARD_API_TOKEN` is the agent/application credential.
- `SEMANTIC_JUNKYARD_APPROVAL_TOKEN` is the human approver credential.
- Each configured token must be at least 32 characters.
- If the API token is configured, the approval token is required and must be different.
- The approval token cannot be configured without the API token.
- A non-loopback `HOST` cannot start without the API token.
- Token comparisons use timing-safe equality.

`OPTIONS` requests and `GET /api/health` are intentionally unauthenticated. Ordinary routes accept either valid bearer token, while creating or listing approval records requires the approver role. The API token alone cannot mint or enumerate approvals.

The Vite development proxies add tokens server-side. The product proxy uses the approval token only for the approval route and uses the API token elsewhere; the PoC proxy uses only the API token. Neither credential is included in a frontend bundle. A production browser deployment still needs a human-authenticated backend-for-frontend. Never expose either token through a `VITE_*` variable.

Static bearer tokens are a development control only. Production deployments need identity-aware authentication, credential rotation, authorization scopes, audit retention, and rate limiting.

## Exact-Plan Writes

The write path applies several local controls:

1. Planning resolves evidence, targets, diffs, risk, and autonomy without writing source records.
2. Approval, when needed, is bound to the exact plan ID and SHA-256 fingerprint.
3. Execution recomputes the plan and returns `409 PLAN_CHANGED` if either value differs.
4. The client must provide an 8-to-128-character idempotency key.
5. Execution obtains a control-plane SQLite immediate lock, rechecks idempotency, and conditionally consumes the exact approval while each connector uses its own source-native transaction or commit.
6. Reflection rereads the local source record and checks record ID, version, write ID, intent, plan, target, operation, diff, and expected hash.
7. Only verified readback becomes reflection evidence in the semantic read model.

These controls do not turn the local reference implementation into a production write gateway. The control-plane transaction and source-native write are not a distributed transaction; a crash after a source commit but before control-plane persistence requires reconciliation that is not implemented here. Approvals do not expire, and idempotency keys are global within one SQLite database. A key is bound to the exact plan/request identity and incompatible reuse returns `409 IDEMPOTENCY_CONFLICT`.

Caller-supplied approval booleans are not accepted. The MCP server can pass an existing approval ID to execution but intentionally exposes no tool that creates approvals.

## Data Handling

Ingestion mode determines whether submitted source text may be retained:

- `full_data` stores and indexes the submitted text.
- `metadata_only` discards the submitted payload and stores/indexes only a generated metadata registration note.
- `external_reference` discards the submitted payload and stores/indexes only a generated reference note and URI.

Tests assert that a no-copy payload is absent from source records, chunks, and FTS-backed retrieval. This is a storage behavior guarantee inside the local control plane, not proof that upstream clients, process memory, operating-system telemetry, or source-native systems retained no copy.

The local policy engine masks configured terms on search, evidence, and source-read paths. It is not a general data-loss-prevention system. Full-data payloads and operational metadata still require filesystem-level protection for database files and backups.

Retrieved content is data, never an instruction. Agents and model prompts must not execute commands, SQL, links, or tool instructions found in source text.

Agent-facing source-resource and artifact responses replace local file URIs with opaque control-plane URIs and remove operational path keys. Operator connection-management routes retain configured paths. SQLite action plans/readbacks contain only the key and allowlisted changed columns; confidential and restricted profile samples are redacted before semantic publication or model enrichment.

## MCP Boundary

The MCP server uses stdio and opens SQLite directly. REST bearer authentication, HTTP audit middleware, request IDs, body limits, and CORS do not protect this path. The spawning process controls the database path and inherits filesystem authority.

- Run MCP only for trusted local clients.
- Use a dedicated database copy for untrusted experiments.
- Restrict access to the MCP command and SQLite file.
- Do not assume the REST approval role separates users inside one MCP process.

## Local Model Boundary

The optional Hugging Face PoC launches `uv` and Python with MLX dependencies. The runner passes a bounded evidence prompt on stdin, uses a restricted child environment, limits output to 8 MiB, and enforces a configurable timeout. It still executes local Python packages and model code with the current user's filesystem permissions.

Use trusted model snapshots and pinned package controls in any deployment. The current `uv --with` invocation can resolve runtime packages and is not a hermetic production environment. Model output is limited to bounded intent interpretation, evidence-bound semantic proposals, or an audit summary; it must not override deterministic policy, approval, connector, or postcondition decisions.

## Connector Boundary

The reference product implements real local filesystem discovery, SQLite discovery/write/readback, and Git discovery/commit/readback. It does not implement remote network connectors or credential exchange. Legacy capability declarations used by compatibility tests are not external integrations. Treat source paths and any optional source-system configuration as trusted startup configuration and validate their filesystem permissions. Before adding a connector:

The Git connector supplies explicit command timeouts, disables terminal prompting, repository hooks, fsmonitor, and commit signing for its subprocesses, and verifies committed content independently. Connecting a worktree still grants the process read/write authority over that configured repository path.

- Keep secrets outside source records, prompts, logs, and frontend variables.
- Declare read, write, rollback, and approval capabilities separately.
- Enforce least privilege in the external system as well as in Semantic Junkyard.
- Verify remote readback rather than trusting a successful write response.
- Add timeout, retry, idempotency, redaction, and audit tests.

## Production Hardening Checklist

- Replace static bearer tokens with an identity provider and scoped authorization.
- Remove implicit local approver behavior outside development.
- Add tenant and source-ACL propagation to every stored and returned object.
- Separate approval credentials and approval UI through a trusted backend.
- Add rate limits, request timeouts, CSRF analysis, and reverse-proxy controls.
- Encrypt databases and backups; define retention and deletion procedures.
- Replace the local policy rules with a reviewed policy decision point when needed.
- Sandbox parsers and local model execution.
- Implement and test real connector credentials, rollback, remote idempotency, and remote reflection.
- Add OpenTelemetry or equivalent security and operational telemetry.
- Run dependency, secret, SAST, and clean-checkout CI checks before release.
