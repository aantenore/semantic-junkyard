import type Database from "better-sqlite3";
import type {
  CatalogSnapshot,
  Chunk,
  Claim,
  DiscoveryEvent,
  DiscoveryRun,
  DocumentElement,
  Entity,
  EvidenceSpan,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  LineageEdge,
  MetricDefinition,
  OntologyClass,
  PolicyRule,
  Relation,
  SearchResult,
  SemanticAsset,
  SemanticContract,
  SourceArtifact,
  SystemStatus
} from "@semantic-junkyard/shared";
import { nanoid } from "nanoid";
import { defaultModules } from "../config/modules.js";
import { decodeJson, encodeJson } from "../core/json.js";
import { nowIso } from "../core/hash.js";

interface ChunkRow {
  id: string;
  source_id: string;
  text: string;
  start_offset: number;
  end_offset: number;
  token_count: number;
  summary: string;
  metadata: string;
  source_name?: string;
}

interface SourceRow {
  id: string;
  uri: string;
  name: string;
  mime_type: string;
  content_hash: string;
  text: string;
  ingestion_mode: SourceArtifact["ingestionMode"];
  metadata: string;
  created_at: string;
}

interface EntityRow {
  id: string;
  canonical_name: string;
  type: string;
  aliases: string;
  confidence: number;
  metadata: string;
}

interface RelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  type: string;
  confidence: number;
  evidence_chunk_id: string;
  metadata: string;
}

export class SemanticRepository {
  constructor(private readonly db: Database.Database) {}

  saveSource(source: SourceArtifact): void {
    this.db
      .prepare(
        `INSERT INTO sources (id, uri, name, mime_type, content_hash, text, ingestion_mode, metadata, created_at)
         VALUES (@id, @uri, @name, @mimeType, @contentHash, @text, @ingestionMode, @metadata, @createdAt)
         ON CONFLICT(id) DO UPDATE SET text=excluded.text, ingestion_mode=excluded.ingestion_mode, metadata=excluded.metadata`
      )
      .run({ ...source, metadata: encodeJson(source.metadata) });
  }

  getSources(): SourceArtifact[] {
    const rows = this.db.prepare("SELECT * FROM sources ORDER BY created_at DESC").all() as SourceRow[];
    return rows.map((row) => ({
      id: row.id,
      uri: row.uri,
      name: row.name,
      mimeType: row.mime_type,
      contentHash: row.content_hash,
      text: row.text,
      ingestionMode: row.ingestion_mode,
      metadata: decodeJson(row.metadata, {}),
      createdAt: row.created_at
    }));
  }

  saveElements(elements: DocumentElement[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO elements (id, source_id, kind, text, start_offset, end_offset, metadata)
       VALUES (@id, @sourceId, @kind, @text, @startOffset, @endOffset, @metadata)`
    );
    const tx = this.db.transaction((items: DocumentElement[]) => {
      for (const item of items) {
        stmt.run({ ...item, metadata: encodeJson(item.metadata) });
      }
    });
    tx(elements);
  }

  saveChunks(chunks: Chunk[], vectors: Map<string, number[]>): void {
    const chunkStmt = this.db.prepare(
      `INSERT OR REPLACE INTO chunks (id, source_id, text, start_offset, end_offset, token_count, summary, metadata)
       VALUES (@id, @sourceId, @text, @startOffset, @endOffset, @tokenCount, @summary, @metadata)`
    );
    const deleteFts = this.db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?");
    const ftsStmt = this.db.prepare("INSERT INTO chunk_fts (chunk_id, text, summary) VALUES (?, ?, ?)");
    const vectorStmt = this.db.prepare("INSERT OR REPLACE INTO vectors (chunk_id, vector) VALUES (?, ?)");
    const tx = this.db.transaction((items: Chunk[]) => {
      for (const item of items) {
        chunkStmt.run({ ...item, metadata: encodeJson(item.metadata) });
        deleteFts.run(item.id);
        ftsStmt.run(item.id, item.text, item.summary);
        vectorStmt.run(item.id, encodeJson(vectors.get(item.id) ?? []));
      }
    });
    tx(chunks);
  }

  saveEntities(entities: Entity[]): void {
    const entityStmt = this.db.prepare(
      `INSERT INTO entities (id, canonical_name, type, aliases, confidence, metadata)
       VALUES (@id, @canonicalName, @type, @aliases, @confidence, @metadata)
       ON CONFLICT(id) DO UPDATE SET
         canonical_name=excluded.canonical_name,
         type=excluded.type,
         aliases=excluded.aliases,
         confidence=max(confidence, excluded.confidence),
         metadata=excluded.metadata`
    );
    const evidenceStmt = this.db.prepare("INSERT OR IGNORE INTO entity_chunks (entity_id, chunk_id) VALUES (?, ?)");
    const tx = this.db.transaction((items: Entity[]) => {
      for (const item of items) {
        entityStmt.run({
          ...item,
          aliases: encodeJson(item.aliases),
          metadata: encodeJson(item.metadata)
        });
        for (const chunkId of item.evidenceChunkIds) {
          evidenceStmt.run(item.id, chunkId);
        }
      }
    });
    tx(entities);
  }

  saveRelations(relations: Relation[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO relations (id, source_entity_id, target_entity_id, type, confidence, evidence_chunk_id, metadata)
       VALUES (@id, @sourceEntityId, @targetEntityId, @type, @confidence, @evidenceChunkId, @metadata)`
    );
    const tx = this.db.transaction((items: Relation[]) => {
      for (const item of items) {
        stmt.run({
          id: item.id,
          sourceEntityId: item.sourceEntityId,
          targetEntityId: item.targetEntityId,
          type: item.type,
          confidence: item.confidence,
          evidenceChunkId: item.evidenceChunkId,
          metadata: encodeJson(item.metadata)
        });
      }
    });
    tx(relations);
  }

