# Local Models And Deterministic Enrichment

Semantic Junkyard separates model-assisted interpretation from enforcing controls. The deterministic runtime, connector configuration, policy, plan fingerprint, approval, source preconditions, idempotency identity, and postconditions remain authoritative whether or not a model is enabled.

## Runtime Layers

| Layer | Implemented provider | May affect source state? |
| --- | --- | --- |
| Parsing, extraction, embeddings, retrieval, discovery, policy | Deterministic local code | No direct source write. |
| Source semantic enrichment | Deterministic connector facts; optional local Hugging Face proposals | No. Produces proposals only. |
| Conversational intent interpretation | Deterministic rules or local Hugging Face typed intent JSON | No. Produces a candidate intent contract only. |
| Action resolution and verification | Deterministic engine plus typed connectors | Yes, but only through configured capabilities and controls. |
| Bundled PoC trace summary | Deterministic text or local Hugging Face summary | No. Runs after the deterministic trace. |

There is no autonomous LLM tool loop inside the control plane.

## Deterministic Semantic Runtime

The default runtime makes no inference request. It uses:

- local format parsing and stable semantic-window chunks;
- extractive summaries;
- configured patterns and proper-noun heuristics for entities, relations, and claims;
- 128-dimensional signed token-hash embeddings;
- SQLite FTS5 and cosine similarity;
- deterministic lexical/vector/graph/quality/freshness score fusion;
- connector-declared source facts and deterministic proposal lifecycle;
- deterministic action routing, policy/risk checks, fingerprints, and postconditions.

This baseline is reproducible and testable, but its semantic quality is intentionally limited.

## Reported Provider Configuration

`SEMANTIC_JUNKYARD_MODEL_PROVIDER` accepts `deterministic`, `ollama`, or `openai-compatible`. `GET /api/providers` reports the selected configuration.

Only `deterministic` returns `runtimeUsage: "semantic-runtime"`. Ollama and OpenAI-compatible selections return `configuration-only`: the engine does not probe those endpoints or use them for parsing, extraction, embeddings, reranking, intent interpretation, planning, policy, or verification.

Example configuration:

