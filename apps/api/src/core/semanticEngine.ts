import type {
  AuditEvent,
  BusinessActionApproval,
  BusinessActionApprovalRequest,
  BusinessActionExecutionRequest,
  BusinessActionPlan,
  BusinessActionRequest,
  BusinessActionRun,
  BusinessActionTarget,
  CatalogSnapshot,
  Chunk,
  CuratedRelationRequest,
  CuratedRelationResponse,
  Entity,
  IngestRequest,
  IngestPreviewResponse,
  IngestResponse,
  ReflectionResult,
  SearchRequest,
  SearchResult,
  SemanticUpdate,
  SourceArtifact,
  SourceResource,
  SourceSystem,
  SourceSystemRecord,
  SourceWrite
} from "@semantic-junkyard/shared";
import {
  BusinessActionApprovalRequestSchema,
  BusinessActionExecutionRequestSchema,
  BusinessActionRequestSchema,
  CatalogSnapshotSchema,
  CuratedRelationRequestSchema,
  EntityLookupRequestSchema,
  ExpandContextRequestSchema,
  FindPathsRequestSchema,
  GraphNeighborsRequestSchema,
  IngestRequestSchema,
  SearchRequestSchema
} from "@semantic-junkyard/shared";
import { DiscoveryAgent } from "../agent/discoveryAgent.js";
import { InlineTextConnector } from "../connectors/inlineTextConnector.js";
import { DeterministicSemanticExtractor } from "../extractors/deterministicExtractor.js";
import { embedText } from "../indexing/embeddings.js";
import { SemanticWindowChunker } from "../indexing/chunker.js";
import { HybridQueryPlanner } from "../indexing/queryPlanner.js";
import { LocalTextParser } from "../parsers/localParser.js";
import { nowIso, sha256, stableId } from "./hash.js";
import { DomainError } from "./errors.js";
import { summarize, tokenize } from "./text.js";
import { PolicyEngine } from "../storage/policy.js";
import type { ActorContext } from "../storage/policy.js";
import type { SemanticRepository } from "../storage/repository.js";
import { loadSourceSystems } from "../config/sourceSystems.js";
import type { SourceManager } from "../sources/sourceManager.js";
import type { ConnectorActionCandidate } from "../sources/connector.js";

type IngestionPlan = IngestPreviewResponse;
type RiskLevel = "low" | "medium" | "high" | "blocked";

export interface SemanticEngineOptions {
  maxAutonomousRisk?: Exclude<RiskLevel, "blocked">;
  sourceSystems?: SourceSystem[];
  sourceManager?: SourceManager;
}

class BusinessActionExecutionFailure extends Error {
  constructor(
    readonly plan: BusinessActionPlan,
    readonly createdAt: string,
    readonly originalError: unknown,
    readonly approvalConsumed: boolean
  ) {
    super("Business action execution failed after the write transaction started.");
    this.name = "BusinessActionExecutionFailure";
  }
}

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  blocked: 4
};

const MAX_GRAPH_NEIGHBOR_NODES = 250;
const MAX_GRAPH_NEIGHBOR_EDGES = 500;
const MAX_PATH_EXPANSIONS = 10_000;

const automationActor: ActorContext = {
  actor: "semantic-junkyard-agent",
  roles: ["semantic-reader", "business-action-planner"],
  clearance: "confidential"
};

export class SemanticEngine {
  private readonly connector = new InlineTextConnector();
  private readonly parser = new LocalTextParser();
  private readonly chunker = new SemanticWindowChunker();
  private readonly extractor = new DeterministicSemanticExtractor();
  private readonly planner: HybridQueryPlanner;
  private readonly policy = new PolicyEngine();
  private readonly discoveryAgent: DiscoveryAgent;

  private readonly maxAutonomousRisk: Exclude<RiskLevel, "blocked">;
  private readonly configuredSourceSystems: SourceSystem[];
  private readonly sourceManager?: SourceManager;

  constructor(private readonly repository: SemanticRepository, options: SemanticEngineOptions = {}) {
    this.maxAutonomousRisk = options.maxAutonomousRisk ?? "medium";
    this.configuredSourceSystems = structuredClone(options.sourceSystems ?? loadSourceSystems());
    this.sourceManager = options.sourceManager;
    this.planner = new HybridQueryPlanner(repository);
    this.discoveryAgent = new DiscoveryAgent(repository, this.sourceManager);
  }

  previewIngest(rawRequest: unknown): IngestPreviewResponse {
    return this.planIngestion(rawRequest);
  }

  ingest(rawRequest: unknown): IngestResponse {
    const plan = this.planIngestion(rawRequest);
    const vectors = new Map(plan.chunks.map((chunk) => [chunk.id, embedText(chunk.text)]));
    this.repository.transaction(() => {
      this.repository.saveSource(plan.source);
      this.repository.saveElements(plan.elements);
      this.repository.saveChunks(plan.chunks, vectors);
      this.repository.saveEntities(plan.entities);
      this.repository.saveRelations(plan.relations);
      this.repository.saveClaims(plan.claims);
      this.repository.audit("system", "ingest", plan.source.id, "allow", {
        chunks: plan.chunks.length,
        entities: plan.entities.length,
        relations: plan.relations.length
      });
    });

    return {
      source: plan.source,
      chunks: plan.chunks,
      entities: plan.entities,
      relations: plan.relations,
      claims: plan.claims
    };
  }

  curateRelation(rawRequest: unknown): CuratedRelationResponse {
    const request = CuratedRelationRequestSchema.parse(rawRequest);
    return this.repository.transaction(() => {
      const evidence = request.evidenceChunkId ? this.getEvidence(request.evidenceChunkId) : this.createCurationEvidence(request);
      if (!evidence) {
        throw new DomainError("EVIDENCE_NOT_FOUND", `Evidence chunk not found: ${request.evidenceChunkId}`, 404);
      }
      const sourceEntity = this.upsertCuratedEntity(request.sourceName, request.sourceType, evidence.chunkId, request.confidence, request.metadata);
      const targetEntity = this.upsertCuratedEntity(request.targetName, request.targetType, evidence.chunkId, request.confidence, request.metadata);
      const relation = {
        id: stableId("rel", `${sourceEntity.id}:${request.relationType}:${targetEntity.id}:${evidence.chunkId}`),
        sourceEntityId: sourceEntity.id,
        targetEntityId: targetEntity.id,
        type: request.relationType.toUpperCase().replace(/\s+/g, "_"),
        confidence: request.confidence,
        evidenceChunkId: evidence.chunkId,
        metadata: {
          ...request.metadata,
          origin: typeof request.metadata.origin === "string" ? request.metadata.origin : "manual-curation",
          rationale: request.rationale ?? null,
          curatedAt: nowIso()
        }
      };
      this.repository.saveRelations([relation]);
      this.repository.audit("human", "semantic.curate_relation", relation.id, "allow", {
        sourceEntity: sourceEntity.canonicalName,
        targetEntity: targetEntity.canonicalName,
        type: relation.type
      });
      return { sourceEntity, targetEntity, relation, evidence };
    });
  }

  sourceSystems(): SourceSystem[] {
    return structuredClone([...this.configuredSourceSystems, ...(this.sourceManager?.sourceSystems() ?? [])]);
  }

  createSourceConnection(rawRequest: unknown) {
    return this.requireSourceManager().createConnection(rawRequest);
  }

  listSourceConnections() {
    return this.requireSourceManager().listConnections();
  }

  testSourceConnection(id: string) {
    return this.requireSourceManager().testConnection(id);
  }

  async syncSourceConnection(id: string, rawRequest: unknown) {
    return this.requireSourceManager().syncConnection(id, rawRequest, this);
  }

  deleteSourceConnection(id: string, actor = "local-user"): void {
    this.requireSourceManager().deleteConnection(id, actor);
  }

  sourceResources(connectionId?: string) {
    return this.requireSourceManager().listResources(connectionId);
  }

  sourceSyncRuns(connectionId?: string) {
    return this.requireSourceManager().listSyncRuns(connectionId);
  }

  semanticProposals(filters: { connectionId?: string; status?: "proposed" | "accepted" | "rejected" | "superseded" } = {}) {
    return this.requireSourceManager().listProposals(filters);
  }

  semanticProposalsForActor(
    actor: ActorContext,
    filters: { connectionId?: string; status?: "proposed" | "accepted" | "rejected" | "superseded" } = {}
  ) {
    const proposals = this.semanticProposals(filters);
    if (actor.roles.includes("semantic-operator")) return proposals;
    const visibleResourceIds = new Set(this.sourceResourcesForActor(actor).map((resource) => resource.id));
    return proposals.filter(
      (proposal) => proposal.evidenceResourceIds.length > 0 && proposal.evidenceResourceIds.every((id) => visibleResourceIds.has(id))
    );
  }

