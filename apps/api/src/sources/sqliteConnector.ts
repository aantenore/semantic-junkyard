import type {
  BusinessActionRequest,
  SemanticAsset,
  SourceConnection,
  SourceResource
} from "@semantic-junkyard/shared";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, stableId } from "../core/hash.js";
import type {
  ConnectorActionCandidate,
  ConnectorSnapshot,
  ConnectorTestResult,
  ConnectorWriteResult,
  SourceConnector
} from "./connector.js";

type SqliteConfig = Extract<SourceConnection["config"], { kind: "sqlite" }>;
type SqliteWriteRule = SqliteConfig["writeRules"][number];
type SqliteParameter = string | number | null;
type DatabaseRow = Record<string, unknown>;

interface SqliteMasterRow {
  name: string;
  sql: string | null;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

interface TableSchema {
  name: string;
  sql: string | null;
  columns: TableInfoRow[];
  foreignKeys: ForeignKeyRow[];
}

interface ProfiledTable extends TableSchema {
  rowCount: number;
  samples: DatabaseRow[];
}

interface ValidatedRule {
  rule: SqliteWriteRule;
  schema: TableSchema;
  index: number;
}

interface RuleValidation {
  valid: ValidatedRule[];
  errors: string[];
}

interface PlannedInput {
  rule: ValidatedRule;
  keyValue: Exclude<SqliteParameter, null>;
  updates: Record<string, SqliteParameter>;
}

interface CandidateOperation extends PlannedInput {
  sourceVersion: string;
  requestMode: BusinessActionRequest["mode"];
  noOp: boolean;
}

interface ContextField {
  present: boolean;
  value?: unknown;
}

interface ParsedLiteral {
  ok: boolean;
  value?: SqliteParameter;
}

const CAPABILITY = "record.update";
const TECHNICAL_OPERATION = "sqlite.record.update";
const MAX_PARAMETER_TEXT_LENGTH = 1_000_000;
const SOURCE_VERSION_PATTERN = /^[a-f0-9]{64}$/;

const sensitivityRank: Record<SourceResource["sensitivity"], number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3
};

export class SqliteConnector implements SourceConnector {
  readonly kind = "sqlite" as const;

