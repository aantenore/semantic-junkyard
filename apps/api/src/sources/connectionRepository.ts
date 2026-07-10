import type Database from "better-sqlite3";
import {
  SourceConnectionConfigSchema,
  type SemanticProposal,
  type SourceConnection,
  type SourceResource,
  type SourceSyncEvent,
  type SourceSyncRun
} from "@semantic-junkyard/shared";

export class SourceConnectionRepository {
  constructor(private readonly db: Database.Database) {}

  saveConnection(connection: SourceConnection): void {
    this.db
      .prepare(
        `INSERT INTO source_connections
         (id, name, description, kind, config, status, last_tested_at, last_sync_at, last_error, created_at, updated_at)
         VALUES (@id, @name, @description, @kind, @config, @status, @lastTestedAt, @lastSyncAt, @lastError, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           kind = excluded.kind,
           config = excluded.config,
           status = excluded.status,
           last_tested_at = excluded.last_tested_at,
           last_sync_at = excluded.last_sync_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run({ ...connection, config: JSON.stringify(connection.config) });
  }

  getConnection(id: string): SourceConnection | null {
    const row = this.db.prepare("SELECT * FROM source_connections WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapConnection(row) : null;
  }

  listConnections(): SourceConnection[] {
    return (this.db.prepare("SELECT * FROM source_connections ORDER BY name, id").all() as Record<string, unknown>[]).map((row) => this.mapConnection(row));
  }

  deleteConnection(id: string): boolean {
    return this.db.prepare("DELETE FROM source_connections WHERE id = ?").run(id).changes > 0;
  }

  replaceResources(connectionId: string, resources: SourceResource[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO source_resources
       (id, connection_id, external_id, parent_id, kind, name, qualified_name, data_type, description, uri, sensitivity, writable, profile, evidence_chunk_ids, metadata, observed_at)
       VALUES (@id, @connectionId, @externalId, @parentId, @kind, @name, @qualifiedName, @dataType, @description, @uri, @sensitivity, @writable, @profile, @evidenceChunkIds, @metadata, @observedAt)
       ON CONFLICT(id) DO UPDATE SET
         parent_id = excluded.parent_id,
         kind = excluded.kind,
         name = excluded.name,
         qualified_name = excluded.qualified_name,
         data_type = excluded.data_type,
         description = excluded.description,
         uri = excluded.uri,
         sensitivity = excluded.sensitivity,
         writable = excluded.writable,
         profile = excluded.profile,
         evidence_chunk_ids = excluded.evidence_chunk_ids,
         metadata = excluded.metadata,
         observed_at = excluded.observed_at`
    );
    this.db.transaction(() => {
      const retained = new Set(resources.map((resource) => resource.id));
      const existing = this.db.prepare("SELECT id FROM source_resources WHERE connection_id = ?").all(connectionId) as Array<{ id: string }>;
      for (const row of existing) {
        if (!retained.has(row.id)) this.db.prepare("DELETE FROM source_resources WHERE id = ?").run(row.id);
      }
      for (const resource of resources) {
        upsert.run({
          ...resource,
          writable: resource.writable ? 1 : 0,
          profile: JSON.stringify(resource.profile),
          evidenceChunkIds: JSON.stringify(resource.evidenceChunkIds),
          metadata: JSON.stringify(resource.metadata)
        });
      }
    })();
  }

  listResources(connectionId?: string): SourceResource[] {
    const rows = connectionId
      ? this.db.prepare("SELECT * FROM source_resources WHERE connection_id = ? ORDER BY qualified_name").all(connectionId)
      : this.db.prepare("SELECT * FROM source_resources ORDER BY connection_id, qualified_name").all();
    return (rows as Record<string, unknown>[]).map((row) => this.mapResource(row));
  }

