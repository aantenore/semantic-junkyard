import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const apiToken = env.SEMANTIC_JUNKYARD_API_TOKEN || process.env.SEMANTIC_JUNKYARD_API_TOKEN;
  const operatorToken = env.SEMANTIC_JUNKYARD_OPERATOR_TOKEN || process.env.SEMANTIC_JUNKYARD_OPERATOR_TOKEN;
  const approvalToken = env.SEMANTIC_JUNKYARD_APPROVAL_TOKEN || process.env.SEMANTIC_JUNKYARD_APPROVAL_TOKEN;
  return {
    envDir: workspaceRoot,
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: env.VITE_DEV_API_TARGET || "http://127.0.0.1:8787",
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest, request) => {
              const operatorPath = [
                "/api/business/actions/approve",
                "/api/catalog/import",
                "/api/ingest",
                "/api/semantic/relations",
                "/api/semantic/proposals",
                "/api/source-connections"
              ].some((prefix) => request.url?.startsWith(prefix));
              const approvalPath = request.url?.startsWith("/api/business/actions/approve") || request.url?.startsWith("/api/business/actions/approvals");
              const token = approvalPath ? approvalToken : operatorPath ? operatorToken : apiToken;
              if (token) proxyRequest.setHeader("Authorization", `Bearer ${token}`);
            });
          }
        }
      }
    }
  };
});