  test(connection: SourceConnection): ConnectorTestResult {
    let db: Database.Database | undefined;
    const configuredPath = connection.config.kind === "sqlite" ? connection.config.databasePath : null;
    try {
      const config = sqliteConfig(connection);
      const databaseFile = resolveDatabaseFile(config.databasePath);
      db = openReadOnly(databaseFile.path);

      const schemas = inspectTables(db);
      const selected = selectTables(schemas, config.includeTables);
      const missingTables = missingIncludedTables(schemas, config.includeTables);
      const ruleValidation = validateWriteRules(config, selected);
      const quickCheck = readPragmaValue(db, "PRAGMA quick_check(1)");
      const sqliteVersion = String(
        (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version
      );
      const issues = [
        ...(quickCheck === "ok" ? [] : [`SQLite quick_check returned: ${quickCheck}`]),
        ...missingTables.map((table) => `Configured include table does not exist: ${table}`),
        ...ruleValidation.errors
      ];

      return {
        ok: issues.length === 0,
        message: issues.length === 0
          ? `SQLite database opened read-only and validated (${selected.length} table${selected.length === 1 ? "" : "s"}).`
          : `SQLite configuration validation failed: ${issues.join("; ")}`,
        details: {
          databasePath: databaseFile.path,
          fileSizeBytes: databaseFile.stat.size,
          sqliteVersion,
          schemaVersion: Number(readPragmaValue(db, "PRAGMA schema_version")),
          quickCheck,
          tableCount: schemas.length,
          selectedTableCount: selected.length,
          selectedTables: selected.map((table) => table.name),
          missingTables,
          writeMode: config.writeMode,
          validatedWriteRules: ruleValidation.valid.length,
          validationErrors: issues,
          accessMode: "read_only"
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown SQLite validation failure.";
      return {
        ok: false,
        message: `SQLite connection failed: ${message}`,
        details: { databasePath: configuredPath, accessMode: "read_only" }
      };
    } finally {
      db?.close();
    }
  }

  discover(connection: SourceConnection): ConnectorSnapshot {
    const config = sqliteConfig(connection);
    const databaseFile = resolveDatabaseFile(config.databasePath);
    const db = openReadOnly(databaseFile.path);

    try {
      const allSchemas = inspectTables(db);
      const schemas = selectTables(allSchemas, config.includeTables);
      const profiledTables = schemas.map((schema) => profileTable(db, schema, config.sampleRows));
      const ruleValidation = validateWriteRules(config, schemas);
      const validRuleByTable = new Map(ruleValidation.valid.map((entry) => [entry.rule.table, entry]));
      const observedAt = new Date().toISOString();
      const databaseExternalId = "database";
      const databaseResourceId = resourceId(connection.id, databaseExternalId);
      const databaseUri = pathToFileURL(databaseFile.path).href;
      const databaseName = path.basename(databaseFile.path);
      const writable = config.writeMode !== "read_only" && ruleValidation.valid.length > 0;
      const resources: SourceResource[] = [];
      const assets: SemanticAsset[] = [];
      const relations: ConnectorSnapshot["relations"] = [];
      const lineage: ConnectorSnapshot["lineage"] = [];
      const documents: ConnectorSnapshot["documents"] = [];
      const tableSensitivity = new Map<string, SourceResource["sensitivity"]>();

      for (const table of profiledTables) {
        tableSensitivity.set(
          table.name,
          highestSensitivity(table.columns.map((column) => inferColumnSensitivity(column.name)))
        );
      }

      resources.push({
        id: databaseResourceId,
        connectionId: connection.id,
        externalId: databaseExternalId,
        parentId: null,
        kind: "database",
        name: databaseName,
        qualifiedName: connection.name,
        dataType: "sqlite",
        description: `SQLite database ${databaseName} discovered from its authoritative schema.`,
        uri: databaseUri,
        sensitivity: highestSensitivity([...tableSensitivity.values()]),
        writable,
        profile: {
          tableCount: allSchemas.length,
          selectedTableCount: profiledTables.length,
          selectedTables: profiledTables.map((table) => table.name),
          schemaVersion: Number(readPragmaValue(db, "PRAGMA schema_version")),
          fileSizeBytes: databaseFile.stat.size,
          sampleRowsPerTable: config.sampleRows
        },
        evidenceChunkIds: [],
        metadata: {
          connector: this.kind,
          databasePath: databaseFile.path,
          writeMode: config.writeMode
        },
        observedAt
      });

      for (const table of profiledTables) {
        const tableExternalId = tableExternalIdFor(table.name);
        const tableResourceId = resourceId(connection.id, tableExternalId);
        const tableAssetId = assetId(connection.id, tableExternalId);
        const rule = validRuleByTable.get(table.name)?.rule;
        const tableWritable = config.writeMode !== "read_only" && Boolean(rule);
        const sensitivity = tableSensitivity.get(table.name) ?? "internal";
        const primaryKeyColumns = table.columns
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name);
        const tableProfile: Record<string, unknown> = {
          rowCount: table.rowCount,
          columnCount: table.columns.length,
          primaryKeyColumns,
          foreignKeys: table.foreignKeys.map(portableForeignKey)
        };
        if (config.sampleRows > 0) tableProfile.sampleRows = table.samples.map((sample) => profileSampleRow(table, sample));

        resources.push({
          id: tableResourceId,
          connectionId: connection.id,
          externalId: tableExternalId,
          parentId: databaseResourceId,
          kind: "table",
          name: table.name,
          qualifiedName: `${connection.name}.${table.name}`,
          dataType: "table",
          description: `SQLite table ${table.name} with ${table.columns.length} columns and ${table.rowCount} rows.`,
          uri: resourceUri(databaseUri, { table: table.name }),
          sensitivity,
          writable: tableWritable,
          profile: tableProfile,
          evidenceChunkIds: [],
          metadata: {
            connector: this.kind,
            schemaSource: "sqlite_master",
            createSql: table.sql,
            writeRule: rule
              ? { keyColumn: rule.keyColumn, allowedColumns: [...rule.allowedColumns], risk: rule.risk }
              : null
          },
          observedAt
        });

        assets.push({
          id: tableAssetId,
          kind: "table",
          name: table.name,
          domain: connection.name,
          owner: `source:${connection.id}`,
          description: `Authoritative SQLite table ${table.name}.`,
          sensitivity,
          freshness: "unknown",
          qualityScore: primaryKeyColumns.length > 0 ? 0.9 : 0.75,
          uri: resourceUri(databaseUri, { table: table.name }),
          metadata: {
            connectionId: connection.id,
            externalId: tableExternalId,
            rowCount: table.rowCount,
            columnCount: table.columns.length,
            primaryKeyColumns,
            writable: tableWritable
          }
        });

        documents.push({
          resourceExternalId: tableExternalId,
          request: {
            name: `${connection.name}.${table.name} SQLite schema`,
            text: schemaEvidence(connection, table),
            uri: resourceUri(databaseUri, { table: table.name }),
            mimeType: "text/plain",
            ingestionMode: "full_data",
            metadata: {
              connector: this.kind,
              connectionId: connection.id,
              externalId: tableExternalId,
              authoritative: true
            }
          }
        });

        for (const column of table.columns) {
          const columnExternalId = columnExternalIdFor(table.name, column.name);
          const columnSensitivity = inferColumnSensitivity(column.name);
          const columnWritable = tableWritable && Boolean(rule?.allowedColumns.includes(column.name));
          const columnProfile: Record<string, unknown> = {
            ordinal: column.cid,
            declaredType: column.type || null,
            nullable: column.notnull === 0 && column.pk === 0,
            defaultValue: column.dflt_value,
            primaryKeyPosition: column.pk
          };
          if (config.sampleRows > 0) {
            columnProfile.sampleValues = table.samples.map((sample) => profileSampleValue(column.name, sample[column.name]));
          }

          resources.push({
            id: resourceId(connection.id, columnExternalId),
            connectionId: connection.id,
            externalId: columnExternalId,
            parentId: tableResourceId,
            kind: "column",
            name: column.name,
            qualifiedName: `${connection.name}.${table.name}.${column.name}`,
            dataType: column.type || null,
            description: columnDescription(table.name, column),
            uri: resourceUri(databaseUri, { table: table.name, column: column.name }),
            sensitivity: columnSensitivity,
            writable: columnWritable,
            profile: columnProfile,
            evidenceChunkIds: [],
            metadata: {
              connector: this.kind,
              schemaSource: "PRAGMA table_info",
              tableExternalId
            },
            observedAt
          });

          assets.push({
            id: assetId(connection.id, columnExternalId),
            kind: "column",
            name: column.name,
            domain: connection.name,
            owner: `source:${connection.id}`,
            description: columnDescription(table.name, column),
            sensitivity: columnSensitivity,
            freshness: "unknown",
            qualityScore: column.pk > 0 || column.notnull > 0 ? 0.9 : 0.8,
            uri: resourceUri(databaseUri, { table: table.name, column: column.name }),
            metadata: {
              connectionId: connection.id,
              externalId: columnExternalId,
              tableExternalId,
              declaredType: column.type || null,
              primaryKeyPosition: column.pk,
              writable: columnWritable
            }
          });

          relations.push({
            subjectExternalId: tableExternalId,
            predicate: "HAS_COLUMN",
            objectExternalId: columnExternalId,
            confidence: 1,
            explanation: `${column.name} is declared by ${table.name} in PRAGMA table_info.`,
            authoritative: true
          });
        }
      }

      const selectedByName = new Map(profiledTables.map((table) => [table.name, table]));
      for (const table of profiledTables) {
        for (const foreignKey of table.foreignKeys) {
          const localColumn = table.columns.find((column) => column.name === foreignKey.from);
          const targetTable = findSchemaTable(selectedByName, foreignKey.table);
          const targetColumn = targetTable ? resolveForeignKeyTargetColumn(targetTable, foreignKey) : null;
          if (!localColumn || !targetTable || !targetColumn) continue;

          const sourceExternalId = columnExternalIdFor(table.name, localColumn.name);
          const targetExternalId = columnExternalIdFor(targetTable.name, targetColumn.name);
          relations.push({
            subjectExternalId: sourceExternalId,
            predicate: "REFERENCES",
            objectExternalId: targetExternalId,
            confidence: 1,
            explanation: `${table.name}.${localColumn.name} references ${targetTable.name}.${targetColumn.name} according to PRAGMA foreign_key_list.`,
            authoritative: true
          });
          lineage.push({
            id: stableId(
              "lineage",
              `${connection.id}:${sourceExternalId}:REFERENCES:${targetExternalId}:${foreignKey.id}:${foreignKey.seq}`
            ),
            fromAssetId: assetId(connection.id, sourceExternalId),
            toAssetId: assetId(connection.id, targetExternalId),
            type: "READS",
            confidence: 1,
            metadata: {
              source: "PRAGMA foreign_key_list",
              relationship: "foreign_key",
              foreignKeyId: foreignKey.id,
              sequence: foreignKey.seq,
              onUpdate: foreignKey.on_update,
              onDelete: foreignKey.on_delete
            }
          });
        }
      }

      const missingTables = missingIncludedTables(allSchemas, config.includeTables);
      const warnings = [
        ...missingTables.map((table) => `Configured include table was not discovered: ${table}.`),
        ...ruleValidation.errors
      ];

      return {
        resources,
        documents,
        assets,
        metrics: [],
        lineage,
        contracts: [],
        ontologyClasses: [],
        relations,
        warnings,
        checkpoint: {
          databasePath: databaseFile.path,
          schemaVersion: Number(readPragmaValue(db, "PRAGMA schema_version")),
          fileSizeBytes: databaseFile.stat.size,
          fileModifiedAt: databaseFile.stat.mtime.toISOString(),
          selectedTables: profiledTables.map((table) => table.name),
          rowCounts: Object.fromEntries(profiledTables.map((table) => [table.name, table.rowCount]))
        }
      };
    } finally {
      db.close();
    }
  }

  planAction(
    connection: SourceConnection,
    request: BusinessActionRequest,
    resources: SourceResource[]
  ): ConnectorActionCandidate | null {
    const config = sqliteConfig(connection);
    if (config.writeMode === "read_only" || config.writeRules.length === 0) return null;
    if (!/\b(?:update|change|set)\b/i.test(request.intent)) return null;
    if (/\b(?:delete|drop|truncate|insert|create|alter|attach|detach|pragma)\b/i.test(request.intent)) return null;

    const databaseFile = resolveDatabaseFile(config.databasePath);
    const db = openReadOnly(databaseFile.path);
    try {
      const schemas = selectTables(inspectTables(db), config.includeTables);
      const validation = validateWriteRules(config, schemas);
      const input = planInput(request, validation.valid);
      if (!input || Object.hasOwn(input.updates, input.rule.rule.keyColumn)) return null;

      const rows = selectRowsByKey(
        db,
        input.rule.schema,
        input.rule.rule.keyColumn,
        input.keyValue
      );
      if (rows.length !== 1) return null;

      const before = rows[0] as DatabaseRow;
      const sourceVersion = rowVersion(before);
      const after = { ...before, ...input.updates };
      const projectedBefore = projectActionRow(before, input.rule.rule.keyColumn, Object.keys(input.updates));
      const projectedAfter = projectActionRow(after, input.rule.rule.keyColumn, Object.keys(input.updates));
      const noOp = Object.entries(input.updates).every(
        ([column, expected]) => Object.hasOwn(before, column) && exactSqliteValue(before[column], expected)
      );
      const relevantExternalIds = new Set([
        tableExternalIdFor(input.rule.schema.name),
        columnExternalIdFor(input.rule.schema.name, input.rule.rule.keyColumn),
        ...Object.keys(input.updates).map((column) => columnExternalIdFor(input.rule.schema.name, column))
      ]);
      const evidenceResources = resources.filter(
        (resource) => resource.connectionId === connection.id && relevantExternalIds.has(resource.externalId)
      );
      const policyResourceIds = evidenceResources
        .filter((resource) => resource.kind === "column")
        .map((resource) => resource.id);
      const riskRequiresApproval = riskRank(input.rule.rule.risk) > riskRank(request.maxAutonomousRisk);

      return {
        connectionId: connection.id,
        capability: CAPABILITY,
        technicalOperation: TECHNICAL_OPERATION,
        objectType: input.rule.schema.name,
        objectKey: `${input.rule.schema.name}:${displayKey(input.keyValue)}`,
        title: `Update ${input.rule.schema.name} record ${displayKey(input.keyValue)}`,
        rationale: noOp
          ? "The request resolved to one configured SQLite write rule and one source row, but the authoritative row already satisfies the requested state; execution will verify without issuing an UPDATE."
          : `The request resolved to one configured SQLite write rule, one source row, and ${Object.keys(input.updates).length} allowed column update${Object.keys(input.updates).length === 1 ? "" : "s"}.`,
        risk: input.rule.rule.risk,
        requiresApproval:
          config.writeMode === "approval_required" ||
          request.mode === "approval_required" ||
          riskRequiresApproval,
        evidenceResourceIds: evidenceResources.map((resource) => resource.id),
        evidenceChunkIds: [...new Set(evidenceResources.flatMap((resource) => resource.evidenceChunkIds))],
        before: projectedBefore,
        after: projectedAfter,
        parameters: {
          table: input.rule.schema.name,
          keyColumn: input.rule.rule.keyColumn,
          keyValue: input.keyValue,
          updates: input.updates,
          noOp,
          policyResourceIds,
          precondition: {
            kind: "source_row_hash",
            sourceVersion
          },
          expectedSourceVersion: sourceVersion,
          requestMode: request.mode
        }
      };
    } finally {
      db.close();
    }
  }

  executeAction(connection: SourceConnection, candidate: ConnectorActionCandidate): ConnectorWriteResult {
    const config = sqliteConfig(connection);
    if (config.writeMode === "read_only") throw new Error("SQLite connection is read-only.");

    const databaseFile = resolveDatabaseFile(config.databasePath);
    const db = openWritable(databaseFile.path);
    let committed: { before: DatabaseRow; rowsChanged: number; operation: CandidateOperation } | null = null;

    try {
      const schemas = selectTables(inspectTables(db), config.includeTables);
      const operation = validateCandidate(connection, config, candidate, schemas, true);
      const execute = db.transaction(() => {
        const rows = selectRowsByKey(
          db,
          operation.rule.schema,
          operation.rule.rule.keyColumn,
          operation.keyValue
        );
        if (rows.length !== 1) {
          throw new Error("SQLite write target is missing or no longer resolves to exactly one row.");
        }

        const current = rows[0] as DatabaseRow;
        const currentVersion = rowVersion(current);
        if (currentVersion !== operation.sourceVersion) {
          throw new Error(
            `SQLite source-row precondition failed: expected ${operation.sourceVersion}, observed ${currentVersion}. The plan is stale.`
          );
        }

        const currentAlreadySatisfiesRequest = Object.entries(operation.updates).every(
          ([column, expected]) => Object.hasOwn(current, column) && exactSqliteValue(current[column], expected)
        );
        if (currentAlreadySatisfiesRequest !== operation.noOp) {
          throw new Error("SQLite no-op state does not match the planned source row.");
        }
        if (operation.noOp) return { before: current, rowsChanged: 0 };

        const updateColumns = Object.keys(operation.updates);
        const assignments = updateColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ");
        const sql = `UPDATE ${quoteIdentifier(operation.rule.schema.name)} SET ${assignments} WHERE ${quoteIdentifier(operation.rule.rule.keyColumn)} = ?`;
        const result = db
          .prepare(sql)
          .run(...updateColumns.map((column) => operation.updates[column]), operation.keyValue);
        if (result.changes !== 1) {
          throw new Error(`SQLite write changed ${result.changes} rows; exactly one row is required.`);
        }
        return { before: current, rowsChanged: result.changes };
      });
      const result = execute.immediate();
      committed = { ...result, operation };
    } finally {
      db.close();
    }

    if (!committed) throw new Error("SQLite write did not produce a committed source row.");
    const { before, operation, rowsChanged } = committed;
    const expectedAfter = { ...before, ...operation.updates };
    const projectedBefore = projectActionRow(before, operation.rule.rule.keyColumn, Object.keys(operation.updates));
    const projectedAfter = projectActionRow(expectedAfter, operation.rule.rule.keyColumn, Object.keys(operation.updates));
    const readback = this.readAction(connection, {
      ...candidate,
      before: projectedBefore,
      after: projectedAfter
    });
    return {
      ...readback,
      before: projectedBefore,
      after: projectedAfter,
      metadata: {
        ...readback.metadata,
        previousSourceVersion: operation.sourceVersion,
        rowsChanged,
        noOp: rowsChanged === 0,
        sourceMutation: rowsChanged > 0,
        transactionMode: "immediate",
        readbackConnection: "independent_read_only"
      }
    };
  }

  readAction(connection: SourceConnection, candidate: ConnectorActionCandidate): ConnectorWriteResult {
    const config = sqliteConfig(connection);
    const databaseFile = resolveDatabaseFile(config.databasePath);
    const db = openReadOnly(databaseFile.path);
    try {
      const schemas = selectTables(inspectTables(db), config.includeTables);
      const operation = validateCandidate(connection, config, candidate, schemas, false);
      const rows = selectRowsByKey(
        db,
        operation.rule.schema,
        operation.rule.rule.keyColumn,
        operation.keyValue
      );
      const readback = rows.length === 1 ? (rows[0] as DatabaseRow) : null;
      const postconditionPassed = Boolean(
        readback &&
          Object.entries(operation.updates).every(
            ([column, expected]) => Object.hasOwn(readback, column) && exactSqliteValue(readback[column], expected)
          )
      );
      const sourceVersion = readback
        ? rowVersion(readback)
        : sha256(`sqlite-readback:${connection.id}:${candidate.objectKey}:${rows.length === 0 ? "missing" : "ambiguous"}`);
      const columns = Object.keys(operation.updates);

      return {
        sourceVersion,
        before: candidate.before,
        after: candidate.after,
        readback: readback
          ? projectActionRow(readback, operation.rule.rule.keyColumn, Object.keys(operation.updates))
          : {},
        postconditionPassed,
        postcondition: `Read back exactly one row and require exact equality for allowed field${columns.length === 1 ? "" : "s"}: ${columns.join(", ")}.`,
        metadata: {
          connectionId: connection.id,
          table: operation.rule.schema.name,
          keyColumn: operation.rule.rule.keyColumn,
          readbackStatus: rows.length === 1 ? "found" : rows.length === 0 ? "missing" : "ambiguous",
          verifiedColumns: columns
        }
      };
    } finally {
      db.close();
    }
  }
}

export const sqliteConnector = new SqliteConnector();

function sqliteConfig(connection: SourceConnection): SqliteConfig {
  if (connection.kind !== "sqlite" || connection.config.kind !== "sqlite") {
    throw new Error(`SQLite connector cannot handle connection kind ${connection.kind}.`);
  }
  return connection.config;
}

function resolveDatabaseFile(databasePath: string): { path: string; stat: fs.Stats } {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) {
    throw new Error("SQLite source connections require a real filesystem database path.");
  }
  const resolved = path.resolve(databasePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`SQLite source is not a regular file: ${resolved}`);
  return { path: resolved, stat };
}

function openReadOnly(databasePath: string): Database.Database {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma("query_only = ON");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openWritable(databasePath: string): Database.Database {
  const db = new Database(databasePath, { fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function inspectTables(db: Database.Database): TableSchema[] {
  const masterRows = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
    )
    .all() as SqliteMasterRow[];
  return masterRows.map((master) => {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(master.name)})`).all() as TableInfoRow[];
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(master.name)})`).all() as ForeignKeyRow[];
    return { name: master.name, sql: master.sql, columns, foreignKeys };
  });
}

function selectTables(schemas: TableSchema[], includeTables: string[]): TableSchema[] {
  if (includeTables.length === 0) return schemas;
  const included = new Set(includeTables);
  return schemas.filter((table) => included.has(table.name));
}

function missingIncludedTables(schemas: TableSchema[], includeTables: string[]): string[] {
  if (includeTables.length === 0) return [];
  const discovered = new Set(schemas.map((table) => table.name));
  return [...new Set(includeTables)].filter((table) => !discovered.has(table));
}

function validateWriteRules(config: SqliteConfig, schemas: TableSchema[]): RuleValidation {
  const schemaByName = new Map(schemas.map((schema) => [schema.name, schema]));
  const candidates: ValidatedRule[] = [];
  const errors: string[] = [];

  config.writeRules.forEach((rule, index) => {
    const schema = schemaByName.get(rule.table);
    if (!schema) {
      errors.push(`SQLite write rule ${index + 1} table is absent or excluded: ${rule.table}.`);
      return;
    }
    const columns = new Set(schema.columns.map((column) => column.name));
    if (!columns.has(rule.keyColumn)) {
      errors.push(`SQLite write rule ${index + 1} key column does not exist: ${rule.table}.${rule.keyColumn}.`);
      return;
    }
    const duplicateAllowedColumns = rule.allowedColumns.filter(
      (column, columnIndex) => rule.allowedColumns.indexOf(column) !== columnIndex
    );
    const missingColumns = rule.allowedColumns.filter((column) => !columns.has(column));
    if (duplicateAllowedColumns.length > 0 || missingColumns.length > 0) {
      if (duplicateAllowedColumns.length > 0) {
        errors.push(
          `SQLite write rule ${index + 1} repeats allowed columns: ${[...new Set(duplicateAllowedColumns)].join(", ")}.`
        );
      }
      if (missingColumns.length > 0) {
        errors.push(
          `SQLite write rule ${index + 1} allows nonexistent columns: ${missingColumns.join(", ")}.`
        );
      }
      return;
    }
    candidates.push({ rule, schema, index });
  });

  const rulesByTable = new Map<string, ValidatedRule[]>();
  for (const candidate of candidates) {
    const existing = rulesByTable.get(candidate.rule.table) ?? [];
    existing.push(candidate);
    rulesByTable.set(candidate.rule.table, existing);
  }
  const ambiguousTables = new Set<string>();
  for (const [table, rules] of rulesByTable) {
    if (rules.length <= 1) continue;
    ambiguousTables.add(table);
    errors.push(`Multiple SQLite write rules target table ${table}; write exposure is disabled for that table.`);
  }

  return {
    valid: candidates.filter((candidate) => !ambiguousTables.has(candidate.rule.table)),
    errors
  };
}

function profileTable(db: Database.Database, schema: TableSchema, sampleRows: number): ProfiledTable {
  const table = quoteIdentifier(schema.name);
  const countRow = db.prepare(`SELECT COUNT(*) AS row_count FROM ${table}`).get() as { row_count: number | bigint };
  const rowCount = Number(countRow.row_count);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error(`SQLite row count is outside the supported range for table ${schema.name}.`);
  }
  const samples = sampleRows > 0
    ? (db.prepare(`SELECT * FROM ${table} LIMIT ?`).all(sampleRows) as DatabaseRow[])
    : [];
  return { ...schema, rowCount, samples };
}

