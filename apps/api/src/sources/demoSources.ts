import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";

export interface DemoSourcePaths {
  rootPath: string;
  operationsDatabasePath: string;
  knowledgePath: string;
  semanticRepositoryPath: string;
  semanticContractPath: string;
}

export function ensureSupplyChainDemoSources(rootPath: string): DemoSourcePaths {
  const resolvedRoot = path.resolve(rootPath);
  const knowledgePath = path.join(resolvedRoot, "knowledge");
  const semanticRepositoryPath = path.join(resolvedRoot, "semantic-contracts");
  const operationsDatabasePath = path.join(resolvedRoot, "operations.sqlite");
  const semanticContractPath = "contracts/late-dispatch-rate.yaml";
  fs.mkdirSync(knowledgePath, { recursive: true });
  fs.mkdirSync(path.join(semanticRepositoryPath, "contracts"), { recursive: true });

  ensureOperationsDatabase(operationsDatabasePath);
  writeIfMissing(
    path.join(knowledgePath, "dispatch-policy.md"),
    [
      "# Dispatch Performance Policy",
      "",
      "Late Dispatch Rate measures orders dispatched after their promised dispatch timestamp.",
      "Only dispatch-eligible orders belong in the denominator; cancelled and fraud-held orders are excluded.",
      "The Logistics Analytics owner reviews this policy monthly.",
      "Source evidence comes from the operations orders and shipments tables."
    ].join("\n")
  );
  writeIfMissing(
    path.join(knowledgePath, "carrier-sla.csv"),
    ["carrier,service_level,max_dispatch_hours", "Northstar Express,priority,4", "Atlas Freight,standard,12"].join("\n")
  );
  writeIfMissing(
    path.join(knowledgePath, "openlineage-event.json"),
    JSON.stringify(
      {
        eventType: "COMPLETE",
        eventTime: "2026-07-10T08:00:00.000Z",
        run: { runId: "demo-late-dispatch-refresh" },
        job: { namespace: "semantic-junkyard-demo", name: "build_late_dispatch_metric" },
        inputs: [{ namespace: "demo.operations", name: "orders" }, { namespace: "demo.operations", name: "shipments" }],
        outputs: [{ namespace: "demo.analytics", name: "late_dispatch_daily" }],
        producer: "https://github.com/aantenore/semantic-junkyard"
      },
      null,
      2
    )
  );

  const contractFile = path.join(semanticRepositoryPath, semanticContractPath);
  writeIfMissing(contractFile, stringify(defaultSemanticContract()));
  ensureGitRepository(semanticRepositoryPath);

  return {
    rootPath: resolvedRoot,
    operationsDatabasePath,
    knowledgePath,
    semanticRepositoryPath,
    semanticContractPath
  };
}

function ensureOperationsDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        customer_region TEXT NOT NULL,
        dispatch_eligible INTEGER NOT NULL CHECK (dispatch_eligible IN (0, 1)),
        promised_dispatch_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shipments (
        shipment_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(order_id),
        carrier TEXT NOT NULL,
        dispatched_at TEXT,
        status TEXT NOT NULL
      );
    `);
    const insertOrder = db.prepare(
      "INSERT OR IGNORE INTO orders (order_id, customer_region, dispatch_eligible, promised_dispatch_at, status) VALUES (?, ?, ?, ?, ?)"
    );
    insertOrder.run("ORD-1001", "EU-South", 1, "2026-07-10T09:00:00Z", "ready");
    insertOrder.run("ORD-1002", "EU-North", 1, "2026-07-10T08:00:00Z", "dispatched");
    insertOrder.run("ORD-1003", "EU-South", 0, "2026-07-10T07:00:00Z", "cancelled");
    const insertShipment = db.prepare(
      "INSERT OR IGNORE INTO shipments (shipment_id, order_id, carrier, dispatched_at, status) VALUES (?, ?, ?, ?, ?)"
    );
    insertShipment.run("SHP-9001", "ORD-1002", "Northstar Express", "2026-07-10T10:15:00Z", "dispatched");
  } finally {
    db.close();
  }
}

function defaultSemanticContract() {
  return {
    id: "contract.late-dispatch-rate",
    name: "Late Dispatch Rate Contract",
    version: "1",
    domain: "Supply Chain",
    status: "draft",
    assets: [
      {
        id: "asset.late-dispatch-daily",
        kind: "dataset",
        name: "Late Dispatch Daily",
        domain: "Supply Chain",
        owner: "Logistics Analytics",
        description: "Daily aggregate of late dispatch outcomes.",
        sensitivity: "internal",
        freshness: "fresh",
        qualityScore: 0.91,
        uri: "openlineage://demo.analytics/late_dispatch_daily",
        metadata: {}
      }
    ],
    metrics: [
      {
        id: "metric.late-dispatch-rate",
        name: "late_dispatch_rate",
        label: "Late Dispatch Rate",
        description: "Share of orders dispatched after the promised dispatch timestamp.",
        expression: "late_dispatch_orders / all_orders",
        dimensions: ["customer_region", "carrier"],
        owner: "Logistics Analytics",
        domain: "Supply Chain",
        contractVersion: "1",
        metadata: {}
      }
    ],
    policies: [],
    ontologyClasses: [
      {
        id: "ontology.dispatch-performance",
        label: "Dispatch Performance",
        description: "Operational concepts describing dispatch eligibility and timeliness.",
        parentId: null,
        constraints: ["Late dispatch requires dispatch_eligible = true"]
      }
    ],
    metadata: { format: "semantic-junkyard-reference-contract" }
  };
}

function ensureGitRepository(repositoryPath: string): void {
  const gitDir = path.join(repositoryPath, ".git");
  const safeConfig = [
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false"
  ];
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!fs.existsSync(gitDir)) {
    execFileSync("git", [...safeConfig, "init", "--initial-branch=main", repositoryPath], {
      stdio: "ignore",
      timeout: 30_000,
      env: environment
    });
  }
  const status = execFileSync("git", [...safeConfig, "-C", repositoryPath, "status", "--porcelain"], {
    encoding: "utf8",
    timeout: 30_000,
    env: environment
  });
  if (!status.trim()) return;
  execFileSync("git", [...safeConfig, "-C", repositoryPath, "add", "--", "."], {
    stdio: "ignore",
    timeout: 30_000,
    env: environment
  });
  execFileSync("git", [...safeConfig, "-C", repositoryPath, "commit", "--no-verify", "--no-gpg-sign", "-m", "Seed supply-chain semantic contract"], {
    stdio: "ignore",
    timeout: 30_000,
    env: {
      ...environment,
      GIT_AUTHOR_NAME: "Semantic Junkyard Demo",
      GIT_AUTHOR_EMAIL: "semantic-junkyard@localhost",
      GIT_COMMITTER_NAME: "Semantic Junkyard Demo",
      GIT_COMMITTER_EMAIL: "semantic-junkyard@localhost"
    }
  });
}

function writeIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}
