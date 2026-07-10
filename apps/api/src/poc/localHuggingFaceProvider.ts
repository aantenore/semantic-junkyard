import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const LocalModelEnvironmentSchema = z.object({
  SEMANTIC_JUNKYARD_HF_CACHE_ROOT: z.string().min(1).optional().or(z.literal("")),
  SEMANTIC_JUNKYARD_HF_MODEL: z.string().min(1).optional().or(z.literal("")),
  SEMANTIC_JUNKYARD_HF_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  SEMANTIC_JUNKYARD_HF_MAX_TOKENS: z.coerce.number().int().min(16).max(1_024).default(72)
});

export interface LocalHuggingFaceModel {
  id: string;
  snapshotPath: string;
  modelType: string;
  architecture: string;
  quantization: string;
}

export interface LocalModelGeneration {
  provider: "local-huggingface-mlx";
  model: LocalHuggingFaceModel;
  text: string;
}

export interface LocalModelGenerationOptions {
  runtimeCommand?: string;
}

export class LocalModelExecutionError extends Error {
  constructor(public readonly code: "LOCAL_MODEL_NOT_FOUND" | "LOCAL_MODEL_RUNTIME_UNAVAILABLE" | "LOCAL_MODEL_TIMEOUT" | "LOCAL_MODEL_OUTPUT_LIMIT" | "LOCAL_MODEL_FAILED", message: string) {
    super(message);
    this.name = "LocalModelExecutionError";
  }
}

export function discoverLocalHuggingFaceModels(cacheRoot = localModelConfig().cacheRoot): LocalHuggingFaceModel[] {
  if (!fs.existsSync(cacheRoot)) return [];
  const repoDirs = fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("models--"))
    .map((entry) => path.join(cacheRoot, entry.name));

  const models: LocalHuggingFaceModel[] = [];
  for (const repoDir of repoDirs) {
    const snapshotsDir = path.join(repoDir, "snapshots");
    if (!fs.existsSync(snapshotsDir)) continue;
    for (const snapshot of fs.readdirSync(snapshotsDir)) {
      const snapshotPath = path.join(snapshotsDir, snapshot);
      const configPath = path.join(snapshotPath, "config.json");
      if (!fs.existsSync(configPath)) continue;
      const hasWeights = fs.readdirSync(snapshotPath).some((name) => name.endsWith(".safetensors"));
      if (!hasWeights) continue;
      let config: { model_type?: string; architectures?: string[]; quantization?: { bits?: number; group_size?: number; mode?: string } };
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof config;
      } catch {
        continue;
      }
      models.push({
        id: repoIdFromCachePath(repoDir),
        snapshotPath,
        modelType: config.model_type ?? "unknown",
        architecture: config.architectures?.[0] ?? "unknown",
        quantization: config.quantization
          ? `${config.quantization.bits ?? "?"}bit/group${config.quantization.group_size ?? "?"}${config.quantization.mode ? `/${config.quantization.mode}` : ""}`
          : "unknown"
      });
    }
  }

  return models.sort((left, right) => scoreModel(right) - scoreModel(left));
}

export function pickDefaultLocalModel(models = discoverLocalHuggingFaceModels()): LocalHuggingFaceModel | null {
  const configuredModel = localModelConfig().modelId;
  return models.find((model) => model.id === configuredModel) ?? models.find((model) => model.id === "mlx-community/Qwen3-1.7B-4bit") ?? models.find((model) => model.modelType === "qwen3") ?? models[0] ?? null;
}

export async function generateWithLocalHuggingFace(
  prompt: string,
  model = pickDefaultLocalModel(),
  options: LocalModelGenerationOptions = {}
): Promise<LocalModelGeneration> {
  if (!model) {
    throw new LocalModelExecutionError("LOCAL_MODEL_NOT_FOUND", "No compatible local Hugging Face MLX model was found.");
  }
  const scriptPath = resolveMlxScriptPath();
  const config = localModelConfig();
  const stdout = await runMlxProcess(options.runtimeCommand ?? "uv", scriptPath, model.snapshotPath, prompt, config.maxTokens, config.timeoutMs);
  return {
    provider: "local-huggingface-mlx",
    model,
    text: stdout.trim()
  };
}

function localModelConfig() {
  const parsed = LocalModelEnvironmentSchema.parse(process.env);
  return {
    cacheRoot: parsed.SEMANTIC_JUNKYARD_HF_CACHE_ROOT || path.join(os.homedir(), ".cache/huggingface/hub"),
    modelId: parsed.SEMANTIC_JUNKYARD_HF_MODEL || "mlx-community/Qwen3-1.7B-4bit",
    timeoutMs: parsed.SEMANTIC_JUNKYARD_HF_TIMEOUT_MS,
    maxTokens: parsed.SEMANTIC_JUNKYARD_HF_MAX_TOKENS
  };
}

function repoIdFromCachePath(repoDir: string): string {
  return path.basename(repoDir).replace(/^models--/, "").replaceAll("--", "/");
}

function resolveMlxScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, "mlxGenerate.py"),
    path.resolve(process.cwd(), "src/poc/mlxGenerate.py"),
    path.resolve(process.cwd(), "apps/api/src/poc/mlxGenerate.py")
  ];
  const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!scriptPath) {
    throw new LocalModelExecutionError("LOCAL_MODEL_RUNTIME_UNAVAILABLE", "The local MLX generation runtime is not installed correctly.");
  }
  return scriptPath;
}

function runMlxProcess(command: string, scriptPath: string, modelPath: string, prompt: string, maxTokens: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ["run", "--with", "mlx-lm", "--with", "transformers<4.54", "--with", "huggingface-hub", "python", scriptPath, modelPath, String(maxTokens)],
      {
        env: safeChildEnvironment(),
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error?: LocalModelExecutionError, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new LocalModelExecutionError("LOCAL_MODEL_TIMEOUT", "Local model generation timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new LocalModelExecutionError("LOCAL_MODEL_OUTPUT_LIMIT", "Local model output exceeded the configured safety limit."));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(new LocalModelExecutionError("LOCAL_MODEL_RUNTIME_UNAVAILABLE", "The local model process could not be started.")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new LocalModelExecutionError("LOCAL_MODEL_FAILED", "Local model generation failed."));
        return;
      }
      finish(undefined, Buffer.concat(stdoutChunks).toString("utf8"));
    });
    child.stdin.on("error", () => finish(new LocalModelExecutionError("LOCAL_MODEL_FAILED", "The local model prompt could not be delivered.")));
    child.stdin.end(prompt, "utf8");
  });
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowedKeys = ["PATH", "HOME", "TMPDIR", "UV_CACHE_DIR", "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "XDG_CACHE_HOME"];
  return Object.fromEntries(allowedKeys.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
}

function scoreModel(model: LocalHuggingFaceModel): number {
  if (model.id === "mlx-community/Qwen3-1.7B-4bit") return 100;
  if (model.id.includes("Qwen3-4B")) return 80;
  if (model.id.includes("gemma")) return 60;
  if (model.id.includes("30B")) return 40;
  return 10;
}
