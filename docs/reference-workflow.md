# Reference Workflow

This workflow demonstrates the real local product, not the legacy in-memory compatibility path. It uses the source files, operational SQLite database, and Git repository created beside the persistent control-plane database.

## 1. Start The Product

```bash
npm ci
npm run dev
```

Open:

- product workbench: `http://localhost:5173`
- external conversational PoC: `http://localhost:5174`
- API health: `http://127.0.0.1:8787/api/health`
- OpenAPI: `http://127.0.0.1:8787/api/openapi.json`

On a fresh persistent control plane, the API creates and starts synchronization for:

1. `Supply Chain Knowledge` (filesystem, read-only);
2. `Operations Database` (SQLite, autonomous allowlisted status update);
3. `Semantic Contract Repository` (Git, approval-required contract commit).

The source registry should show observed files/documents/datasets, SQLite tables/columns, a semantic contract/metric, and sync events with source checkpoints.

## 2. Inspect Authority And Proposals

In the product source workbench:

1. Select each connection and inspect its real location, status, resources, evidence links, and write mode.
2. Confirm filesystem resources are not writable.
3. Confirm only `Operations Database.orders.status` is writable under the seeded SQLite rule.
4. Confirm only `contracts/late-dispatch-rate.yaml` is writable in Git and requires approval.
5. Review semantic proposals and distinguish accepted authoritative source facts from proposed inferences.
6. Accept or reject a non-authoritative proposal only with a rationale; do not attempt to reject a source fact.

Expected source-fact examples include SQLite `HAS_COLUMN`/`REFERENCES` assertions and a declared contract `DEFINES_METRIC` assertion. Representation/inference and optional local-model assertions remain reviewable.

## 3. Run The Autonomous SQLite Path

Use the external PoC in `autonomous` mode with deterministic interpretation, or call the API with this business intent:

```text
Set order ORD-1001 status to dispatched
```

Expected stages:

1. Resource search finds the observed order/status resources and evidence.
2. The product resolves exactly one target: the `orders` row keyed by `ORD-1001` and the allowlisted `status` column.
3. The plan contains the row's source-version hash, exact before/after state, evidence IDs, low risk, autonomous status, ID, and fingerprint.
4. Execution uses a fingerprint-scoped idempotency key and recomputes the plan.
5. The connector opens the source, rechecks the full-row hash, updates exactly one row, and commits its immediate transaction.
6. A separate read-only connection rereads `ORD-1001` and requires `status == dispatched`.
7. The control plane verifies its reflection record and publishes semantic reflection evidence.
8. The run is `verified`; only then may the PoC claim completion.

Repeat the exact execution request with the same key and confirm the stored run returns without a second source update. Reuse the key with a different plan identity and confirm `IDEMPOTENCY_CONFLICT`.

## 4. Run The Approval-Gated Git Path

From the product Actions surface, plan:

```text
Use dispatch eligible orders as the denominator for Late Dispatch Rate and publish version 2
```

Expected stages:

1. The connector resolves the one configured contract file and one metric.
2. The plan displays exact YAML before/after content, expected Git HEAD/blob, parsed contract/metric expectations, evidence, medium risk, and `approval_required`.
3. The external conversational PoC stops. It cannot approve its own request.
4. An operator reviews the target, diff, preconditions, evidence, risk, and fingerprint in the product UI and creates the exact approval.
5. Execution recomputes the plan and consumes the matching approval once.
6. The connector stages and commits only the configured contract path.
7. It verifies the commit parent, changed-path set, committed blob/content, contract version/status, and metric expression/version.
8. Only a passing committed-content postcondition produces a `verified` run and semantic reflection evidence.

Change the target file or Git HEAD after planning and before execution; the old plan must fail with a stale precondition or `PLAN_CHANGED`. A new plan and approval are required.

## 5. Exercise MCP As An External Client

After the product API has initialized the persistent reference database:

```bash
npm run build
npm run poc:agent:mcp
```

