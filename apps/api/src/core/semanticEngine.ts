import type {
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
  SourceSystem,
  SourceSystemRecord,
  SourceWrite
} from "@semantic-junkyard/shared";
import { BusinessActionRequestSchema, CuratedRelationRequestSchema, IngestRequestSchema, SearchRequestSchema } from "@semantic-junkyard/shared";
import { DiscoveryAgent } from "../agent/discoveryAgent.js";
import { InlineTextConnector } from "../connectors/inlineTextConnector.js";
import { DeterministicSemanticExtractor } from "../extractors/deterministicExtractor.js";
import { embedText } from "../indexing/embeddings.js";
import { SemanticWindowChunker } from "../indexing/chunker.js";
import { HybridQueryPlanner } from "../indexing/queryPlanner.js";
import { LocalTextParser } from "../parsers/localParser.js";
import { nowIso, sha256, stableId } from "./hash.js";
import { summarize, tokenize } from "./text.js";
import { PolicyEngine } from "../storage/policy.js";
import type { SemanticRepository } from "../storage/repository.js";

type IngestionPlan = IngestPreviewResponse;
type RiskLevel = "low" | "medium" | "high" | "blocked";

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  blocked: 4
};

const sourceSystems: SourceSystem[] = [
  {
    id: "source.data-catalog",
    name: "Data Catalog",
    kind: "catalog",
    description: "Governed catalog adapter for business descriptions, metric definitions, tags, and ownership metadata.",
    capabilities: [
      {
        id: "catalog.update_metric_definition",
        systemId: "source.data-catalog",
        label: "Update metric definition",
        businessCapability: "metric.align_definition",
        technicalOperation: "catalog.metric.upsert_description",
        risk: "low",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Writes a governed metric description and supporting semantic evidence into the catalog source."
      },
      {
        id: "catalog.update_asset_description",
        systemId: "source.data-catalog",
        label: "Update asset context",
        businessCapability: "asset.annotate_context",
        technicalOperation: "catalog.asset.upsert_description",
        risk: "low",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Writes business context on a catalog asset without changing source data."
      }
    ]
  },
  {
    id: "source.openmetadata",
    name: "OpenMetadata Mirror",
    kind: "metadata-api",
    description: "Metadata API adapter shape for lineage and semantic relationship publication.",
    capabilities: [
      {
        id: "openmetadata.publish_lineage",
        systemId: "source.openmetadata",
        label: "Publish lineage edge",
        businessCapability: "lineage.publish_dependency",
        technicalOperation: "openmetadata.lineage.upsert_edge",
        risk: "medium",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Publishes a reversible metadata lineage edge that can be reread as source truth."
      }
    ]
  },
  {
    id: "source.dbt-repo",
    name: "dbt Semantic Repository",
    kind: "git",
    description: "Git-backed semantic model adapter that creates reviewable contract and test proposals.",
    capabilities: [
      {
        id: "dbt.create_contract_pr",
        systemId: "source.dbt-repo",
        label: "Create dbt contract PR",
        businessCapability: "contract.propose_change",
        technicalOperation: "git.pull_request.create",
        risk: "medium",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Creates a source-side pull request proposal instead of silently changing production models."
      }
    ]
  },
  {
    id: "source.ticketing",
    name: "Governance Ticketing",
    kind: "ticketing",
    description: "Ticketing adapter for owner review, approval, and business accountability.",
    capabilities: [
      {
        id: "ticketing.create_owner_review",
        systemId: "source.ticketing",
        label: "Create owner review task",
        businessCapability: "governance.request_owner_review",
        technicalOperation: "ticket.create",
        risk: "low",
        autonomous: true,
        requiresApproval: false,
        reversible: true,
        description: "Creates an owner review task with evidence, target systems, and verification state."
      }
    ]
  }
];

export class SemanticEngine {
  private readonly connector = new InlineTextConnector();
  private readonly parser = new LocalTextParser();
  private readonly chunker = new SemanticWindowChunker();
  private readonly extractor = new DeterministicSemanticExtractor();
  private readonly planner: HybridQueryPlanner;
  private readonly policy = new PolicyEngine();
  private readonly discoveryAgent: DiscoveryAgent;

  constructor(private readonly repository: SemanticRepository) {
    this.planner = new HybridQueryPlanner(repository);
    this.discoveryAgent = new DiscoveryAgent(repository);
  }

  previewIngest(rawRequest: unknown): IngestPreviewResponse {
    return this.planIngestion(rawRequest);
  }