function planInput(request: BusinessActionRequest, rules: ValidatedRule[]): PlannedInput | null {
  const rule = resolveIntentRule(request.intent, request.context, rules);
  if (!rule) return null;

  const contextKeyColumn = oneContextField(request.context, ["keyColumn"]);
  if (contextKeyColumn.present && contextKeyColumn.value !== rule.rule.keyColumn) return null;

  const contextKey = oneContextField(
    request.context,
    [...new Set(["keyValue", "recordKey", "key", rule.rule.keyColumn])]
  );
  const intentKeys = parseIntentKeyValues(request.intent, rule.rule);
  let keyValue: SqliteParameter | undefined;
  if (contextKey.present) {
    const normalized = normalizeParameter(contextKey.value, false);
    if (!normalized.ok) return null;
    keyValue = normalized.value;
    if (intentKeys.length > 0 && !intentKeys.every((value) => exactSqliteValue(value, keyValue))) return null;
  } else {
    if (intentKeys.length !== 1) return null;
    keyValue = intentKeys[0];
  }
  if (keyValue === null || keyValue === undefined) return null;

  const contextUpdates = oneContextField(request.context, ["updates", "changes", "values"]);
  const updates = contextUpdates.present
    ? normalizeContextUpdates(contextUpdates.value, rule.rule)
    : parseIntentUpdates(request.intent, rule.rule);
  if (!updates || Object.keys(updates).length === 0) return null;

  return { rule, keyValue, updates };
}

