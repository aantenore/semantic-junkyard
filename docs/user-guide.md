# Hands-On Guide

This guide runs the real Semantic Junkyard reference environment and explains what each visible step means. It covers the operator product, the separate conversational PoC, the optional local Hugging Face path, and the MCP client proof.

## 1. Start Everything

Prerequisites:

- Node.js 20 or later;
- npm;
- Git;
- macOS/Apple Silicon plus `uv` only for the optional local Hugging Face path.

From the repository root:

```bash
npm ci
npm run dev
```

Open:

| Surface | Address | Purpose |
| --- | --- | --- |
| Product workbench | `http://localhost:5173` | Operator control plane |
| Conversational PoC | `http://localhost:5174` | Separate external agent-like REST client |
| API readiness | `http://127.0.0.1:8787/api/ready` | Bootstrap and dependency readiness |
| OpenAPI | `http://127.0.0.1:8787/api/openapi.json` | Machine-readable REST contract |

On a fresh persistent control plane, the API creates and synchronizes three local reference connections:

- **Supply Chain Knowledge**: filesystem discovery, read-only.
- **Operations Database**: SQLite discovery and one autonomous allowlisted order-status update.
- **Semantic Contract Repository**: Git discovery and one approval-gated contract path.

The bootstrap reuses persistent local source state. If an action has already been completed, a later run may correctly become a verified no-op instead of resetting the source.

## 2. Read The Product Workbench

The left navigation is a map of operator responsibilities:

| Section | What to inspect or do |
| --- | --- |
| Dashboard | Source-wide discovery missions, Connect/Observe/Govern/Act/Verify state, verified action receipts, and operational audit. |
| Sources | Connections, tests, synchronization, observed resources, writability, semantic proposals, and sync events. |
| Ingest | Preview or ingest submitted unstructured text under `full_data`, `metadata_only`, or `external_reference` retention. Extracted relations are persisted as proposed and remain inactive for agent graph reasoning. |
| Actions | Search evidence, profile the persisted semantic fabric, create exact business action plans, approve when required, execute, and inspect readback. |
| Graph | Filter authoritative, accepted, and proposed relations; select keyboard-accessible nodes/edges to inspect confidence, lifecycle, and evidence identity. Proposed relations are operator-visible but agent-inactive. |
| Agents | Inspect the agent manifest and MCP capability summary. |
| Discovery | Inspect objective-aware discovery runs and their timeline. |

The status label has operational meaning:

- **Active**: required product surfaces loaded successfully.
- **Degraded**: the API is reachable but one or more optional/bootstrap surfaces failed; inspect `/api/ready` and source sync events.
- **Unavailable**: the product cannot load the required API snapshot.

## 3. Inspect How Semantics Were Created

Open **Sources** and inspect each reference connection.

1. Select a connection and review its kind, path, write mode, latest checkpoint, and observed resources.
2. Confirm that filesystem resources are read-only.
3. Confirm that only the configured `Operations Database.orders.status` capability is writable for the seeded SQLite source.
4. Confirm that only the configured semantic-contract path is writable for the seeded Git source.
5. Open the semantic proposal queue and compare `source_fact`, deterministic, and optional `local_model` origins.
6. Select **Review evidence** and read every bound chunk. Accept/reject controls remain disabled until evidence opens successfully and a rationale is entered.

