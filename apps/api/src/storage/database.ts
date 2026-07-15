import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDatabase(filePath = process.env.SEMANTIC_JUNKYARD_DB ?? "data/semantic-junkyard.sqlite"): Database.Database {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      text TEXT NOT NULL,
      ingestion_mode TEXT NOT NULL DEFAULT 'full_data',
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      summary TEXT NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
      chunk_id UNINDEXED,
      text,
      summary,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS vectors (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      vector TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      aliases TEXT NOT NULL,
      confidence REAL NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_chunks (
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      PRIMARY KEY (entity_id, chunk_id)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      entity_ids TEXT NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_runs (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS discovery_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
      step INTEGER NOT NULL,
      tool TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      owner TEXT NOT NULL,
      description TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      freshness TEXT NOT NULL,
      quality_score REAL NOT NULL,
      uri TEXT,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      expression TEXT NOT NULL,
      dimensions TEXT NOT NULL,
      owner TEXT NOT NULL,
      domain TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      effect TEXT NOT NULL,
      applies_to TEXT NOT NULL,
      condition TEXT NOT NULL,
      rationale TEXT NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lineage_edges (
      id TEXT PRIMARY KEY,
      from_asset_id TEXT NOT NULL,
      to_asset_id TEXT NOT NULL,
      type TEXT NOT NULL,
      confidence REAL NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ontology_classes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      parent_id TEXT,
      constraints TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS semantic_contracts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      domain TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_system_records (
      id TEXT PRIMARY KEY,
      system_id TEXT NOT NULL,
      system_name TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(system_id, object_type, object_key)
    );

    CREATE TABLE IF NOT EXISTS source_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      kind TEXT NOT NULL,
      config TEXT NOT NULL,
      status TEXT NOT NULL,
      last_tested_at TEXT,
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_resources (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      data_type TEXT,
      description TEXT NOT NULL,
      uri TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      writable INTEGER NOT NULL,
      profile TEXT NOT NULL,
      evidence_chunk_ids TEXT NOT NULL,
      metadata TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      UNIQUE(connection_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS source_sync_runs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
      objective TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      resources_discovered INTEGER NOT NULL,
      assets_published INTEGER NOT NULL,
      proposals_created INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS source_sync_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES source_sync_runs(id) ON DELETE CASCADE,
      step INTEGER NOT NULL,
      phase TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      severity TEXT NOT NULL,
      evidence_resource_ids TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_proposals (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES source_sync_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_id TEXT,
      value TEXT NOT NULL,
      confidence REAL NOT NULL,
      explanation TEXT NOT NULL,
      origin TEXT NOT NULL,
      authoritative INTEGER NOT NULL,
      status TEXT NOT NULL,
      evidence_resource_ids TEXT NOT NULL,
      evidence_chunk_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      decision_rationale TEXT
    );

    CREATE TABLE IF NOT EXISTS source_discovery_missions (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      report TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS business_action_plans (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS business_action_runs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      intent TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      risk TEXT NOT NULL,
      plan TEXT NOT NULL,
      writes TEXT NOT NULL,
      reflections TEXT NOT NULL,
      semantic_updates TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS business_action_approvals (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_fingerprint TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      rationale TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      decision TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_source_id ON chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_entity_chunks_chunk_id ON entity_chunks(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_assets_domain ON semantic_assets(domain);
    CREATE INDEX IF NOT EXISTS idx_lineage_from ON lineage_edges(from_asset_id);
    CREATE INDEX IF NOT EXISTS idx_lineage_to ON lineage_edges(to_asset_id);
    CREATE INDEX IF NOT EXISTS idx_source_records_system ON source_system_records(system_id);
    CREATE INDEX IF NOT EXISTS idx_source_resources_connection ON source_resources(connection_id, kind);
    CREATE INDEX IF NOT EXISTS idx_source_sync_runs_connection ON source_sync_runs(connection_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_source_sync_events_run ON source_sync_events(run_id, step);
    CREATE INDEX IF NOT EXISTS idx_semantic_proposals_status ON semantic_proposals(status, connection_id);
    CREATE INDEX IF NOT EXISTS idx_source_discovery_missions_started ON source_discovery_missions(started_at);
    CREATE INDEX IF NOT EXISTS idx_business_action_plans_created ON business_action_plans(created_at);
    CREATE INDEX IF NOT EXISTS idx_business_action_runs_created ON business_action_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_business_action_approvals_plan ON business_action_approvals(plan_id, plan_fingerprint, status);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
  `);

    const columns = db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "ingestion_mode")) {
      db.exec("ALTER TABLE sources ADD COLUMN ingestion_mode TEXT NOT NULL DEFAULT 'full_data'");
    }

    const actionColumns = db.prepare("PRAGMA table_info(business_action_runs)").all() as Array<{ name: string }>;
    if (!actionColumns.some((column) => column.name === "idempotency_key")) {
      db.exec("ALTER TABLE business_action_runs ADD COLUMN idempotency_key TEXT");
      db.exec("UPDATE business_action_runs SET idempotency_key = id WHERE idempotency_key IS NULL");
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_business_action_runs_idempotency ON business_action_runs(idempotency_key)");

    const ontologyColumns = db.prepare("PRAGMA table_info(ontology_classes)").all() as Array<{ name: string }>;
    if (!ontologyColumns.some((column) => column.name === "metadata")) {
      db.exec("ALTER TABLE ontology_classes ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
    }
  })();
}