function resolveIntentRule(
  intent: string,
  context: Record<string, unknown>,
  rules: ValidatedRule[]
): ValidatedRule | null {
  const contextTable = oneContextField(context, ["table", "tableAlias", "targetTable"]);
  const intentMatches = rules.filter((candidate) =>
    ruleTokens(candidate.rule).some((token) => containsExactToken(intent, token))
  );

  if (contextTable.present) {
    if (typeof contextTable.value !== "string" || contextTable.value.trim() !== contextTable.value) return null;
    const contextMatches = rules.filter((candidate) =>
      ruleTokens(candidate.rule).some((token) => token.localeCompare(contextTable.value as string, undefined, { sensitivity: "accent" }) === 0)
    );
    if (contextMatches.length !== 1) return null;
    const selected = contextMatches[0] as ValidatedRule;
    if (intentMatches.some((candidate) => candidate !== selected)) return null;
    return selected;
  }

  const uniqueRules = [...new Set(intentMatches)];
  return uniqueRules.length === 1 ? (uniqueRules[0] as ValidatedRule) : null;
}

function ruleTokens(rule: SqliteWriteRule): string[] {
  return [...new Set([rule.table, ...rule.aliases])];
}

function oneContextField(context: Record<string, unknown>, names: string[]): ContextField {
  const present = names.filter((name) => Object.hasOwn(context, name));
  if (present.length === 0) return { present: false };
  if (present.length > 1) return { present: true, value: Symbol("ambiguous") };
  return { present: true, value: context[present[0] as string] };
}

