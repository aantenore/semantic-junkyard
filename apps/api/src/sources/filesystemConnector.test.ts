import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SourceConnection, SourceResource } from "@semantic-junkyard/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemConnector } from "./filesystemConnector.js";

describe("FilesystemConnector", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("tests and recursively indexes supported files without exposing write capabilities", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "notes.txt"), "Filesystem source text", "utf8");
    fs.writeFileSync(path.join(root, "nested", "guide.md"), "# Nested guide\nUseful details.", "utf8");
    fs.writeFileSync(path.join(root, "nested", "page.html"), "<h1>Indexed HTML</h1>", "utf8");
    fs.writeFileSync(path.join(root, "ignored.bin"), Buffer.from([0, 1, 2]));
    const connector = new FilesystemConnector();
    const connection = makeConnection(root);

    const tested = connector.test(connection);
    const snapshot = connector.discover(connection);

    expect(tested).toMatchObject({ ok: true, details: { recursive: true, supportedFiles: 3 } });
    expect(snapshot.documents).toHaveLength(3);
    expect(snapshot.documents.find((document) => document.request.name === "guide.md")?.request.text).toContain("Nested guide");
    expect(snapshot.resources.filter((resource) => resource.kind === "file")).toHaveLength(3);
    expect(snapshot.resources.filter((resource) => resource.kind === "document")).toHaveLength(3);
    expect(snapshot.resources.every((resource) => resource.writable === false)).toBe(true);
    expect(snapshot.relations.every((relation) => relation.authoritative === false)).toBe(true);
    expect(snapshot.resources.some((resource) => resource.name === "ignored.bin")).toBe(false);
    expect("executeAction" in connector).toBe(false);
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("Filesystem source text");
  });

  it("keeps raw content out of metadata-only and external-reference ingest requests", () => {
    const root = makeTempDir();
    const sentinel = "RAW_CONTENT_MUST_NOT_BE_COPIED";
    fs.writeFileSync(path.join(root, "private.md"), sentinel, "utf8");
    const connector = new FilesystemConnector();

    for (const ingestionMode of ["metadata_only", "external_reference"] as const) {
      const snapshot = connector.discover(makeConnection(root, { ingestionMode }));
      expect(snapshot.documents).toHaveLength(1);
      expect(snapshot.documents[0]?.request).toMatchObject({ ingestionMode, text: "" });
      expect(JSON.stringify(snapshot.documents[0]?.request.metadata)).not.toContain(sentinel);
    }
  });

  it("profiles JSON, JSONL, and CSV schemas deterministically", () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, "records.json"),
      JSON.stringify([{ beta: "first", alpha: 1 }, { alpha: 2.5, enabled: true }]),
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "events.jsonl"),
      '{"id":1,"tag":null}\n{"id":2,"tag":"ready"}\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "orders.csv"),
      'id,active,amount,note\n1,true,10.5,"hello, world"\n2,false,,plain\n',
      "utf8"
    );
    const connector = new FilesystemConnector();
    const connection = makeConnection(root);

    const first = connector.discover(connection);
    const second = connector.discover(connection);
    const json = dataset(first.resources, "dataset:records.json");
    const jsonl = dataset(first.resources, "dataset:events.jsonl");
    const csv = dataset(first.resources, "dataset:orders.csv");

    expect(json.profile).toMatchObject({ recordCount: 2, objectRecordCount: 2 });
    expect(schemaFields(json).map((field) => field.name)).toEqual(["alpha", "beta", "enabled"]);
    expect(schemaFields(json).find((field) => field.name === "alpha")).toMatchObject({
      type: "union<integer|number>",
      nullable: false
    });
    expect(schemaFields(json).find((field) => field.name === "beta")?.nullable).toBe(true);
    expect(schemaFields(jsonl).find((field) => field.name === "tag")).toMatchObject({
      type: "string",
      types: ["null", "string"],
      nullable: true
    });
    expect(csv.profile).toMatchObject({ recordCount: 2, columnCount: 4 });
    expect(schemaFields(csv)).toEqual([
      { name: "id", type: "integer", types: ["integer"], nullable: false, required: true },
      { name: "active", type: "boolean", types: ["boolean"], nullable: false, required: true },
      { name: "amount", type: "number", types: ["null", "number"], nullable: true, required: false },
      { name: "note", type: "string", types: ["string"], nullable: false, required: true }
    ]);
    expect(
      first.resources.filter((resource) => resource.kind === "dataset").map((resource) => resource.profile)
    ).toEqual(second.resources.filter((resource) => resource.kind === "dataset").map((resource) => resource.profile));
  });

  it("publishes declared semantic-contract and metric facts without inferring missing objects", () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, "revenue.semantic.yaml"),
      [
        "name: revenue_contract",
        "version: 1.2.0",
        "domain: finance",
        "status: active",
        "owner: finance-data",
        "description: Governed revenue definitions.",
        "metrics:",
        "  - name: net_revenue",
        "    label: Net revenue",
        "    description: Recognized revenue after refunds.",
        "    expression: sum(amount) - sum(refund_amount)",
        "    dimensions: [region, channel]",
        "    owner: revenue-team",
        "  - name: order_count",
        "    expression: count_distinct(order_id)"
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "almost.yaml"),
      "name: not_a_contract\nversion: 1\ndomain: finance\nstatus: active\n",
      "utf8"
    );
    const snapshot = new FilesystemConnector().discover(makeConnection(root));

    expect(snapshot.contracts).toHaveLength(1);
    expect(snapshot.contracts[0]).toMatchObject({
      name: "revenue_contract",
      version: "1.2.0",
      domain: "finance",
      status: "active"
    });
    expect(snapshot.metrics.map((metric) => metric.name)).toEqual(["net_revenue", "order_count"]);
    expect(snapshot.metrics.find((metric) => metric.name === "net_revenue")).toMatchObject({
      label: "Net revenue",
      expression: "sum(amount) - sum(refund_amount)",
      dimensions: ["region", "channel"],
      owner: "revenue-team",
      domain: "finance",
      contractVersion: "1.2.0"
    });
    expect(snapshot.metrics.find((metric) => metric.name === "order_count")).toMatchObject({
      label: "order_count",
      description: "",
      expression: "count_distinct(order_id)",
      owner: "finance-data"
    });
    expect(snapshot.resources.filter((resource) => resource.kind === "semantic_contract")).toHaveLength(1);
    expect(snapshot.resources.filter((resource) => resource.kind === "metric")).toHaveLength(2);
    expect(snapshot.resources.find((resource) => resource.externalId === "document:almost.yaml")).toBeDefined();
    expect(snapshot.relations.filter((relation) => relation.predicate === "DEFINES_METRIC"))
      .toHaveLength(2);
    expect(snapshot.relations.filter((relation) => relation.predicate === "DEFINES_METRIC").every((relation) => relation.authoritative))
      .toBe(true);
  });

  it("turns OpenLineage events into job and dataset assets with explicit lineage", () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, "lineage.json"),
      JSON.stringify({
        eventType: "COMPLETE",
        eventTime: "2026-01-01T00:00:00Z",
        run: { runId: "run-42" },
        job: {
          namespace: "analytics",
          name: "build_orders",
          facets: { ownership: { owners: [{ name: "data-platform", type: "TEAM" }] } }
        },
        inputs: [{ namespace: "warehouse", name: "raw_orders" }],
        outputs: [{
          namespace: "analytics",
          name: "orders_mart",
          facets: { documentation: { description: "Curated orders mart." } }
        }]
      }),
      "utf8"
    );
    const snapshot = new FilesystemConnector().discover(makeConnection(root));
    const pipeline = snapshot.assets.find((asset) => asset.kind === "pipeline");
    const input = snapshot.assets.find((asset) => asset.name === "raw_orders");
    const output = snapshot.assets.find((asset) => asset.name === "orders_mart");

    expect(snapshot.assets.filter((asset) => asset.kind === "dataset")).toHaveLength(2);
    expect(pipeline).toMatchObject({ name: "build_orders", domain: "analytics", owner: "data-platform" });
    expect(output?.description).toBe("Curated orders mart.");
    expect(snapshot.resources.filter((resource) => resource.kind === "job")).toHaveLength(1);
    expect(snapshot.resources.filter((resource) => resource.kind === "dataset")).toHaveLength(3);
    expect(snapshot.lineage).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromAssetId: pipeline?.id, toAssetId: input?.id, type: "READS", confidence: 1 }),
      expect.objectContaining({ fromAssetId: pipeline?.id, toAssetId: output?.id, type: "WRITES", confidence: 1 })
    ]));
  });

  it("skips symlinks and enforces file-count and byte limits", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    fs.writeFileSync(path.join(root, "a.txt"), "a", "utf8");
    fs.writeFileSync(path.join(root, "b.txt"), "this file is too large", "utf8");
    fs.writeFileSync(path.join(root, "c.txt"), "c", "utf8");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside", "utf8");
    fs.symlinkSync(path.join(outside, "outside.txt"), path.join(root, "linked.txt"));
    fs.symlinkSync(outside, path.join(root, "linked-directory"), "dir");
    const connector = new FilesystemConnector();
    const snapshot = connector.discover(makeConnection(root, { maxFiles: 1, maxFileBytes: 8 }));

    expect(snapshot.documents.map((document) => document.request.name)).toEqual(["a.txt"]);
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Skipped symbolic link: linked-directory"),
      expect.stringContaining("Skipped symbolic link: linked.txt"),
      expect.stringContaining("exceeds maxFileBytes (8)"),
      expect.stringContaining("maxFiles limit (1) reached")
    ]));
    expect(snapshot.resources.some((resource) => resource.name === "outside.txt")).toBe(false);

    const linkedRoot = path.join(path.dirname(root), `${path.basename(root)}-link`);
    fs.symlinkSync(root, linkedRoot, "dir");
    try {
      expect(connector.test(makeConnection(linkedRoot)).ok).toBe(false);
      expect(() => connector.discover(makeConnection(linkedRoot))).toThrow(/symbolic link/i);
    } finally {
      fs.rmSync(linkedRoot, { force: true });
    }
  });

  it("extracts text from a PDF through pdf-parse v2", () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, "semantic.pdf"), minimalPdf("Semantic PDF content"));

    const snapshot = new FilesystemConnector().discover(makeConnection(root));
    const document = snapshot.documents.find((item) => item.request.name === "semantic.pdf");
    const resource = snapshot.resources.find((item) => item.externalId === "document:semantic.pdf");

    expect(document?.request).toMatchObject({ mimeType: "application/pdf", ingestionMode: "full_data" });
    expect(document?.request.text).toContain("Semantic PDF content");
    expect(resource?.profile.pageCount).toBe(1);
  }, 20_000);

  function makeTempDir(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-filesystem-"));
    tempDirs.push(directory);
    return directory;
  }
});

function makeConnection(
  rootPath: string,
  overrides: Partial<Extract<SourceConnection["config"], { kind: "filesystem" }>> = {}
): SourceConnection {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: "connection-filesystem-test",
    name: "Test filesystem",
    description: "Filesystem connector test source.",
    kind: "filesystem",
    config: {
      kind: "filesystem",
      rootPath,
      recursive: true,
      maxFiles: 250,
      maxFileBytes: 2_000_000,
      ingestionMode: "full_data",
      ...overrides
    },
    status: "configured",
    lastTestedAt: null,
    lastSyncAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function dataset(resources: SourceResource[], externalId: string): SourceResource {
  const resource = resources.find((candidate) => candidate.externalId === externalId);
  if (!resource) throw new Error(`Missing dataset ${externalId}`);
  return resource;
}

function schemaFields(resource: SourceResource): Array<{
  name: string;
  type: string;
  types: string[];
  nullable: boolean;
  required: boolean;
}> {
  return (resource.profile.schema as { fields: ReturnType<typeof schemaFields> }).fields;
}

function minimalPdf(text: string): Buffer {
  const escapedText = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