  ingest(rawRequest: unknown): IngestResponse {
    const plan = this.planIngestion(rawRequest);
    const vectors = new Map(plan.chunks.map((chunk) => [chunk.id, embedText(chunk.text)]));
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
    const evidence = request.evidenceChunkId ? this.repository.evidence(request.evidenceChunkId) : this.createCurationEvidence(request);
    if (!evidence) {
      throw new Error(`Evidence chunk not found: ${request.evidenceChunkId}`);
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
  }

  sourceSystems(): SourceSystem[] {
    return sourceSystems;
  }

  planBusinessAction(rawRequest: unknown): BusinessActionPlan {
    const request = BusinessActionRequestSchema.parse(rawRequest);
    return this.buildBusinessActionPlan(request);
  }

  executeBusinessAction(rawRequest: unknown): BusinessActionRun {
    const request = BusinessActionRequestSchema.parse(rawRequest);
    const plan = this.buildBusinessActionPlan(request);
    const blockedTargets = plan.targets.filter((target) => target.autonomy !== "autonomous");
    const isDryRun = request.mode === "dry_run";
    const createdAt = nowIso();

    if (isDryRun || blockedTargets.length > 0) {
      const run: BusinessActionRun = {
        id: stableId("action_run", `${plan.id}:${createdAt}`),
        intent: request.intent,
        actionType: plan.actionType,
        status: isDryRun ? "planned" : "approval_required",
        mode: request.mode,
        risk: plan.risk,
        plan: {
          ...plan,
          status: isDryRun ? "planned" : "approval_required",
          targets: plan.targets.map((target) => ({
            ...target,
            status: target.autonomy === "autonomous" && !isDryRun ? "planned" : target.status
          }))
        },
        writes: [],
        reflections: [],
        semanticUpdates: [],
        createdAt,
        completedAt: isDryRun ? createdAt : null
      };
      this.repository.saveBusinessActionRun(run);
      this.repository.audit(request.actor, "business_action.plan", run.id, isDryRun ? "allow" : "review", {
        intent: request.intent,
        blockedTargets: blockedTargets.map((target) => target.stepId)
      });
      return run;
    }

    const writes = plan.targets.map((target) => this.executeSourceWrite(plan, target, request));
    const reflectionPackage = this.reflectSourceWrites(plan, writes, request);
    const run: BusinessActionRun = {
      id: stableId("action_run", `${plan.id}:${createdAt}`),
      intent: request.intent,
      actionType: plan.actionType,
      status: reflectionPackage.reflections.every((reflection) => reflection.status === "verified") ? "verified" : "reflected",
      mode: request.mode,
      risk: plan.risk,
      plan: {
        ...plan,
        status: "verified",
        targets: plan.targets.map((target) => ({ ...target, status: "verified" }))
      },
      writes,
      reflections: reflectionPackage.reflections,
      semanticUpdates: reflectionPackage.semanticUpdates,
      createdAt,
      completedAt: nowIso()
    };
    this.repository.saveBusinessActionRun(run);
    this.repository.audit(request.actor, "business_action.execute", run.id, "allow", {
      intent: request.intent,
      writes: writes.length,
      reflections: reflectionPackage.reflections.length,
      semanticUpdates: reflectionPackage.semanticUpdates.length
    });
    return run;
  }

  importCatalog(snapshot: CatalogSnapshot): CatalogSnapshot {
    this.repository.upsertCatalog(snapshot);
    this.repository.audit("system", "catalog.import", "catalog", "allow", {
      assets: snapshot.assets.length,
      metrics: snapshot.metrics.length,
      policies: snapshot.policies.length
    });
    return this.repository.catalog();
  }

  search(rawRequest: SearchRequest): SearchResult[] {
    const request = SearchRequestSchema.parse(rawRequest);
    const results = this.planner.search(request);
    const policies = this.repository.catalog().policies;
    const filtered = this.policy.applyResultPolicies(results, policies);
    this.repository.audit("agent", "semantic_search", request.query, "allow", {
      mode: request.mode,
      returned: filtered.length
    });
    return filtered;
  }

  runDiscovery(objective?: string) {
    return this.discoveryAgent.run(objective);
  }

  agentManifest() {
    return this.discoveryAgent.manifest();
  }

  entityLookup(name: string) {
    const normalized = name.toLowerCase();
    const graph = this.repository.graphSnapshot();
    return this.repository
      .getEntities()
      .filter((entity) => entity.canonicalName.toLowerCase().includes(normalized) || entity.aliases.some((alias) => alias.toLowerCase().includes(normalized)))
      .map((entity) => ({
        ...entity,
        degree: graph.edges.filter((edge) => edge.source === entity.id || edge.target === entity.id).length,
        evidence: entity.evidenceChunkIds.map((chunkId) => this.repository.evidence(chunkId)).filter(Boolean)
      }));
  }

  graphNeighbors(entityId: string, depth = 1) {
    const maxDepth = Math.min(Math.max(depth, 1), 2);
    const graph = this.repository.graphSnapshot();
    const visited = new Set([entityId]);
    const frontier = new Set([entityId]);
    const selectedEdges = new Map<string, (typeof graph.edges)[number]>();
    for (let level = 0; level < maxDepth; level += 1) {
      const next = new Set<string>();
      for (const edge of graph.edges) {
        if (frontier.has(edge.source) || frontier.has(edge.target)) {
          selectedEdges.set(edge.id, edge);
          const other = frontier.has(edge.source) ? edge.target : edge.source;
          if (!visited.has(other)) {
            visited.add(other);
            next.add(other);
          }
        }
      }
      frontier.clear();
      for (const item of next) frontier.add(item);
    }
    return {
      nodes: graph.nodes.filter((node) => visited.has(node.id)),
      edges: [...selectedEdges.values()]
    };
  }

  findPaths(fromEntityId: string, toEntityId: string, maxDepth = 4) {
    const graph = this.repository.graphSnapshot();
    const boundedDepth = Math.min(Math.max(maxDepth, 1), 4);
    const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: fromEntityId, path: [] }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (current.nodeId === toEntityId) {
        return current.path.map((edgeId) => graph.edges.find((edge) => edge.id === edgeId)).filter(Boolean);
      }
      if (current.path.length >= boundedDepth || visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);
      for (const edge of graph.edges.filter((candidate) => candidate.source === current.nodeId || candidate.target === current.nodeId)) {
        const nextNode = edge.source === current.nodeId ? edge.target : edge.source;
        queue.push({ nodeId: nextNode, path: [...current.path, edge.id] });
      }
    }
    return [];
  }

  expandContext(input: { query?: string; chunkIds?: string[]; entityIds?: string[] }) {
    const searchResults = input.query ? this.search({ query: input.query, topK: 5, mode: "hybrid" }) : [];
    const chunkIds = new Set([...(input.chunkIds ?? []), ...searchResults.map((result) => result.chunkId)]);
    for (const entityId of input.entityIds ?? []) {
      for (const entity of this.repository.getEntities().filter((candidate) => candidate.id === entityId)) {
        for (const chunkId of entity.evidenceChunkIds) chunkIds.add(chunkId);
      }
    }
    const evidence = [...chunkIds].map((chunkId) => this.repository.evidence(chunkId)).filter(Boolean);
    return {
      query: input.query ?? null,
      evidence,
      entities: this.repository.getEntities().filter((entity) => evidence.some((item) => item?.chunkId && entity.evidenceChunkIds.includes(item.chunkId))),
      guidance: "Use these evidence spans as citations. If evidence is insufficient, stop instead of guessing."
    };
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
    const actionType = this.resolveBusinessActionType(request.intent);
    const primaryMetric = this.findMetricForIntent(request.intent, catalog);
    const [fromAsset, toAsset] = this.findAssetPairForIntent(request.intent, catalog);
    const title = this.businessActionTitle(actionType, primaryMetric?.label ?? fromAsset?.name ?? "Business semantic update");
    const targets = this.buildBusinessActionTargets({
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
    const risk = this.highestRisk(targets.map((target) => target.risk));
    const approvalTargets = targets.filter((target) => target.autonomy === "approval_required");

    return {
      id: stableId("action_plan", `${request.intent}:${actionType}:${targets.map((target) => target.objectKey).join("|")}`),
      intent: request.intent,
      actionType,
      title,
      summary: `Semantic Junkyard resolved the business intent into ${targets.length} source-system write target${targets.length === 1 ? "" : "s"} and ${evidence.length} evidence span${evidence.length === 1 ? "" : "s"}.`,
      mode: request.mode,
      risk,
      status: approvalTargets.length > 0 ? "approval_required" : "planned",
      targets,
      warnings: [
        evidence.length === 0 ? "No direct evidence was found; writeback should stay in review mode until more context is ingested." : null,
        approvalTargets.length > 0 ? `${approvalTargets.length} target requires approval before execution.` : null
      ].filter((item): item is string => Boolean(item)),
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
    const addTarget = (target: Omit<BusinessActionTarget, "autonomy" | "status" | "evidenceChunkIds"> & { risk: RiskLevel }) => {
      const autonomy = this.autonomyFor(target.risk, input.request);
      targets.push({
        ...target,
        autonomy,
        status: autonomy === "approval_required" ? "approval_required" : "planned",
        evidenceChunkIds: input.evidenceChunkIds
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

  private executeSourceWrite(plan: BusinessActionPlan, target: BusinessActionTarget, request: BusinessActionRequest): SourceWrite {
    const createdAt = nowIso();
    if (target.systemId === "source.data-catalog") {
      this.applyCatalogTarget(target, plan, request);
    }
    if (target.systemId === "source.openmetadata") {
      this.applyLineageTarget(target, plan, request);
    }
    const payload = {
      intent: request.intent,
      actionType: plan.actionType,
      planId: plan.id,
      stepId: target.stepId,
      capability: target.capability,
      technicalOperation: target.technicalOperation,
      risk: target.risk,
      autonomy: target.autonomy,
      diff: target.diff,
      evidenceChunkIds: target.evidenceChunkIds,
      actor: request.actor,
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
      id: stableId("write", `${plan.id}:${target.stepId}:${createdAt}`),
      planId: plan.id,
      stepId: target.stepId,
      systemId: target.systemId,
      systemName: target.systemName,
      objectType: target.objectType,
      objectKey: target.objectKey,
      operation: target.technicalOperation,
      status: "executed",
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
      const reflected = record?.payload && record.payload.intent === request.intent && record.payload.planId === plan.id;
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
    const reflectionText = this.buildReflectionText(plan, writes, reflections);
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
    const updatedReflections = reflections.map((reflection) => ({ ...reflection, evidenceChunkId }));
    const curatedRelations = evidenceChunkId
      ? writes.map((write) =>
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
      `Status: ${reflections.every((reflection) => reflection.status === "verified") ? "verified" : "drift_detected"}`,
      "",
      "Verified source writes:"
    ];
    for (const write of writes) {
      const reflection = reflections.find((item) => item.writeId === write.id);
      lines.push(`- ${write.systemName} wrote ${write.operation} on ${write.objectType}:${write.objectKey}. Reflection: ${reflection?.status ?? "unknown"}.`);
    }
    lines.push("", "Business semantic result:");
    lines.push(`${plan.title} is reflected in ${writes.map((write) => write.systemName).join(", ")}.`);
    lines.push("The semantic read model must be refreshed from these source records before agents rely on the updated state.");
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
    if (/(trace|tracci|lineage|end-to-end|dipend|depend|where|dove)/i.test(normalized)) return "publish_traceability";
    if (/(align|allinea|consistent|coeren|definition|definiz|metric|kpi|contratt)/i.test(normalized)) return "align_metric_definition";
    if (/(review|approv|owner|responsabil)/i.test(normalized)) return "owner_review";
    return "operational_semantic_update";
  }

  private businessActionTitle(actionType: string, subject: string): string {
    if (actionType === "publish_traceability") return `Make ${subject} traceable end-to-end`;
    if (actionType === "align_metric_definition") return `Align ${subject} definition`;
    if (actionType === "owner_review") return `Request owner review for ${subject}`;
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
    return (
      catalog.metrics.find((metric) => this.hasTermOverlap(normalized, `${metric.name} ${metric.label} ${metric.description}`)) ??
      catalog.metrics[0] ??
      null
    );
  }

  private findAssetPairForIntent(intent: string, catalog: CatalogSnapshot) {
    const normalized = this.normalizedTerms(intent);
    const matchedAssets = catalog.assets.filter((asset) => this.hasTermOverlap(normalized, `${asset.name} ${asset.description} ${asset.kind}`));
    const pipeline = matchedAssets.find((asset) => asset.kind === "pipeline") ?? catalog.assets.find((asset) => asset.kind === "pipeline") ?? matchedAssets[0] ?? catalog.assets[0] ?? null;
    const dataset = matchedAssets.find((asset) => asset.kind === "dataset" || asset.kind === "table") ?? catalog.assets.find((asset) => asset.kind === "dataset" || asset.kind === "table") ?? matchedAssets[1] ?? catalog.assets[1] ?? pipeline;
    return [pipeline, dataset] as const;
  }

  private normalizedTerms(value: string): Set<string> {
    return new Set(value.toLowerCase().replace(/[_-]+/g, " ").split(/\W+/).filter((term) => term.length > 2));
  }

  private hasTermOverlap(terms: Set<string>, value: string): boolean {
    const haystack = value.toLowerCase().replace(/[_-]+/g, " ");
    return [...terms].some((term) => haystack.includes(term));
  }

  private autonomyFor(risk: RiskLevel, request: BusinessActionRequest): BusinessActionTarget["autonomy"] {
    if (risk === "blocked") return "blocked";
    if (request.approved) return "autonomous";
    if (request.mode === "approval_required") return "approval_required";
    return riskRank[risk] <= riskRank[request.maxAutonomousRisk] ? "autonomous" : "approval_required";
  }

  private highestRisk(risks: RiskLevel[]): RiskLevel {
    return risks.reduce<RiskLevel>((highest, current) => (riskRank[current] > riskRank[highest] ? current : highest), "low");
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