function normalizeContextUpdates(value: unknown, rule: SqliteWriteRule): Record<string, SqliteParameter> | null {
  if (!isPlainRecord(value)) return null;
  const columns = Object.keys(value);
  if (columns.length === 0 || columns.length > rule.allowedColumns.length) return null;
  const allowed = new Set(rule.allowedColumns);
  const updates: Record<string, SqliteParameter> = Object.create(null) as Record<string, SqliteParameter>;
  for (const column of columns) {
    if (!allowed.has(column)) return null;
    const normalized = normalizeParameter(value[column], true);
    if (!normalized.ok) return null;
    updates[column] = normalized.value as SqliteParameter;
  }
  return updates;
}

function parseIntentUpdates(intent: string, rule: SqliteWriteRule): Record<string, SqliteParameter> | null {
  const setMatch = /\bset\b/i.exec(intent);
  if (!setMatch) return null;
  let body = intent.slice(setMatch.index + setMatch[0].length).trim();
  const trailingWhere = new RegExp(
    `\\s+where\\s+${escapeRegularExpression(rule.keyColumn)}\\s*(?:=|:|is\\b)`,
    "i"
  ).exec(body);
  if (trailingWhere) body = body.slice(0, trailingWhere.index).trim();
  body = body.replace(/[.]\s*$/, "").trim();
  if (!body) return null;

  const columns = [...rule.allowedColumns].sort((left, right) => right.length - left.length);
  const firstColumnOffset = columns
    .map((column) => findConfiguredToken(body, column))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (firstColumnOffset === undefined) return null;
  body = body.slice(firstColumnOffset);
  const updates: Record<string, SqliteParameter> = Object.create(null) as Record<string, SqliteParameter>;
  let cursor = 0;
  let first = true;

  while (cursor < body.length) {
    cursor = skipWhitespace(body, cursor);
    if (!first) {
      if (body[cursor] === "," || body[cursor] === ";") {
        cursor = skipWhitespace(body, cursor + 1);
      } else {
        const conjunction = /^and\b/i.exec(body.slice(cursor));
        if (!conjunction) return null;
        cursor = skipWhitespace(body, cursor + conjunction[0].length);
      }
    }

    const column = columns.find((candidate) => configuredTokenAt(body, cursor, candidate));
    if (!column || Object.hasOwn(updates, column)) return null;
    cursor = skipWhitespace(body, cursor + column.length);

    if (body[cursor] === "=") {
      cursor += 1;
    } else {
      const operator = /^(?:to|as)\b/i.exec(body.slice(cursor));
      if (!operator) return null;
      cursor += operator[0].length;
    }
    cursor = skipWhitespace(body, cursor);
    const token = readAssignmentValue(body, cursor);
    if (!token) return null;
    const parsed = parseLiteral(token.text);
    if (!parsed.ok) return null;
    updates[column] = parsed.value as SqliteParameter;
    cursor = token.end;
    first = false;
  }

  return updates;
}

