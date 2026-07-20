# Evaluation

Semantic Junkyard uses deterministic tests as the release foundation. Optional local-model generation is deliberately outside the default release gate. The suite proves important local invariants; it does not establish production connector reliability, distributed exactly-once execution, semantic quality, or enterprise security.

## Commands

Install from the lockfile:

```bash
npm ci
```

Run the non-browser checks:

```bash
npm run check
```

`npm run check` validates documentation, runs type checking and API/MCP Vitest, and creates all
production builds. MCP tests require built API/shared workspace exports, which the root scripts
prepare.

Run the deterministic reference benchmark:

```bash
npm run benchmark:reference
```

Run browser checks separately:

```bash
npx --no-install playwright install chromium
npx --no-install playwright test
```

## Deterministic Reference Benchmark

`benchmarks/reference.mjs` is a release regression gate over one versioned synthetic fixture. It
exercises the shipped deterministic retrieval and SQLite action path without a hosted or local
model. The gate requires:

| Metric | Alpha threshold |
| --- | --- |
| Evidence recall at five | 7/7 expected items found across seven fixed queries |
| Exact action target | 3/3 plans select the expected system, object, key, operation, and new value |
| Unsupported-intent abstention | 3/3 destructive, unmapped, or unauthorized requests remain blocked without a source change |
| False verified rate | 0/6 across a valid write, drifted readback, stale state, and three blocked requests |
| Idempotent replay | 1/1 retry returns the same run and produces exactly one authoritative mutation |
| Stale-precondition rejection | 1/1 concurrent source change is preserved and the requested update is not applied |

The command exits nonzero when a case or aggregate threshold fails and emits machine-readable JSON.
Optional `--timings` output is classified as hardware-dependent and is not a latency gate.

The fixture is deliberately small and synthetic. Passing it does **not** establish general retrieval
quality, cross-domain relevance, production safety, model quality, scalability, remote connector
reliability, or superiority over another system. It catches deterministic regressions in a narrow,
auditable reference path. A representative labeled corpus, adversarial cases, repeated runs, and
deployment-specific service-level measurements remain future work.

## Source Connector Coverage

### Filesystem

The connector suite verifies:

- recursive discovery of supported real files with no write capability;
- payload-free `metadata_only` and `external_reference` materialization;
- deterministic JSON, JSONL, and CSV profiling;
- declared semantic-contract and metric facts without invented objects;
- OpenLineage job/dataset resources and explicit lineage;
- symlink rejection plus file-count/byte bounds;
- PDF text extraction through the bounded worker path.

It does not evaluate hostile PDFs, malware scanning, every encoding, very large trees, incremental checkpoints, file permission changes during traversal, or remote object stores.

### SQLite

The connector suite uses a real temporary SQLite source and verifies:

- read-only validation/discovery, selected tables, schema/foreign keys, profiles, sensitivity, and writability;
- one bounded natural-language row update;
- parameterized allowlisted columns and independent read-only postcondition readback;
- rejection of unauthorized columns at planning and execution;
- stale source-row hash failure without applying the planned write.

It does not evaluate high concurrency, lock starvation, every SQLite affinity/conversion edge, attached databases, triggers with external effects, replication, or non-SQLite databases.

### Git

The connector suite uses a real temporary Git repository and verifies:

- committed-tree discovery and contract commit/blob provenance;
- exact YAML denominator/version planning and committed readback;
- unrelated dirty files left out of the target-only commit;
- stale HEAD/blob rejection;
- pre-commit target restoration on failure;
- repository path traversal rejection;
- ambiguous metric selection and read-only connection refusal.

It does not evaluate remote pushes, protected branches, signed commits, merge requests, hooks (the connector uses `--no-verify`), submodules, LFS, concurrent distributed writers, or post-commit reconciliation.

## End-To-End Source Workflow Coverage

`sourceWorkflow.integration.test.ts` proves against real temporary local sources that the runtime can:

- create and synchronize an external SQLite connection;
- ground a business intent to one configured row update;
- execute, independently reread, satisfy the postcondition, and publish reflected semantic evidence;
- create and synchronize a real Git semantic-contract connection;
- require exact-plan human approval, commit the change, and verify committed content;
- fail closed for an unrelated domain rather than select fallback objects;
- retain no submitted payload in no-copy ingestion modes;
- replace stale evidence on resync and remove connection-owned observations on deletion.

This test is the primary code-level evidence for the [reference workflow](reference-workflow.md).

## Semantic Proposal And Model Boundary Coverage

The local enrichment suite verifies strict provider-neutral proposal output, safe audit summaries, malformed/oversized output handling, partial envelope normalization, invented ID/self-relation/duplicate rejection, and per-kind caps.

The deterministic/local-HF intent interpreter suite verifies deterministic output, prevention of model-invented mutation when the original request has no explicit action verb, and fail-closed malformed output.

Current gaps beyond the fixed synthetic reference benchmark:

