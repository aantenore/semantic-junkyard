import type { SourceConnection, SourceResource } from "@semantic-junkyard/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ConnectorSnapshot, SourceConnector } from "./sources/connector.js";
import { openMemoryDatabase } from "./storage/database.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("application bootstrap", () => {
  it("recovers only incomplete reference connections after a partial bootstrap", async () => {
    const root = temporaryRoot();
    const calls = new Map<string, number>();
    let failGit = true;
    const connectors = [
      fakeConnector("filesystem", calls),
      fakeConnector("sqlite", calls),
      fakeConnector("git", calls, () => failGit)
    ];
    const db = openMemoryDatabase();
    try {
      const first = createApp(db, {
        seed: false,
        bootstrapReferenceSources: true,
        referenceSourcesRoot: root,
        connectors,
        semanticEnricher: null
      });
      const firstReport = await first.ready;
      expect(firstReport.status).toBe("partial");
      expect(firstReport.failures).toEqual([expect.objectContaining({ connectionName: "Semantic Contract Repository" })]);
      expect(first.engine.listSourceConnections().map((connection) => connection.status).sort()).toEqual(["error", "ready", "ready"]);
      expect(first.repository.listDiscoveryRuns()[0]?.objective).toContain("synchronized reference sources");
      expect((await request(first.app).get("/api/ready")).status).toBe(503);

      failGit = false;
      const restarted = createApp(db, {
        seed: false,
        bootstrapReferenceSources: true,
        referenceSourcesRoot: root,
        connectors,
        semanticEnricher: null
      });
      const restartedReport = await restarted.ready;
      expect(restartedReport.status).toBe("completed");
      expect(restartedReport.syncedConnectionIds).toHaveLength(1);
      expect(restartedReport.skippedConnectionIds).toHaveLength(2);
      expect(restarted.engine.listSourceConnections().every((connection) => connection.status === "ready")).toBe(true);
      expect(calls).toEqual(new Map([["filesystem", 1], ["sqlite", 1], ["git", 2]]));
      expect((await request(restarted.app).get("/api/ready")).status).toBe(200);
    } finally {
      db.close();
    }
  });

  it("honors an injected connector registry and a disabled semantic enricher", async () => {
    const calls = new Map<string, number>();
    const connector = fakeConnector("filesystem", calls, undefined, true);
    const db = openMemoryDatabase();
    try {
      const { engine } = createApp(db, {
        seed: false,
        bootstrapReferenceSources: false,
        connectors: [connector],
        semanticEnricher: null
      });
      expect(() => engine.createSourceConnection({
        name: "Unavailable SQLite",
        description: "Must be rejected by the injected registry.",
        config: { kind: "sqlite", databasePath: "/tmp/unavailable.sqlite", includeTables: [], sampleRows: 0, writeMode: "read_only", writeRules: [] }
      })).toThrow(/No connector is configured/);

      const connection = engine.createSourceConnection({
        name: "Injected files",
        description: "Fake connector with evidence.",
        config: { kind: "filesystem", rootPath: "/virtual/files", recursive: true, maxFiles: 10, maxFileBytes: 10_000, ingestionMode: "full_data" }
      });
      const run = await engine.syncSourceConnection(connection.id, { objective: "Discover evidence.", provider: "local-huggingface" });
      expect(run.status).toBe("completed");
      expect(run.events).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Local model unavailable", severity: "warning" })]));
    } finally {
      db.close();
    }
  });
});

function fakeConnector(
  kind: SourceConnector["kind"],
  calls: Map<string, number>,
  shouldFail: (() => boolean) | undefined = undefined,
  withDocument = false
): SourceConnector {
  return {
    kind,
    test: () => ({ ok: true, message: `${kind} available`, details: {} }),
    discover(connection) {
      calls.set(kind, (calls.get(kind) ?? 0) + 1);
      if (shouldFail?.()) throw new Error(`${kind} discovery failed`);
      return snapshot(connection, withDocument);
    }
  };
}

function snapshot(connection: SourceConnection, withDocument: boolean): ConnectorSnapshot {
  const resource: SourceResource = {
    id: `resource.${connection.id}`,
    connectionId: connection.id,
    externalId: "fixture",
    parentId: null,
    kind: connection.kind === "sqlite" ? "database" : connection.kind === "git" ? "semantic_contract" : "file",
    name: "fixture",
    qualifiedName: `${connection.name}.fixture`,
    dataType: "text/plain",
    description: "Injected connector fixture",
    uri: "semantic-junkyard://fixture",
    sensitivity: "internal",
    writable: false,
    profile: {},
    evidenceChunkIds: [],
    metadata: {},
    observedAt: "2026-07-10T00:00:00.000Z"
  };
  return {
    resources: [resource],
    documents: withDocument ? [{
      resourceExternalId: resource.externalId,
      request: { name: "fixture.txt", text: "Dispatch evidence fixture.", mimeType: "text/plain", ingestionMode: "full_data", metadata: {} }
    }] : [],
    assets: [],
    metrics: [],
    lineage: [],
    contracts: [],
    ontologyClasses: [],
    relations: [],
    warnings: [],
    checkpoint: {}
  };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-bootstrap-"));
  temporaryRoots.push(root);
  return root;
}