Source facts are authoritative and locked as accepted. Accepting an inference confirms it for navigation but does not make it authoritative. Pending relations are visible in the operator graph but excluded from agent graph tools and retrieval boosts. Rejected and superseded relations leave active navigation. See [How semantic meaning is governed](how-it-works.md#5-how-semantic-meaning-is-governed) for the exact lifecycle and the direct-ingest exception.

## 4. Use The Conversational PoC For A Read-Only Question

Open `http://localhost:5174`.

1. The PoC starts with **Deterministic rules** and **Read only** selected. Keep these safe defaults for a reproducible first run, or explicitly select **Local model** to use a compatible cached model for intent interpretation.
2. Leave **Read only** selected.
3. Ask:

```text
Which governed data and policy control order dispatch?
```

The PoC should visibly interpret a typed intent, search observed resources, profile the already-persisted semantic fabric, search semantic evidence, resolve entity/graph context, expand context, open evidence, and return a human-readable answer with an audit trace. This discovery run does not synchronize sources.

Expected visible artifacts include the interpreter/provider identity, source-resource matches, discovery events, ranked evidence, canonical entity candidates, graph nodes/edges, context spans, opened evidence, and an answer contract with supporting claims, clickable chunk citations, and an explicit evidence boundary. A read-only turn never creates a business action plan.

The PoC does not display or request hidden chain-of-thought. It displays observable tool calls, typed artifacts, evidence, policy decisions, stop reasons, diffs, writes, readbacks, and final status.

## 5. Run An Autonomous SQLite Business Action

You can use the product **Actions** section for direct control or the PoC to observe an external client workflow.

### From the product

1. Open **Actions**.
2. Keep mode **autonomous** and autonomy ceiling **Low** or **Medium**.
3. Select the **Dispatch order** preset, or enter:

   ```text
   Set order ORD-1001 status to dispatched
   ```

4. Select **Plan**.
5. Before execution, inspect the exact connection, table, key, column, before/after diff, evidence, risk, row-hash precondition, plan ID, full fingerprint, planning principal, and policy version.
6. Select **Execute plan**.

### From the PoC

1. Select **Autonomous**.
2. Submit the same sentence.
3. The command changes to **Plan & execute**. Watch the client gather evidence, ask for permissions, request the exact plan, execute only when every target is autonomous, reread source state, and show that the executed fingerprint matches the reviewed fingerprint.

Expected successful result: the connector rechecks the source-row hash, performs one parameterized allowlisted update, closes the write connection, opens a new read-only connection, verifies `status == dispatched`, returns a `verified` run, and publishes reflected evidence.

If the row is already `dispatched`, the system should issue no redundant `UPDATE`. It records a `skipped` source write, performs the authoritative reread, and may still return `verified` because the planned postcondition is already true.

## 6. Run The Approval-Gated Git Business Action

Use the product workbench because the external PoC cannot approve its own request. In tokenless loopback mode the local owner can approve. With authentication enabled, the approval API requires the separate approver role; the current browser UI needs an auth-injecting proxy or client change to supply bearer tokens.

1. Open **Actions**.
2. Select the **Publish Git contract** preset, or enter:

   ```text
   Use dispatch eligible orders as the denominator for Late Dispatch Rate and publish version 2
   ```

3. Select **Plan**.
4. Inspect the exact repository, allowlisted path, YAML before/after content, expected `HEAD`, blob hash, evidence, risk, plan ID, and full fingerprint.
5. Enter an approval rationale.
6. Check the attestation confirming that you reviewed target systems, diffs, evidence, risk, and fingerprint.
7. Select **Approve exact plan**.
8. Select **Execute plan**.

On approval, the product first recomputes and validates the exact plan, then stores an approval bound to its fingerprint. On execution it checks idempotency, recomputes again, consumes the matching approval, verifies `HEAD`, blob, path, and target cleanliness, commits only the configured path, and reads committed `commit:path` content before returning `verified`.

Changing `HEAD`, the target blob, the diff, or the policy result after planning invalidates the old plan or approval. Create a new plan and review the new fingerprint.

## 7. Understand Action States

| Run state | Meaning | What the client should do |
| --- | --- | --- |
| `planned` | A dry run was recorded without changing a source. | Review only; create a new executable request when appropriate. |
| `approval_required` | One or more exact targets require a separate human decision. | Stop; obtain approval through the approver channel. |
| `blocked` | No safe exact capability or policy path exists. | Do not invent a fallback target or operation. |
| `reflected` | Source reflection exists but all required postconditions were not verified. | Report an incomplete outcome; do not claim completion. |
| `verified` | Source readback and control-plane reflection both passed. | Completion may be reported; refreshed evidence should be available. |
| `reconciliation_required` | The outcome became ambiguous after approval reservation/execution began. | Stop automatic retry; an operator must reconcile source and control-plane state. |

Individual writes use `executed`, `skipped`, or `failed`; individual reflections use `verified`, `missing`, or `drift`. Do not interpret a write status of `executed` as a verified run.

`reconciliation_required` is intentionally terminal for the used idempotency key and approval. Reusing either must not authorize another blind write.

## 8. Test A Real Local Hugging Face Model

The UI **Local Hugging Face** option uses a compatible model already present in the configured Hugging Face cache. It produces typed intent candidates; deterministic grounding and action controls still decide what may happen.

To run the bundled end-to-end local-model trace with fallback disabled:

```bash
./node_modules/.bin/tsx apps/api/src/poc/localAgentUseCase.ts --local-hf --no-fallback
```

A successful real-model run reports:

- provider `local-huggingface-mlx`;
- model role `audit-fact-selector` for the final narration;
- overall status `completed`;
- model summary status `grounded`;
- a business action that passed deterministic source readback.

The model selects IDs from verified audit facts. The renderer maps those IDs back to canonical statements; malformed, duplicate, unknown, or invented selections are rejected. See [Local models](local-models.md) for cache discovery, variables, roles, and limitations.

## 9. Test The MCP Integration

After the persistent API has bootstrapped the reference sources:

```bash
npm run build
npm run poc:agent:mcp
```

This starts a real MCP stdio client/server pair, searches source resources and evidence, resolves the order entity, plans the configured autonomous action, executes through the same writeback contracts, and reports authoritative readback.

A normal MCP server is read-only by default:

```bash
npm run mcp
```

Mutation tools are independently enabled with:

| Flag | Adds |
| --- | --- |
| `--allow-discovery` | Persisted objective-aware discovery runs |
| `--allow-sync` | Synchronization of an existing operator-configured connection |
| `--allow-write` | Exact business action execution |

MCP never exposes connection creation, semantic proposal decisions, or approval creation. Treat the operating-system identity that starts the server as privileged because the MCP runtime opens the selected control-plane database and local source paths directly.

Read-only MCP means that source mutation tools are absent. Startup may still apply control-plane migrations, and read tools persist audit events in the selected control-plane database.

## 10. Verify The Repository

Run the release checks:

```bash
npm run check
npm run test:e2e
```

`npm run check` performs Markdown/link validation, type checking, Vitest tests, and production builds. Playwright verifies the product and PoC browser workflows separately, including mobile overflow checks.

For the exact acceptance and negative-path checklist, continue with the [Reference workflow](reference-workflow.md) and [Evaluation](evaluation.md). For deeper component and failure-window details, read [Architecture](architecture.md).

Return to the [documentation index](README.md) or [project README](../README.md).