- proposal precision, recall, and reviewer agreement are not measured against a labeled corpus;
- no real MLX inference runs in the default suite;
- no representative multi-domain benchmark measures proposal precision/recall, entity resolution,
  retrieval quality, citation faithfulness, or model faithfulness;
- prompt-injection defenses are schema/rule tested but not evaluated against a maintained adversarial corpus.

The manual local-HF acceptance run must use `--no-fallback` and report `modelSummaryStatus: grounded`. The model selects only verified fact IDs; the deterministic renderer rejects malformed, duplicate, unknown, or invented selections.

## Change-Control Coverage

Engine/API tests verify:

- exact plan ID/fingerprint recomputation and unknown-field rejection;
- durable plan persistence and actor/role/clearance/policy-version principal binding;
- separate agent, operator, and approver HTTP roles;
- approval-required pause, exact approval binding, single consumption, and mismatch rejection;
- durable approval reservation and `reconciliation_required` handling for ambiguous in-process outcomes;
- local idempotent replay and conflict detection;
- blocking destructive, unsupported, evidence-free, policy-denied, and evidence-resource-mismatched actions;
- readback drift preventing semantic publication;
- atomic control-plane migrations and local transaction rollback behavior;
- cross-runtime synchronization leases and whole-observation rollback when a later source document fails;
- changed-evidence proposal identity, terminal decision isolation, and inactive-relation retrieval filtering;
- domain/operational evidence isolation, bounded graph boosts, and MCP propagation of the requested evidence scope;
- read-only MCP defaults with explicit mutation-tool enablement;
- consistent masking across search, evidence, source, and operational responses;
- strict request validation, request IDs, body limits, CORS, security headers, and optional bearer auth.

Static capability templates are explicitly tested as non-executable without a managed connector. Real temporary SQLite/Git integration tests are the reference writeback proof.

No test can currently prove atomicity between a source-native commit and control-plane persistence because the implementation has no distributed transaction/outbox. Crash injection across that boundary remains a required future suite.

## MCP Coverage

MCP Vitest uses the official SDK linked in-memory transport. It verifies tool discovery, strict schemas, governed search/evidence, action planning/execution, risk ceilings, redaction, manifest resources, and prompts. The MCP server code also exposes source resource search, configured source sync, and proposal listing.

`npm run poc:agent:mcp` manually exercises a real stdio process against the selected product database. It is not part of the assertion suite and does not create approvals.

Not covered:

- stdio process lifecycle under load;
- simultaneous API/MCP writers against a persistent database;
- OS filesystem permission matrices;
- MCP transport authentication (stdio has none);
- a Git approval created over HTTP and then consumed by MCP;
- remote/streamable HTTP MCP.

## Browser Coverage

Playwright runs product and PoC desktop/mobile projects. It checks meaningful rendering, safe PoC defaults, answer citations, evidence-before-proposal-decision, plan/fingerprint visibility, fingerprint continuity after execution, no Vite/page/console failures, mobile horizontal overflow, and autonomous completion only after reflected readback.

Browser tests use a dedicated local database and deterministic provider. They do not run real MLX generation. Coverage is not a complete accessibility audit and does not test production authentication, final proposal decision submission, source connection forms for every failure mode, or Git execution after approval in the browser.

## Acceptance Gates

A release candidate for the reference product should satisfy all of these:

1. `npm run typecheck`, `npm test`, and `npm run build` pass from the lockfile.
2. Filesystem, SQLite, and Git connector suites pass against real temporary sources.
3. The end-to-end SQLite and Git source workflow tests pass.
4. No-copy tests prove the submitted payload is absent from sources/elements/chunks.
5. Exact-plan, approval, idempotency, stale-precondition, and postcondition-negative tests pass.
6. MCP schemas remain strict and approval creation remains absent.
7. Product and PoC Playwright flows claim completion only for `verified` runs.
8. The deterministic reference benchmark passes every case and aggregate threshold.
9. Documentation local links and cited official market links resolve.

The manual product checklist is in [Reference workflow](reference-workflow.md).

## Production Evaluation Backlog

- Contract and failure-injection suites for every remote connector.
- Durable job/outbox crash-recovery and reconciliation tests.
- Source/control-plane split-brain detection after process termination at every write stage.
- Concurrent writer, load, migration, backup, and restore tests.
- Multi-tenant IAM, source ACL, token rotation, approval expiry/revocation/delegation, and audit-retention tests.
- Labeled retrieval, citation accuracy, entity/relation, proposal, and contradiction benchmarks.
- Real local/hosted model faithfulness and adversarial prompt-injection evaluation.
- Browser accessibility, keyboard, authenticated deployment, and failure-state tests.
- Remote MCP authorization and least-privilege connector process isolation.

Model-based evaluators may supplement these layers, but deterministic evidence, identity, approval, idempotency, precondition, and postcondition assertions remain hard gates.
