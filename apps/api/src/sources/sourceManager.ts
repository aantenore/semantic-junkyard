import {
  CreateSourceConnectionRequestSchema,
  SemanticProposalDecisionRequestSchema,
  SourceResourceSearchRequestSchema,
  SyncSourceConnectionRequestSchema,
  type BusinessActionRequest,
  type BusinessActionTarget,
  type CatalogSnapshot,
  type CreateSourceConnectionRequest,
  type Entity,
  type IngestResponse,
  type Relation,
  type SemanticProposal,
  type SourceConnection,
  type SourceConnectionTestResult,
  type SourceResource,
  type SourceSyncEvent,
  type SourceSyncRun,
  type SourceSystem
} from "@semantic-junkyard/shared";
import { nanoid } from "nanoid";
import { DomainError } from "../core/errors.js";
import { nowIso, stableId } from "../core/hash.js";
import type { SemanticRepository } from "../storage/repository.js";
import type { ConnectorActionCandidate, ConnectorSnapshot, ConnectorWriteResult, SourceConnector } from "./connector.js";
import { SourceConnectionRepository } from "./connectionRepository.js";

export interface SourceIngestionPort {
  ingest(request: unknown): IngestResponse;
}

export interface SemanticEnrichmentCandidate {
  kind: "relation" | "classification" | "description" | "ontology_class" | "metric" | "conflict";
  subjectId: string;
  predicate: string;
  objectId: string | null;
  value: Record<string, unknown>;
  confidence: number;
  explanation: string;
  evidenceResourceIds: string[];
}

export interface SemanticEnrichmentResult {
  provider: "local-huggingface";
  modelId: string;
  summary: string;
  candidates: SemanticEnrichmentCandidate[];
}

export interface SemanticEnrichmentProvider {
  enrich(objective: string, resources: SourceResource[]): Promise<SemanticEnrichmentResult>;
}

export interface SourceManagerOptions {
  connectors: SourceConnector[];
  enricher?: SemanticEnrichmentProvider;
}

export interface ResolvedConnectorAction {
  candidate: ConnectorActionCandidate | null;
  warnings: string[];
}

export class SourceManager {
  private readonly connectors: Map<SourceConnector["kind"], SourceConnector>;
  private readonly enricher?: SemanticEnrichmentProvider;
  private readonly activeSyncConnectionIds = new Set<string>();

  constructor(
    private readonly connections: SourceConnectionRepository,
    private readonly semanticRepository: SemanticRepository,
    options: SourceManagerOptions
  ) {
    this.connectors = new Map(options.connectors.map((connector) => [connector.kind, connector]));
    this.enricher = options.enricher;
  }

  createConnection(rawRequest: unknown): SourceConnection {
    const request = CreateSourceConnectionRequestSchema.parse(rawRequest);
    const connector = this.connectorFor(request.config.kind);
    const createdAt = nowIso();
    const identity = this.connectionIdentity(request);
    const existing = this.connections.getConnection(identity);
    const connection: SourceConnection = {
      id: identity,
      name: request.name,
      description: request.description,
      kind: request.config.kind,
      config: request.config,
      status: existing?.status ?? "configured",
      lastTestedAt: existing?.lastTestedAt ?? null,
      lastSyncAt: existing?.lastSyncAt ?? null,
      lastError: null,
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: createdAt
    };
    this.connections.saveConnection(connection);
    this.semanticRepository.audit("human", "source_connection.create", connection.id, "allow", {
      kind: connector.kind,
      name: connection.name
    });
    return connection;
  }

  listConnections(): SourceConnection[] {
    return this.connections.listConnections();
  }

  listResources(connectionId?: string): SourceResource[] {
    return this.connections.listResources(connectionId);
  }

