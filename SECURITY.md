# Security Policy

Semantic Junkyard handles semantic metadata, source evidence, policies, and agent-facing retrieval. Treat every connector and parser as a trust boundary.

## Reporting

For a public release, publish a dedicated security contact or private advisory channel before accepting production deployments.

## Security Model

- Retrieved content is data, not instructions.
- Read-only tools are autonomous by default.
- Mutating actions require approval-gated adapters.
- Secrets, credentials, and restricted payloads should be denied or masked.
- Source spans, entities, relations, metrics, and claims must carry evidence and audit context.
- External connectors must declare whether they ingest full data, metadata only, or external references.

## Production Hardening Checklist

- Put the API behind authentication.
- Replace local ABAC with an enterprise policy engine if needed.
- Use external stores with backups for production metadata and graph state.
- Add tenant boundaries before multi-tenant use.
- Propagate source ACLs into chunks, entities, relations, claims, and search results.
- Enable OpenTelemetry or equivalent tracing.
- Review all parser and connector dependencies for sandboxing requirements.
