import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function discoverLocalHuggingFaceModels(cacheRoot = path.join(os.homedir(), ".cache/huggingface/hub")): LocalHuggingFaceModel[] {
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
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        model_type?: string;
        architectures?: string[];
        quantization?: { bits?: number; group_size?: number; mode?: string };
      };
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
  return models.find((model) => model.id === "mlx-community/Qwen3-1.7B-4bit") ?? models.find((model) => model.modelType === "qwen3") ?? models[0] ?? null;
}

export function generateWithLocalHuggingFace(prompt: string, model = pickDefaultLocalModel()): LocalModelGeneration {
  if (!model) {
    throw new Error("No local Hugging Face MLX model found in ~/.cache/huggingface/hub.");
  }
  const scriptPath = resolveMlxScriptPath();
  const output = execFileSync(
    "uv",
    ["run", "--with", "mlx-lm", "--with", "transformers<4.54", "--with", "huggingface-hub", "python", scriptPath, model.snapshotPath, prompt],
    {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 8
    }
  );
  return {
    provider: "local-huggingface-mlx",
    model,
    text: output.trim()
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
    throw new Error(`MLX generation script not found. Checked: ${candidates.join(", ")}`);
  }
  return scriptPath;
}

function scoreModel(model: LocalHuggingFaceModel): number {
  if (model.id === "mlx-community/Qwen3-1.7B-4bit") return 100;
  if (model.id.includes("Qwen3-4B")) return 80;
  if (model.id.includes("gemma")) return 60;
  if (model.id.includes("30B")) return 40;
  return 10;
}
