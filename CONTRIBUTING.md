# Contributing

Semantic Junkyard is designed as a capability-agnostic semantic layer for AI agents. Contributions should preserve that direction.

## Principles

- Keep capabilities replaceable through explicit contracts.
- Do not hardcode one model, database, parser, policy engine, or agent framework.
- Preserve provenance and evidence links for semantic objects.
- Treat policy, lineage, quality, freshness, and sensitivity as first-class retrieval signals.
- Add tests for ingestion, retrieval, graph traversal, policy behavior, and agent manifests when changing core behavior.

## Local Development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

## Adapter Contributions

New adapters should document:

- capability kind
- external system supported
- configuration shape
- failure behavior
- policy implications
- test strategy

Do not let an adapter bypass the agent capability manifest or audit log.
