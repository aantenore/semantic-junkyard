# Agent Contract

Semantic Junkyard is designed so an agent placed above it can understand what it can and cannot do without hidden assumptions.

## Capability Manifest

`GET /api/agent/manifest` returns:

- Product name and version.
- Whether the layer is model-agnostic.
- Autonomy boundary.
- Tool capabilities.
- Tool input schemas.
- Risk class.
- Evidence requirement.
- Operating rules.
- Stop conditions.

## Tool Set

Read and discovery tools:

- `semantic_search`
- `entity_lookup`
- `graph_neighbors`
- `find_paths`
- `expand_context`
- `explain_permissions`
- `open_source_span` via `/api/evidence/:chunkId`

Business action tools:

- `business_action_plan`: read-only planning that resolves business intent into source targets, diffs, evidence, risk, and autonomy.
- `business_action_execute`: policy-governed writeback that executes only through configured source-system capabilities and requires reflection before completion.

## Agent Procedure For Undefined Problems

1. Call `explain_permissions` for the intent.
2. Run `semantic_search` to identify candidate context.
3. Use `entity_lookup` and `graph_neighbors` to ground important concepts.
4. Use `find_paths` for multi-hop dependency questions.
5. Use `expand_context` to assemble evidence.
6. Check freshness, quality, sensitivity, policy, owner, lineage, and contract version.
7. Answer only with evidence.
8. If the user asks for an action, call `business_action_plan` and inspect target systems, diffs, autonomy, and risk.
9. Execute only if policy allows the requested autonomy level or approval is present.
10. Reread source systems through reflection and treat the action as complete only after the semantic read model refreshes from reflected evidence.
11. Stop if the task requires restricted data, secrets, unsupported source access, destructive mutation, or insufficient evidence.

## Explicit Approval-Gated Or Blocked Actions

These are intentionally outside direct autonomous scope:

- Applying physical schema changes.
- Changing access policies.
- Lowering data sensitivity classifications.
- Executing generated SQL on external systems.
- Sending unapproved external communications.
- Deleting or overwriting source data.
- Re-identifying masked data.
- Modifying access control.

Low/medium-risk writes such as catalog descriptions, reversible lineage metadata, dbt PR proposals, and owner review tickets can run autonomously only when the source-system capability, policy, evidence, and risk threshold allow it. Every write must be audited and reflected back from the source.
