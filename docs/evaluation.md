# Evaluation

Production semantic layers for agents need evals beyond chat answer quality.

## Built-In MVP Checks

The current test suite verifies:

- Seeded catalog and corpus load.
- Full data ingestion creates chunks, entities, relations, and claims.
- Hybrid search returns grounded results.
- Graph snapshot contains nodes and edges.
- Discovery agent emits a capability-aware plan.
- Agent manifest exposes autonomy boundaries.

Run:

```bash
npm test
```

## Recommended Production Evals

- Retrieval recall: can the system find relevant chunks, assets, metrics, and graph nodes?
- Citation accuracy: does each answer cite the correct source span?
- Entity resolution precision: are aliases and duplicates merged correctly?
- Relation precision: are extracted edges supported by evidence?
- Graph usefulness: do graph paths help answer multi-hop tasks?
- Policy compliance: are restricted, stale, low-quality, and masked assets handled correctly?
- Semantic contract consistency: do metrics and dimensions match governed definitions?
- Freshness and quality sensitivity: does the agent warn or stop when assets are stale or weak?
- Cost and latency: are expensive external calls bounded and cached?
- Drift: do schema, lineage, ontology, and metric changes alter retrieval behavior?