  saveClaims(claims: Claim[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO claims (id, text, confidence, evidence_chunk_id, entity_ids, metadata)
       VALUES (@id, @text, @confidence, @evidenceChunkId, @entityIds, @metadata)`
    );
    const tx = this.db.transaction((items: Claim[]) => {
      for (const item of items) {
        stmt.run({
          ...item,
          entityIds: encodeJson(item.entityIds),
          metadata: encodeJson(item.metadata)
        });
      }
    });
    tx(claims);
  }

  getChunks(): Array<Chunk & { sourceName: string }> {
    const rows = this.db
      .prepare(
        `SELECT chunks.*, sources.name AS source_name
         FROM chunks JOIN sources ON sources.id = chunks.source_id
         ORDER BY chunks.rowid DESC`
      )
      .all() as ChunkRow[];
    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      text: row.text,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      tokenCount: row.token_count,
      summary: row.summary,
      metadata: decodeJson(row.metadata, {}),
      sourceName: row.source_name ?? "Unknown source"
    }));
  }

  getVectors(): Map<string, number[]> {
    const rows = this.db.prepare("SELECT chunk_id, vector FROM vectors").all() as Array<{ chunk_id: string; vector: string }>;
    return new Map(rows.map((row) => [row.chunk_id, decodeJson<number[]>(row.vector, [])]));
  }

  getEntities(): Entity[] {
    const rows = this.db.prepare("SELECT * FROM entities ORDER BY canonical_name").all() as EntityRow[];
    const evidenceRows = this.db.prepare("SELECT entity_id, chunk_id FROM entity_chunks").all() as Array<{ entity_id: string; chunk_id: string }>;
    const evidence = new Map<string, string[]>();
    for (const row of evidenceRows) {
      evidence.set(row.entity_id, [...(evidence.get(row.entity_id) ?? []), row.chunk_id]);
    }
    return rows.map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      type: row.type,
      aliases: decodeJson<string[]>(row.aliases, []),
      confidence: row.confidence,
      evidenceChunkIds: evidence.get(row.id) ?? [],
      metadata: decodeJson(row.metadata, {})
    }));
  }

  getRelations(): Array<{
    id: string;
    sourceEntityId: string;
    targetEntityId: string;
    type: string;
    confidence: number;
    evidenceChunkId: string;
    metadata: Record<string, unknown>;
  }> {
    const rows = this.db.prepare("SELECT * FROM relations").all() as RelationRow[];
    return rows.map((row) => ({
      id: row.id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      type: row.type,
      confidence: row.confidence,
      evidenceChunkId: row.evidence_chunk_id,
      metadata: decodeJson(row.metadata, {})
    }));
  }

  getClaims(): Claim[] {
    const rows = this.db.prepare("SELECT * FROM claims ORDER BY confidence DESC").all() as Array<{
      id: string;
      text: string;
      confidence: number;
      evidence_chunk_id: string;
      entity_ids: string;
      metadata: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      confidence: row.confidence,
      evidenceChunkId: row.evidence_chunk_id,
      entityIds: decodeJson<string[]>(row.entity_ids, []),
      metadata: decodeJson(row.metadata, {})
    }));
  }

  saveDiscoveryRun(run: DiscoveryRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO discovery_runs (id, objective, status, started_at, completed_at)
         VALUES (@id, @objective, @status, @startedAt, @completedAt)`
      )
      .run(run);
    this.saveDiscoveryEvents(run.events);
  }