  getResource(id: string): SourceResource | null {
    const row = this.db.prepare("SELECT * FROM source_resources WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapResource(row) : null;
  }

  saveSyncRun(run: SourceSyncRun): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO source_sync_runs
           (id, connection_id, objective, provider, status, resources_discovered, assets_published, proposals_created, started_at, completed_at)
           VALUES (@id, @connectionId, @objective, @provider, @status, @resourcesDiscovered, @assetsPublished, @proposalsCreated, @startedAt, @completedAt)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             resources_discovered = excluded.resources_discovered,
             assets_published = excluded.assets_published,
             proposals_created = excluded.proposals_created,
             completed_at = excluded.completed_at`
        )
        .run(run);
      this.db.prepare("DELETE FROM source_sync_events WHERE run_id = ?").run(run.id);
      const saveEvent = this.db.prepare(
        `INSERT INTO source_sync_events
         (id, run_id, step, phase, title, detail, severity, evidence_resource_ids, metadata, created_at)
         VALUES (@id, @runId, @step, @phase, @title, @detail, @severity, @evidenceResourceIds, @metadata, @createdAt)`
      );
      for (const event of run.events) {
        saveEvent.run({
          ...event,
          evidenceResourceIds: JSON.stringify(event.evidenceResourceIds),
          metadata: JSON.stringify(event.metadata)
        });
      }
    })();
  }

  listSyncRuns(connectionId?: string, limit = 100): SourceSyncRun[] {
    const rows = connectionId
      ? this.db.prepare("SELECT * FROM source_sync_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT ?").all(connectionId, limit)
      : this.db.prepare("SELECT * FROM source_sync_runs ORDER BY started_at DESC LIMIT ?").all(limit);
    const runRows = rows as Record<string, unknown>[];
    if (runRows.length === 0) return [];
    const events = this.db
      .prepare(`SELECT * FROM source_sync_events WHERE run_id IN (${runRows.map(() => "?").join(",")}) ORDER BY run_id, step`)
      .all(...runRows.map((row) => String(row.id))) as Record<string, unknown>[];
    return runRows.map((row) => ({
      id: String(row.id),
      connectionId: String(row.connection_id),
      objective: String(row.objective),
      provider: row.provider as SourceSyncRun["provider"],
      status: row.status as SourceSyncRun["status"],
      resourcesDiscovered: Number(row.resources_discovered),
      assetsPublished: Number(row.assets_published),
      proposalsCreated: Number(row.proposals_created),
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      events: events.filter((event) => event.run_id === row.id).map((event) => this.mapSyncEvent(event))
    }));
  }

  saveProposal(proposal: SemanticProposal): SemanticProposal {
    const existing = this.getProposal(proposal.id);
    const preserved = existing && !existing.authoritative && !proposal.authoritative && existing.status !== "proposed"
      ? {
          ...proposal,
          status: existing.status,
          decidedAt: existing.decidedAt,
          decidedBy: existing.decidedBy,
          decisionRationale: existing.decisionRationale
        }
      : proposal;
    this.db
      .prepare(
        `INSERT INTO semantic_proposals
         (id, connection_id, run_id, kind, subject_id, predicate, object_id, value, confidence, explanation, origin, authoritative, status, evidence_resource_ids, evidence_chunk_ids, created_at, decided_at, decided_by, decision_rationale)
         VALUES (@id, @connectionId, @runId, @kind, @subjectId, @predicate, @objectId, @value, @confidence, @explanation, @origin, @authoritative, @status, @evidenceResourceIds, @evidenceChunkIds, @createdAt, @decidedAt, @decidedBy, @decisionRationale)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id,
           value = excluded.value,
           confidence = excluded.confidence,
           explanation = excluded.explanation,
           authoritative = excluded.authoritative,
           status = excluded.status,
           evidence_resource_ids = excluded.evidence_resource_ids,
           evidence_chunk_ids = excluded.evidence_chunk_ids,
           decided_at = excluded.decided_at,
           decided_by = excluded.decided_by,
           decision_rationale = excluded.decision_rationale`
      )
      .run({
        ...preserved,
        value: JSON.stringify(preserved.value),
        authoritative: preserved.authoritative ? 1 : 0,
        evidenceResourceIds: JSON.stringify(preserved.evidenceResourceIds),
        evidenceChunkIds: JSON.stringify(preserved.evidenceChunkIds)
      });
    return preserved;
  }

  getProposal(id: string): SemanticProposal | null {
    const row = this.db.prepare("SELECT * FROM semantic_proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapProposal(row) : null;
  }

  listProposals(filters: { connectionId?: string; status?: SemanticProposal["status"] } = {}): SemanticProposal[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filters.connectionId) {
      conditions.push("connection_id = ?");
      values.push(filters.connectionId);
    }
    if (filters.status) {
      conditions.push("status = ?");
      values.push(filters.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM semantic_proposals ${where} ORDER BY created_at DESC, id`).all(...values) as Record<string, unknown>[]).map((row) => this.mapProposal(row));
  }

  decideProposal(id: string, decision: "accepted" | "rejected", actor: string, rationale: string, decidedAt: string): SemanticProposal | null {
    const proposal = this.getProposal(id);
    if (!proposal) return null;
    if (proposal.authoritative) return proposal;
    this.db
      .prepare(
        `UPDATE semantic_proposals
         SET status = ?, decided_at = ?, decided_by = ?, decision_rationale = ?
         WHERE id = ?`
      )
      .run(decision, decidedAt, actor, rationale, id);
    return this.getProposal(id);
  }

  supersedeMissingProposals(connectionId: string, currentIds: string[], runId: string, decidedAt: string): SemanticProposal[] {
    const current = new Set(currentIds);
    const candidates = this.listProposals({ connectionId }).filter(
      (proposal) => proposal.runId !== runId && proposal.status !== "rejected" && proposal.status !== "superseded" && !current.has(proposal.id)
    );
    const update = this.db.prepare(
      `UPDATE semantic_proposals
       SET status = 'superseded', decided_at = ?, decided_by = 'system', decision_rationale = ?
       WHERE id = ?`
    );
    for (const proposal of candidates) {
      update.run(decidedAt, "The latest authoritative source synchronization no longer emitted this assertion.", proposal.id);
    }
    return candidates.map((proposal) => this.getProposal(proposal.id)).filter((proposal): proposal is SemanticProposal => proposal !== null);
  }

  counts(): { connections: number; resources: number; proposals: number } {
    return {
      connections: Number((this.db.prepare("SELECT COUNT(*) AS count FROM source_connections").get() as { count: number }).count),
      resources: Number((this.db.prepare("SELECT COUNT(*) AS count FROM source_resources").get() as { count: number }).count),
      proposals: Number((this.db.prepare("SELECT COUNT(*) AS count FROM semantic_proposals WHERE status = 'proposed'").get() as { count: number }).count)
    };
  }

  private mapConnection(row: Record<string, unknown>): SourceConnection {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      kind: row.kind as SourceConnection["kind"],
      config: SourceConnectionConfigSchema.parse(JSON.parse(String(row.config))),
      status: row.status as SourceConnection["status"],
      lastTestedAt: row.last_tested_at ? String(row.last_tested_at) : null,
      lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapResource(row: Record<string, unknown>): SourceResource {
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      externalId: String(row.external_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      kind: row.kind as SourceResource["kind"],
      name: String(row.name),
      qualifiedName: String(row.qualified_name),
      dataType: row.data_type ? String(row.data_type) : null,
      description: String(row.description),
      uri: String(row.uri),
      sensitivity: row.sensitivity as SourceResource["sensitivity"],
      writable: Boolean(row.writable),
      profile: JSON.parse(String(row.profile)) as Record<string, unknown>,
      evidenceChunkIds: JSON.parse(String(row.evidence_chunk_ids)) as string[],
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      observedAt: String(row.observed_at)
    };
  }

  private mapSyncEvent(row: Record<string, unknown>): SourceSyncEvent {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      step: Number(row.step),
      phase: row.phase as SourceSyncEvent["phase"],
      title: String(row.title),
      detail: String(row.detail),
      severity: row.severity as SourceSyncEvent["severity"],
      evidenceResourceIds: JSON.parse(String(row.evidence_resource_ids)) as string[],
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      createdAt: String(row.created_at)
    };
  }

  private mapProposal(row: Record<string, unknown>): SemanticProposal {
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      runId: String(row.run_id),
      kind: row.kind as SemanticProposal["kind"],
      subjectId: String(row.subject_id),
      predicate: String(row.predicate),
      objectId: row.object_id ? String(row.object_id) : null,
      value: JSON.parse(String(row.value)) as Record<string, unknown>,
      confidence: Number(row.confidence),
      explanation: String(row.explanation),
      origin: row.origin as SemanticProposal["origin"],
      authoritative: Boolean(row.authoritative),
      status: row.status as SemanticProposal["status"],
      evidenceResourceIds: JSON.parse(String(row.evidence_resource_ids)) as string[],
      evidenceChunkIds: JSON.parse(String(row.evidence_chunk_ids)) as string[],
      createdAt: String(row.created_at),
      decidedAt: row.decided_at ? String(row.decided_at) : null,
      decidedBy: row.decided_by ? String(row.decided_by) : null,
      decisionRationale: row.decision_rationale ? String(row.decision_rationale) : null
    };
  }
}
