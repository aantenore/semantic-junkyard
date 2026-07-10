import type { BusinessActionRequest, SourceConnection, SourceResource } from "@semantic-junkyard/shared";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectorActionCandidate } from "./connector.js";
import { SqliteConnector } from "./sqliteConnector.js";

type SqliteConfig = Extract<SourceConnection["config"], { kind: "sqlite" }>;

describe("SqliteConnector", () => {
  const connector = new SqliteConnector();
  let temporaryDirectory: string;
  let databasePath: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-sqlite-"));
    databasePath = path.join(temporaryDirectory, "source.sqlite");
    const db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE teams (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        email TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        secret_token TEXT
      );

      CREATE TABLE excluded_audit (
        id INTEGER PRIMARY KEY,
        event TEXT NOT NULL
      );

      INSERT INTO teams (id, name) VALUES (10, 'Platform');
      INSERT INTO users (id, team_id, email, status, note, secret_token)
      VALUES (1, 10, 'antonio@example.com', 'pending', 'initial', 'do-not-expose');
      INSERT INTO excluded_audit (id, event) VALUES (1, 'created');
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("validates and discovers a real SQLite database read-only", () => {
    const connection = sqliteConnection();
    const modifiedBeforeTest = fs.statSync(databasePath).mtimeMs;
    const tested = connector.test(connection);

    expect(tested.ok).toBe(true);
    expect(tested.details).toMatchObject({
      tableCount: 3,
      selectedTableCount: 2,
      selectedTables: ["teams", "users"],
      accessMode: "read_only",
      validatedWriteRules: 1
    });
    expect(fs.statSync(databasePath).mtimeMs).toBe(modifiedBeforeTest);

    const snapshot = connector.discover(connection);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.resources.filter((resource) => resource.kind === "database")).toHaveLength(1);
    expect(snapshot.resources.filter((resource) => resource.kind === "table").map((resource) => resource.name)).toEqual([
      "teams",
      "users"
    ]);
    expect(snapshot.resources.some((resource) => resource.name === "excluded_audit")).toBe(false);
    expect(snapshot.documents).toHaveLength(2);

    const users = resource(snapshot.resources, "table:users");
    expect(users.profile).toMatchObject({ rowCount: 1, columnCount: 6 });
    expect(users.profile.sampleRows).toEqual([
      expect.objectContaining({ id: 1, status: "pending", email: "[redacted]", secret_token: "[redacted]" })
    ]);
    expect(users.writable).toBe(true);
    expect(resource(snapshot.resources, "table:teams").writable).toBe(false);
    expect(resource(snapshot.resources, "column:users.status").writable).toBe(true);
    expect(resource(snapshot.resources, "column:users.email").writable).toBe(false);
    expect(resource(snapshot.resources, "column:users.email").sensitivity).toBe("confidential");
    expect(resource(snapshot.resources, "column:users.secret_token").sensitivity).toBe("restricted");

    expect(snapshot.assets.filter((asset) => asset.kind === "table")).toHaveLength(2);
    expect(snapshot.assets.filter((asset) => asset.kind === "column")).toHaveLength(8);
    expect(snapshot.relations).toContainEqual(
      expect.objectContaining({
        subjectExternalId: "table:users",
        predicate: "HAS_COLUMN",
        objectExternalId: "column:users.status",
        authoritative: true
      })
    );
    expect(snapshot.relations).toContainEqual(
      expect.objectContaining({
        subjectExternalId: "column:users.team_id",
        predicate: "REFERENCES",
        objectExternalId: "column:teams.id",
        authoritative: true
      })
    );
    expect(snapshot.lineage).toHaveLength(1);
    expect(snapshot.lineage[0]).toMatchObject({
      type: "READS",
      confidence: 1,
      metadata: { relationship: "foreign_key" }
    });
    expect(snapshot.checkpoint).toMatchObject({
      selectedTables: ["teams", "users"],
      rowCounts: { teams: 1, users: 1 }
    });
  });

  it("plans a bounded natural-language update and verifies an independent readback", () => {
    const connection = sqliteConnection();
    const discovered = connector.discover(connection);
    const resourcesWithEvidence = discovered.resources.map((resource) =>
      resource.externalId === "table:users" ? { ...resource, evidenceChunkIds: ["chunk-users-schema"] } : resource
    );
    const candidate = requireCandidate(
      connector.planAction(
        connection,
        actionRequest('Update customer with id = 1 set status to "active" and note to "verified"'),
        resourcesWithEvidence
      )
    );

    expect(candidate.capability).toBe("record.update");
    expect(candidate.technicalOperation).toBe("sqlite.record.update");
    expect(candidate.before).toMatchObject({ status: "pending", note: "initial" });
    expect(candidate.after).toMatchObject({ status: "active", note: "verified" });
    expect(candidate.before).not.toHaveProperty("email");
    expect(candidate.before).not.toHaveProperty("secret_token");
    expect(candidate.evidenceChunkIds).toEqual(["chunk-users-schema"]);
    expect(candidate.parameters).not.toHaveProperty("sql");
    expect(candidate.parameters.precondition).toEqual({
      kind: "source_row_hash",
      sourceVersion: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const result = connector.executeAction(connection, candidate);
    expect(result.postconditionPassed).toBe(true);
    expect(result.before).toMatchObject({ status: "pending", note: "initial" });
    expect(result.after).toMatchObject({ status: "active", note: "verified" });
    expect(result.readback).toMatchObject({ status: "active", note: "verified" });
    expect(result.readback).not.toHaveProperty("email");
    expect(result.readback).not.toHaveProperty("secret_token");
    expect(result.metadata).toMatchObject({
      rowsChanged: 1,
      transactionMode: "immediate",
      readbackConnection: "independent_read_only",
      verifiedColumns: ["status", "note"]
    });

    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT status, note FROM users WHERE id = ?").get(1);
    db.close();
    expect(row).toEqual({ status: "active", note: "verified" });
  });

  it("verifies an already-satisfied request without issuing a redundant update", () => {
    const connection = sqliteConnection();
    const candidate = requireCandidate(
      connector.planAction(
        connection,
        actionRequest('Set customer with id = 1 status to "pending"'),
        connector.discover(connection).resources
      )
    );

    expect(candidate.parameters.noOp).toBe(true);
    expect(candidate.before).toMatchObject({ status: "pending" });
    expect(candidate.after).toMatchObject({ status: "pending" });
    expect(candidate.rationale).toContain("already satisfies");

    const result = connector.executeAction(connection, candidate);
    expect(result.postconditionPassed).toBe(true);
    expect(result.readback).toMatchObject({ status: "pending" });
    expect(result.metadata).toMatchObject({ rowsChanged: 0, noOp: true, sourceMutation: false });
  });

  it("rejects unauthorized columns during planning and again at execution", () => {
    const connection = sqliteConnection();
    const resources = connector.discover(connection).resources;
    expect(
      connector.planAction(
        connection,
        actionRequest('Update customer with id = 1 set email to "attacker@example.com"'),
        resources
      )
    ).toBeNull();

    const candidate = requireCandidate(
      connector.planAction(
        connection,
        actionRequest('Update customer with id = 1 set status to "active"'),
        resources
      )
    );
    const tampered: ConnectorActionCandidate = {
      ...candidate,
      after: { ...candidate.after, email: "attacker@example.com" },
      parameters: { ...candidate.parameters, updates: { email: "attacker@example.com" } }
    };
    expect(() => connector.executeAction(connection, tampered)).toThrow(/unauthorized|not exposed|write rule/i);

    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT email, status FROM users WHERE id = ?").get(1);
    db.close();
    expect(row).toEqual({ email: "antonio@example.com", status: "pending" });
  });

  it("rejects a stale source-row hash precondition without applying the planned write", () => {
    const connection = sqliteConnection();
    const candidate = requireCandidate(
      connector.planAction(
        connection,
        actionRequest('Update customer with id = 1 set status to "active"'),
        connector.discover(connection).resources
      )
    );

    const concurrent = new Database(databasePath);
    concurrent.prepare("UPDATE users SET note = ? WHERE id = ?").run("changed elsewhere", 1);
    concurrent.close();

    expect(() => connector.executeAction(connection, candidate)).toThrow(/precondition|stale/i);

    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT status, note FROM users WHERE id = ?").get(1);
    db.close();
    expect(row).toEqual({ status: "pending", note: "changed elsewhere" });
  });

  function sqliteConnection(overrides: Partial<SqliteConfig> = {}): SourceConnection {
    const config: SqliteConfig = {
      kind: "sqlite",
      databasePath,
      includeTables: ["teams", "users"],
      sampleRows: 1,
      writeMode: "autonomous",
      writeRules: [
        {
          table: "users",
          aliases: ["customer", "customers"],
          keyColumn: "id",
          allowedColumns: ["status", "note"],
          risk: "medium"
        }
      ],
      ...overrides
    };
    return {
      id: "connection-sqlite-test",
      name: "Customer operations",
      description: "Temporary SQLite source",
      kind: "sqlite",
      config,
      status: "ready",
      lastTestedAt: null,
      lastSyncAt: null,
      lastError: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    };
  }
});

function actionRequest(intent: string): BusinessActionRequest {
  return {
    intent,
    mode: "autonomous",
    maxAutonomousRisk: "medium",
    context: {}
  };
}

function resource(resources: SourceResource[], externalId: string): SourceResource {
  const result = resources.find((candidate) => candidate.externalId === externalId);
  if (!result) throw new Error(`Missing test resource ${externalId}.`);
  return result;
}

function requireCandidate(candidate: ConnectorActionCandidate | null): ConnectorActionCandidate {
  if (!candidate) throw new Error("Expected SQLite action candidate.");
  return candidate;
}