```bash
export SEMANTIC_JUNKYARD_MODEL_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.2
export OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

```bash
export SEMANTIC_JUNKYARD_MODEL_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:8080/v1
export OPENAI_COMPATIBLE_MODEL=local-model
export OPENAI_COMPATIBLE_EMBEDDING_MODEL=local-embedding-model
```

Selecting either block does not make an inference integration operational.

## Local Hugging Face Runtime

Real optional generation uses `mlx-lm` through `uv` and a compatible Hugging Face snapshot already present in the local cache. The runner:

- scans `models--*` cache directories for `config.json` and `.safetensors`;
- selects models by role: the configured/default 1.7B model for intent interpretation and the configured/default 4B model for semantic enrichment, with discovered Qwen fallbacks;
- sends prompts through stdin rather than command arguments;
- passes only selected path/home/temp/cache environment variables to the child;
- caps captured output at 8 MiB;
- kills the process on timeout;
- suppresses raw stderr from API/model errors.

The model snapshot is not downloaded by Semantic Junkyard. `uv run --with ...` may still resolve Python runtime packages if they are not cached, so an offline deployment must pre-provision both model and package caches.

### Variables

| Variable | Default | Constraint |
| --- | --- | --- |
| `SEMANTIC_JUNKYARD_HF_CACHE_ROOT` | `~/.cache/huggingface/hub` | Existing Hugging Face cache root. |
| `SEMANTIC_JUNKYARD_HF_MODEL` | `mlx-community/Qwen3-1.7B-4bit` | Preferred discovered repository ID. |
| `SEMANTIC_JUNKYARD_HF_ENRICHMENT_MODEL` | `mlx-community/Qwen3-4B-4bit` | Preferred discovered repository ID for source-semantic proposals. |
| `SEMANTIC_JUNKYARD_HF_TIMEOUT_MS` | `120000` | 1,000 to 600,000 ms. |
| `SEMANTIC_JUNKYARD_HF_MAX_TOKENS` | `72` | Default 16 to 1,024; bounded roles may supply their own lower/role-specific limit. |

The intended runtime is Apple Silicon/macOS with `uv`, MLX-compatible weights, and sufficient memory. It is not a cross-platform production model service.

## Source Enrichment Role

A source sync with provider `local-huggingface` sends at most 24 observed resource summaries. Each summary is limited to typed fields such as resource ID, parent, kind, name, qualified name, data type, description, sensitivity, and writability.

The prompt labels those summaries as untrusted evidence and requires one strict JSON object containing bounded arrays of concepts, relations, classifications, and conflicts. Validation then:

- accepts only exact IDs from the supplied resource set;
- rejects self-relations and unknown IDs;
- validates confidence, lengths, relation naming, and shape;
- deduplicates candidates;
- caps each candidate kind at eight;
- records discarded/capped counts and a concise audit summary.

Accepted candidates become `local_model` proposals with resource/chunk evidence. They are not authoritative and require operator review. Malformed or over-limit output yields no model proposals rather than guessed semantics. A model runtime exception marks the synchronous run `partial` and leaves deterministic source facts available; there is no durable retry job.

## Intent Interpretation Role

The external conversational PoC can select deterministic or local-HF intent interpretation. The output schema contains:

```text
objective
resourceQuery
searchQuery
entityQuery | null
actionIntent | null
requestedAction
confidence
summary
warnings[]
provider + modelId
```

The model cannot call tools. The harness independently requires an explicit mutation verb in the original user message before preserving `requestedAction: true`; otherwise it forces the turn read-only and records a warning. Low confidence, missing evidence, or no matching writable resource stops the client before planning.

Invalid local-model intent JSON fails the interpretation request without running downstream tools or writes. There is no silent deterministic fallback for this API role.

## Trace Summary Role

`npm run poc:agent:hf` runs the real local supply-chain sequence against temporary filesystem, SQLite, and Git sources, then asks the model to select two IDs from a bounded set of deterministic verified audit facts. The renderer resolves those IDs back to canonical human-readable statements. Unknown, duplicate, malformed, or invented selections are rejected and mark the narration degraded; raw model claims never enter the authoritative final answer. The model cannot reorder tools, alter the plan, approve, write, verify, or override stop conditions.

The acceptance command prints its report without modifying the repository. Add `-- --write-report` only when deliberately refreshing `artifacts/poc/local-agent-use-case-report.json`; temporary fixture paths make evidence chunk IDs run-specific.

This CLI path allows deterministic fallback by default and reports `local-huggingface-mlx-unavailable-fallback` plus a normalized error code when generation is unavailable. `--no-fallback` turns that into a command failure. The connector workflow and every write/readback decision remain deterministic even when the optional summary uses a local model.

## No Chain-Of-Thought Contract

Semantic Junkyard does not request or store hidden chain-of-thought.

- The MLX chat template disables thinking where supported.
- Enrichment and interpretation prompts require JSON without prose, analysis, or reasoning traces.
- Summary prompts request concise operational explanation rather than private reasoning.
- Persisted audit artifacts contain model identity, validated outputs, counts, explanations, evidence IDs, decisions, tool observations, and source readback.

This is a deliberate trust boundary: audit claims must be supported by observable evidence and deterministic checks, not unverifiable hidden reasoning.

## Failure And Safety Boundaries

- A model cannot create/modify source connection configuration.
- A model cannot mark a proposal authoritative or accepted.
- A model cannot select an arbitrary SQL statement, file path, Git patch, shell command, or unknown connector.
- A model-derived action intent still passes resource grounding, exact connector resolution, policy, fingerprint, approval, idempotency, preconditions, and postconditions.
- Prompt text and raw local model paths are not echoed in normalized API errors.
- There is no model-output faithfulness evaluator in the release gate.

## Current Gaps

- Ollama/OpenAI-compatible settings are reporting only.
- MLX is a process-level local integration, not an injected multi-provider abstraction.
- No locked Python environment is committed; `uv` resolves declared runtime packages.
- No automated real-model inference test runs in the default suite.
- No model quality, faithfulness, bias, or adversarial prompt-injection benchmark is a release gate.
- Source enrichment is bounded to summaries rather than full evidence chunks.
- Intent interpretation supports a narrow reference vocabulary and still depends on deterministic connector resolution.
- No hidden chain-of-thought is available for debugging by design; debugging uses typed artifacts and observable traces.
