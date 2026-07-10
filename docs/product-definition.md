# Product Definition

## Product Statement

Semantic Junkyard is an **agent-safe semantic federation and verified change-control plane**. It gives agents one bounded contract for discovering evidence across heterogeneous sources and for changing an authoritative source only when the target, policy, approval, idempotency identity, reread, and postcondition are explicit.

It is not a catalog replacement. Catalogs, databases, repositories, files, and future operational systems remain systems of record. Semantic Junkyard maintains a derived control plane that answers two questions:

1. What governed, source-linked context may this agent use for the current objective?
2. What exact source change, if any, may it make, and how can the system prove the source now reflects it?

## Problem

An agent that receives only search results or a catalog tool still has unsafe gaps:

- a retrieved assertion may be inferred rather than authoritative;
- source identity and evidence can be lost during enrichment;
- a business request can be translated to the wrong technical object;
- an approval can be detached from the diff that was reviewed;
- a connector success response can be mistaken for authoritative state;
- retries can duplicate effects;
- model-generated context can silently become semantic truth.

Semantic Junkyard makes those gaps first-class product states instead of leaving them to prompt instructions.

## Product Contract

### Semantic Federation

- Register explicit source connections and their read/write configuration.
- Discover resources from each source without claiming ownership of the source.
- Materialize bounded evidence with source/resource provenance.
- Publish declared source facts as authoritative observations.
- Store deterministic and model-generated interpretations as evidence-bound proposals.
- Namespace source-local semantic IDs by connection while retaining their declared identity and contract membership as provenance.
- Expose policy-filtered resource, lexical, vector, graph, and evidence tools through REST and MCP.

### Verified Change Control

- Accept a business intent, not arbitrary connector commands.
- Resolve it to exactly one typed configured capability or fail closed.
- Return the target identity, operation, before/after state, evidence, risk, autonomy, and source-version preconditions.
- Fingerprint the complete resolved plan.
- Recompute the plan at approval and execution time.
- Bind a human approval to one plan ID/fingerprint pair.
- Bind an idempotency key to one exact execution request.
- Execute through the connector's allowlist and optimistic preconditions.
- Reread the authoritative source independently and evaluate an explicit postcondition.
- Refresh semantic evidence only from verified writes.

## Authority Model

| Artifact | Authority | Lifecycle |
| --- | --- | --- |
| Filesystem/Git content and SQLite schema/rows | Connected source | Read or changed only through connector rules. |
| Declared structural fact | Source observation | Automatically accepted and marked authoritative. |
| Deterministic inference | Control-plane proposal | Proposed, then accepted, rejected, or superseded. |
| Local-model candidate | Control-plane proposal | Proposed, strictly validated, never authoritative by origin. |
| Human proposal decision | Operator control plane | Audited decision with rationale. |
| Action plan | Read-only change candidate | Valid only while its target state and fingerprint still match. |
| Approval | Human control plane | Exact-plan-bound and single-use in the current implementation. |
| Connector response | Operational observation | Insufficient by itself. |
| Authoritative reread plus postcondition | Completion evidence | Required before a run is `verified` and semantic reflection is published. |

## Intended Users

- Data and AI platform engineers exposing governed context to agents.
- Data stewards reviewing inferred relations, classifications, descriptions, and conflicts.
- Software architects defining safe source capabilities rather than generic write tools.
- Agent builders who need a stable API/MCP contract independent of one model provider.
- Reviewers evaluating whether reflected state supports an agent's completion claim.

## Product Surfaces

The product workbench is the operator control plane. It manages source connections, synchronization, proposal decisions, evidence inspection, exact plan review, approval, execution, and reflected readback.

The conversational PoC is a separate external REST application. It demonstrates how an agent client interprets a request, searches observed resources, retrieves governed evidence, stops at explicit boundaries, plans an exact action, and executes only autonomous targets. It cannot approve its own request.

The MCP stdio server is a second external-agent surface. It opens the selected SQLite control plane in its own process and is read-only by default. Persisted discovery, source synchronization, and business execution require independent startup flags. It cannot configure connections, decide proposals, or create approvals.

## Design Principles

1. **Federate authority; do not flatten it.** The semantic read model is useful context, not a replacement source of truth.
2. **Evidence before interpretation.** Every proposal and action target must be grounded in observed resource or chunk identity.
3. **Proposal before promotion.** Non-authoritative inference does not silently become accepted semantics.
4. **Business intent before technical operation.** The connector resolves a typed target; clients do not submit arbitrary SQL, shell, paths, or patches.
5. **Precondition before write.** The planned source version must still be current.
6. **Approval binds to content.** A human approves one exact fingerprint, not a generic intent.
7. **Readback before completion.** Connector success is not the postcondition.
8. **Models advise; deterministic controls decide.** Local models may interpret or propose but cannot grant authority or bypass the harness.
9. **Observable audit over hidden reasoning.** Store evidence, typed artifacts, concise explanations, decisions, tool events, diffs, and readbacks. Do not request or persist hidden chain-of-thought.
10. **Fail closed on ambiguity.** Zero or multiple source targets produce no write.

## Non-Goals

- Replacing DataHub, OpenMetadata, or another enterprise catalog.
- Becoming the authoritative database, Git service, document store, or semantic-model standard.
- Accepting arbitrary source credentials and generating a write connector at runtime.
- Giving an LLM a generic database, filesystem, shell, or network mutation tool.
- Capturing private model chain-of-thought as an audit mechanism.
- Claiming distributed exactly-once execution, transactional outbox behavior, or production workflow durability in the reference implementation.
- Claiming production tenancy, IAM, policy federation, HA, or connector scale.

## Reference Scope

Implemented now:

- local filesystem, SQLite, and Git discovery;
- direct and connector-driven evidence ingestion, including enforced no-copy source retention modes;
- deterministic semantic processing and optional bounded local-HF enrichment;
- authoritative source facts plus proposed/accepted/rejected/superseded semantics;
- SQLite allowlisted record updates and Git semantic-contract commits;
- exact plan fingerprinting, policy/autonomy checks, separate approval, local idempotency, authoritative reread, and postconditions;
- operator UI, external conversational REST PoC, REST/OpenAPI, and MCP stdio.

Not implemented now:

- remote production connectors or arbitrary connector plugins;
- multi-node or multi-tenant control plane;
- production IAM or source-native ACL federation;
- durable queue, scheduler, outbox, retries, or crash reconciliation;
- distributed transactions across control plane and source;
- production model-provider injection or quality gates;
- OSI/Ossie import/export compatibility;
- hidden chain-of-thought capture.

## Product Acceptance

The product hypothesis is accepted only if an external client can complete the workflow in [Reference workflow](reference-workflow.md) and every checklist item passes. A successful API response without authoritative reread is not acceptance.
