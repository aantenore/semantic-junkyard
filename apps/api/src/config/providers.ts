import type { ProviderConfig } from "@semantic-junkyard/shared";
import { z } from "zod";

const ProviderKindSchema = z.enum(["deterministic", "ollama", "openai-compatible"]);

export function loadProviderConfig(): ProviderConfig {
  const kind = ProviderKindSchema.parse(process.env.SEMANTIC_JUNKYARD_MODEL_PROVIDER ?? "deterministic");
  if (kind === "ollama") {
    return {
      id: "provider.ollama",
      kind: "ollama",
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      model: process.env.OLLAMA_MODEL ?? "llama3.2",
      embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",
      enabled: true,
      runtimeUsage: "configuration-only"
    };
  }
  if (kind === "openai-compatible") {
    return {
      id: "provider.openai-compatible",
      kind: "openai-compatible",
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "http://localhost:8080/v1",
      model: process.env.OPENAI_COMPATIBLE_MODEL ?? "local-model",
      embeddingModel: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL,
      enabled: true,
      runtimeUsage: "configuration-only"
    };
  }
  return {
    id: "provider.deterministic",
    kind: "deterministic",
    model: "deterministic-rules",
    embeddingModel: "local-hash-128",
    enabled: true,
    runtimeUsage: "semantic-runtime"
  };
}
