import cors from "cors";
import express from "express";
import type Database from "better-sqlite3";
import { defaultCatalogSnapshot } from "./core/catalogSeed.js";
import { demoDocuments } from "./core/demoCorpus.js";
import { SemanticEngine } from "./core/semanticEngine.js";
import { loadProviderConfig } from "./config/providers.js";
import { openApiDocument } from "./api/openapi.js";
import { mcpCapabilitySnapshot, toMcpToolDescriptors } from "./api/mcp.js";
import { runLocalAgentUseCase } from "./poc/localAgentUseCase.js";
import { SemanticRepository } from "./storage/repository.js";

export interface SemanticRuntime {
  repository: SemanticRepository;
  engine: SemanticEngine;
}

export function createSemanticRuntime(db: Database.Database, options: { seed?: boolean } = {}): SemanticRuntime {
  const repository = new SemanticRepository(db);
  const engine = new SemanticEngine(repository);

  if (options.seed ?? true) {
    seedIfEmpty(engine, repository);
  }

  return { repository, engine };
}

export function createApp(db: Database.Database, options: { seed?: boolean } = {}) {
  const app = express();
  const { repository, engine } = createSemanticRuntime(db, options);

  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/status", (_request, response) => {
    response.json(repository.status());
  });

  app.get("/api/providers", (_request, response) => {
    response.json(loadProviderConfig());
  });

  app.get("/api/catalog", (_request, response) => {
    response.json(repository.catalog());
  });

  app.get("/api/sources", (_request, response) => {
    response.json(repository.getSources().map((source) => ({
      ...source,
      text: source.ingestionMode === "full_data" ? source.text : ""
    })));
  });

  app.post("/api/catalog/import", (request, response) => {
    response.json(engine.importCatalog(request.body));
  });

  app.post("/api/ingest", (request, response) => {
    response.status(201).json(engine.ingest(request.body));
  });

  app.post("/api/discovery/run", (request, response) => {
    response.json(engine.runDiscovery(request.body?.objective));
  });

  app.get("/api/discovery/runs", (_request, response) => {
    response.json(repository.listDiscoveryRuns());
  });

  app.get("/api/graph", (_request, response) => {
    response.json(repository.graphSnapshot());
  });

  app.get("/api/agent/manifest", (_request, response) => {
    response.json(engine.agentManifest());
  });

  app.get("/api/openapi.json", (_request, response) => {
    response.json(openApiDocument);
  });

  app.get("/api/mcp/tools", (_request, response) => {
    response.json({ tools: toMcpToolDescriptors(engine.agentManifest()) });
  });

  app.get("/api/mcp/capabilities", (_request, response) => {
    response.json(mcpCapabilitySnapshot(engine.agentManifest()));
  });

  app.get("/api/poc/local-agent", async (request, response, next) => {
    try {
      const provider = request.query.provider === "local-huggingface" ? "local-huggingface" : "deterministic";
      response.json(await runLocalAgentUseCase({ provider, writeReport: false }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tools/semantic_search", (request, response) => {
    response.json({ results: engine.search(request.body) });
  });

  app.post("/api/tools/entity_lookup", (request, response) => {
    response.json({ entities: engine.entityLookup(String(request.body?.name ?? "")) });
  });

  app.post("/api/tools/graph_neighbors", (request, response) => {
    response.json(engine.graphNeighbors(String(request.body?.entityId ?? ""), Number(request.body?.depth ?? 1)));
  });

  app.post("/api/tools/find_paths", (request, response) => {
    response.json({
      path: engine.findPaths(String(request.body?.fromEntityId ?? ""), String(request.body?.toEntityId ?? ""), Number(request.body?.maxDepth ?? 4))
    });
  });

  app.post("/api/tools/expand_context", (request, response) => {
    response.json(engine.expandContext(request.body ?? {}));
  });

  app.post("/api/tools/explain_permissions", (request, response) => {
    response.json(engine.explainPermissions(String(request.body?.intent ?? "")));
  });

  app.get("/api/evidence/:chunkId", (request, response) => {
    const evidence = repository.evidence(request.params.chunkId);
    if (!evidence) {
      response.status(404).json({ error: "Evidence chunk not found" });
      return;
    }
    response.json(evidence);
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected error";
    response.status(400).json({ error: message });
  });

  return { app, repository, engine };
}

function seedIfEmpty(engine: SemanticEngine, repository: SemanticRepository): void {
  const status = repository.status();
  if (status.assets === 0) {
    engine.importCatalog(defaultCatalogSnapshot);
  }
  if (status.sources === 0) {
    for (const document of demoDocuments) {
      engine.ingest({
        name: document.name,
        mimeType: document.mimeType,
        ingestionMode: "full_data",
        text: document.text,
        metadata: { seeded: true }
      });
    }
    engine.runDiscovery("Initial semantic fabric discovery over demo corpus and seeded catalog.");
  }
}
