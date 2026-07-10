import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLocalHuggingFaceModels, generateWithLocalHuggingFace, LocalModelExecutionError, pickDefaultLocalModel } from "./localHuggingFaceProvider.js";

describe("local Hugging Face provider", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers local MLX snapshots and prioritizes the smaller Qwen model", () => {
    const cacheRoot = makeCacheRoot();
    writeSnapshot(cacheRoot, "mlx-community/Qwen3-4B-4bit", "qwen3", "Qwen3ForCausalLM", true);
    writeSnapshot(cacheRoot, "mlx-community/Qwen3-1.7B-4bit", "qwen3", "Qwen3ForCausalLM", true);
    writeSnapshot(cacheRoot, "mlx-community/metadata-only", "qwen3", "Qwen3ForCausalLM", false);

    const models = discoverLocalHuggingFaceModels(cacheRoot);

    expect(models.map((model) => model.id)).toEqual(["mlx-community/Qwen3-1.7B-4bit", "mlx-community/Qwen3-4B-4bit"]);
    expect(models[0]?.quantization).toBe("4bit/group64");
    expect(pickDefaultLocalModel(models)?.id).toBe("mlx-community/Qwen3-1.7B-4bit");
  });

  it("does not echo prompts or model paths when the local runtime cannot start", async () => {
    const sentinel = "PRIVATE_PROMPT_SENTINEL";
    const modelPath = "/private/model/path/SENSITIVE_MODEL";
    let caught: unknown;
    try {
      await generateWithLocalHuggingFace(sentinel, {
          id: "test/model",
          snapshotPath: modelPath,
          modelType: "qwen3",
          architecture: "Qwen3ForCausalLM",
          quantization: "4bit"
        }, { runtimeCommand: "semantic-junkyard-missing-runtime-for-test" });
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain(modelPath);
    expect(caught).toBeInstanceOf(LocalModelExecutionError);
    expect(caught).toMatchObject({ code: "LOCAL_MODEL_RUNTIME_UNAVAILABLE" });
  });

  function makeCacheRoot(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-hf-"));
    tempDirs.push(tempDir);
    return tempDir;
  }
});

function writeSnapshot(cacheRoot: string, repoId: string, modelType: string, architecture: string, includeWeights: boolean) {
  const snapshotDir = path.join(cacheRoot, `models--${repoId.replaceAll("/", "--")}`, "snapshots", "test-snapshot");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "config.json"),
    JSON.stringify({
      model_type: modelType,
      architectures: [architecture],
      quantization: { bits: 4, group_size: 64 }
    }),
    "utf8"
  );
  if (includeWeights) {
    fs.writeFileSync(path.join(snapshotDir, "weights.safetensors"), "", "utf8");
  }
}