function readAssignmentValue(input: string, start: number): { text: string; end: number } | null {
  if (start >= input.length) return null;
  const quote = input[start];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = start + 1; index < input.length; index += 1) {
      const character = input[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        return { text: input.slice(start, index + 1), end: index + 1 };
      }
    }
    return null;
  }

  const remainder = input.slice(start);
  const separator = /\s+and\s+|[,;]/i.exec(remainder);
  const end = separator ? start + separator.index : input.length;
  const text = input.slice(start, end).trim();
  return text ? { text, end } : null;
}

function parseIntentKeyValues(intent: string, rule: SqliteWriteRule): SqliteParameter[] {
  const escapedColumn = escapeRegularExpression(rule.keyColumn);
  const tableTokens = ruleTokens(rule)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegularExpression)
    .join("|");
  const literal = `("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;:.=]+)`;
  const patterns = [
    new RegExp(`(?:^|[^A-Za-z0-9_])${escapedColumn}\\s*(?:=|:|is\\b)\\s*${literal}`, "gi"),
    new RegExp(`\\b(?:where|with)\\s+(?:the\\s+)?${escapedColumn}\\s+${literal}`, "gi"),
    new RegExp(
      `(?:^|[^A-Za-z0-9_])(?:${tableTokens})\\s+(?:record\\s+)?(?:with\\s+)?${escapedColumn}\\s+(?:(?:is|=|:)\\s*)?${literal}`,
      "gi"
    ),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:${tableTokens})\\s+record\\s+${literal}`, "gi"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:${tableTokens})\\s+${literal}`, "gi")
  ];
  const values: SqliteParameter[] = [];
  for (const pattern of patterns) {
    for (const match of intent.matchAll(pattern)) {
      const parsed = parseLiteral(match[1] ?? "");
      if (
        parsed.ok &&
        parsed.value !== null &&
        parsed.value !== undefined &&
        !(typeof parsed.value === "string" && /^(?:with|where|record|id|key|set)$/i.test(parsed.value))
      ) {
        values.push(parsed.value);
      }
    }
  }
  const unique = new Map(values.map((value) => [canonicalValue(value), value]));
  return [...unique.values()];
}

function parseLiteral(raw: string): ParsedLiteral {
  const value = raw.trim();
  if (!value) return { ok: false };
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return normalizeParameter(decodeQuoted(value), true);
  }
  if (/^null$/i.test(value)) return { ok: true, value: null };
  if (/^true$/i.test(value)) return { ok: true, value: 1 };
  if (/^false$/i.test(value)) return { ok: true, value: 0 };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    return normalizeParameter(number, true);
  }
  return normalizeParameter(value, true);
}

function decodeQuoted(value: string): string {
  const quote = value[0];
  const body = value.slice(1, -1);
  let decoded = "";
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      decoded += character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else {
      decoded += character;
    }
  }
  if (escaped) decoded += "\\";
  return quote ? decoded : value;
}

function normalizeParameter(value: unknown, allowNull: boolean): ParsedLiteral {
  if (value === null) return allowNull ? { ok: true, value: null } : { ok: false };
  if (typeof value === "boolean") return { ok: true, value: value ? 1 : 0 };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return { ok: false };
    return { ok: true, value };
  }
  if (typeof value === "string" && value.length <= MAX_PARAMETER_TEXT_LENGTH) return { ok: true, value };
  return { ok: false };
}