  decideSemanticProposal(id: string, rawRequest: unknown, actor = "local-user") {
    return this.requireSourceManager().decideProposal(id, rawRequest, actor);
  }

  planBusinessAction(rawRequest: unknown): BusinessActionPlan {
    const request = BusinessActionRequestSchema.parse(rawRequest);
    return this.buildBusinessActionPlan(request);
  }

  approveBusinessAction(rawRequest: unknown, actor = "local-user"): BusinessActionApproval {
    const request = BusinessActionApprovalRequestSchema.parse(rawRequest);
    const plan = this.buildBusinessActionPlan(this.planRequestFromApproval(request));
    this.assertPlanIdentity(plan, request.planId, request.planFingerprint);
    if (plan.status !== "approval_required") {
      throw new DomainError("APPROVAL_NOT_REQUIRED", "This plan does not require approval.", 409);
    }

    const createdAt = nowIso();
    const approval: BusinessActionApproval = {
      id: stableId("approval", `${plan.id}:${plan.fingerprint}:${actor}:${createdAt}`),
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      approvedBy: actor,
      rationale: request.rationale,
      status: "active",
      createdAt,
      consumedAt: null
    };
    this.repository.transaction(() => {
      this.repository.saveBusinessActionApproval(approval);
      this.repository.audit(actor, "business_action.approve", approval.id, "allow", {
        planId: plan.id,
        planFingerprint: plan.fingerprint
      });
    });
    return approval;
  }

  executeBusinessAction(rawRequest: unknown, actor = "local-user"): BusinessActionRun {
    const request = BusinessActionExecutionRequestSchema.parse(rawRequest);
    const replay = this.repository.getBusinessActionRunByIdempotencyKey(request.idempotencyKey);
    if (replay) this.assertIdempotencyMatch(replay, request);
    if (replay && replay.status !== "approval_required") return replay;
    const planRequest = this.planRequestFromExecution(request);
    const preflightPlan = this.buildBusinessActionPlan(planRequest);
    this.assertPlanIdentity(preflightPlan, request.planId, request.planFingerprint);
    const preflightApprovalTargets = preflightPlan.targets.filter((target) => target.autonomy === "approval_required");
    const reservedApproval =
      preflightPlan.status !== "blocked" && request.mode !== "dry_run" && preflightApprovalTargets.length > 0 && request.approvalId
        ? this.repository.immediateTransaction(() => {
            const approval = this.validApproval(request.approvalId, preflightPlan);
            const consumedAt = nowIso();
            if (!approval || !this.repository.consumeBusinessActionApproval(approval.id, consumedAt)) {
              throw new DomainError("INVALID_APPROVAL", "Approval was already consumed by another execution.", 403);
            }
            this.repository.audit(actor, "business_action.approval_reserve", approval.id, "allow", {
              planId: preflightPlan.id,
              planFingerprint: preflightPlan.fingerprint,
              idempotencyKey: request.idempotencyKey
            });
            return approval;
          })
        : null;
    try {
      return this.repository.immediateTransaction(() => {
        const concurrentReplay = this.repository.getBusinessActionRunByIdempotencyKey(request.idempotencyKey);
        if (concurrentReplay) {
          this.assertIdempotencyMatch(concurrentReplay, request);
          if (concurrentReplay.status !== "approval_required") return concurrentReplay;
        }

        const plan = this.buildBusinessActionPlan(planRequest);
        this.assertPlanIdentity(plan, request.planId, request.planFingerprint);

        if (plan.status === "blocked") {
          const run = this.buildNonExecutingRun(plan, request, "blocked");
          this.repository.saveBusinessActionRun(run);
          this.repository.audit(actor, "business_action.execute", run.id, "deny", { reason: "plan_blocked", intent: request.intent });
          return run;
        }

        if (request.mode === "dry_run") {
          const run = this.buildNonExecutingRun(plan, request, "planned");
          this.repository.saveBusinessActionRun(run);
          this.repository.audit(actor, "business_action.dry_run", run.id, "allow", { intent: request.intent });
          return run;
        }

        const approvalTargets = plan.targets.filter((target) => target.autonomy === "approval_required");
        if (approvalTargets.length > 0 && !request.approvalId) {
          const run = this.buildNonExecutingRun(plan, request, "approval_required");
          this.repository.saveBusinessActionRun(run);
          this.repository.audit(actor, "business_action.execute", run.id, "review", {
            intent: request.intent,
            approvalTargets: approvalTargets.map((target) => target.stepId)
          });
          return run;
        }

        const createdAt = nowIso();
        try {
          const writes = plan.targets.map((target) => this.executeSourceWrite(plan, target, planRequest, actor));
          const reflectionPackage = this.reflectSourceWrites(plan, writes, planRequest);
          const fullyVerified = writes.length > 0 && reflectionPackage.reflections.length === writes.length && reflectionPackage.reflections.every((reflection) => reflection.status === "verified");
          const runStatus: BusinessActionRun["status"] = fullyVerified ? "verified" : "reflected";
          const run: BusinessActionRun = {
            id: stableId("action_run", request.idempotencyKey),
            idempotencyKey: request.idempotencyKey,
            intent: request.intent,
            actionType: plan.actionType,
            status: runStatus,
            mode: request.mode,
            risk: plan.risk,
            plan: {
              ...plan,
              status: runStatus,
              targets: plan.targets.map((target) => {
                const write = writes.find((item) => item.stepId === target.stepId);
                const reflection = write ? reflectionPackage.reflections.find((item) => item.writeId === write.id) : null;
                return { ...target, status: reflection?.status === "verified" ? "verified" : "failed" };
              })
            },
            writes,
            reflections: reflectionPackage.reflections,
            semanticUpdates: reflectionPackage.semanticUpdates,
            createdAt,
            completedAt: nowIso()
          };
          this.repository.saveBusinessActionRun(run);
          this.repository.audit(actor, "business_action.execute", run.id, fullyVerified ? "allow" : "review", {
            intent: request.intent,
            writes: writes.length,
            verifiedReflections: reflectionPackage.reflections.filter((reflection) => reflection.status === "verified").length,
            semanticUpdates: reflectionPackage.semanticUpdates.length,
            approvalId: reservedApproval?.id ?? null
          });
          return run;
        } catch (error) {
          throw new BusinessActionExecutionFailure(plan, createdAt, error, Boolean(reservedApproval));
        }
      });
    } catch (error) {
      const executionFailure =
        error instanceof BusinessActionExecutionFailure
          ? error
          : reservedApproval
            ? new BusinessActionExecutionFailure(preflightPlan, nowIso(), error, true)
            : null;
      if (!executionFailure) throw error;
      const plan = executionFailure.plan;
      const failedRun: BusinessActionRun = {
        id: stableId("action_run", request.idempotencyKey),
        idempotencyKey: request.idempotencyKey,
        intent: request.intent,
        actionType: plan.actionType,
        status: "reconciliation_required",
        mode: request.mode,
        risk: plan.risk,
        plan: {
          ...plan,
          status: "reconciliation_required",
          warnings: [
            ...plan.warnings,
            "The source outcome could not be proven. Reconcile authoritative sources before retrying.",
            ...(executionFailure.approvalConsumed ? ["The approval was consumed and cannot authorize another attempt."] : [])
          ],
          targets: plan.targets.map((target) => ({ ...target, status: "reconciliation_required" }))
        },
        writes: [],
        reflections: [],
        semanticUpdates: [],
        createdAt: executionFailure.createdAt,
        completedAt: nowIso()
      };
      return this.repository.immediateTransaction(() => {
        const concurrentReplay = this.repository.getBusinessActionRunByIdempotencyKey(request.idempotencyKey);
        if (concurrentReplay) {
          this.assertIdempotencyMatch(concurrentReplay, request);
          if (concurrentReplay.status !== "approval_required") return concurrentReplay;
        }
        this.repository.saveBusinessActionRun(failedRun);
        this.repository.audit(actor, "business_action.execute", failedRun.id, "review", {
          intent: request.intent,
          errorType: executionFailure.originalError instanceof Error ? executionFailure.originalError.name : "unknown",
          reconciliationRequired: true,
          approvalConsumed: executionFailure.approvalConsumed
        });
        return failedRun;
      });
    }
  }

  importCatalog(rawSnapshot: unknown): CatalogSnapshot {
    const snapshot = CatalogSnapshotSchema.parse(rawSnapshot);
    this.repository.transaction(() => {
      this.repository.upsertCatalog(snapshot);
      this.repository.audit("system", "catalog.import", "catalog", "allow", {
        assets: snapshot.assets.length,
        metrics: snapshot.metrics.length,
        policies: snapshot.policies.length
      });
    });
    return this.repository.catalog();
  }

