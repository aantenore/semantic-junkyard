# Local Models And Provider Configuration

Semantic Junkyard has two separate model concepts:

1. The semantic runtime provider reported by `GET /api/providers`.
2. The optional Hugging Face MLX generator used only by the bundled PoC audit summary.

They are not interchangeable and neither controls an autonomous LLM tool loop.

## Deterministic Semantic Runtime

The working semantic runtime requires no model server and makes no inference request. It uses:

- Extractive chunk summaries.
- Pattern and proper-noun extraction.
- 128-dimensional hash embeddings.
- Deterministic score fusion and discovery profiling.
- Regex-based action classification and server-side policy/risk checks.

The default provider response is equivalent to:

```json
{
  "id": "provider.deterministic",
  "kind": "deterministic",
  "model": "deterministic-rules",
  "embeddingModel": "local-hash-128",
  "enabled": true,
  "runtimeUsage": "semantic-runtime"
}
```

This is the only provider currently used by ingestion, retrieval, discovery, action planning, or policy enforcement.

## Configuration-Only Providers

`SEMANTIC_JUNKYARD_MODEL_PROVIDER` accepts `deterministic`, `ollama`, or `openai-compatible`. The API validates the value at startup and reports the selected configuration.

For Ollama, the active configuration variables are:

```bash
export SEMANTIC_JUNKYARD_MODEL_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.2
export OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

For an OpenAI-compatible endpoint, they are:

```bash
export SEMANTIC_JUNKYARD_MODEL_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:8080/v1
export OPENAI_COMPATIBLE_MODEL=local-model
export OPENAI_COMPATIBLE_EMBEDDING_MODEL=local-embedding-model
```

These variables affect only the `ProviderConfig` returned by `GET /api/providers` and displayed in the frontends. Both selections return `runtimeUsage: "configuration-only"`. The API does not probe the base URL, load an SDK, send prompts, create embeddings, or fall back based on endpoint health. `enabled: true` means the configuration was selected, not that connectivity was verified.

The API reads these values from its process environment. It does not load a root `.env` file automatically.

## Real Local Hugging Face Generation

The PoC path can perform real local generation through `mlx-lm`:

```bash
npm run poc:agent:hf
```

The deterministic PoC first creates an in-memory seeded semantic runtime and executes this fixed sequence:

```text
explain_permissions
semantic_search
entity_lookup
graph_neighbors
expand_context
business_action_plan
business_action_execute
semantic_search
```

Only after that sequence does the MLX runner receive a bounded prompt containing selected evidence excerpts. The model is instructed to produce a concise operational audit summary without private chain-of-thought. Its text is appended to the deterministic answer and recorded with:

- `orchestrationProvider: "deterministic-policy-harness"`
- `modelRole: "trace-summarizer"`
- `provider: "local-huggingface-mlx"` when generation succeeds

The model does not select or reorder tools, change search results, create the action plan, approve execution, write source records, verify reflection, or override stop conditions.

The PoC HTTP endpoint uses the same boundary:

```http
POST /api/poc/local-agent
Content-Type: application/json

{"provider":"local-huggingface"}
```

The separate PoC cockpit calls that endpoint through its REST client. Its normal conversational workflow is also deterministic even when the UI's audit-run provider control is set to Hugging Face.

## Local Runtime Requirements

The MLX path is intended for a compatible Apple Silicon/macOS environment with:

- `uv` available on `PATH`.
- A compatible Hugging Face snapshot already present in the local cache.
- Sufficient memory for the selected MLX model.

The runner scans directories named `models--*` under the cache root, requires `config.json` and at least one `.safetensors` file, and passes the snapshot path directly to `mlx-lm`. It does not download a missing model snapshot. The `uv run --with ...` command may resolve Python runtime packages (`mlx-lm`, `transformers<4.54`, and `huggingface-hub`) if they are not cached.

Model selection order is:

1. Exact `SEMANTIC_JUNKYARD_HF_MODEL` match.
2. `mlx-community/Qwen3-1.7B-4bit`.
3. Another model whose `model_type` is `qwen3`.
4. The highest-scored discovered fallback.

The active MLX variables are:

| Variable | Default | Constraint |
| --- | --- | --- |
| `SEMANTIC_JUNKYARD_HF_CACHE_ROOT` | `~/.cache/huggingface/hub` | Existing cache directory. |
| `SEMANTIC_JUNKYARD_HF_MODEL` | `mlx-community/Qwen3-1.7B-4bit` | Exact discovered repository ID when available. |
| `SEMANTIC_JUNKYARD_HF_TIMEOUT_MS` | `120000` | 1,000 to 600,000 ms. |
| `SEMANTIC_JUNKYARD_HF_MAX_TOKENS` | `72` | 16 to 1,024 tokens. |

The child process receives the prompt through stdin. Its environment is restricted to selected path, home, temporary-directory, uv-cache, and Hugging Face cache variables. Output is capped at 8 MiB and the process is killed on timeout.

## Fallback Behavior

The normal `poc:agent:hf` flow allows fallback. If no compatible snapshot exists, `uv` cannot start, generation times out, output exceeds the limit, or MLX exits unsuccessfully, the deterministic workflow still completes and the report identifies:

```text
provider: local-huggingface-mlx-unavailable-fallback
modelRole: deterministic-summary
```

The fallback records only a normalized runtime error code, not the prompt, model path, or raw child-process error, and sets the report's `overallStatus` to `degraded` when the deterministic workflow otherwise completed. A successful semantic/action trace therefore does not prove that MLX inference ran; check `provider`, `model`, `modelRole`, and `overallStatus` in the report.

The CLI implementation also recognizes `--no-fallback` for diagnostic runs, causing a local-model failure to fail the process instead of producing the fallback report.

## Current Gaps

- There is no model-provider injection into `SemanticEngine`.
- Ollama and OpenAI-compatible settings do not perform inference or connectivity checks.
- MLX generation is not part of the regular Vitest suite and is platform-dependent.
- The local model summarizes a fixed demo trace; it is not a general agent planner.
- Runtime Python dependencies are resolved dynamically rather than from a locked Python environment.
- No model-output evaluation gate decides whether the summary is faithful before it is appended to the deterministic answer.