function validateCandidate(
  connection: SourceConnection,
  config: SqliteConfig,
  candidate: ConnectorActionCandidate,
  schemas: TableSchema[],
  requireWritable: boolean
): CandidateOperation {
  if (candidate.connectionId !== connection.id) throw new Error("SQLite action connection does not match the candidate.");
  if (candidate.capability !== CAPABILITY || candidate.technicalOperation !== TECHNICAL_OPERATION) {
    throw new Error("SQLite action capability or technical operation is not supported.");
  }
  if (requireWritable && config.writeMode === "read_only") throw new Error("SQLite connection is read-only.");

  const table = candidate.parameters.table;
  const keyColumn = candidate.parameters.keyColumn;
  if (typeof table !== "string" || typeof keyColumn !== "string") {
    throw new Error("SQLite action is missing its canonical table or key column.");
  }
  const validation = validateWriteRules(config, schemas);
  const matches = validation.valid.filter((entry) => entry.rule.table === table);
  if (matches.length !== 1) throw new Error(`SQLite table ${table} is not exposed by exactly one valid write rule.`);
  const rule = matches[0] as ValidatedRule;
  if (keyColumn !== rule.rule.keyColumn || candidate.objectType !== rule.schema.name) {
    throw new Error("SQLite action target does not match the configured write rule.");
  }
  if (candidate.risk !== rule.rule.risk) throw new Error("SQLite action risk does not match the configured write rule.");

  const normalizedKey = normalizeParameter(candidate.parameters.keyValue, false);
  if (!normalizedKey.ok || normalizedKey.value === null || normalizedKey.value === undefined) {
    throw new Error("SQLite action key value is invalid.");
  }
  if (candidate.objectKey !== `${rule.schema.name}:${displayKey(normalizedKey.value)}`) {
    throw new Error("SQLite action object key does not match its parameterized record key.");
  }
  const updates = normalizeContextUpdates(candidate.parameters.updates, rule.rule);
  if (!updates) throw new Error("SQLite action contains an unauthorized or invalid column update.");
  if (Object.hasOwn(updates, rule.rule.keyColumn)) {
    throw new Error("SQLite action cannot change the record key column.");
  }
  for (const [column, value] of Object.entries(updates)) {
    if (!Object.hasOwn(candidate.after, column) || !exactSqliteValue(candidate.after[column], value)) {
      throw new Error(`SQLite action after-state does not match parameterized value for ${column}.`);
    }
  }
  validateCandidateDiff(candidate, updates);

  const precondition = candidate.parameters.precondition;
  if (!isPlainRecord(precondition) || precondition.kind !== "source_row_hash") {
    throw new Error("SQLite action is missing its source-row hash precondition.");
  }
  const sourceVersion = precondition.sourceVersion;
  if (typeof sourceVersion !== "string" || !SOURCE_VERSION_PATTERN.test(sourceVersion)) {
    throw new Error("SQLite action source-row version is invalid.");
  }
  if (candidate.parameters.expectedSourceVersion !== sourceVersion) {
    throw new Error("SQLite action source-row precondition representations do not match.");
  }
  const requestMode = candidate.parameters.requestMode;
  if (requestMode !== "autonomous" && requestMode !== "approval_required" && requestMode !== "dry_run") {
    throw new Error("SQLite action request mode is invalid.");
  }
  if (requireWritable && requestMode === "dry_run") throw new Error("Dry-run SQLite actions cannot be executed.");
  if (typeof candidate.parameters.noOp !== "boolean") throw new Error("SQLite action no-op state is invalid.");

  return {
    rule,
    keyValue: normalizedKey.value,
    updates,
    sourceVersion,
    requestMode,
    noOp: candidate.parameters.noOp
  };
}

function selectRowsByKey(
  db: Database.Database,
  schema: TableSchema,
  keyColumn: string,
  keyValue: Exclude<SqliteParameter, null>
): DatabaseRow[] {
  if (!schema.columns.some((column) => column.name === keyColumn)) {
    throw new Error(`SQLite key column is not present in the inspected schema: ${schema.name}.${keyColumn}.`);
  }
  const statement = db.prepare(
    `SELECT * FROM ${quoteIdentifier(schema.name)} WHERE ${quoteIdentifier(keyColumn)} = ? LIMIT 2`
  );
  statement.safeIntegers(true);
  return statement.all(keyValue) as DatabaseRow[];
}

function inferColumnSensitivity(name: string): SourceResource["sensitivity"] {
  const tokens = splitIdentifier(name);
  const normalized = tokens.join("");
  const restrictedTokens = new Set(["password", "passwd", "pwd", "secret", "token", "credential", "credentials", "cvv"]);
  if (
    tokens.some((token) => restrictedTokens.has(token)) ||
    [
      "apikey",
      "accesskey",
      "privatekey",
      "encryptionkey",
      "socialsecuritynumber",
      "ssn",
      "cardnumber",
      "creditcardnumber",
      "cardpin"
    ].includes(normalized)
  ) {
    return "restricted";
  }

  const confidentialTokens = new Set(["email", "phone", "mobile", "address", "birthdate", "dob", "iban"]);
  if (
    tokens.some((token) => confidentialTokens.has(token)) ||
    [
      "firstname",
      "lastname",
      "fullname",
      "customerid",
      "userid",
      "nationalid",
      "taxid",
      "accountnumber",
      "ipaddress",
      "dateofbirth"
    ].includes(normalized)
  ) {
    return "confidential";
  }
  return "internal";
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function highestSensitivity(values: SourceResource["sensitivity"][]): SourceResource["sensitivity"] {
  return values.reduce<SourceResource["sensitivity"]>(
    (highest, value) => sensitivityRank[value] > sensitivityRank[highest] ? value : highest,
    "internal"
  );
}

function riskRank(risk: "low" | "medium" | "high"): number {
  return risk === "low" ? 0 : risk === "medium" ? 1 : 2;
}

function rowVersion(row: DatabaseRow): string {
  return sha256(canonicalValue(row));
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "boolean") return `boolean:${value ? "true" : "false"}`;
  if (Buffer.isBuffer(value)) return `blob:${value.toString("base64")}`;
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("base64")}`;
  if (Array.isArray(value)) return `array:[${value.map(canonicalValue).join(",")}]`;
  if (isPlainRecord(value)) {
    return `object:{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  return `unsupported:${Object.prototype.toString.call(value)}`;
}

function portableRow(row: DatabaseRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, portableValue(value)]));
}

function projectActionRow(row: DatabaseRow, keyColumn: string, updateColumns: string[]): Record<string, unknown> {
  const allowedColumns = new Set([keyColumn, ...updateColumns]);
  return portableRow(Object.fromEntries(Object.entries(row).filter(([column]) => allowedColumns.has(column))));
}

