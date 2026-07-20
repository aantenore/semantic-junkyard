# Changelog

All notable changes to Semantic Junkyard are recorded here. The project follows Semantic
Versioning while it is released as an alpha source distribution.

## [0.1.0-alpha.1] - 2026-07-20

First public alpha of the local-first semantic federation and verified semantic-action reference
product.

### Added

- Federated discovery over local filesystem, SQLite, and Git sources with provenance-linked
  evidence, lexical/vector/graph retrieval, and governed semantic proposals.
- Exact business-action plans with actor and policy binding, source-version preconditions, optional
  approval, idempotent execution, authoritative reread, and postcondition verification.
- Operator workbench, independent conversational PoC, REST/OpenAPI contract, and a read-only-by-
  default MCP stdio server.
- Deterministic offline enrichment plus an optional bounded local Hugging Face path for typed
  suggestions.
- A concrete threat model, documentation integrity check, browser acceptance path, and built-
  artifact API/MCP release smoke on Linux and Windows.

### Security

- Control-plane SQLite storage is confined to the deterministic product-owned root used by default
  launchers, or an explicit pre-existing root supplied programmatically by an embedding host.
  Database names are portable relative paths; traversal, absolute or drive-qualified paths, file
  URIs, reserved device names, symbolic links, multiply linked files, and orphaned rollback/WAL
  sidecars fail before SQLite opens the target.
- GitHub Actions are pinned to reviewed commit identifiers with read-only workflow permissions.
- Private vulnerability reporting is documented as the disclosure path.

### Verification

- The minimum supported runtime is Node.js 20.19.0.
- `npm run check` validates documentation, types, unit/integration behavior, and all production
  builds.
- `npm run benchmark:reference` gates one fixed synthetic fixture at 7/7 relevant items retrieved in
  the top five, 3/3 exact targets, 3/3 unsupported-intent abstentions, 0/6 false verified outcomes,
  one idempotent replay, and one stale-precondition rejection. It does not claim general retrieval
  quality, production safety, or comparative model performance.
- `node scripts/smoke-release.mjs` starts the built API in isolated temporary storage, checks
  liveness/readiness/OpenAPI, and performs an MCP handshake plus tool discovery.

### Known Limitations

This is a source-installable local reference release, not a published npm package or a production
multi-tenant service. See the [threat model](docs/threat-model.md#failure-windows-and-residual-risks)
and [current limitations](README.md#current-limitations) before deployment.

[0.1.0-alpha.1]: https://github.com/aantenore/semantic-junkyard/releases/tag/v0.1.0-alpha.1
