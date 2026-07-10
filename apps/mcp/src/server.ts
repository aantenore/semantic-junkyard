#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSemanticRuntime, loadRuntimeConfig, loadSourceSystems, openDatabase, openMemoryDatabase } from "@semantic-junkyard/api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSemanticJunkyardMcpServer } from "./mcpServer.js";

const args = new Set(process.argv.slice(2));
let db: ReturnType<typeof openDatabase> | null = null;
let server: ReturnType<typeof createSemanticJunkyardMcpServer> | null = null;
let shuttingDown = false;

try {
  const dbPath = readOption("--db") ?? process.env.SEMANTIC_JUNKYARD_DB ?? defaultProductDatabasePath();
  db = args.has("--memory") ? openMemoryDatabase() : openDatabase(dbPath);
  const runtimeConfig = loadRuntimeConfig(process.env, { validateHttpSecurity: false });
  const runtime = createSemanticRuntime(db, {
    seed: args.has("--memory") && !args.has("--no-seed"),
    maxAutonomousRisk: runtimeConfig.maxAutonomousRisk,
    sourceSystems: runtimeConfig.sourceSystemsFile ? loadSourceSystems(runtimeConfig.sourceSystemsFile) : []
  });
  server = createSemanticJunkyardMcpServer(runtime, {
    allowDiscoveryRuns: args.has("--allow-discovery"),
    allowSourceSync: args.has("--allow-sync"),
    allowBusinessWrites: args.has("--allow-write")
  });
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.stdin.once("end", () => void shutdown(0));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  await shutdown(1);
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  try {
    await server?.close();
  } finally {
    db?.close();
  }
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultProductDatabasePath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDirectory, "../../api/data/semantic-junkyard.sqlite");
}
