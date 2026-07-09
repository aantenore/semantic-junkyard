# Local And Model-Agnostic Providers

The local MVP does not require an LLM. It uses deterministic extraction and local hash embeddings so tests and demos run offline.

To connect local models, configure environment variables before starting the API.

## Ollama

```bash
export SEMANTIC_JUNKYARD_MODEL_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.2
export OLLAMA_EMBEDDING_MODEL=nomic-embed-text
npm run dev
```

The provider is exposed at:

```bash
curl http://localhost:8787/api/providers
```

## OpenAI-Compatible Local Servers

```bash
export SEMANTIC_JUNKYARD_MODEL_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:8080/v1
export OPENAI_COMPATIBLE_MODEL=local-model
npm run dev
```

Examples include vLLM, LM Studio, llama.cpp server, LocalAI, and other OpenAI-compatible runtimes.

## Current Boundary

Provider configuration is implemented and visible to the product. The local extraction path remains deterministic for reproducible tests. Production adapters should implement:

- embeddings
- extraction
- reranking
- summarization
- policy risk classification
- ontology-guided validation suggestions