  catalogForActor(actor: ActorContext): CatalogSnapshot {
    const catalog = this.repository.catalog();
    const assets = catalog.assets.filter((asset) => this.policy.evaluateAsset(asset, actor).decision !== "deny");
    const assetIds = new Set(assets.map((asset) => asset.id));
    const domains = new Set(assets.map((asset) => asset.domain));
    const result: CatalogSnapshot = {
      assets,
      metrics: catalog.metrics.filter((metric) => domains.has(metric.domain)),
      policies: catalog.policies,
      lineage: catalog.lineage.filter((edge) => assetIds.has(edge.fromAssetId) && assetIds.has(edge.toAssetId)),
      contracts: catalog.contracts
        .filter((contract) => domains.has(contract.domain))
        .map((contract) => ({
          ...contract,
          assets: contract.assets.filter((asset) => assetIds.has(asset.id)),
          metrics: contract.metrics.filter((metric) => domains.has(metric.domain))
        })),
      ontologyClasses: catalog.ontologyClasses
    };
    this.repository.audit(actor.actor, "catalog.read", "catalog", "allow", { returnedAssets: assets.length, filteredAssets: catalog.assets.length - assets.length });
    return this.policy.applyDataPolicies(result, catalog.policies);
  }

  graphForActor(actor: ActorContext) {
    const graph = this.repository.graphSnapshot();
    const deniedAssetIds = new Set(
      this.repository
        .catalog()
        .assets.filter((asset) => this.policy.evaluateAsset(asset, actor).decision === "deny")
        .map((asset) => asset.id)
    );
    const deniedEntityIds = new Set(
      this.repository
        .getEntities()
        .filter((entity) => {
          const sensitivity = entity.metadata.sensitivity;
          return typeof sensitivity === "string" && ["public", "internal", "confidential", "restricted"].includes(sensitivity)
            ? this.policy.evaluateSensitivity(sensitivity as "public" | "internal" | "confidential" | "restricted", actor).decision === "deny"
            : false;
        })
        .map((entity) => entity.id)
    );
    const denied = new Set([...deniedAssetIds, ...deniedEntityIds]);
    const nodes = graph.nodes.filter((node) => !denied.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const result = {
      nodes,
      edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    };
    this.repository.audit(actor.actor, "graph.read", "semantic-graph", "allow", { returnedNodes: nodes.length, filteredNodes: graph.nodes.length - nodes.length });
    return this.policy.applyDataPolicies(result, this.repository.catalog().policies);
  }

  sourceResourcesForActor(actor: ActorContext, connectionId?: string) {
    const resources = this.requireSourceManager()
      .listResources(connectionId)
      .filter((resource) => this.policy.evaluateSensitivity(resource.sensitivity, actor).decision !== "deny")
      .map((resource) => sourceResourceForActor(resource, actor));
    this.repository.audit(actor.actor, "source_resources.read", connectionId ?? "all", "allow", { returned: resources.length });
    return this.policy.applyDataPolicies(resources, this.repository.catalog().policies);
  }

  searchSourceResources(rawRequest: unknown, actor: ActorContext = automationActor) {
    const resources = this.requireSourceManager()
      .searchResources(rawRequest)
      .filter((resource) => this.policy.evaluateSensitivity(resource.sensitivity, actor).decision !== "deny")
      .map((resource) => ({
        ...sourceResourceForActor(resource, actor),
        governance: {
          ...this.policy.evaluateSensitivity(resource.sensitivity, actor),
          sensitivity: resource.sensitivity
        }
      }));
    this.repository.audit(actor.actor, "source_resources.search", "resource-registry", "allow", { returned: resources.length });
    return this.policy.applyDataPolicies(resources, this.repository.catalog().policies);
  }

  search(rawRequest: SearchRequest, actor: ActorContext = automationActor): SearchResult[] {
    const request = SearchRequestSchema.parse(rawRequest);
    const results = this.planner.search(request);
    const catalog = this.repository.catalog();
    const sources = new Map(this.repository.getSources().map((source) => [source.id, source]));
    const resources = new Map((this.sourceManager?.listResources() ?? []).map((resource) => [resource.id, resource]));
    const governed = results.flatMap((result) => {
      const source = sources.get(result.sourceId);
      const sensitivity =
        source && typeof source.metadata.sensitivity === "string" && ["public", "internal", "confidential", "restricted"].includes(source.metadata.sensitivity)
          ? (source.metadata.sensitivity as "public" | "internal" | "confidential" | "restricted")
          : "internal";
      const resourceId = source && typeof source.metadata.resourceId === "string" ? source.metadata.resourceId : null;
      const resource = resourceId ? resources.get(resourceId) : null;
      const asset = catalog.assets.find((candidate) => {
        if (candidate.metadata.resourceId === resourceId || candidate.metadata.sourceResourceId === resourceId) return true;
        if (!resource || candidate.metadata.connectionId !== resource.connectionId) return false;
        return candidate.metadata.externalId === resource.externalId || candidate.metadata.sourceResourceExternalId === resource.externalId;
      });
      const decision = asset ? this.policy.evaluateAsset(asset, actor) : this.policy.evaluateSensitivity(sensitivity, actor);
      if (decision.decision === "deny") return [];
      return [
        {
          ...result,
          governance: {
            decision: decision.decision,
            reason: decision.reason,
            sensitivity: asset?.sensitivity ?? sensitivity,
            owner: asset?.owner ?? null,
            freshness: asset?.freshness ?? "unknown",
            qualityScore: asset?.qualityScore ?? 0.5
          }
        }
      ];
    });
    const filtered = this.policy.applyResultPolicies(governed, catalog.policies);
    this.repository.audit(actor.actor, "semantic_search", request.query, "allow", {
      mode: request.mode,
      returned: filtered.length,
      denied: results.length - governed.length
    });
    return filtered;
  }

  runDiscovery(objective?: string) {
    return this.discoveryAgent.run(objective);
  }

  agentManifest() {
    return this.discoveryAgent.manifest();
  }

  entityLookup(rawRequest: unknown, actor: ActorContext = automationActor) {
    const request = EntityLookupRequestSchema.parse(typeof rawRequest === "string" ? { name: rawRequest } : rawRequest);
    const normalized = request.name?.toLowerCase();
    const graph = this.graphForActor(actor);
    const allowedNodeIds = new Set(graph.nodes.map((node) => node.id));
    const entities = this.repository
      .getEntities()
      .filter((entity) =>
        allowedNodeIds.has(entity.id) &&
        (request.entityId
          ? entity.id === request.entityId
          : Boolean(normalized) && (entity.canonicalName.toLowerCase().includes(normalized!) || entity.aliases.some((alias) => alias.toLowerCase().includes(normalized!))))
      )
      .map((entity) => ({
        ...entity,
        degree: graph.edges.filter((edge) => edge.source === entity.id || edge.target === entity.id).length,
        matchScore: request.entityId ? 1 : entityLookupMatchScore(entity.canonicalName, entity.aliases, normalized!),
      }))
      .sort((left, right) => right.matchScore - left.matchScore || right.degree - left.degree || left.canonicalName.localeCompare(right.canonicalName))
      .slice(0, request.topK)
      .map(({ matchScore: _matchScore, ...entity }) => ({
        ...entity,
        evidence: entity.evidenceChunkIds.map((chunkId) => this.getEvidence(chunkId, actor)).filter((item) => item !== null)
      }));
    this.repository.audit(actor.actor, "entity_lookup", request.entityId ?? request.name ?? "unknown", "allow", { returned: entities.length });
    return entities;
  }

  graphNeighbors(rawRequest: unknown, legacyDepth?: number, actor: ActorContext = automationActor) {
    const request = GraphNeighborsRequestSchema.parse(typeof rawRequest === "string" ? { entityId: rawRequest, depth: legacyDepth } : rawRequest);
    const { entityId, depth: maxDepth } = request;
    const graph = this.graphForActor(actor);
    const visited = new Set([entityId]);
    const frontier = new Set([entityId]);
    const selectedEdges = new Map<string, (typeof graph.edges)[number]>();
    let budgetExceeded = false;
    for (let level = 0; level < maxDepth; level += 1) {
      const next = new Set<string>();
      for (const edge of graph.edges) {
        if (frontier.has(edge.source) || frontier.has(edge.target)) {
          const other = frontier.has(edge.source) ? edge.target : edge.source;
          if (!visited.has(other) && visited.size >= MAX_GRAPH_NEIGHBOR_NODES) {
            budgetExceeded = true;
            continue;
          }
          if (!selectedEdges.has(edge.id) && selectedEdges.size >= MAX_GRAPH_NEIGHBOR_EDGES) {
            budgetExceeded = true;
            break;
          }
          selectedEdges.set(edge.id, edge);
          if (!visited.has(other)) {
            visited.add(other);
            next.add(other);
          }
        }
      }
      frontier.clear();
      for (const item of next) frontier.add(item);
      if (selectedEdges.size >= MAX_GRAPH_NEIGHBOR_EDGES) break;
    }
    const result = {
      nodes: graph.nodes.filter((node) => visited.has(node.id)),
      edges: [...selectedEdges.values()]
    };
    this.repository.audit(actor.actor, "graph_neighbors", entityId, "allow", {
      depth: maxDepth,
      nodes: result.nodes.length,
      edges: result.edges.length,
      budgetExceeded
    });
    return result;
  }

  findPaths(rawRequest: unknown, legacyToEntityId?: string, legacyMaxDepth?: number, actor: ActorContext = automationActor) {
    const request = FindPathsRequestSchema.parse(
      typeof rawRequest === "string" ? { fromEntityId: rawRequest, toEntityId: legacyToEntityId, maxDepth: legacyMaxDepth } : rawRequest
    );
    const { fromEntityId, toEntityId, maxDepth: boundedDepth } = request;
    const graph = this.graphForActor(actor);
    const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: fromEntityId, path: [] }];
    const visited = new Set<string>([fromEntityId]);
    let expansions = 0;
    while (queue.length > 0 && expansions < MAX_PATH_EXPANSIONS) {
      const current = queue.shift();
      if (!current) break;
      expansions += 1;
      if (current.nodeId === toEntityId) {
        const path = current.path.map((edgeId) => graph.edges.find((edge) => edge.id === edgeId)).filter((edge) => edge !== undefined);
        this.repository.audit(actor.actor, "find_paths", `${fromEntityId}->${toEntityId}`, "allow", { maxDepth: boundedDepth, edges: path.length });
        return path;
      }
      if (current.path.length >= boundedDepth) continue;
      for (const edge of graph.edges.filter((candidate) => candidate.source === current.nodeId || candidate.target === current.nodeId)) {
        const nextNode = edge.source === current.nodeId ? edge.target : edge.source;
        if (visited.has(nextNode)) continue;
        visited.add(nextNode);
        queue.push({ nodeId: nextNode, path: [...current.path, edge.id] });
      }
    }
    this.repository.audit(actor.actor, "find_paths", `${fromEntityId}->${toEntityId}`, "allow", {
      maxDepth: boundedDepth,
      edges: 0,
      expansions,
      budgetExceeded: queue.length > 0
    });
    return [];
  }

  expandContext(rawInput: unknown, actor: ActorContext = automationActor) {
    const input = ExpandContextRequestSchema.parse(rawInput);
    const searchResults = input.query ? this.search({ query: input.query, topK: 5, mode: "hybrid" }, actor) : [];
    const chunkIds = new Set([...(input.chunkIds ?? []), ...searchResults.map((result) => result.chunkId)]);
    for (const entityId of input.entityIds ?? []) {
      for (const entity of this.repository.getEntities().filter((candidate) => candidate.id === entityId)) {
        for (const chunkId of entity.evidenceChunkIds) chunkIds.add(chunkId);
      }
    }
    const evidence = [...chunkIds].slice(0, 25).map((chunkId) => this.getEvidence(chunkId, actor)).filter((item) => item !== null);
    const result = {
      query: input.query ?? null,
      evidence,
      entities: this.repository.getEntities().filter((entity) => evidence.some((item) => entity.evidenceChunkIds.includes(item.chunkId))).slice(0, 25),
      guidance: "Use these evidence spans as citations. If evidence is insufficient, stop instead of guessing."
    };
    this.repository.audit(actor.actor, "expand_context", input.query ?? "explicit_ids", "allow", { evidence: result.evidence.length, entities: result.entities.length });
    return result;
  }

  getEvidence(chunkId: string, actor: ActorContext = automationActor) {
    const evidence = this.repository.evidence(chunkId);
    if (!evidence) return null;
    const source = this.repository.getSources().find((candidate) => candidate.id === evidence.sourceId);
    const sensitivity =
      source && typeof source.metadata.sensitivity === "string" && ["public", "internal", "confidential", "restricted"].includes(source.metadata.sensitivity)
        ? (source.metadata.sensitivity as "public" | "internal" | "confidential" | "restricted")
        : "internal";
    if (this.policy.evaluateSensitivity(sensitivity, actor).decision === "deny") {
      this.repository.audit(actor.actor, "evidence.read", chunkId, "deny", { sensitivity });
      return null;
    }
    const text = this.policy.applyTextPolicies(evidence.text, this.repository.catalog().policies);
    if (text === null) return null;
    this.repository.audit(actor.actor, "evidence.read", chunkId, "allow", { sensitivity });
    return { ...evidence, text };
  }

  getSources(actor: ActorContext = automationActor): SourceArtifact[] {
    const policies = this.repository.catalog().policies;
    return this.repository
      .getSources()
      .map((source) => {
        const sensitivity =
          typeof source.metadata.sensitivity === "string" && ["public", "internal", "confidential", "restricted"].includes(source.metadata.sensitivity)
            ? (source.metadata.sensitivity as "public" | "internal" | "confidential" | "restricted")
            : "internal";
        if (this.policy.evaluateSensitivity(sensitivity, actor).decision === "deny") return null;
        const visibleSource = sourceArtifactForActor(source, actor);
        if (source.ingestionMode !== "full_data") return { ...visibleSource, text: "" };
        const text = this.policy.applyTextPolicies(source.text, policies);
        return text === null ? null : { ...visibleSource, text };
      })
      .filter((source): source is SourceArtifact => source !== null);
  }

  redactOperationalData<T>(value: T): T {
    return stripOperationalData(this.policy.applyDataPolicies(value, this.repository.catalog().policies)) as T;
  }

  auditEventsForActor(actor: ActorContext, limit: number): AuditEvent[] {
    const events = this.repository.listAuditEvents(limit);
    const mayInspectApprovals = actor.roles.includes("approver") || actor.roles.includes("semantic-operator");
    const visibleEvents = mayInspectApprovals
      ? events
      : events.map((event) => ({
          ...event,
          target: event.action.includes("approv") || event.target.startsWith("approval_") ? "approval:[redacted]" : event.target,
          metadata: stripApprovalIdentifiers(event.metadata) as Record<string, unknown>
        }));
    return this.redactOperationalData(visibleEvents);
  }

  explainPermissions(intent: string) {
    return {
      intent,
      manifest: this.agentManifest(),
      decision: "read access and business-action planning are autonomous; configured low/medium-risk source writes may execute autonomously through policy-governed writeback, while privileged or destructive actions require approval",
      safeNextSteps: [
        "Run semantic_search to identify candidate context.",
        "Use entity_lookup and graph_neighbors to ground concepts.",
        "Open evidence spans before producing an answer.",
        "Use business_action_plan before any mutation so target systems, diffs, autonomy, risk, and evidence are explicit.",
        "Execute only through the writeback gateway, then reread source systems and require reflection before claiming completion."
      ]
    };
  }

  private buildBusinessActionPlan(request: BusinessActionRequest): BusinessActionPlan {
    const catalog = this.repository.catalog();
    const evidence = this.search({ query: request.intent, topK: 5, mode: "hybrid" }).slice(0, 4);
    const connectorResolution = this.sourceManager?.resolveBusinessAction(request);
    if (connectorResolution?.candidate) {
      return this.buildConnectorBusinessActionPlan(request, connectorResolution.candidate, connectorResolution.warnings);
    }
    const actionType = this.resolveBusinessActionType(request.intent);
    const evidenceMissing = evidence.length === 0;
    const primaryMetric = this.findMetricForIntent(request.intent, catalog);
    const [fromAsset, toAsset] = this.findAssetPairForIntent(request.intent, catalog);
    const groundingMissing =
      ((actionType === "align_metric_definition" || actionType === "operational_semantic_update") && !primaryMetric) ||
      ((actionType === "publish_traceability" || actionType === "operational_semantic_update") && (!fromAsset || !toAsset));
    const actionBlocked = actionType === "blocked" || actionType === "unsupported" || groundingMissing;
    const governedAssets = [...new Map([fromAsset, toAsset].filter((asset) => asset !== null).map((asset) => [asset.id, asset])).values()];
    const assetDecisions = governedAssets.map((asset) => ({ asset, decision: this.policy.evaluateAsset(asset, automationActor) }));
    const deniedAssets = assetDecisions.filter((item) => item.decision.decision === "deny");
    const reviewAssets = assetDecisions.filter((item) => item.decision.decision === "review");
    const policyBlocked = deniedAssets.length > 0;
    const title = this.businessActionTitle(actionType, primaryMetric?.label ?? fromAsset?.name ?? "Business semantic update");
    const plannedTargets = actionBlocked || policyBlocked
      ? []
      : this.buildBusinessActionTargets({
          request,
          actionType,
          evidenceChunkIds: evidence.map((item) => item.chunkId),
          metricName: primaryMetric?.name ?? "business_metric",
          metricLabel: primaryMetric?.label ?? "Business metric",
          metricDescription: primaryMetric?.description ?? null,
          fromAssetName: fromAsset?.name ?? "Source business asset",
          fromAssetId: fromAsset?.id ?? "source_asset",
          toAssetName: toAsset?.name ?? "Target business asset",
          toAssetId: toAsset?.id ?? "target_asset"
        });
    const targets = evidenceMissing
      ? plannedTargets.map((target) => ({ ...target, autonomy: "blocked" as const, status: "blocked" as const }))
      : reviewAssets.length > 0
        ? plannedTargets.map((target) => ({ ...target, autonomy: "approval_required" as const, status: "approval_required" as const }))
        : plannedTargets;
    const risk = actionBlocked || policyBlocked || evidenceMissing ? "blocked" : this.highestRisk(targets.map((target) => target.risk));
    const approvalTargets = targets.filter((target) => target.autonomy === "approval_required");
    const id = stableId("action_plan", `${request.intent}:${actionType}:${targets.map((target) => target.objectKey).join("|")}`);
    const warnings = [
      ...(connectorResolution?.warnings ?? []),
      actionType === "blocked" ? "The intent requests a destructive, privileged, secret-related, or access-policy action and is blocked." : null,
      actionType === "unsupported" ? "The requested action is not mapped to a configured business capability." : null,
      groundingMissing ? "The intent could not be grounded to the required metric and asset identities. No fallback object was selected." : null,
      ...deniedAssets.map(({ asset, decision }) => `Asset ${asset.name} is not authorized for automation: ${decision.reason}`),
      ...reviewAssets.map(({ asset, decision }) => `Asset ${asset.name} requires human review: ${decision.reason}`),
      evidenceMissing ? "No authorized evidence was found. The plan is blocked until relevant evidence is ingested." : null,
      riskRank[request.maxAutonomousRisk] > riskRank[this.maxAutonomousRisk]
        ? `Requested autonomy ${request.maxAutonomousRisk} exceeds the server ceiling ${this.maxAutonomousRisk}.`
        : null,
      approvalTargets.length > 0 ? `${approvalTargets.length} target requires approval before execution.` : null
    ].filter((item): item is string => Boolean(item));
    const status: BusinessActionPlan["status"] = risk === "blocked" ? "blocked" : approvalTargets.length > 0 ? "approval_required" : "planned";
    const fingerprint = sha256(
      JSON.stringify({ id, intent: request.intent, actionType, mode: request.mode, maxAutonomousRisk: request.maxAutonomousRisk, risk, targets, warnings })
    );

    return {
      id,
      fingerprint,
      intent: request.intent,
      actionType,
      title,
      summary: `Semantic Junkyard resolved the business intent into ${targets.length} source-system write target${targets.length === 1 ? "" : "s"} and ${evidence.length} evidence span${evidence.length === 1 ? "" : "s"}.`,
      mode: request.mode,
      maxAutonomousRisk: request.maxAutonomousRisk,
      risk,
      status,
      targets,
      warnings,
      createdAt: nowIso()
    };
  }

  private buildConnectorBusinessActionPlan(
    request: BusinessActionRequest,
    candidate: ConnectorActionCandidate,
    connectorWarnings: string[]
  ): BusinessActionPlan {
    const sourceSystem = this.sourceManager?.sourceSystems().find((system) => system.id === candidate.connectionId);
    const connectionResources = this.sourceManager?.listResources(candidate.connectionId) ?? [];
    const resourceById = new Map(connectionResources.map((resource) => [resource.id, resource]));
    const declaredEvidenceResources = candidate.evidenceResourceIds.flatMap((id) => {
      const resource = resourceById.get(id);
      return resource ? [resource] : [];
    });
    const missingEvidenceResourceIds = candidate.evidenceResourceIds.filter((id) => !resourceById.has(id));
    const declaredEvidenceChunkIds = new Set(declaredEvidenceResources.flatMap((resource) => resource.evidenceChunkIds));
    const unboundEvidenceChunkIds = candidate.evidenceChunkIds.filter((chunkId) => !declaredEvidenceChunkIds.has(chunkId));
    const authorizedEvidenceChunkIds = candidate.evidenceChunkIds.filter(
      (chunkId) => declaredEvidenceChunkIds.has(chunkId) && this.getEvidence(chunkId, automationActor) !== null
    );
    const configuredPolicyResourceIds = Array.isArray(candidate.parameters.policyResourceIds)
      ? candidate.parameters.policyResourceIds.filter((id): id is string => typeof id === "string")
      : [];
    const policyResourceIds = configuredPolicyResourceIds.length > 0
      ? configuredPolicyResourceIds
      : candidate.evidenceResourceIds;
    const missingPolicyResourceIds = policyResourceIds.filter((id) => !resourceById.has(id));
    const evidenceResources = policyResourceIds.flatMap((id) => {
      const resource = resourceById.get(id);
      return resource ? [resource] : [];
    });
    const deniedResources = evidenceResources.filter(
      (resource) => this.policy.evaluateSensitivity(resource.sensitivity, automationActor).decision === "deny"
    );
    const evidenceBindingInvalid =
      candidate.evidenceResourceIds.length === 0 ||
      missingEvidenceResourceIds.length > 0 ||
      missingPolicyResourceIds.length > 0 ||
      unboundEvidenceChunkIds.length > 0;
    const evidenceMissing = authorizedEvidenceChunkIds.length === 0 || evidenceBindingInvalid;
    const policyBlocked = deniedResources.length > 0 || missingPolicyResourceIds.length > 0;
    const risk: RiskLevel = evidenceMissing || policyBlocked ? "blocked" : candidate.risk;
    const autonomy = risk === "blocked"
      ? "blocked"
      : candidate.requiresApproval
        ? "approval_required"
        : this.autonomyFor(risk, request);
    const target: BusinessActionTarget = {
      stepId: stableId("step", `${candidate.connectionId}:${candidate.technicalOperation}:${candidate.objectKey}`),
      systemId: candidate.connectionId,
      systemName: sourceSystem?.name ?? candidate.connectionId,
      capability: candidate.capability,
      technicalOperation: candidate.technicalOperation,
      objectType: candidate.objectType,
      objectKey: candidate.objectKey,
      risk,
      autonomy,
      status: autonomy === "blocked" ? "blocked" : autonomy === "approval_required" ? "approval_required" : "planned",
      rationale: candidate.rationale,
      evidenceChunkIds: authorizedEvidenceChunkIds,
      parameters: {
        ...candidate.parameters,
        before: candidate.before,
        after: candidate.after,
        evidenceResourceIds: candidate.evidenceResourceIds
      },
      diff: {
        summary: candidate.title,
        before: candidate.before ? JSON.stringify(candidate.before, null, 2) : null,
        after: JSON.stringify(candidate.after, null, 2)
      }
    };
    const targets = [target];
    const warnings = [
      ...connectorWarnings,
      evidenceMissing ? "The connector resolved an action but provided no source evidence; execution is blocked." : null,
      missingEvidenceResourceIds.length > 0
        ? `The connector referenced unknown evidence resources: ${missingEvidenceResourceIds.join(", ")}.`
        : null,
      missingPolicyResourceIds.length > 0
        ? `The connector referenced unknown policy resources: ${missingPolicyResourceIds.join(", ")}.`
        : null,
      unboundEvidenceChunkIds.length > 0
        ? `The connector supplied evidence chunks that are not owned by its declared resources: ${unboundEvidenceChunkIds.join(", ")}.`
        : null,
      ...deniedResources.map(
        (resource) => `Source resource ${resource.qualifiedName} is ${resource.sensitivity} and is not authorized for the agent write boundary.`
      ),
      riskRank[request.maxAutonomousRisk] > riskRank[this.maxAutonomousRisk]
        ? `Requested autonomy ${request.maxAutonomousRisk} exceeds the server ceiling ${this.maxAutonomousRisk}.`
        : null,
      autonomy === "approval_required" ? "The authoritative source capability requires approval before execution." : null
    ].filter((item): item is string => Boolean(item));
    const status: BusinessActionPlan["status"] = autonomy === "blocked" ? "blocked" : autonomy === "approval_required" ? "approval_required" : "planned";
    const id = stableId("action_plan", `${request.intent}:${candidate.capability}:${candidate.connectionId}:${candidate.objectKey}`);
    const actionType = candidate.capability;
    const fingerprint = sha256(
      JSON.stringify({ id, intent: request.intent, actionType, mode: request.mode, maxAutonomousRisk: request.maxAutonomousRisk, risk, targets, warnings })
    );
    return {
      id,
      fingerprint,
      intent: request.intent,
      actionType,
      title: candidate.title,
      summary: `Resolved one authoritative ${sourceSystem?.kind ?? "source"} capability with version preconditions, an exact diff, and independent readback postconditions.`,
      mode: request.mode,
      maxAutonomousRisk: request.maxAutonomousRisk,
      risk,
      status,
      targets,
      warnings,
      createdAt: nowIso()
    };
  }

  private buildBusinessActionTargets(input: {
    request: BusinessActionRequest;
    actionType: string;
    evidenceChunkIds: string[];
    metricName: string;
    metricLabel: string;
    metricDescription: string | null;
    fromAssetName: string;
    fromAssetId: string;
    toAssetName: string;
    toAssetId: string;
  }): BusinessActionTarget[] {
    const sharedRationale = "Selected by the semantic action router from the intent, matching catalog concepts, lineage assets, and available source-system capabilities.";
    const targets: BusinessActionTarget[] = [];
    const addTarget = (target: Omit<BusinessActionTarget, "autonomy" | "status" | "evidenceChunkIds" | "parameters"> & { risk: RiskLevel }) => {
      const capability = this.configuredSourceSystems
        .find((system) => system.id === target.systemId)
        ?.capabilities.find((candidate) => candidate.businessCapability === target.capability && candidate.technicalOperation === target.technicalOperation);
      const risk = capability ? this.highestRisk([target.risk, capability.risk]) : "blocked";
      const autonomy = !capability
        ? "blocked"
        : capability.requiresApproval || !capability.autonomous
          ? "approval_required"
          : this.autonomyFor(risk, input.request);
      targets.push({
        ...target,
        risk,
        autonomy,
        status: autonomy === "blocked" ? "blocked" : autonomy === "approval_required" ? "approval_required" : "planned",
        evidenceChunkIds: input.evidenceChunkIds,
        parameters: {}
      });
    };

    if (input.actionType === "align_metric_definition" || input.actionType === "operational_semantic_update") {
      const nextDefinition = this.businessDefinitionFor(input.request.intent, input.metricLabel);
      addTarget({
        stepId: "step.catalog.metric-definition",
        systemId: "source.data-catalog",
        systemName: "Data Catalog",
        capability: "metric.align_definition",
        technicalOperation: "catalog.metric.upsert_description",
        objectType: "metric",
        objectKey: input.metricName,
        risk: "low",
        rationale: sharedRationale,
        diff: {
          summary: `Align ${input.metricLabel} definition in the source catalog.`,
          before: input.metricDescription,
          after: nextDefinition
        }
      });
      addTarget({
        stepId: "step.dbt.contract-pr",
        systemId: "source.dbt-repo",
        systemName: "dbt Semantic Repository",
        capability: "contract.propose_change",
        technicalOperation: "git.pull_request.create",
        objectType: "pull_request",
        objectKey: `semantic-contract-${input.metricName}`,
        risk: "medium",
        rationale: sharedRationale,
        diff: {
          summary: `Create a reviewable semantic contract PR for ${input.metricLabel}.`,
          before: null,
          after: `Propose dbt semantic contract update for ${input.metricLabel}: ${nextDefinition}`
        }
      });
    }

    if (input.actionType === "publish_traceability" || input.actionType === "operational_semantic_update") {
      addTarget({
        stepId: "step.metadata.lineage",
        systemId: "source.openmetadata",
        systemName: "OpenMetadata Mirror",
        capability: "lineage.publish_dependency",
        technicalOperation: "openmetadata.lineage.upsert_edge",
        objectType: "lineage_edge",
        objectKey: `${input.fromAssetId}->${input.toAssetId}`,
        risk: "medium",
        rationale: sharedRationale,
        diff: {
          summary: `Publish ${input.fromAssetName} to ${input.toAssetName} dependency in the metadata source.`,
          before: null,
          after: `${input.fromAssetName} FEEDS ${input.toAssetName} for intent: ${input.request.intent}`
        }
      });
    }

    addTarget({
      stepId: "step.ticket.owner-review",
      systemId: "source.ticketing",
      systemName: "Governance Ticketing",
      capability: "governance.request_owner_review",
      technicalOperation: "ticket.create",
      objectType: "owner_review",
      objectKey: stableId("review", input.request.intent),
      risk: "low",
      rationale: sharedRationale,
      diff: {
        summary: "Create an owner-facing review task with evidence and reflected write status.",
        before: null,
        after: `Review business action '${input.request.intent}' after source reflection verifies the writeback.`
      }
    });

    return targets;
  }

  private executeSourceWrite(plan: BusinessActionPlan, target: BusinessActionTarget, request: BusinessActionRequest, actor: string): SourceWrite {
    const createdAt = nowIso();
    const writeId = stableId("write", `${plan.fingerprint}:${target.stepId}`);
    const connectorResult = this.sourceManager?.isManagedSystem(target.systemId)
      ? this.sourceManager.executeAction(target, request)
      : null;
    if (target.systemId === "source.data-catalog") {
      this.applyCatalogTarget(target, plan, request);
    }
    if (target.systemId === "source.openmetadata") {
      this.applyLineageTarget(target, plan, request);
    }
    const expectedRecord = {
      planFingerprint: plan.fingerprint,
      stepId: target.stepId,
      systemId: target.systemId,
      objectType: target.objectType,
      objectKey: target.objectKey,
      operation: target.technicalOperation,
      diff: target.diff
    };
    const payload = {
      intent: request.intent,
      actionType: plan.actionType,
      planId: plan.id,
      writeId,
      ...expectedRecord,
      expectedHash: sha256(JSON.stringify(expectedRecord)),
      capability: target.capability,
      technicalOperation: target.technicalOperation,
      risk: target.risk,
      autonomy: target.autonomy,
      diff: target.diff,
      evidenceChunkIds: target.evidenceChunkIds,
      connectorReadback: connectorResult?.readback ?? null,
      connectorSourceVersion: connectorResult?.sourceVersion ?? null,
      connectorPostcondition: connectorResult?.postcondition ?? null,
      externalPostconditionPassed: connectorResult?.postconditionPassed ?? true,
      connectorMetadata: connectorResult?.metadata ?? {},
      actor,
      appliedAt: createdAt
    };
    const record = this.repository.saveSourceSystemRecord({
      id: stableId("source_record", `${target.systemId}:${target.objectType}:${target.objectKey}`),
      systemId: target.systemId,
      systemName: target.systemName,
      objectType: target.objectType,
      objectKey: target.objectKey,
      payload,
      updatedAt: createdAt
    });
    return {
      id: writeId,
      planId: plan.id,
      stepId: target.stepId,
      systemId: target.systemId,
      systemName: target.systemName,
      objectType: target.objectType,
      objectKey: target.objectKey,
      operation: target.technicalOperation,
      status:
        connectorResult && !connectorResult.postconditionPassed
          ? "failed"
          : connectorResult && (connectorResult.metadata.noOp === true || connectorResult.metadata.sourceMutation === false)
            ? "skipped"
            : "executed",
      dryRun: false,
      payload: {
        ...payload,
        sourceRecordId: record.id,
        version: record.version
      },
      createdAt
    };
  }

  private reflectSourceWrites(plan: BusinessActionPlan, writes: SourceWrite[], request: BusinessActionRequest): { reflections: ReflectionResult[]; semanticUpdates: SemanticUpdate[] } {
    const observedAt = nowIso();
    const reflections = writes.map<ReflectionResult>((write) => {
      const record = this.repository.getSourceSystemRecord(write.systemId, write.objectType, write.objectKey);
      const observedRecord = record
        ? {
            planFingerprint: record.payload.planFingerprint,
            stepId: record.payload.stepId,
            systemId: record.systemId,
            objectType: record.objectType,
            objectKey: record.objectKey,
            operation: record.payload.technicalOperation,
            diff: record.payload.diff
          }
        : null;
      const reflected = Boolean(
        record &&
          observedRecord &&
          record.id === write.payload.sourceRecordId &&
          record.version === write.payload.version &&
          record.payload.writeId === write.id &&
          record.payload.intent === request.intent &&
          record.payload.planId === plan.id &&
          record.payload.expectedHash === write.payload.expectedHash &&
          record.payload.externalPostconditionPassed !== false &&
          sha256(JSON.stringify(observedRecord)) === write.payload.expectedHash
      );
      return {
        id: stableId("reflection", `${write.id}:${observedAt}`),
        writeId: write.id,
        sourceRecordId: record?.id ?? null,
        status: reflected ? "verified" : record ? "drift" : "missing",
        summary: reflected
          ? `${write.systemName} reflects ${write.operation} on ${write.objectType}:${write.objectKey}.`
          : `${write.systemName} did not reflect the expected write for ${write.objectType}:${write.objectKey}.`,
        evidenceChunkId: null,
        observedAt
      };
    });
    const verifiedWrites = writes.filter((write) => reflections.find((reflection) => reflection.writeId === write.id)?.status === "verified");
    if (verifiedWrites.length === 0) {
      return { reflections, semanticUpdates: [] };
    }

    const reflectionText = this.buildReflectionText(plan, verifiedWrites, reflections);
    const ingested = this.ingest({
      name: `business-action-reflection-${plan.id}.md`,
      mimeType: "text/markdown",
      ingestionMode: "full_data",
      text: reflectionText,
      metadata: {
        connector: "connector.business-action-reflection",
        businessActionPlanId: plan.id,
        actionType: plan.actionType
      }
    });
    const evidenceChunkId = ingested.chunks[0]?.id ?? null;
    const updatedReflections = reflections.map((reflection) => ({
      ...reflection,
      evidenceChunkId: reflection.status === "verified" ? evidenceChunkId : null
    }));
    const curatedRelations = evidenceChunkId
      ? verifiedWrites.map((write) =>
          this.curateRelation({
            sourceName: plan.title,
            sourceType: "BusinessAction",
            relationType: "REFLECTED_IN",
            targetName: write.systemName,
            targetType: "SourceSystem",
            evidenceChunkId,
            rationale: `Source reflection verified ${write.operation}.`,
            metadata: { businessActionPlanId: plan.id, writeId: write.id, origin: "business-action-reflection", curator: "system" }
          })
        )
      : [];
    return {
      reflections: updatedReflections,
      semanticUpdates: [
        {
          sourceId: ingested.source.id,
          chunkIds: ingested.chunks.map((chunk) => chunk.id),
          entityIds: [...new Set([...ingested.entities.map((entity) => entity.id), ...curatedRelations.flatMap((relation) => [relation.sourceEntity.id, relation.targetEntity.id])])],
          relationIds: [...ingested.relations.map((relation) => relation.id), ...curatedRelations.map((relation) => relation.relation.id)],
          searchQuery: request.intent
        }
      ]
    };
  }

  private buildReflectionText(plan: BusinessActionPlan, writes: SourceWrite[], reflections: ReflectionResult[]): string {
    const lines = [
      `# Business Action Reflection`,
      `Intent: ${plan.intent}`,
      `Action type: ${plan.actionType}`,
      "Status: verified",
      "",
      "Verified source writes:"
    ];
    for (const write of writes) {
      const reflection = reflections.find((item) => item.writeId === write.id);
      lines.push(`- ${write.systemName} wrote ${write.operation} on ${write.objectType}:${write.objectKey}. Reflection: ${reflection?.status ?? "unknown"}.`);
    }
    lines.push("", "Business semantic result:");
    lines.push(`${plan.title} is reflected in ${writes.map((write) => write.systemName).join(", ")}.`);
    lines.push("The semantic read model was refreshed only from source records whose expected hash, target, operation, diff, record identity, and version matched readback.");
    return lines.join("\n");
  }

  private applyCatalogTarget(target: BusinessActionTarget, plan: BusinessActionPlan, request: BusinessActionRequest): void {
    const catalog = this.repository.catalog();
    const now = nowIso();
    const next = {
      ...catalog,
      metrics: catalog.metrics.map((metric) =>
        metric.name === target.objectKey
          ? {
              ...metric,
              description: target.diff.after,
              metadata: {
                ...metric.metadata,
                lastBusinessAction: {
                  planId: plan.id,
                  intent: request.intent,
                  reflectedAt: now
                }
              }
            }
          : metric
      ),
      assets: catalog.assets.map((asset) =>
        target.objectType === "asset" && asset.id === target.objectKey
          ? {
              ...asset,
              description: target.diff.after,
              metadata: {
                ...asset.metadata,
                lastBusinessAction: {
                  planId: plan.id,
                  intent: request.intent,
                  reflectedAt: now
                }
              }
            }
          : asset
      )
    };
    this.repository.upsertCatalog(next);
  }

  private applyLineageTarget(target: BusinessActionTarget, plan: BusinessActionPlan, request: BusinessActionRequest): void {
    const catalog = this.repository.catalog();
    const [fromAssetId, toAssetId] = target.objectKey.split("->");
    if (!fromAssetId || !toAssetId) return;
    const edgeId = stableId("lineage", `${fromAssetId}:${toAssetId}:${plan.actionType}`);
    const exists = catalog.lineage.some((edge) => edge.id === edgeId);
    this.repository.upsertCatalog({
      ...catalog,
      lineage: exists
        ? catalog.lineage
        : [
            ...catalog.lineage,
            {
              id: edgeId,
              fromAssetId,
              toAssetId,
              type: "FEEDS",
              confidence: 0.94,
              metadata: {
                origin: "business-action-writeback",
                planId: plan.id,
                intent: request.intent,
                reflectedAt: nowIso()
              }
            }
          ]
    });
  }

  private resolveBusinessActionType(intent: string): string {
    const normalized = intent.toLowerCase();
    if (/(delete|drop|truncate|destroy|erase|purge|overwrite|secret|credential|api[_ -]?key|password|access policy|permission|grant access|revoke access|execute sql|generated sql|production customer)/i.test(normalized)) return "blocked";
    if (/(trace|tracci|lineage|end-to-end|dipend|depend|where|dove)/i.test(normalized)) return "publish_traceability";
    if (/(align|allinea|consistent|coeren|definition|definiz|metric|kpi|contratt)/i.test(normalized)) return "align_metric_definition";
    if (/(review|approv|owner|responsabil)/i.test(normalized)) return "owner_review";
    if (/(annotat|update|aggiorn|document|descri|publish|pubblic)/i.test(normalized)) return "operational_semantic_update";
    return "unsupported";
  }

  private businessActionTitle(actionType: string, subject: string): string {
    if (actionType === "publish_traceability") return `Make ${subject} traceable end-to-end`;
    if (actionType === "align_metric_definition") return `Align ${subject} definition`;
    if (actionType === "owner_review") return `Request owner review for ${subject}`;
    if (actionType === "blocked") return "Blocked high-risk business action";
    if (actionType === "unsupported") return "Unsupported business action";
    return `Execute semantic business action for ${subject}`;
  }

  private businessDefinitionFor(intent: string, metricLabel: string): string {
    return [
      `${metricLabel} is governed through Semantic Junkyard business action writeback.`,
      `Business intent: ${intent}`,
      "This definition is source-reflected and should be treated as the current business-facing semantic contract until superseded by a newer reflected action."
    ].join(" ");
  }

  private findMetricForIntent(intent: string, catalog: CatalogSnapshot) {
    const normalized = this.normalizedTerms(intent);
    return catalog.metrics.find((metric) => this.hasTermOverlap(normalized, `${metric.name} ${metric.label} ${metric.description}`)) ?? null;
  }

  private findAssetPairForIntent(intent: string, catalog: CatalogSnapshot) {
    const normalized = this.normalizedTerms(intent);
    const matchedAssets = catalog.assets.filter((asset) => this.hasTermOverlap(normalized, `${asset.name} ${asset.description} ${asset.kind}`));
    const pipeline = matchedAssets.find((asset) => asset.kind === "pipeline") ?? null;
    const dataset = matchedAssets.find((asset) => asset.kind === "dataset" || asset.kind === "table") ?? null;
    return [pipeline, dataset] as const;
  }

  private normalizedTerms(value: string): Set<string> {
    const genericTerms = new Set([
      "align",
      "change",
      "contract",
      "data",
      "definition",
      "metric",
      "publish",
      "rate",
      "semantic",
      "source",
      "system",
      "update",
      "with",
      "across",
      "from",
      "into",
      "then"
    ]);
    return new Set(
      value
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .split(/\W+/)
        .filter((term) => term.length > 2 && !genericTerms.has(term))
    );
  }

  private hasTermOverlap(terms: Set<string>, value: string): boolean {
    const haystack = value.toLowerCase().replace(/[_-]+/g, " ");
    return [...terms].some((term) => haystack.includes(term));
  }

  private autonomyFor(risk: RiskLevel, request: BusinessActionRequest): BusinessActionTarget["autonomy"] {
    if (risk === "blocked") return "blocked";
    if (request.mode === "approval_required") return "approval_required";
    const effectiveMaximum = riskRank[request.maxAutonomousRisk] <= riskRank[this.maxAutonomousRisk] ? request.maxAutonomousRisk : this.maxAutonomousRisk;
    return riskRank[risk] <= riskRank[effectiveMaximum] ? "autonomous" : "approval_required";
  }

  private highestRisk(risks: RiskLevel[]): RiskLevel {
    return risks.reduce<RiskLevel>((highest, current) => (riskRank[current] > riskRank[highest] ? current : highest), "low");
  }

  private planRequestFromExecution(request: BusinessActionExecutionRequest): BusinessActionRequest {
    return {
      intent: request.intent,
      mode: request.mode,
      maxAutonomousRisk: request.maxAutonomousRisk,
      context: request.context
    };
  }

  private planRequestFromApproval(request: BusinessActionApprovalRequest): BusinessActionRequest {
    return {
      intent: request.intent,
      mode: request.mode,
      maxAutonomousRisk: request.maxAutonomousRisk,
      context: request.context
    };
  }

  private assertPlanIdentity(plan: BusinessActionPlan, planId: string, fingerprint: string): void {
    if (plan.id !== planId || plan.fingerprint !== fingerprint) {
      throw new DomainError(
        "PLAN_CHANGED",
        "The business action plan no longer matches current source state. Create and review a new plan before execution.",
        409,
        { expectedPlanId: plan.id, expectedFingerprint: plan.fingerprint }
      );
    }
  }

  private assertIdempotencyMatch(run: BusinessActionRun, request: BusinessActionExecutionRequest): void {
    const matches =
      run.plan.id === request.planId &&
      run.plan.fingerprint === request.planFingerprint &&
      run.intent === request.intent &&
      run.mode === request.mode &&
      run.plan.maxAutonomousRisk === request.maxAutonomousRisk;
    if (!matches) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key is already bound to a different business action request.",
        409,
        { existingRunId: run.id, existingPlanId: run.plan.id, existingPlanFingerprint: run.plan.fingerprint }
      );
    }
  }

  private validApproval(approvalId: string | undefined, plan: BusinessActionPlan): BusinessActionApproval | null {
    if (!approvalId) return null;
    const approval = this.repository.getBusinessActionApproval(approvalId);
    if (!approval || approval.status !== "active" || approval.planId !== plan.id || approval.planFingerprint !== plan.fingerprint) {
      throw new DomainError("INVALID_APPROVAL", "Approval is missing, consumed, or does not match this exact plan.", 403);
    }
    return approval;
  }

  private buildNonExecutingRun(
    plan: BusinessActionPlan,
    request: BusinessActionExecutionRequest,
    status: "planned" | "approval_required" | "blocked"
  ): BusinessActionRun {
    const createdAt = nowIso();
    return {
      id: stableId("action_run", request.idempotencyKey),
      idempotencyKey: request.idempotencyKey,
      intent: request.intent,
      actionType: plan.actionType,
      status,
      mode: request.mode,
      risk: plan.risk,
      plan: {
        ...plan,
        status,
        targets: plan.targets.map((target) => ({
          ...target,
          status: status === "blocked" || target.autonomy === "blocked" ? "blocked" : status === "approval_required" && target.autonomy === "approval_required" ? "approval_required" : "planned"
        }))
      },
      writes: [],
      reflections: [],
      semanticUpdates: [],
      createdAt,
      completedAt: status === "approval_required" ? null : createdAt
    };
  }

  private requireSourceManager(): SourceManager {
    if (!this.sourceManager) {
      throw new DomainError("SOURCE_REGISTRY_UNAVAILABLE", "The source connection registry is not configured in this runtime.", 503);
    }
    return this.sourceManager;
  }

  private planIngestion(rawRequest: unknown): IngestionPlan {
    const request = IngestRequestSchema.parse(rawRequest);
    if (!this.parser.supports(request.mimeType)) {
      throw new Error(`Unsupported MIME type ${request.mimeType}. Configure a Docling, Tika, or Unstructured parser adapter for this source.`);
    }
    const source = this.connector.createSource(request);
    const textForIndexing = request.ingestionMode === "external_reference"
      ? `External reference registered: ${source.name}. URI: ${source.uri}. Metadata: ${JSON.stringify(source.metadata)}`
      : request.ingestionMode === "metadata_only"
        ? `Metadata-only source registered: ${source.name}. URI: ${source.uri}. Metadata: ${JSON.stringify(source.metadata)}`
        : source.text;
    const elements = this.parser.parse({ sourceId: source.id, text: textForIndexing, mimeType: source.mimeType });
    const chunks = this.chunker.chunk(source.id, elements);
    const extraction = this.extractor.extract(chunks);
    const warnings = [
      request.ingestionMode !== "full_data" ? "This ingestion mode indexes a registration note instead of the full raw payload." : null,
      extraction.relations.length === 0 ? "No relations were inferred automatically; use semantic curation to add authoritative dependencies." : null
    ].filter((item): item is string => Boolean(item));

    return {
      source,
      elements,
      chunks,
      entities: extraction.entities,
      relations: extraction.relations,
      claims: extraction.claims,
      profile: {
        mode: request.ingestionMode,
        mimeType: request.mimeType,
        chunkCount: chunks.length,
        entityCount: extraction.entities.length,
        relationCount: extraction.relations.length,
        claimCount: extraction.claims.length,
        warnings
      }
    };
  }

  private createCurationEvidence(request: CuratedRelationRequest) {
    const sourceText = "Manual semantic curation assertions.";
    const source = {
      id: stableId("src", "manual-semantic-curation"),
      uri: "curation://manual-semantic-curation",
      name: "Manual Semantic Curation",
      mimeType: "text/plain",
      contentHash: sha256(sourceText),
      text: sourceText,
      ingestionMode: "metadata_only" as const,
      metadata: { connector: "connector.manual-curation" },
      createdAt: nowIso()
    };
    const relationType = request.relationType.toUpperCase().replace(/\s+/g, "_");
    const text = [
      `Manual semantic assertion: ${request.sourceName} ${relationType} ${request.targetName}.`,
      request.rationale ? `Rationale: ${request.rationale}` : null
    ].filter(Boolean).join(" ");
    const chunk: Chunk = {
      id: stableId("chunk", `${source.id}:${request.sourceName}:${relationType}:${request.targetName}:${request.rationale ?? ""}`),
      sourceId: source.id,
      text,
      startOffset: 0,
      endOffset: text.length,
      tokenCount: tokenize(text).length,
      summary: summarize(text),
      metadata: {
        chunker: "chunker.manual-curation",
        curated: true
      }
    };
    this.repository.saveSource(source);
    this.repository.saveChunks([chunk], new Map([[chunk.id, embedText(chunk.text)]]));
    return this.repository.evidence(chunk.id);
  }

  private upsertCuratedEntity(name: string, type: string, evidenceChunkId: string, confidence: number, metadata: Record<string, unknown>): Entity {
    const existing = this.repository.getEntities().find((entity) => entity.canonicalName.toLowerCase() === name.toLowerCase());
    const entity: Entity = {
      id: existing?.id ?? stableId("ent", name.toLowerCase()),
      canonicalName: existing?.canonicalName ?? name,
      type: existing?.type ?? type,
      aliases: [...new Set([...(existing?.aliases ?? []), name])],
      confidence: Math.max(existing?.confidence ?? 0, confidence),
      evidenceChunkIds: [...new Set([...(existing?.evidenceChunkIds ?? []), evidenceChunkId])],
      metadata: {
        ...(existing?.metadata ?? {}),
        ...metadata,
        curated: true,
        curator: typeof metadata.curator === "string" ? metadata.curator : "human"
      }
    };
    this.repository.saveEntities([entity]);
    return entity;
  }
}