  searchResources(rawRequest: unknown): SourceResource[] {
    const request = SourceResourceSearchRequestSchema.parse(rawRequest);
    const terms = request.query
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2);
    const kinds = new Set(request.kinds);
    return this.connections
      .listResources(request.connectionId)
      .filter((resource) => kinds.size === 0 || kinds.has(resource.kind))
      .map((resource) => {
        const haystack = `${resource.name} ${resource.qualifiedName} ${resource.description} ${JSON.stringify(resource.profile)}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { resource, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.resource.qualifiedName.localeCompare(right.resource.qualifiedName))
      .slice(0, request.topK)
      .map((item) => item.resource);
  }

  listSyncRuns(connectionId?: string): SourceSyncRun[] {
    return this.connections.listSyncRuns(connectionId);
  }

  listProposals(filters: { connectionId?: string; status?: SemanticProposal["status"] } = {}): SemanticProposal[] {
    return this.connections.listProposals(filters);
  }

  deleteConnection(id: string, actor = "local-user"): void {
    const connection = this.requireConnection(id);
    this.semanticRepository.transaction(() => {
      this.semanticRepository.removeConnectionObservations(id);
      if (!this.connections.deleteConnection(id)) throw new DomainError("CONNECTION_NOT_FOUND", `Connection not found: ${id}`, 404);
    });
    this.semanticRepository.audit(actor, "source_connection.delete", id, "allow", { name: connection.name, kind: connection.kind });
  }

  testConnection(id: string): SourceConnectionTestResult {
    const connection = this.requireConnection(id);
    const connector = this.connectorFor(connection.kind);
    const testedAt = nowIso();
    try {
      const result = connector.test(connection);
      const next: SourceConnection = {
        ...connection,
        status: result.ok ? "ready" : "error",
        lastTestedAt: testedAt,
        lastError: result.ok ? null : result.message,
        updatedAt: testedAt
      };
      this.connections.saveConnection(next);
      return { connectionId: id, ok: result.ok, message: result.message, details: result.details, testedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connector test failed.";
      this.connections.saveConnection({ ...connection, status: "error", lastTestedAt: testedAt, lastError: message, updatedAt: testedAt });
      return { connectionId: id, ok: false, message, details: {}, testedAt };
    }
  }

  async syncConnection(id: string, rawRequest: unknown, ingestion: SourceIngestionPort): Promise<SourceSyncRun> {
    const request = SyncSourceConnectionRequestSchema.parse(rawRequest ?? {});
    const connection = this.requireConnection(id);
    const connector = this.connectorFor(connection.kind);
    if (this.activeSyncConnectionIds.has(id)) {
      throw new DomainError("SYNC_ALREADY_RUNNING", `A synchronization is already running for source connection ${id}.`, 409);
    }
    this.activeSyncConnectionIds.add(id);
    const run = this.newRun(connection.id, request.objective, request.provider);
    const events = run.events;
    try {
      this.connections.saveConnection({ ...connection, status: "syncing", lastError: null, updatedAt: nowIso() });
      this.connections.saveSyncRun(run);
    } catch (error) {
      this.activeSyncConnectionIds.delete(id);
      throw error;
    }

    try {
      const tested = connector.test(connection);
      this.addEvent(events, run.id, "connect", "Connection verified", tested.message, tested.ok ? "success" : "error", [], tested.details);
      if (!tested.ok) throw new DomainError("CONNECTION_UNAVAILABLE", tested.message, 422, tested.details);

      const snapshot = connector.discover(connection);
      this.addEvent(
        events,
        run.id,
        "inspect",
        "Source inventory discovered",
        `${snapshot.resources.length} resources and ${snapshot.documents.length} evidence documents were observed from the authoritative source.`,
        "success",
        snapshot.resources.map((resource) => resource.id),
        { checkpoint: snapshot.checkpoint }
      );
      for (const warning of snapshot.warnings) this.addEvent(events, run.id, "profile", "Connector warning", warning, "warning");

      const chunkIdsByExternalId = new Map<string, string[]>();
      const retainedSourceIds: string[] = [];
      for (const document of snapshot.documents) {
        const resource = snapshot.resources.find((candidate) => candidate.externalId === document.resourceExternalId);
        const result = ingestion.ingest({
          ...document.request,
          metadata: {
            ...document.request.metadata,
            connectionId: connection.id,
            resourceExternalId: document.resourceExternalId,
            resourceId: resource?.id ?? null,
            sensitivity: resource?.sensitivity ?? "internal"
          }
        });
        retainedSourceIds.push(result.source.id);
        chunkIdsByExternalId.set(document.resourceExternalId, result.chunks.map((chunk) => chunk.id));
      }
      this.semanticRepository.pruneConnectionEvidence(connection.id, retainedSourceIds);
      const resources = snapshot.resources.map((resource) => ({
        ...resource,
        evidenceChunkIds: chunkIdsByExternalId.get(resource.externalId) ?? resource.evidenceChunkIds
      }));
      this.connections.replaceResources(connection.id, resources);
      this.addEvent(events, run.id, "parse", "Evidence materialized", `${snapshot.documents.length} source documents were indexed with provenance-preserving resource links.`, "success");

      const resourceByExternalId = new Map(resources.map((resource) => [resource.externalId, resource]));
      const catalog = connectionCatalogSnapshot(connection.id, snapshot, resourceByExternalId);
      const assets = catalog.assets;
      this.semanticRepository.replaceCatalogObservations(connection.id, catalog);
      const currentProposalIds = this.publishStructuralGraph(connection, resources, snapshot.relations, run.id);

      let modelProposalCount = 0;
      let enrichmentFailed = false;
      const enrichableResources = resources.filter((resource) => resource.evidenceChunkIds.length > 0);
      if (request.provider === "local-huggingface" && enrichableResources.length > 0) {
        if (!this.enricher) {
          this.addEvent(events, run.id, "extract", "Local model unavailable", "The local Hugging Face enrichment provider is not configured; deterministic source facts were still published.", "warning");
        } else {
          try {
            const enrichment = await this.enricher.enrich(request.objective, enrichableResources);
            for (const candidate of enrichment.candidates) {
              const proposal = this.connections.saveProposal(this.proposalFromEnrichment(connection.id, run.id, candidate));
              this.applyProposalLifecycle(proposal);
              currentProposalIds.push(proposal.id);
              modelProposalCount += 1;
            }
            this.addEvent(
              events,
              run.id,
              "extract",
              "Local model proposed semantic assertions",
              enrichment.summary,
              "success",
              enrichment.candidates.flatMap((candidate) => candidate.evidenceResourceIds),
              { provider: enrichment.provider, model: enrichment.modelId, proposals: enrichment.candidates.length }
            );
          } catch (error) {
            enrichmentFailed = true;
            this.addEvent(
              events,
              run.id,
              "extract",
              "Local model enrichment failed",
              "Deterministic source facts remain available, but this synchronization produced no fresh model proposals.",
              "warning",
              [],
              { errorCode: normalizedModelErrorCode(error) }
            );
          }
        }
      } else if (request.provider === "local-huggingface") {
        this.addEvent(events, run.id, "extract", "Local model enrichment skipped", "No observed resources had materialized evidence chunks, so no evidence-bound model proposal could be requested.", "warning");
      }

      const superseded = this.connections.supersedeMissingProposals(connection.id, currentProposalIds, run.id, nowIso());
      for (const proposal of superseded) this.applyProposalLifecycle(proposal);
      if (superseded.length > 0) {
        this.addEvent(events, run.id, "propose", "Stale semantic assertions superseded", `${superseded.length} assertions were not emitted by the latest source observation and were removed from active navigation.`, "warning");
      }

      const proposals = this.connections.listProposals({ connectionId: connection.id });
      const completedAt = nowIso();
      const completed: SourceSyncRun = {
        ...run,
        status: snapshot.warnings.length > 0 || enrichmentFailed ? "partial" : "completed",
        resourcesDiscovered: resources.length,
        assetsPublished: assets.length,
        proposalsCreated: snapshot.relations.length + modelProposalCount,
        completedAt,
        events
      };
      this.addEvent(
        events,
        run.id,
        "complete",
        "Semantic synchronization completed",
        `${resources.length} resources, ${assets.length} governed assets, and ${proposals.filter((proposal) => proposal.status === "proposed").length} reviewable proposals are now available.`,
        "success"
      );
      this.connections.saveSyncRun(completed);
      this.connections.saveConnection({ ...connection, status: completed.status === "partial" ? "degraded" : "ready", lastSyncAt: completedAt, lastError: null, updatedAt: completedAt });
      this.semanticRepository.audit("system", "source_connection.sync", connection.id, completed.status, {
        runId: run.id,
        resources: resources.length,
        assets: assets.length,
        provider: request.provider
      });
      return completed;
    } catch (error) {
      const completedAt = nowIso();
      const message = error instanceof Error ? error.message : "Source synchronization failed.";
      this.addEvent(events, run.id, "complete", "Synchronization failed", message, "error");
      const failed: SourceSyncRun = { ...run, status: "failed", completedAt, events };
      this.connections.saveSyncRun(failed);
      this.connections.saveConnection({ ...connection, status: "error", lastError: message, updatedAt: completedAt });
      throw error;
    } finally {
      this.activeSyncConnectionIds.delete(id);
    }
  }

  decideProposal(id: string, rawRequest: unknown, actor = "local-user"): SemanticProposal {
    const request = SemanticProposalDecisionRequestSchema.parse(rawRequest);
    const proposal = this.connections.getProposal(id);
    if (!proposal) throw new DomainError("PROPOSAL_NOT_FOUND", `Semantic proposal not found: ${id}`, 404);
    if (proposal.authoritative) {
      throw new DomainError("AUTHORITATIVE_ASSERTION", "Source facts cannot be rejected in the semantic layer; change the authoritative source or its field-authority mapping.", 409);
    }
    if (proposal.status !== "proposed") {
      throw new DomainError("PROPOSAL_ALREADY_DECIDED", `Semantic proposal ${id} is already ${proposal.status}. Decisions are terminal; resynchronize or create a new proposal to review changed evidence.`, 409);
    }
    const decided = this.connections.decideProposal(id, request.decision, actor, request.rationale, nowIso());
    if (!decided) throw new DomainError("PROPOSAL_NOT_FOUND", `Semantic proposal not found: ${id}`, 404);
    this.applyProposalLifecycle(decided);
    this.semanticRepository.audit(actor, "semantic_proposal.decide", id, request.decision, {
      rationale: request.rationale,
      connectionId: decided.connectionId
    });
    return decided;
  }

  sourceSystems(): SourceSystem[] {
    return this.connections.listConnections().map((connection) => {
      const writeMode = connection.config.kind === "filesystem" ? "read_only" : connection.config.writeMode;
      return {
        id: connection.id,
        name: connection.name,
        kind: connection.kind === "git" ? "git" : connection.kind === "sqlite" ? "database" : "local",
        description: connection.description || `Real ${connection.kind} source connection managed by the connector registry.`,
        capabilities: [
          {
            id: `${connection.id}.discover`,
            systemId: connection.id,
            label: "Discover source semantics",
            businessCapability: "source.discover",
            technicalOperation: `${connection.kind}.discover`,
            risk: "low",
            autonomous: true,
            requiresApproval: false,
            reversible: true,
            description: "Inspect and synchronize source metadata and evidence through the configured connector."
          },
          ...(writeMode === "read_only"
            ? []
            : [
                {
                  id: `${connection.id}.write`,
                  systemId: connection.id,
                  label: "Apply governed source change",
                  businessCapability: connection.kind === "git" ? "semantic_contract.publish" : "record.update",
                  technicalOperation: connection.kind === "git" ? "git.semantic_contract.commit" : "sqlite.record.update",
                  risk: "medium" as const,
                  autonomous: writeMode === "autonomous",
                  requiresApproval: writeMode === "approval_required",
                  reversible: true,
                  description: "Apply an exact fingerprinted change with optimistic concurrency and authoritative readback."
                }
              ])
        ]
      };
    });
  }

  isManagedSystem(id: string): boolean {
    return this.connections.getConnection(id) !== null;
  }

  resolveBusinessAction(request: BusinessActionRequest): ResolvedConnectorAction {
    const candidates: ConnectorActionCandidate[] = [];
    const failures: string[] = [];
    for (const connection of this.connections.listConnections()) {
      const connector = this.connectorFor(connection.kind);
      if (!connector.planAction) continue;
      try {
        const candidate = connector.planAction(connection, request, this.connections.listResources(connection.id));
        if (candidate) candidates.push(candidate);
      } catch (error) {
        failures.push(`${connection.name}: ${error instanceof Error ? error.message : "action resolution failed"}`);
      }
    }
    if (candidates.length === 0) return { candidate: null, warnings: failures };
    if (candidates.length > 1) {
      return {
        candidate: null,
        warnings: [`The intent matched ${candidates.length} connector capabilities. Add a source or object name so identity resolution is unambiguous.`]
      };
    }
    return { candidate: candidates[0] ?? null, warnings: failures };
  }

  executeAction(target: BusinessActionTarget, request: BusinessActionRequest): ConnectorWriteResult {
    const connection = this.requireConnection(target.systemId);
    const connector = this.connectorFor(connection.kind);
    if (!connector.executeAction) throw new DomainError("CONNECTOR_READ_ONLY", `Connector ${connection.name} does not support writeback.`, 409);
    const candidate: ConnectorActionCandidate = {
      connectionId: connection.id,
      capability: target.capability,
      technicalOperation: target.technicalOperation,
      objectType: target.objectType,
      objectKey: target.objectKey,
      title: target.diff.summary,
      rationale: target.rationale,
      risk: target.risk,
      requiresApproval: target.autonomy === "approval_required",
      evidenceResourceIds: Array.isArray(target.parameters.evidenceResourceIds) ? target.parameters.evidenceResourceIds.filter((item): item is string => typeof item === "string") : [],
      evidenceChunkIds: target.evidenceChunkIds,
      before: this.recordParameter(target.parameters.before),
      after: this.recordParameter(target.parameters.after) ?? {},
      parameters: { ...target.parameters, intent: request.intent }
    };
    return connector.executeAction(connection, candidate);
  }

  counts(): { connections: number; resources: number; proposals: number } {
    return this.connections.counts();
  }

  private publishStructuralGraph(
    connection: SourceConnection,
    resources: SourceResource[],
    relations: Array<{ subjectExternalId: string; predicate: string; objectExternalId: string; confidence: number; explanation: string; authoritative: boolean }>,
    runId: string
  ): string[] {
    const resourceByExternalId = new Map(resources.map((resource) => [resource.externalId, resource]));
    const entities = resources.map<Entity>((resource) => ({
      id: sourceEntityId(resource),
      canonicalName: sourceEntityName(connection, resource),
      type: this.entityTypeForResource(resource),
      aliases: [resource.name],
      confidence: 1,
      evidenceChunkIds: resource.evidenceChunkIds,
      metadata: {
        connectionId: connection.id,
        resourceId: resource.id,
        externalId: resource.externalId,
        authoritative: true,
        sensitivity: resource.sensitivity,
        writable: resource.writable
      }
    }));
    this.semanticRepository.saveEntities(entities);
    const entityByExternalId = new Map(resources.map((resource) => [resource.externalId, sourceEntityId(resource)]));
    const graphRelations: Relation[] = [];
    const proposalIds: string[] = [];
    const savedProposals: SemanticProposal[] = [];
    for (const relation of relations) {
      const source = resourceByExternalId.get(relation.subjectExternalId);
      const target = resourceByExternalId.get(relation.objectExternalId);
      const sourceEntityId = entityByExternalId.get(relation.subjectExternalId);
      const targetEntityId = entityByExternalId.get(relation.objectExternalId);
      if (!source || !target || !sourceEntityId || !targetEntityId) continue;
      const evidenceChunkId = source.evidenceChunkIds[0] ?? target.evidenceChunkIds[0];
      if (!evidenceChunkId) continue;
      const assertionIdentity = [
        connection.id,
        relation.subjectExternalId,
        relation.predicate,
        relation.objectExternalId,
        ...(relation.authoritative ? [] : [evidenceChunkId, relation.confidence, relation.explanation])
      ].join(":");
      const relationId = stableId("rel", assertionIdentity);
      graphRelations.push({
        id: relationId,
        sourceEntityId,
        targetEntityId,
        type: relation.predicate,
        confidence: relation.confidence,
        evidenceChunkId,
        metadata: {
          connectionId: connection.id,
          authoritative: relation.authoritative,
          lifecycle: relation.authoritative ? "accepted" : "proposed",
          explanation: relation.explanation
        }
      });
      const proposalId = stableId("proposal", assertionIdentity);
      const savedProposal = this.connections.saveProposal({
        id: proposalId,
        connectionId: connection.id,
        runId,
        kind: "relation",
        subjectId: source.id,
        predicate: relation.predicate,
        objectId: target.id,
        value: { relationId, sourceEntityId, targetEntityId, relationType: relation.predicate },
        confidence: relation.confidence,
        explanation: relation.explanation,
        origin: relation.authoritative ? "source_fact" : "deterministic_inference",
        authoritative: relation.authoritative,
        status: relation.authoritative ? "accepted" : "proposed",
        evidenceResourceIds: [source.id, target.id],
        evidenceChunkIds: [evidenceChunkId],
        createdAt: nowIso(),
        decidedAt: relation.authoritative ? nowIso() : null,
        decidedBy: relation.authoritative ? "source" : null,
        decisionRationale: relation.authoritative ? "Published directly from an authoritative structural source fact." : null
      });
      savedProposals.push(savedProposal);
      proposalIds.push(proposalId);
    }
    this.semanticRepository.saveRelations(graphRelations);
    this.semanticRepository.pruneConnectionGraph(
      connection.id,
      entities.map((entity) => entity.id),
      graphRelations.map((relation) => relation.id)
    );
    for (const proposal of savedProposals) this.applyProposalLifecycle(proposal);
    return proposalIds;
  }

  private proposalFromEnrichment(connectionId: string, runId: string, candidate: SemanticEnrichmentCandidate): SemanticProposal {
    const evidenceChunkIds = candidate.evidenceResourceIds.flatMap((id) => this.connections.getResource(id)?.evidenceChunkIds ?? []);
    return {
      id: stableId(
        "proposal",
        `${connectionId}:${candidate.kind}:${candidate.subjectId}:${candidate.predicate}:${candidate.objectId ?? ""}:${JSON.stringify(candidate.value)}:${candidate.confidence}:${candidate.explanation}:${candidate.evidenceResourceIds.join("|")}:${evidenceChunkIds.join("|")}`
      ),
      connectionId,
      runId,
      kind: candidate.kind,
      subjectId: candidate.subjectId,
      predicate: candidate.predicate,
      objectId: candidate.objectId,
      value: candidate.value,
      confidence: candidate.confidence,
      explanation: candidate.explanation,
      origin: "local_model",
      authoritative: false,
      status: "proposed",
      evidenceResourceIds: candidate.evidenceResourceIds,
      evidenceChunkIds,
      createdAt: nowIso(),
      decidedAt: null,
      decidedBy: null,
      decisionRationale: null
    };
  }

  private applyProposalLifecycle(proposal: SemanticProposal): void {
    if (proposal.kind !== "relation") {
      this.applySemanticAnnotation(proposal);
      return;
    }
    const relationId = typeof proposal.value.relationId === "string" ? proposal.value.relationId : null;
    if (relationId) {
      const relation = this.semanticRepository.getRelations().find((item) => item.id === relationId);
      if (relation) this.semanticRepository.saveRelations([{ ...relation, metadata: { ...relation.metadata, lifecycle: proposal.status } }]);
      return;
    }
    const existing = this.semanticRepository.getRelations().find((item) => item.metadata.proposalId === proposal.id);
    if (existing) {
      this.semanticRepository.saveRelations([{ ...existing, metadata: { ...existing.metadata, lifecycle: proposal.status } }]);
      if (proposal.status !== "accepted") return;
    } else if (proposal.status !== "accepted") {
      return;
    }
    const source = this.connections.getResource(proposal.subjectId);
    const target = proposal.objectId ? this.connections.getResource(proposal.objectId) : null;
    if (!source || !target) return;
    const sourceNodeId = sourceEntityId(source);
    const targetNodeId = sourceEntityId(target);
    const evidenceChunkId = proposal.evidenceChunkIds[0];
    if (!evidenceChunkId) return;
    this.semanticRepository.saveRelations([
      {
        id: stableId("rel", `${proposal.id}:${sourceNodeId}:${proposal.predicate}:${targetNodeId}`),
        sourceEntityId: sourceNodeId,
        targetEntityId: targetNodeId,
        type: proposal.predicate,
        confidence: proposal.confidence,
        evidenceChunkId,
        metadata: {
          connectionId: proposal.connectionId,
          lifecycle: "accepted",
          proposalId: proposal.id,
          authoritative: false,
          explanation: proposal.explanation
        }
      }
    ]);
  }

  private applySemanticAnnotation(proposal: SemanticProposal): void {
    const resource = this.connections.getResource(proposal.subjectId);
    if (!resource) return;
    const entityId = sourceEntityId(resource);
    const entity = this.semanticRepository.getEntities().find((candidate) => candidate.id === entityId);
    if (!entity) return;
    const annotations = Array.isArray(entity.metadata.semanticAnnotations)
      ? entity.metadata.semanticAnnotations.filter(
          (annotation): annotation is Record<string, unknown> => Boolean(annotation) && typeof annotation === "object" && !Array.isArray(annotation)
        )
      : [];
    const retained = annotations.filter((annotation) => annotation.proposalId !== proposal.id);
    if (proposal.status === "accepted") {
      retained.push({
        proposalId: proposal.id,
        kind: proposal.kind,
        predicate: proposal.predicate,
        value: proposal.value,
        confidence: proposal.confidence,
        explanation: proposal.explanation,
        evidenceResourceIds: proposal.evidenceResourceIds
      });
    }
    this.semanticRepository.saveEntities([
      {
        ...entity,
        metadata: {
          ...entity.metadata,
          semanticAnnotations: retained
        }
      }
    ]);
  }

  private newRun(connectionId: string, objective: string, provider: SourceSyncRun["provider"]): SourceSyncRun {
    return {
      id: `sync_${nanoid(12)}`,
      connectionId,
      objective,
      provider,
      status: "running",
      resourcesDiscovered: 0,
      assetsPublished: 0,
      proposalsCreated: 0,
      startedAt: nowIso(),
      completedAt: null,
      events: []
    };
  }

  private addEvent(
    events: SourceSyncEvent[],
    runId: string,
    phase: SourceSyncEvent["phase"],
    title: string,
    detail: string,
    severity: SourceSyncEvent["severity"],
    evidenceResourceIds: string[] = [],
    metadata: Record<string, unknown> = {}
  ): void {
    events.push({
      id: `sync_evt_${nanoid(12)}`,
      runId,
      step: events.length + 1,
      phase,
      title,
      detail,
      severity,
      evidenceResourceIds: [...new Set(evidenceResourceIds)],
      metadata,
      createdAt: nowIso()
    });
  }

  private connectionIdentity(request: CreateSourceConnectionRequest): string {
    const location = request.config.kind === "sqlite"
      ? request.config.databasePath
      : request.config.kind === "filesystem"
        ? request.config.rootPath
        : request.config.repositoryPath;
    return stableId("connection", `${request.config.kind}:${location}`);
  }

  private connectorFor(kind: SourceConnection["kind"]): SourceConnector {
    const connector = this.connectors.get(kind);
    if (!connector) throw new DomainError("CONNECTOR_NOT_CONFIGURED", `No connector is configured for source kind ${kind}.`, 422);
    return connector;
  }

  private requireConnection(id: string): SourceConnection {
    const connection = this.connections.getConnection(id);
    if (!connection) throw new DomainError("CONNECTION_NOT_FOUND", `Connection not found: ${id}`, 404);
    return connection;
  }

  private entityTypeForResource(resource: SourceResource): string {
    if (resource.kind === "table" || resource.kind === "dataset") return "Dataset";
    if (resource.kind === "column") return "Field";
    if (resource.kind === "metric") return "Metric";
    if (resource.kind === "semantic_contract") return "SemanticContract";
    if (resource.kind === "job") return "Pipeline";
    return "Document";
  }

  private recordParameter(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }
}

function connectionCatalogSnapshot(
  connectionId: string,
  snapshot: ConnectorSnapshot,
  resourcesByExternalId: Map<string, SourceResource>
): CatalogSnapshot {
  const sourceContracts = uniqueById(snapshot.contracts);
  const sourceAssets = uniqueById([...snapshot.assets, ...sourceContracts.flatMap((contract) => contract.assets)]);
  const sourceMetrics = uniqueById([...snapshot.metrics, ...sourceContracts.flatMap((contract) => contract.metrics)]);
  const sourcePolicies = uniqueById(sourceContracts.flatMap((contract) => contract.policies));
  const sourceOntology = uniqueById([
    ...snapshot.ontologyClasses,
    ...sourceContracts.flatMap((contract) => contract.ontologyClasses)
  ]);
  const assetIds = new Map(sourceAssets.map((asset) => [asset.id, stableId("asset", `${connectionId}:${asset.id}`)]));
  const metricIds = new Map(sourceMetrics.map((metric) => [metric.id, stableId("metric", `${connectionId}:${metric.id}`)]));
  const policyIds = new Map(sourcePolicies.map((policy) => [policy.id, stableId("policy", `${connectionId}:${policy.id}`)]));
  const ontologyIds = new Map(sourceOntology.map((item) => [item.id, stableId("ontology", `${connectionId}:${item.id}`)]));
  const contractIds = new Map(sourceContracts.map((contract) => [contract.id, stableId("contract", `${connectionId}:${contract.id}`)]));

  const memberships = <T extends { id: string }>(
    item: T,
    select: (contract: (typeof sourceContracts)[number]) => T[]
  ): string[] => sourceContracts
    .filter((contract) => select(contract).some((candidate) => candidate.id === item.id))
    .map((contract) => contractIds.get(contract.id)!)
    .filter(Boolean);

  const assets = sourceAssets.map((asset) => {
    const explicitContractIds = memberships(asset, (contract) => contract.assets);
    const declaredContractId = typeof asset.metadata.contractId === "string"
      ? contractIds.get(asset.metadata.contractId)
      : undefined;
    const memberContractIds = [...new Set([...explicitContractIds, ...(declaredContractId ? [declaredContractId] : [])])];
    const externalId = String(asset.metadata.externalId ?? asset.metadata.sourceResourceExternalId ?? "");
    return {
      ...asset,
      id: assetIds.get(asset.id)!,
      metadata: {
        ...asset.metadata,
        connectionId,
        sourceSemanticId: asset.id,
        contractIds: memberContractIds,
        evidenceChunkIds: resourcesByExternalId.get(externalId)?.evidenceChunkIds ?? []
      }
    };
  });
  const metrics = sourceMetrics.map((metric) => ({
    ...metric,
    id: metricIds.get(metric.id)!,
    metadata: {
      ...metric.metadata,
      connectionId,
      sourceSemanticId: metric.id,
      contractIds: memberships(metric, (contract) => contract.metrics)
    }
  }));
  const policies = sourcePolicies.map((policy) => ({
    ...policy,
    id: policyIds.get(policy.id)!,
    metadata: {
      ...policy.metadata,
      connectionId,
      sourceSemanticId: policy.id,
      contractIds: memberships(policy, (contract) => contract.policies)
    }
  }));
  const ontologyClasses = sourceOntology.map((item) => ({
    ...item,
    id: ontologyIds.get(item.id)!,
    parentId: item.parentId ? ontologyIds.get(item.parentId) ?? null : null,
    metadata: {
      ...(item.metadata ?? {}),
      connectionId,
      sourceSemanticId: item.id,
      contractIds: memberships(item, (contract) => contract.ontologyClasses)
    }
  }));
  const assetBySourceId = new Map(assets.map((asset) => [String(asset.metadata.sourceSemanticId), asset]));
  const metricBySourceId = new Map(metrics.map((metric) => [String(metric.metadata.sourceSemanticId), metric]));
  const policyBySourceId = new Map(policies.map((policy) => [String(policy.metadata.sourceSemanticId), policy]));
  const ontologyBySourceId = new Map(ontologyClasses.map((item) => [String(item.metadata?.sourceSemanticId), item]));
  const contracts = sourceContracts.map((contract) => ({
    ...contract,
    id: contractIds.get(contract.id)!,
    assets: contract.assets.flatMap((asset) => assetBySourceId.get(asset.id) ?? []),
    metrics: contract.metrics.flatMap((metric) => metricBySourceId.get(metric.id) ?? []),
    policies: contract.policies.flatMap((policy) => policyBySourceId.get(policy.id) ?? []),
    ontologyClasses: contract.ontologyClasses.flatMap((item) => ontologyBySourceId.get(item.id) ?? []),
    metadata: {
      ...contract.metadata,
      connectionId,
      sourceSemanticId: contract.id
    }
  }));
  const lineage = snapshot.lineage.flatMap((edge) => {
    const fromAssetId = assetIds.get(edge.fromAssetId);
    const toAssetId = assetIds.get(edge.toAssetId);
    if (!fromAssetId || !toAssetId) return [];
    return [{
      ...edge,
      id: stableId("lineage", `${connectionId}:${edge.id}`),
      fromAssetId,
      toAssetId,
      metadata: { ...edge.metadata, connectionId, sourceSemanticId: edge.id }
    }];
  });
  return { assets, metrics, policies, lineage, contracts, ontologyClasses };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function normalizedModelErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "LOCAL_MODEL_FAILED";
  const code = error.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "LOCAL_MODEL_FAILED";
}

function sourceEntityId(resource: SourceResource): string {
  return stableId("ent", `${resource.connectionId}:${resource.externalId}`);
}

function sourceEntityName(connection: SourceConnection, resource: SourceResource): string {
  return `${connection.name} (${connection.id.slice(-6)}) / ${resource.kind} / ${resource.qualifiedName}`;
}
