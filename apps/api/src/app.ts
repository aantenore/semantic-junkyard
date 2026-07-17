import cors from "cors";
import express from "express";
import helmet from "helmet";
import type Database from "better-sqlite3";
import path from "node:path";
import { z } from "zod";
import { AgentIntentRequestSchema, DiscoveryRequestSchema, ExplainPermissionsRequestSchema } from "@semantic-junkyard/shared";
import { defaultCatalogSnapshot } from "./core/catalogSeed.js";
import { demoDocuments } from "./core/demoCorpus.js";
import { SemanticEngine } from "./core/semanticEngine.js";
import { loadProviderConfig } from "./config/providers.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime.js";
import { loadSourceSystems } from "./config/sourceSystems.js";
import type { SourceSystem } from "@semantic-junkyard/shared";
import { openApiDocument } from "./api/openapi.js";
import { mcpCapabilitySnapshot, toMcpToolDescriptors } from "./api/mcp.js";
import { apiTokenMiddleware, createCorsOptions, errorHandler, HttpError, notFoundHandler, requestActor, requestActorContext, requestIdMiddleware, requireApprovalRole, requireOperatorRole } from "./api/http.js";
import { runLocalAgentUseCase } from "./poc/localAgentUseCase.js";
import { SemanticRepository } from "./storage/repository.js";
import { SourceConnectionRepository } from "./sources/connectionRepository.js";
import { SourceManager, type SemanticEnrichmentProvider } from "./sources/sourceManager.js";
import type { SourceConnector } from "./sources/connector.js";
import { FilesystemConnector } from "./sources/filesystemConnector.js";
import { GitConnector } from "./sources/gitConnector.js";
import { SqliteConnector } from "./sources/sqliteConnector.js";
import { LocalSourceSemanticEnrichmentProvider } from "./ai/sourceManagerEnricher.js";
import { ensureSupplyChainDemoSources } from "./sources/demoSources.js";
import { interpretAgentIntent } from "./agent/localIntentInterpreter.js";
import { discoverLocalHuggingFaceModels, LocalModelExecutionError, pickDefaultLocalModel, pickSemanticEnrichmentModel } from "./poc/localHuggingFaceProvider.js";

export interface SemanticRuntime {
  repository: SemanticRepository;
  connectionRepository: SourceConnectionRepository;
  sourceManager: SourceManager;
  engine: SemanticEngine;
}

export interface SemanticRuntimeOptions {
  seed?: boolean;
  maxAutonomousRisk?: RuntimeConfig["maxAutonomousRisk"];
  sourceSystems?: SourceSystem[];
  connectors?: SourceConnector[];
  semanticEnricher?: SemanticEnrichmentProvider | null;
}

export interface CreateAppOptions extends SemanticRuntimeOptions {
  runtimeConfig?: RuntimeConfig;
  bootstrapReferenceSources?: boolean;
  referenceSourcesRoot?: string;
}

export interface ReferenceSourceBootstrapFailure {
  connectionId: string | null;
  connectionName: string;
  code: string;
  message: string;
}

export interface ReferenceSourceBootstrapReport {
  enabled: boolean;
  status: "skipped" | "completed" | "partial";
  connectionIds: string[];
  syncedConnectionIds: string[];
  skippedConnectionIds: string[];
  failures: ReferenceSourceBootstrapFailure[];
}

export function createSemanticRuntime(db: Database.Database, options: SemanticRuntimeOptions = {}): SemanticRuntime {
  const repository = new SemanticRepository(db);
  const connectionRepository = new SourceConnectionRepository(db);
  const semanticEnricher = options.semanticEnricher === undefined
    ? new LocalSourceSemanticEnrichmentProvider()
    : options.semanticEnricher ?? undefined;
  const sourceManager = new SourceManager(connectionRepository, repository, {
    connectors: options.connectors ?? [new FilesystemConnector(), new SqliteConnector(), new GitConnector()],
    enricher: semanticEnricher
  });
  const engine = new SemanticEngine(repository, {
    maxAutonomousRisk: options.maxAutonomousRisk,
    sourceSystems: options.sourceSystems ?? loadSourceSystems(),
    sourceManager
  });

  if (options.seed ?? true) {
    seedIfEmpty(engine, repository);
  }

  return { repository, connectionRepository, sourceManager, engine };
}