function profileSampleRow(table: TableSchema, row: DatabaseRow): Record<string, unknown> {
  return Object.fromEntries(
    table.columns.map((column) => [column.name, profileSampleValue(column.name, row[column.name])])
  );
}

function profileSampleValue(columnName: string, value: unknown): unknown {
  const sensitivity = inferColumnSensitivity(columnName);
  return sensitivity === "confidential" || sensitivity === "restricted" ? "[redacted]" : portableValue(value);
}

function portableValue(value: unknown): unknown {
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    return { type: "blob", encoding: "base64", byteLength: buffer.byteLength, value: buffer.toString("base64") };
  }
  return value;
}

function portableForeignKey(foreignKey: ForeignKeyRow): Record<string, unknown> {
  return {
    id: foreignKey.id,
    sequence: foreignKey.seq,
    fromColumn: foreignKey.from,
    targetTable: foreignKey.table,
    targetColumn: foreignKey.to,
    onUpdate: foreignKey.on_update,
    onDelete: foreignKey.on_delete,
    match: foreignKey.match
  };
}

function exactSqliteValue(actual: unknown, expected: unknown): boolean {
  if (Buffer.isBuffer(actual) && Buffer.isBuffer(expected)) return actual.equals(expected);
  if (typeof actual === "bigint" && typeof expected === "number" && Number.isSafeInteger(expected)) {
    return actual === BigInt(expected);
  }
  if (typeof expected === "bigint" && typeof actual === "number" && Number.isSafeInteger(actual)) {
    return expected === BigInt(actual);
  }
  return Object.is(actual, expected);
}

function validateCandidateDiff(
  candidate: ConnectorActionCandidate,
  updates: Record<string, SqliteParameter>
): void {
  if (!candidate.before) throw new Error("SQLite update candidates require a complete before-state.");
  const beforeKeys = new Set(Object.keys(candidate.before));
  const afterKeys = new Set(Object.keys(candidate.after));
  for (const column of new Set([...beforeKeys, ...afterKeys])) {
    if (Object.hasOwn(updates, column)) continue;
    if (
      !Object.hasOwn(candidate.before, column) ||
      !Object.hasOwn(candidate.after, column) ||
      canonicalValue(candidate.before[column]) !== canonicalValue(candidate.after[column])
    ) {
      throw new Error(`SQLite action diff changes unauthorized column ${column}.`);
    }
  }
}

function findSchemaTable<T extends TableSchema>(schemas: Map<string, T>, name: string): T | null {
  const exact = schemas.get(name);
  if (exact) return exact;
  const matches = [...schemas.values()].filter((schema) => schema.name.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? (matches[0] as T) : null;
}

function resolveForeignKeyTargetColumn(table: TableSchema, foreignKey: ForeignKeyRow): TableInfoRow | null {
  if (foreignKey.to) return table.columns.find((column) => column.name === foreignKey.to) ?? null;
  const primaryKey = table.columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk);
  return primaryKey[foreignKey.seq] ?? null;
}

function schemaEvidence(connection: SourceConnection, table: ProfiledTable): string {
  const columns = table.columns.map((column) => {
    const flags = [
      column.pk > 0 ? `primary key position ${column.pk}` : null,
      column.notnull > 0 ? "not null" : "nullable",
      column.dflt_value !== null ? `default ${column.dflt_value}` : null
    ].filter(Boolean);
    return `- ${column.name}: ${column.type || "untyped"}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`;
  });
  const foreignKeys = table.foreignKeys.map(
    (foreignKey) => `- ${foreignKey.from} REFERENCES ${foreignKey.table}.${foreignKey.to ?? "primary key"}`
  );
  return [
    `Authoritative SQLite schema for ${connection.name}.${table.name}.`,
    `Observed row count: ${table.rowCount}.`,
    "Columns:",
    ...columns,
    ...(foreignKeys.length > 0 ? ["Foreign keys:", ...foreignKeys] : [])
  ].join("\n");
}

function columnDescription(table: string, column: TableInfoRow): string {
  const constraints = [
    column.pk > 0 ? `primary key position ${column.pk}` : null,
    column.notnull > 0 ? "not null" : "nullable"
  ].filter(Boolean);
  return `SQLite column ${table}.${column.name}${column.type ? ` declared as ${column.type}` : ""}${constraints.length > 0 ? ` (${constraints.join(", ")})` : ""}.`;
}

function quoteIdentifier(identifier: string): string {
  if (identifier.includes("\0")) throw new Error("SQLite identifier contains a NUL byte.");
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readPragmaValue(db: Database.Database, pragma: string): string {
  const row = db.prepare(pragma).get() as Record<string, unknown> | undefined;
  if (!row) throw new Error(`SQLite pragma returned no result: ${pragma}`);
  const value = Object.values(row)[0];
  return String(value);
}

function resourceId(connectionId: string, externalId: string): string {
  return stableId("resource", `${connectionId}:${externalId}`);
}

function assetId(connectionId: string, externalId: string): string {
  return stableId("asset", `${connectionId}:${externalId}`);
}

function tableExternalIdFor(table: string): string {
  return `table:${table}`;
}

function columnExternalIdFor(table: string, column: string): string {
  return `column:${table}.${column}`;
}

function resourceUri(databaseUri: string, parts: Record<string, string>): string {
  return `${databaseUri}#${Object.entries(parts).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}

function containsExactToken(input: string, token: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegularExpression(token)}(?=$|[^A-Za-z0-9_])`, "i");
  return pattern.test(input);
}

function findConfiguredToken(input: string, token: string): number {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegularExpression(token)})(?=$|[^A-Za-z0-9_])`, "i");
  const match = pattern.exec(input);
  return match ? match.index + (match[1]?.length ?? 0) : -1;
}

function configuredTokenAt(input: string, offset: number, token: string): boolean {
  if (input.slice(offset, offset + token.length).toLowerCase() !== token.toLowerCase()) return false;
  const next = input[offset + token.length];
  return next === undefined || /\s|=/.test(next);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skipWhitespace(input: string, cursor: number): number {
  let next = cursor;
  while (next < input.length && /\s/.test(input[next] as string)) next += 1;
  return next;
}

function displayKey(value: Exclude<SqliteParameter, null>): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
