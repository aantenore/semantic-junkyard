import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const apiToken = env.SEMANTIC_JUNKYARD_API_TOKEN || process.env.SEMANTIC_JUNKYARD_API_TOKEN;
  return {
    envDir: workspaceRoot,
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {
        "/api": {
          target: env.VITE_DEV_API_TARGET || "http://127.0.0.1:8787",
          changeOrigin: true,
          headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined
        }
      }
    }
  };
});
