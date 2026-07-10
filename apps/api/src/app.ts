import cors from "cors";
import express from "express";
import helmet from "helmet";
import type Database from "better-sqlite3";
import { z } from "zod";
import { DiscoveryRequestSchema, ExplainPermissionsRequestSchema } from "@semantic-junkyard/shared";
import { defaultCatalogSnapshot } from "./core/catalogSeed.js";
import { demoDocuments } from "./core/demoCorpus.js";
import { SemanticEngine } from "./core/semanticEngine.js";
import { loadProviderConfig } from "./config/providers.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime.js";
import { loadSourceSystems } from "./config/sourceSystems.js";
import type { SourceSystem } from "@semantic-junkyard/shared";
import { openApiDocument } from "./api/openapi.js";
import { mcpCapabilitySnapshot, toMcpToolDescriptors } from "./api/mcp.js";
import { apiTokenMiddleware, createCorsOptions, errorHandler, HttpError, notFoundHandler, requestActor, requestIdMiddleware, requireApprovalRole } from "./api/http.js";
import { runLocalAgentUseCase } from "./poc/localAgentUseCase.js";
import { SemanticRepository } from "./storage/repository.js";

export interface SemanticRuntime {
  repository: SemanticRepository;
  engine: SemanticEngine;
}

export interface SemanticRuntimeOptions {
  seed?: boolean;
  maxAutonomousRisk?: RuntimeConfig["maxAutonomousRisk"];
  sourceSystems?: SourceSystem[];
}

export interface CreateAppOptions extends SemanticRuntimeOptions {
  runtimeConfig?: RuntimeConfig;
}

export function createSemanticRuntime(db: Database.Database, options: SemanticRuntimeOptions = {}): SemanticRuntime {
  const repository = new SemanticRepository(db);
  const engine = new SemanticEngine(repository, {
    maxAutonomousRisk: options.maxAutonomousRisk,
    sourceSystems: options.sourceSystems ?? loadSourceSystems()
  });

  if (options.seed ?? true) {
    seedIfEmpty(engine, repository);
  }

  return { repository, engine };
}

export function createApp(db: Database.Database, options: CreateAppOptions = {}) {
  const app = express();
  const config = options.runtimeConfig ?? loadRuntimeConfig();
  const providerConfig = loadProviderConfig();
  const { repository, engine } = createSemanticRuntime(db, {
    seed: options.seed,
    maxAutonomousRisk: options.maxAutonomousRisk ?? config.maxAutonomousRisk,
    sourceSystems: options.sourceSystems ?? loadSourceSystems(config.sourceSystemsFile)
  });
  let localPocRun: Promise<Awaited<ReturnType<typeof runLocalAgentUseCase>>> | null = null;

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(requestIdMiddleware);
  app.use(cors(createCorsOptions(config.corsOrigins)));
  app.use(apiTokenMiddleware(config.apiToken, config.approvalToken));
  app.use(express.json({ limit: config.requestBodyLimit }));
  app.use((request, response, next) => {
    const startedAt = performance.now();
    response.on("finish", () => {
      if (request.path === "/api/health") return;
      try {
        repository.audit(requestActor(request), "api.request", `${request.method} ${request.path}`, response.statusCode < 400 ? "allow" : "deny", {
          requestId: response.locals.requestId,
          status: response.statusCode,
          durationMs: Number((performance.now() - startedAt).toFixed(2))
        });
      } catch (error) {
        console.error(`[${String(response.locals.requestId ?? "unknown")}] Failed to persist request audit`, error);
      }
    });
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/status", (_request, response) => {
    response.json(repository.status());
  });

  app.get("/api/providers", (_request, response) => {
    response.json(providerConfig);
  });

  app.get("/api/catalog", (_request, response) => {
    response.json(repository.catalog());
  });

  app.get("/api/sources", (_request, response) => {
    response.json(engine.getSources());
  });

  app.get("/api/source-systems", (_request, response) => {
    response.json(engine.redactOperationalData({
      systems: engine.sourceSystems(),
      records: repository.listSourceSystemRecords()
    }));
  });

  app.post("/api/catalog/import", (request, response) => {
    response.json(engine.importCatalog(request.body));
  });

  app.post("/api/ingest", (request, response) => {
    response.status(201).json(engine.ingest(request.body));
  });

  app.post("/api/ingest/preview", (request, response) => {
    response.json(engine.previewIngest(request.body));
  });

  app.post("/api/semantic/relations", (request, response) => {
    response.status(201).json(engine.curateRelation(request.body));
  });

  app.post("/api/business/actions/plan", (request, response) => {
    response.json(engine.planBusinessAction(request.body));
  });

  app.post("/api/business/actions/approve", requireApprovalRole, (request, response) => {
    response.status(201).json(engine.approveBusinessAction(request.body, requestActor(request)));
  });

  app.post("/api/business/actions/execute", (request, response) => {
    response.status(201).json(engine.redactOperationalData(engine.executeBusinessAction(request.body, requestActor(request))));
  });

  app.get("/api/business/actions/runs", (_request, response) => {
    response.json(engine.redactOperationalData(repository.listBusinessActionRuns()));
  });

  app.get("/api/business/actions/approvals", requireApprovalRole, (_request, response) => {
    response.json(engine.redactOperationalData(repository.listBusinessActionApprovals()));
  });

  app.get("/api/audit/events", (request, response) => {
    const limit = z.coerce.number().int().positive().max(250).default(100).parse(request.query.limit);
    response.json(engine.redactOperationalData(repository.listAuditEvents(limit)));
  });

  app.post("/api/discovery/run", (request, response) => {
    const input = DiscoveryRequestSchema.parse(request.body ?? {});
    response.json(engine.runDiscovery(input.objective));
  });

  app.get("/api/discovery/runs", (_request, response) => {
    response.json(engine.redactOperationalData(repository.listDiscoveryRuns()));
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

  app.post("/api/poc/local-agent", async (request, response) => {
    if (!config.enableLocalPoc) throw new HttpError(404, "POC_DISABLED", "The bundled local PoC is disabled.");
    if (localPocRun) throw new HttpError(409, "POC_ALREADY_RUNNING", "A local PoC model run is already in progress.");
    const input = z.object({ provider: z.enum(["local-huggingface", "deterministic"]).default("deterministic") }).strict().parse(request.body ?? {});
    localPocRun = runLocalAgentUseCase({ provider: input.provider, writeReport: false });
    try {
      response.json(engine.redactOperationalData(await localPocRun));
    } finally {
      localPocRun = null;
    }
  });

  app.post("/api/tools/semantic_search", (request, response) => {
    response.json({ results: engine.search(request.body) });
  });

  app.post("/api/tools/entity_lookup", (request, response) => {
    response.json({ entities: engine.entityLookup(request.body) });
  });

  app.post("/api/tools/graph_neighbors", (request, response) => {
    response.json(engine.graphNeighbors(request.body));
  });

  app.post("/api/tools/find_paths", (request, response) => {
    response.json({ path: engine.findPaths(request.body) });
  });

  app.post("/api/tools/expand_context", (request, response) => {
    response.json(engine.expandContext(request.body ?? {}));
  });

  app.post("/api/tools/explain_permissions", (request, response) => {
    const input = ExplainPermissionsRequestSchema.parse(request.body);
    response.json(engine.explainPermissions(input.intent));
  });

  app.get("/api/evidence/:chunkId", (request, response) => {
    const evidence = engine.getEvidence(request.params.chunkId);
    if (!evidence) {
      response.status(404).json({ error: "Evidence chunk not found" });
      return;
    }
    response.json(evidence);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, repository, engine, config };
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