  saveDiscoveryEvents(events: DiscoveryEvent[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO discovery_events (id, run_id, step, tool, title, detail, severity, created_at)
       VALUES (@id, @runId, @step, @tool, @title, @detail, @severity, @createdAt)`
    );
    const tx = this.db.transaction((items: DiscoveryEvent[]) => {
      for (const event of items) stmt.run(event);
    });
    tx(events);
  }

  listDiscoveryRuns(): DiscoveryRun[] {
    const runs = this.db
      .prepare("SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 12")
      .all() as Array<{ id: string; objective: string; status: DiscoveryRun["status"]; started_at: string; completed_at: string | null }>;
    const eventRows = this.db.prepare("SELECT * FROM discovery_events ORDER BY step ASC").all() as Array<{
      id: string;
      run_id: string;
      step: number;
      tool: string;
      title: string;
      detail: string;
      severity: DiscoveryEvent["severity"];
      created_at: string;
    }>;
    return runs.map((run) => ({
      id: run.id,
      objective: run.objective,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      events: eventRows
        .filter((event) => event.run_id === run.id)
        .map((event) => ({
          id: event.id,
          runId: event.run_id,
          step: event.step,
          tool: event.tool,
          title: event.title,
          detail: event.detail,
          severity: event.severity,
          createdAt: event.created_at
        }))
    }));
  }

  graphSnapshot(): GraphSnapshot {
    const entities = this.getEntities();
    const relations = this.getRelations();
    const degree = new Map<string, number>();
    for (const relation of relations) {
      degree.set(relation.sourceEntityId, (degree.get(relation.sourceEntityId) ?? 0) + 1);
      degree.set(relation.targetEntityId, (degree.get(relation.targetEntityId) ?? 0) + 1);
    }
    const nodes: GraphNode[] = entities.map((entity) => ({
      id: entity.id,
      label: entity.canonicalName,
      type: entity.type,
      confidence: entity.confidence,
      degree: degree.get(entity.id) ?? 0
    }));
    const edges: GraphEdge[] = relations.map((relation) => ({
      id: relation.id,
      source: relation.sourceEntityId,
      target: relation.targetEntityId,
      label: relation.type,
      confidence: relation.confidence,
      evidenceChunkId: relation.evidenceChunkId
    }));
    return { nodes, edges };
  }

  evidence(chunkId: string): EvidenceSpan | null {
    const row = this.db
      .prepare(
        `SELECT chunks.*, sources.name AS source_name
         FROM chunks JOIN sources ON sources.id = chunks.source_id
         WHERE chunks.id = ?`
      )
      .get(chunkId) as ChunkRow | undefined;
    if (!row) return null;
    return {
      chunkId: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name ?? "Unknown source",
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      text: row.text
    };
  }

  lexicalSearch(query: string, topK: number): Array<SearchResult & { rawRank: number }> {
    const ftsQuery = query
      .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .join(" OR ");
    if (!ftsQuery) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT chunks.*, sources.name AS source_name, bm25(chunk_fts) AS rank
           FROM chunk_fts
           JOIN chunks ON chunks.id = chunk_fts.chunk_id
           JOIN sources ON sources.id = chunks.source_id
           WHERE chunk_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, topK) as Array<ChunkRow & { rank: number }>;
      return rows.map((row) => ({
        chunkId: row.id,
        sourceId: row.source_id,
        sourceName: row.source_name ?? "Unknown source",
        text: row.text,
        summary: row.summary,
        lexicalScore: Math.max(0, 1 / (1 + Math.abs(row.rank))),
        vectorScore: 0,
        graphBoost: 0,
        hybridScore: 0,
        entityIds: this.entitiesForChunk(row.id).map((entity) => entity.id),
        rawRank: row.rank
      }));
    } catch {
      return [];
    }
  }

  entitiesForChunk(chunkId: string): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT entities.*
         FROM entities
         JOIN entity_chunks ON entity_chunks.entity_id = entities.id
         WHERE entity_chunks.chunk_id = ?`
      )
      .all(chunkId) as EntityRow[];
    return rows.map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      type: row.type,
      aliases: decodeJson<string[]>(row.aliases, []),
      confidence: row.confidence,
      evidenceChunkIds: [chunkId],
      metadata: decodeJson(row.metadata, {})
    }));
  }

  upsertCatalog(snapshot: CatalogSnapshot): void {
    const assetStmt = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_assets
       (id, kind, name, domain, owner, description, sensitivity, freshness, quality_score, uri, metadata)
       VALUES (@id, @kind, @name, @domain, @owner, @description, @sensitivity, @freshness, @qualityScore, @uri, @metadata)`
    );
    const metricStmt = this.db.prepare(
      `INSERT OR REPLACE INTO metrics
       (id, name, label, description, expression, dimensions, owner, domain, contract_version, metadata)
       VALUES (@id, @name, @label, @description, @expression, @dimensions, @owner, @domain, @contractVersion, @metadata)`
    );
    const policyStmt = this.db.prepare(
      `INSERT OR REPLACE INTO policies
       (id, name, effect, applies_to, condition, rationale, metadata)
       VALUES (@id, @name, @effect, @appliesTo, @condition, @rationale, @metadata)`
    );
    const lineageStmt = this.db.prepare(
      `INSERT OR REPLACE INTO lineage_edges
       (id, from_asset_id, to_asset_id, type, confidence, metadata)
       VALUES (@id, @fromAssetId, @toAssetId, @type, @confidence, @metadata)`
    );
    const ontologyStmt = this.db.prepare(
      `INSERT OR REPLACE INTO ontology_classes
       (id, label, description, parent_id, constraints)
       VALUES (@id, @label, @description, @parentId, @constraints)`
    );
    const contractStmt = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_contracts
       (id, name, version, domain, status, metadata)
       VALUES (@id, @name, @version, @domain, @status, @metadata)`
    );
    const tx = this.db.transaction(() => {
      for (const item of snapshot.assets) assetStmt.run({ ...item, uri: item.uri ?? null, metadata: encodeJson(item.metadata) });
      for (const item of snapshot.metrics) metricStmt.run({ ...item, dimensions: encodeJson(item.dimensions), metadata: encodeJson(item.metadata) });
      for (const item of snapshot.policies) policyStmt.run({ ...item, appliesTo: encodeJson(item.appliesTo), metadata: encodeJson(item.metadata) });
      for (const item of snapshot.lineage) lineageStmt.run({ ...item, metadata: encodeJson(item.metadata) });
      for (const item of snapshot.ontologyClasses) ontologyStmt.run({ ...item, constraints: encodeJson(item.constraints) });
      for (const item of snapshot.contracts) contractStmt.run({ ...item, metadata: encodeJson(item.metadata) });
    });
    tx();
  }

  catalog(): CatalogSnapshot {
    const assets = (this.db.prepare("SELECT * FROM semantic_assets ORDER BY domain, name").all() as any[]).map<SemanticAsset>((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      domain: row.domain,
      owner: row.owner,
      description: row.description,
      sensitivity: row.sensitivity,
      freshness: row.freshness,
      qualityScore: row.quality_score,
      uri: row.uri ?? undefined,
      metadata: decodeJson(row.metadata, {})
    }));
    const metrics = (this.db.prepare("SELECT * FROM metrics ORDER BY domain, name").all() as any[]).map<MetricDefinition>((row) => ({
      id: row.id,
      name: row.name,
      label: row.label,
      description: row.description,
      expression: row.expression,
      dimensions: decodeJson<string[]>(row.dimensions, []),
      owner: row.owner,
      domain: row.domain,
      contractVersion: row.contract_version,
      metadata: decodeJson(row.metadata, {})
    }));
    const policies = (this.db.prepare("SELECT * FROM policies ORDER BY name").all() as any[]).map<PolicyRule>((row) => ({
      id: row.id,
      name: row.name,
      effect: row.effect,
      appliesTo: decodeJson<string[]>(row.applies_to, []),
      condition: row.condition,
      rationale: row.rationale,
      metadata: decodeJson(row.metadata, {})
    }));
    const lineage = (this.db.prepare("SELECT * FROM lineage_edges").all() as any[]).map<LineageEdge>((row) => ({
      id: row.id,
      fromAssetId: row.from_asset_id,
      toAssetId: row.to_asset_id,
      type: row.type,
      confidence: row.confidence,
      metadata: decodeJson(row.metadata, {})
    }));
    const ontologyClasses = (this.db.prepare("SELECT * FROM ontology_classes ORDER BY label").all() as any[]).map<OntologyClass>((row) => ({
      id: row.id,
      label: row.label,
      description: row.description,
      parentId: row.parent_id,
      constraints: decodeJson<string[]>(row.constraints, [])
    }));
    const contracts = (this.db.prepare("SELECT * FROM semantic_contracts ORDER BY domain, name").all() as any[]).map<SemanticContract>((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      domain: row.domain,
      status: row.status,
      assets: assets.filter((asset) => asset.domain === row.domain),
      metrics: metrics.filter((metric) => metric.domain === row.domain),
      policies,
      ontologyClasses,
      metadata: decodeJson(row.metadata, {})
    }));
    return { assets, metrics, policies, lineage, contracts, ontologyClasses };
  }

  status(): SystemStatus {
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
    return {
      sources: count("sources"),
      chunks: count("chunks"),
      entities: count("entities"),
      relations: count("relations"),
      claims: count("claims"),
      assets: count("semantic_assets"),
      metrics: count("metrics"),
      policies: count("policies"),
      lineageEdges: count("lineage_edges"),
      modules: defaultModules
    };
  }

  audit(actor: string, action: string, target: string, decision: string, metadata: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO audit_log (id, actor, action, target, decision, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`audit_${nanoid(12)}`, actor, action, target, decision, encodeJson(metadata), nowIso());
  }
}