const OPERATIONAL_PATH_KEYS = new Set(["databasePath", "repositoryPath", "rootPath", "modelPath", "resolvedPath"]);

function sourceResourceForActor(resource: SourceResource, actor: ActorContext): SourceResource {
  if (actor.roles.includes("semantic-operator")) return resource;
  return {
    ...resource,
    uri: `semantic-junkyard://resource/${encodeURIComponent(resource.id)}`,
    metadata: stripOperationalData(resource.metadata) as Record<string, unknown>
  };
}

function sourceArtifactForActor(source: SourceArtifact, actor: ActorContext): SourceArtifact {
  if (actor.roles.includes("semantic-operator")) return source;
  return {
    ...source,
    uri: `semantic-junkyard://source/${encodeURIComponent(source.id)}`,
    metadata: stripOperationalData(source.metadata) as Record<string, unknown>
  };
}

function stripOperationalData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOperationalData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !OPERATIONAL_PATH_KEYS.has(key))
      .map(([key, item]) => [key, stripOperationalData(item)])
  );
}

function stripApprovalIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripApprovalIdentifiers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== "approvalid")
      .map(([key, item]) => [key, stripApprovalIdentifiers(item)])
  );
}

function entityLookupMatchScore(canonicalName: string, aliases: string[], normalizedQuery: string): number {
  const canonical = canonicalName.toLowerCase();
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  if (canonical === normalizedQuery) return 5;
  if (normalizedAliases.includes(normalizedQuery)) return 4;
  if (normalizedAliases.some((alias) => alias.startsWith(normalizedQuery))) return 3;
  if (canonical.split(/[^a-z0-9_]+/).includes(normalizedQuery)) return 2;
  if (normalizedAliases.some((alias) => alias.includes(normalizedQuery))) return 1.5;
  return canonical.includes(normalizedQuery) ? 1 : 0;
}
