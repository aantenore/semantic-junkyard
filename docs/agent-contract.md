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

## Safe Tool Set

Current read-only tools:

- `semantic_search`
- `entity_lookup`
- `graph_neighbors`
- `find_paths`
- `expand_context`
- `explain_permissions`
- `open_source_span` via `/api/evidence/:chunkId`

## Agent Procedure For Undefined Problems

1. Call `explain_permissions` for the intent.
2. Run `semantic_search` to identify candidate context.
3. Use `entity_lookup` and `graph_neighbors` to ground important concepts.
4. Use `find_paths` for multi-hop dependency questions.
5. Use `expand_context` to assemble evidence.
6. Check freshness, quality, sensitivity, policy, owner, lineage, and contract version.
7. Answer only with evidence.
8. Stop if the task requires mutation, restricted data, secrets, unsupported source access, or insufficient evidence.

## Explicit Non-Autonomous Actions

These are intentionally outside autonomous scope in the MVP:

- Applying schema, metric, policy, or ontology changes.
- Executing generated SQL on external systems.
- Sending messages or creating tickets.
- Deleting or overwriting source data.
- Re-identifying masked data.
- Modifying access control.

Adapters may implement these later, but they must be approval-gated and audited.

