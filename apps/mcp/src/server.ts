#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSemanticRuntime, loadRuntimeConfig, loadSourceSystems, openDatabase, openMemoryDatabase } from "@semantic-junkyard/api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSemanticJunkyardMcpServer } from "./mcpServer.js";

const args = new Set(process.argv.slice(2));

try {
  const dbPath = readOption("--db") ?? process.env.SEMANTIC_JUNKYARD_DB ?? defaultProductDatabasePath();
  const db = args.has("--memory") ? openMemoryDatabase() : openDatabase(dbPath);
  const runtimeConfig = loadRuntimeConfig(process.env, { validateHttpSecurity: false });
  const runtime = createSemanticRuntime(db, {
    seed: args.has("--memory") && !args.has("--no-seed"),
    maxAutonomousRisk: runtimeConfig.maxAutonomousRisk,
    sourceSystems: runtimeConfig.sourceSystemsFile ? loadSourceSystems(runtimeConfig.sourceSystemsFile) : []
  });
  const server = createSemanticJunkyardMcpServer(runtime);
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultProductDatabasePath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDirectory, "../../api/data/semantic-junkyard.sqlite");
}
