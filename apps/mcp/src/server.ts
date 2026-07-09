#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSemanticRuntime, openDatabase, openMemoryDatabase } from "@semantic-junkyard/api";
import fs from "node:fs";
import path from "node:path";
import { createSemanticJunkyardMcpServer } from "./mcpServer.js";

const args = new Set(process.argv.slice(2));

try {
  const dbPath = readOption("--db") ?? process.env.SEMANTIC_JUNKYARD_DB ?? defaultProductDatabasePath();
  const db = args.has("--memory") ? openMemoryDatabase() : openDatabase(dbPath);
  const runtime = createSemanticRuntime(db, { seed: !args.has("--no-seed") });
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
  return path.join(findRepoRoot(), "apps/api/data/semantic-junkyard.sqlite");
}

function findRepoRoot(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string };
      if (packageJson.name === "semantic-junkyard") return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(process.cwd(), "../..");
}