export function createApp(db: Database.Database, options: CreateAppOptions = {}) {
  const app = express();
  const config = options.runtimeConfig ?? loadRuntimeConfig();
  const providerConfig = loadProviderConfig();
  const seedLegacyDemo = options.seed ?? config.databasePath === ":memory:";
  const runtime = createSemanticRuntime(db, {
    seed: seedLegacyDemo,
    maxAutonomousRisk: options.maxAutonomousRisk ?? config.maxAutonomousRisk,
    sourceSystems: options.sourceSystems ?? (config.sourceSystemsFile ? loadSourceSystems(config.sourceSystemsFile) : seedLegacyDemo ? loadSourceSystems() : []),
    connectors: options.connectors,
    semanticEnricher: options.semanticEnricher
  });
  const { repository, engine } = runtime;
  const bootstrapReferenceSources =
    options.bootstrapReferenceSources ?? (config.bootstrapReferenceSources && options.seed !== false && db.name !== ":memory:" && config.databasePath !== ":memory:");
  let bootstrapStatus: "initializing" | "ready" | "degraded" | "disabled" = bootstrapReferenceSources ? "initializing" : "disabled";
  const ready = bootstrapReferenceSources
    ? seedReferenceSources(
        engine,
        options.referenceSourcesRoot ?? path.resolve(path.dirname(config.databasePath), "reference-sources")
      ).then((report) => {
        bootstrapStatus = report.status === "partial" ? "degraded" : "ready";
        return report;
      })
    : Promise.resolve<ReferenceSourceBootstrapReport>({
        enabled: false,
        status: "skipped",
        connectionIds: [],
        syncedConnectionIds: [],
        skippedConnectionIds: [],
        failures: []
      });
  let localPocRun: Promise<Awaited<ReturnType<typeof runLocalAgentUseCase>>> | null = null;
  let localIntentRun: Promise<Awaited<ReturnType<typeof interpretAgentIntent>>> | null = null;

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(requestIdMiddleware);
  app.use(cors(createCorsOptions(config.corsOrigins)));
  app.use(apiTokenMiddleware(config.apiToken, config.operatorToken, config.approvalToken));
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
        console.error("Failed to persist request audit", String(response.locals.requestId ?? "unknown"), error);
      }
    });
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/ready", (_request, response) => {
    const readyForTraffic = bootstrapStatus === "ready" || bootstrapStatus === "disabled";
    response.status(readyForTraffic ? 200 : 503).json({ ok: readyForTraffic, bootstrap: bootstrapStatus });
  });

  app.get("/api/status", (_request, response) => {
    response.json(repository.status());
  });

  app.get("/api/providers", (_request, response) => {
    response.json(providerConfig);
  });

  app.get("/api/models/local", (_request, response) => {
    const models = discoverLocalHuggingFaceModels();
    const selected = pickDefaultLocalModel(models);
    const enrichmentModel = pickSemanticEnrichmentModel(models);
    response.json({
      available: models.length > 0,
      selectedModelId: selected?.id ?? null,
      selectedModels: {
        intentInterpreter: selected?.id ?? null,
        semanticEnricher: enrichmentModel?.id ?? null
      },
      models: models.map(({ id, modelType, architecture, quantization }) => ({ id, modelType, architecture, quantization }))
    });
  });

  app.get("/api/catalog", (request, response) => {
    response.json(engine.catalogForActor(requestActorContext(request)));
  });

  app.get("/api/sources", (request, response) => {
    response.json(engine.getSources(requestActorContext(request)));
  });

  app.get("/api/source-systems", (_request, response) => {
    response.json(engine.redactOperationalData({
      systems: engine.sourceSystems(),
      records: repository.listSourceSystemRecords()
    }));
  });

  app.post("/api/catalog/import", requireOperatorRole, (request, response) => {
    response.json(engine.importCatalog(request.body));
  });

  app.post("/api/ingest", requireOperatorRole, (request, response) => {
    response.status(201).json(engine.ingest(request.body));
  });

  app.post("/api/ingest/preview", requireOperatorRole, (request, response) => {
    response.json(engine.previewIngest(request.body));
  });

  app.post("/api/semantic/relations", requireOperatorRole, (request, response) => {
    response.status(201).json(engine.curateRelation(request.body));
  });

  app.get("/api/source-connections", requireOperatorRole, (_request, response) => {
    response.json(engine.listSourceConnections());
  });

  app.post("/api/source-connections", requireOperatorRole, (request, response) => {
    response.status(201).json(engine.createSourceConnection(request.body));
  });

  app.post("/api/source-connections/:connectionId/test", requireOperatorRole, (request, response) => {
    response.json(engine.testSourceConnection(z.string().parse(request.params.connectionId)));
  });

  app.post("/api/source-connections/:connectionId/sync", requireOperatorRole, async (request, response) => {
    response.json(await engine.syncSourceConnection(z.string().parse(request.params.connectionId), request.body ?? {}));
  });

  app.delete("/api/source-connections/:connectionId", requireOperatorRole, (request, response) => {
    engine.deleteSourceConnection(z.string().parse(request.params.connectionId), requestActor(request));
    response.status(204).end();
  });

  app.get("/api/source-resources", (request, response) => {
    const connectionId = z.string().min(1).optional().parse(request.query.connectionId);
    response.json(engine.sourceResourcesForActor(requestActorContext(request), connectionId));
  });

  app.get("/api/source-sync-runs", (request, response) => {
    const connectionId = z.string().min(1).optional().parse(request.query.connectionId);
    response.json(engine.redactOperationalData(engine.sourceSyncRuns(connectionId)));
  });

  app.post("/api/discovery/missions", requireOperatorRole, async (request, response) => {
    response.status(201).json(engine.redactOperationalData(await engine.runSourceDiscoveryMission(request.body ?? {}, requestActor(request))));
  });

  app.get("/api/discovery/missions", requireOperatorRole, (_request, response) => {
    response.json(engine.redactOperationalData(engine.sourceDiscoveryMissions()));
  });

  app.get("/api/semantic/proposals", requireOperatorRole, (request, response) => {
    const filters = z
      .object({
        connectionId: z.string().min(1).optional(),
        status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional()
      })
      .parse(request.query);
    response.json(engine.redactOperationalData(engine.semanticProposalsForActor(requestActorContext(request), filters)));
  });

  app.post("/api/semantic/proposals/:proposalId/decision", requireOperatorRole, (request, response) => {
    response.json(engine.decideSemanticProposal(z.string().parse(request.params.proposalId), request.body, requestActor(request)));
  });

  app.post("/api/business/actions/plan", (request, response) => {
    response.json(engine.planBusinessAction(request.body, requestActorContext(request)));
  });

  app.post("/api/business/actions/approve", requireApprovalRole, (request, response) => {
    response.status(201).json(engine.approveBusinessAction(request.body, requestActorContext(request)));
  });

  app.post("/api/business/actions/execute", (request, response) => {
    response.status(201).json(engine.redactOperationalData(engine.executeBusinessAction(request.body, requestActorContext(request))));
  });

  app.get("/api/business/actions/runs", (_request, response) => {
    response.json(engine.redactOperationalData(repository.listBusinessActionRuns()));
  });

  app.get("/api/business/actions/approvals", requireApprovalRole, (_request, response) => {
    response.json(engine.redactOperationalData(repository.listBusinessActionApprovals()));
  });

  app.get("/api/audit/events", (request, response) => {
    const limit = z.coerce.number().int().positive().max(250).default(100).parse(request.query.limit);
    const actions = z
      .string()
      .max(2_000)
      .optional()
      .transform((value) => value?.split(",").map((action) => action.trim()).filter(Boolean) ?? [])
      .pipe(z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,254}$/)).max(20))
      .parse(request.query.actions);
    response.json(engine.auditEventsForActor(requestActorContext(request), limit, actions));
  });

  app.post("/api/discovery/run", (request, response) => {
    const input = DiscoveryRequestSchema.parse(request.body ?? {});
    response.json(engine.runDiscovery(input.objective));
  });

  app.get("/api/discovery/runs", (_request, response) => {
    response.json(engine.redactOperationalData(repository.listDiscoveryRuns()));
  });

  app.get("/api/graph", (request, response) => {
    response.json(engine.graphForActor(requestActorContext(request)));
  });

  app.get("/api/agent/manifest", (_request, response) => {
    response.json(engine.agentManifest());
  });

  app.post("/api/agent/interpret", async (request, response) => {
    const input = AgentIntentRequestSchema.parse(request.body ?? {});
    if (input.provider === "local-huggingface" && localIntentRun) {
      throw new HttpError(409, "LOCAL_MODEL_ALREADY_RUNNING", "A local model interpretation is already in progress.");
    }
    const operation = interpretAgentIntent(input, engine.sourceResourcesForActor(requestActorContext(request)));
    if (input.provider === "local-huggingface") localIntentRun = operation;
    try {
      const plan = await operation;
      repository.audit(requestActor(request), "agent.interpret", "conversation", "allow", {
        provider: plan.provider,
        modelId: plan.modelId,
        requestedAction: plan.requestedAction,
        confidence: plan.confidence
      });
      response.json(plan);
    } catch (error) {
      if (error instanceof LocalModelExecutionError) {
        throw new HttpError(503, error.code, error.message);
      }
      throw new HttpError(422, "INVALID_MODEL_INTENT_PLAN", error instanceof Error ? error.message : "The model intent plan was invalid.");
    } finally {
      if (input.provider === "local-huggingface") localIntentRun = null;
    }
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
    response.json({ results: engine.search(request.body, requestActorContext(request)) });
  });

  app.post("/api/tools/source_resource_search", (request, response) => {
    response.json({ resources: engine.searchSourceResources(request.body, requestActorContext(request)) });
  });

  app.post("/api/tools/entity_lookup", (request, response) => {
    response.json({ entities: engine.entityLookup(request.body, requestActorContext(request)) });
  });

  app.post("/api/tools/graph_neighbors", (request, response) => {
    response.json(engine.graphNeighbors(request.body, undefined, requestActorContext(request)));
  });

  app.post("/api/tools/find_paths", (request, response) => {
    response.json({ path: engine.findPaths(request.body, undefined, undefined, requestActorContext(request)) });
  });

  app.post("/api/tools/expand_context", (request, response) => {
    response.json(engine.expandContext(request.body ?? {}, requestActorContext(request)));
  });

  app.post("/api/tools/explain_permissions", (request, response) => {
    const input = ExplainPermissionsRequestSchema.parse(request.body);
    response.json(engine.explainPermissions(input.intent));
  });

  app.get("/api/evidence/:chunkId", (request, response) => {
    const evidence = engine.getEvidence(z.string().parse(request.params.chunkId), requestActorContext(request));
    if (!evidence) {
      response.status(404).json({ error: "Evidence chunk not found" });
      return;
    }
    response.json(evidence);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, repository, engine, config, ready };
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

async function seedReferenceSources(engine: SemanticEngine, rootPath: string): Promise<ReferenceSourceBootstrapReport> {
  let demo: ReturnType<typeof ensureSupplyChainDemoSources>;
  try {
    demo = ensureSupplyChainDemoSources(rootPath);
  } catch (error) {
    return {
      enabled: true,
      status: "partial",
      connectionIds: [],
      syncedConnectionIds: [],
      skippedConnectionIds: [],
      failures: [bootstrapFailure(null, "Reference source bootstrap", error)]
    };
  }
  const requests = [
    {
      name: "Supply Chain Knowledge",
      description: "Real local files containing policy, CSV reference data, and an OpenLineage event.",
      config: {
        kind: "filesystem",
        rootPath: demo.knowledgePath,
        recursive: true,
        maxFiles: 250,
        maxFileBytes: 2_000_000,
        ingestionMode: "full_data"
      }
    },
    {
      name: "Operations Database",
      description: "Real SQLite operational source used for schema discovery and bounded record updates.",
      config: {
        kind: "sqlite",
        databasePath: demo.operationsDatabasePath,
        includeTables: [],
        sampleRows: 2,
        writeMode: "autonomous",
        writeRules: [
          {
            table: "orders",
            aliases: ["order"],
            keyColumn: "order_id",
            allowedColumns: ["status"],
            risk: "low"
          }
        ]
      }
    },
    {
      name: "Semantic Contract Repository",
      description: "Real Git repository with versioned semantic contracts and commit-based readback.",
      config: {
        kind: "git",
        repositoryPath: demo.semanticRepositoryPath,
        includePaths: ["contracts"],
        maxFiles: 250,
        maxFileBytes: 2_000_000,
        writeMode: "approval_required",
        semanticContractPaths: [demo.semanticContractPath]
      }
    }
  ];

  const failures: ReferenceSourceBootstrapFailure[] = [];
  const connections = requests.flatMap((request) => {
    try {
      return [engine.createSourceConnection(request)];
    } catch (error) {
      failures.push(bootstrapFailure(null, request.name, error));
      return [];
    }
  });
  const syncedConnectionIds: string[] = [];
  const skippedConnectionIds: string[] = [];
  await Promise.all(connections.map(async (connection) => {
    const hasPublishedResources = engine.sourceResources(connection.id).length > 0;
    const needsRecovery = ["configured", "syncing", "error"].includes(connection.status) || !connection.lastSyncAt || !hasPublishedResources;
    if (!needsRecovery) {
      skippedConnectionIds.push(connection.id);
      return;
    }
    try {
      await engine.syncSourceConnection(connection.id, {
        objective: "Discover supply-chain assets, metric definitions, lineage, governance signals, and safe source actions.",
        provider: "deterministic"
      });
      syncedConnectionIds.push(connection.id);
    } catch (error) {
      failures.push(bootstrapFailure(connection.id, connection.name, error));
    }
  }));
  if (syncedConnectionIds.length > 0) {
    try {
      engine.runDiscovery("Inspect the synchronized reference sources, governed evidence, semantic proposals, and safe business-action capabilities.");
    } catch (error) {
      failures.push(bootstrapFailure(null, "Reference fabric discovery", error));
    }
  }
  return {
    enabled: true,
    status: failures.length > 0 ? "partial" : "completed",
    connectionIds: connections.map((connection) => connection.id),
    syncedConnectionIds,
    skippedConnectionIds,
    failures
  };
}

function bootstrapFailure(connectionId: string | null, connectionName: string, error: unknown): ReferenceSourceBootstrapFailure {
  return {
    connectionId,
    connectionName,
    code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "BOOTSTRAP_FAILED",
    message: error instanceof Error ? error.message : "Reference source bootstrap failed."
  };
}