The MCP PoC starts a real stdio client/server pair, searches observed source resources and semantic evidence, plans a configured action, executes only when autonomous, and reports authoritative readback. MCP can list proposals and synchronize an existing connection, but it cannot create a connection, decide a proposal, or create an approval.

For an approval-required Git plan, create approval through the product/API channel and pass its exact ID to MCP execution. The OS user that spawns MCP must be treated as privileged because MCP opens the control database and configured local paths directly.

## 6. Negative Paths

Verify each fail-closed path:

- Ask to update an unrelated domain with no matching source. No fallback target is selected.
- Ask to change an unallowlisted SQLite column. Planning produces no connector target.
- Change the SQLite row after planning. The source-row hash precondition fails and the planned field update is not applied.
- Ask for delete/drop/truncate/insert/DDL, secrets, access-policy changes, arbitrary SQL, or arbitrary file writes. The action is blocked.
- Remove evidence from a candidate target. Planning is blocked rather than made evidence-optional.
- Reuse an approval for another fingerprint or after consumption. Execution rejects it.
- Force readback drift. The run is not `verified`, and no semantic update is published from that write.
- Use `read_only` PoC mode with a mutation request. The client gathers evidence and stops before planning.
- Use `plan_only` mode. The client stops with the exact plan and performs no write.

## Acceptance Checklist

### Federation

- [ ] Three real local source connections are visible and individually testable.
- [ ] Filesystem discovery respects root, symlink, file-count, byte, and format boundaries.
- [ ] SQLite resources reflect real schema, primary/foreign keys, profiles, and sensitivity.
- [ ] Git resources carry committed path, commit SHA, and blob SHA provenance.
- [ ] Evidence chunks link back to observed resource IDs and source URIs.
- [ ] `metadata_only` and `external_reference` retain no submitted payload text.

### Semantic Governance

- [ ] Authoritative source facts are accepted, labeled, and not rejectable in the semantic layer.
- [ ] Deterministic/local-model assertions remain proposals with confidence, explanation, origin, and evidence.
- [ ] Accept/reject decisions require an operator rationale and are audited.
- [ ] Assertions missing from a later sync become superseded and leave active navigation.
- [ ] Model-invented resource IDs and malformed output do not become proposals.

### Change Control

- [ ] A business intent resolves to one typed configured target or fails closed.
- [ ] The plan exposes exact diff, evidence, risk, autonomy, preconditions, ID, and fingerprint.
- [ ] Approval is separate, exact-fingerprint-bound, and unavailable to the conversational PoC/MCP toolset.
- [ ] SQLite rejects unallowlisted columns, stale row hashes, and non-singleton rows.
- [ ] Git rejects unallowlisted/dirty/stale targets and commits only the exact planned path.
- [ ] The idempotency key prevents duplicate execution for an exact terminal replay.
- [ ] Authoritative reread and connector postcondition pass before `verified`.
- [ ] Drift/missing readback prevents a completion claim and semantic publication.

### Trust Boundaries

- [ ] Retrieved content is handled as untrusted data, not instructions.
- [ ] REST agent and operator/approver roles remain separate when tokens are enabled.
- [ ] MCP process filesystem authority is documented and constrained operationally.
- [ ] Audit records contain observable evidence/artifacts/decisions, not hidden chain-of-thought.
- [ ] No UI/API/MCP path offers generic SQL, shell, arbitrary filesystem, or unknown-source writes.

### Reference, Not Production

- [ ] Single-node SQLite, local connectors, static token auth, and in-process jobs are visibly labeled as limitations.
- [ ] No claim of tenancy, production IAM, durable queue/outbox, distributed transaction, or exactly-once crash recovery is made.
- [ ] Legacy in-memory demo actions are not presented as real external integrations.

## Repeatability Note

The reference sources persist. After the SQLite row is already `dispatched` or the Git contract is already version `2`, an identical plan may have no new diff. Use a fresh control-plane/reference-source directory for a clean acceptance run rather than treating a no-op as a connector failure.
