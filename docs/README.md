# Semantic Junkyard Documentation

This documentation explains the shipped local reference implementation. It distinguishes implemented behavior from production requirements and uses the source system, not the semantic read model or an AI model, as the final authority.

## Choose A Starting Point

| You want to... | Start here |
| --- | --- |
| Understand the idea and every end-to-end flow | [How it works](how-it-works.md) |
| Start the apps and try the real reference cases | [Hands-on guide](user-guide.md) |
| Define product scope, principles, and non-goals | [Product definition](product-definition.md) |
| Inspect components, boundaries, and failure windows | [Architecture](architecture.md) |
| Integrate an AI agent over REST or MCP | [Agent contract](agent-contract.md) |
| Implement or replace a connector or policy adapter | [Adapter contracts](adapter-contracts.md) |
| Configure and evaluate local Hugging Face behavior | [Local models](local-models.md) |
| Reproduce the complete acceptance path | [Reference workflow](reference-workflow.md) |
| Understand automated and manual verification | [Evaluation](evaluation.md) |
| Compare the product hypothesis with existing systems | [Market scan](market-scan.md) |

## The Short Mental Model

Semantic Junkyard has two paths that share one governed control plane:

- The **read path** turns heterogeneous source observations into searchable, navigable, provenance-linked context.
- The **write path** translates business intent into one configured source capability, verifies the source result, and then refreshes the read path.
- The **model path** is advisory. It may propose semantics or interpret intent but cannot approve, bypass policy, select arbitrary operations, or declare a write successful.

## Implemented Reference Scope

The repository currently proves these behaviors with local filesystem, SQLite, and Git connectors, a single-node SQLite control-plane database, an Express API, two separate React applications, an MCP stdio server, deterministic semantic processing, and optional local Hugging Face inference through MLX.

It does **not** claim production tenancy, IAM, source ACL propagation, high availability, distributed transactions, durable job orchestration, remote enterprise connectors, or automatic crash reconciliation. Those boundaries are detailed in [Architecture](architecture.md#current-deployment-limits).

Return to the [project README](../README.md).
