import Database from "better-sqlite3";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { sqliteSidecarPaths } from "../storage/databasePathPolicy.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface DemoSourcePaths {
  rootPath: string;
  operationsDatabasePath: string;
  knowledgePath: string;
  semanticRepositoryPath: string;
  semanticContractPath: string;
}

export function ensureSupplyChainDemoSources(rootPath: string): DemoSourcePaths {
  const layout = preflightDemoLayout(rootPath);
  const resolvedRoot = layout.rootPath;
  const knowledgePath = ensurePrivateDirectory(resolvedRoot, layout.knowledgePath);
  const semanticRepositoryPath = ensurePrivateDirectory(resolvedRoot, layout.semanticRepositoryPath);
  ensurePrivateDirectory(resolvedRoot, path.dirname(layout.contractFilePath));
  const operationsDatabasePath = preparePrivateRegularFile(resolvedRoot, layout.operationsDatabasePath);
  const semanticContractPath = "contracts/late-dispatch-rate.yaml";

  ensureOperationsDatabase(operationsDatabasePath);
  writeIfMissing(
    resolvedRoot,
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
    resolvedRoot,
    path.join(knowledgePath, "carrier-sla.csv"),
    ["carrier,service_level,max_dispatch_hours", "Northstar Express,priority,4", "Atlas Freight,standard,12"].join("\n")
  );
  writeIfMissing(
    resolvedRoot,
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
  writeIfMissing(resolvedRoot, contractFile, stringify(defaultSemanticContract()));
  ensureGitRepository(resolvedRoot, semanticRepositoryPath, semanticContractPath);

  return {
    rootPath: resolvedRoot,
    operationsDatabasePath,
    knowledgePath,
    semanticRepositoryPath,
    semanticContractPath
  };
}

function ensureOperationsDatabase(databasePath: string): void {
  const db = new Database(databasePath, { fileMustExist: true });
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

function ensureGitRepository(rootPath: string, repositoryPath: string, semanticContractPath: string): void {
  validateExistingDirectory(rootPath, repositoryPath, "semantic repository");
  const gitDir = path.join(repositoryPath, ".git");
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const safeConfig = [
    "-c",
    `core.hooksPath=${nullDevice}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    `core.attributesFile=${nullDevice}`,
    "-c",
    `core.excludesFile=${nullDevice}`
  ];
  const environment = safeGitEnvironment(nullDevice);
  if (!fs.existsSync(gitDir)) {
    execFileSync("git", [...safeConfig, "init", "--initial-branch=main", repositoryPath], {
      stdio: "ignore",
      timeout: 30_000,
      env: environment
    });
  }
  validateGitMetadataTree(rootPath, gitDir);
  validateGitConfiguration(rootPath, gitDir);
  validateGitWorktree(rootPath, repositoryPath);
  const repositoryArgs = [`--git-dir=${gitDir}`, `--work-tree=${repositoryPath}`];
  execFileSync("git", [...safeConfig, ...repositoryArgs, "add", "-f", "--", semanticContractPath], {
    stdio: "ignore",
    timeout: 30_000,
    env: environment
  });
  validateGitMetadataTree(rootPath, gitDir);
  validateGitConfiguration(rootPath, gitDir);
  validateGitWorktree(rootPath, repositoryPath);
  const staged = spawnSync("git", [...safeConfig, ...repositoryArgs, "diff", "--cached", "--quiet", "--no-ext-diff", "--", semanticContractPath], {
    encoding: "utf8",
    timeout: 30_000,
    env: environment
  });
  if (staged.error) throw staged.error;
  if (staged.status !== 0 && staged.status !== 1) {
    throw new Error(`Could not inspect the staged semantic contract: ${staged.stderr.trim()}`);
  }
  if (staged.status === 1) {
    execFileSync("git", [...safeConfig, ...repositoryArgs, "commit", "--no-verify", "--no-gpg-sign", "-m", "Seed supply-chain semantic contract", "--", semanticContractPath], {
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
  validateGitMetadataTree(rootPath, gitDir);
  validateGitConfiguration(rootPath, gitDir);
  validateGitWorktree(rootPath, repositoryPath);
  verifyCommittedFile(repositoryPath, gitDir, semanticContractPath, safeConfig, environment);
}

function safeGitEnvironment(nullDevice: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))
  );
  return {
    ...inherited,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function validateGitMetadataTree(rootPath: string, gitDir: string): void {
  const metadataRoot = validateExistingDirectory(rootPath, gitDir, "semantic repository metadata");
  const forbiddenMetadataFiles = new Set([
    "commondir",
    "info/attributes",
    "objects/info/alternates",
    "objects/info/http-alternates"
  ]);
  const pending = [metadataRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      const candidate = assertContained(rootPath, path.join(current, name), "semantic repository metadata", false);
      const status = fs.lstatSync(candidate);
      const metadataPath = path.relative(metadataRoot, candidate).split(path.sep).join("/");
      if (status.isSymbolicLink()) throw new Error("semantic repository metadata cannot contain symbolic links.");
      if (status.isDirectory()) {
        pending.push(validateExistingDirectory(rootPath, candidate, "semantic repository metadata"));
      } else if (status.isFile()) {
        if (forbiddenMetadataFiles.has(metadataPath)) {
          throw new Error(`semantic repository metadata cannot contain ${metadataPath}.`);
        }
        validateExistingRegularFile(rootPath, candidate, "semantic repository metadata file");
      } else {
        throw new Error("semantic repository metadata may contain only directories and regular files.");
      }
    }
  }
}

function validateGitConfiguration(rootPath: string, gitDir: string): void {
  const configPath = validateExistingRegularFile(rootPath, path.join(gitDir, "config"), "semantic repository config");
  const allowedCoreKeys = new Map<string, RegExp>([
    ["bare", /^false$/i],
    ["filemode", /^(?:true|false)$/i],
    ["ignorecase", /^(?:true|false)$/i],
    ["logallrefupdates", /^true$/i],
    ["precomposeunicode", /^(?:true|false)$/i],
    ["repositoryformatversion", /^0$/],
    ["symlinks", /^(?:true|false)$/i]
  ]);
  const seen = new Set<string>();
  let section = "";
  for (const rawLine of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9.-]*)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]?.toLowerCase() ?? "";
      if (section !== "core") throw new Error("semantic repository config contains an unsupported section.");
      continue;
    }
    if (line.startsWith("[")) throw new Error("semantic repository config contains an unsupported section.");
    if (section !== "core") throw new Error("semantic repository config must contain only a core section.");
    const entry = /^([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!entry) throw new Error("semantic repository config contains unsupported syntax.");
    const key = entry[1]?.toLowerCase() ?? "";
    const value = entry[2] ?? "";
    const allowedValue = allowedCoreKeys.get(key);
    if (!allowedValue || !allowedValue.test(value) || seen.has(key)) {
      throw new Error(`semantic repository config contains unsupported key or value: core.${key}.`);
    }
    seen.add(key);
  }
  if (!seen.has("repositoryformatversion") || !seen.has("bare")) {
    throw new Error("semantic repository config is missing required core settings.");
  }
}

function verifyCommittedFile(
  repositoryPath: string,
  gitDir: string,
  semanticContractPath: string,
  safeConfig: string[],
  environment: NodeJS.ProcessEnv
): void {
  const committed = execFileSync(
    "git",
    [...safeConfig, `--git-dir=${gitDir}`, `--work-tree=${repositoryPath}`, "show", `HEAD:${semanticContractPath}`],
    { timeout: 30_000, env: environment }
  );
  const source = fs.readFileSync(path.join(repositoryPath, semanticContractPath));
  if (!committed.equals(source)) {
    throw new Error("Committed semantic contract does not match the source file byte for byte.");
  }
}

function validateGitWorktree(rootPath: string, repositoryPath: string): void {
  const worktreeRoot = validateExistingDirectory(rootPath, repositoryPath, "semantic repository");
  const pending = [worktreeRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      if (current === worktreeRoot && name === ".git") continue;
      const candidate = assertContained(rootPath, path.join(current, name), "semantic repository worktree", false);
      const status = fs.lstatSync(candidate);
      if (status.isSymbolicLink()) throw new Error("semantic repository worktree cannot contain symbolic links.");
      if (status.isDirectory()) {
        pending.push(validateExistingDirectory(rootPath, candidate, "semantic repository worktree"));
      } else if (status.isFile()) {
        if (name === ".gitattributes") {
          throw new Error("semantic repository worktree cannot define Git attributes in the reference fixture.");
        }
        validateExistingRegularFile(rootPath, candidate, "semantic repository worktree file");
      } else {
        throw new Error("semantic repository worktree may contain only directories and regular files.");
      }
    }
  }
}

function writeIfMissing(rootPath: string, filePath: string, content: string): void {
  const containedFilePath = assertContained(rootPath, filePath, "reference file", false);
  validateExistingDirectory(rootPath, path.dirname(containedFilePath), "reference file parent");
  const status = lstatOrUndefined(containedFilePath);
  if (status) {
    validateExistingRegularFile(rootPath, containedFilePath, "reference file");
    return;
  }

  const descriptor = fs.openSync(
    containedFilePath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
    PRIVATE_FILE_MODE
  );
  try {
    fs.writeFileSync(descriptor, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  validateExistingRegularFile(rootPath, containedFilePath, "reference file");
  setModeWhereSupported(containedFilePath, PRIVATE_FILE_MODE);
}

interface DemoLayout extends DemoSourcePaths {
  contractFilePath: string;
}

function preflightDemoLayout(rootPath: string): DemoLayout {
  const lexicalRoot = path.resolve(rootPath);
  const rootStatus = lstatOrUndefined(lexicalRoot);
  if (!rootStatus) throw new Error("Reference source root must already exist.");
  if (rootStatus.isSymbolicLink()) throw new Error("Reference source root cannot be a symbolic link.");
  if (!rootStatus.isDirectory()) throw new Error("Reference source root must be a directory.");
  const resolvedRoot = fs.realpathSync(lexicalRoot);

  const semanticContractPath = "contracts/late-dispatch-rate.yaml";
  const layout: DemoLayout = {
    rootPath: resolvedRoot,
    operationsDatabasePath: assertContained(resolvedRoot, path.join(resolvedRoot, "operations.sqlite"), "operations database", false),
    knowledgePath: assertContained(resolvedRoot, path.join(resolvedRoot, "knowledge"), "knowledge root", false),
    semanticRepositoryPath: assertContained(resolvedRoot, path.join(resolvedRoot, "semantic-contracts"), "semantic repository", false),
    semanticContractPath,
    contractFilePath: assertContained(
      resolvedRoot,
      path.join(resolvedRoot, "semantic-contracts", semanticContractPath),
      "semantic contract",
      false
    )
  };

  validateExistingDirectory(resolvedRoot, resolvedRoot, "reference source root");
  for (const [label, directoryPath] of [
    ["knowledge root", layout.knowledgePath],
    ["semantic repository", layout.semanticRepositoryPath],
    ["semantic contract directory", path.dirname(layout.contractFilePath)],
    ["semantic repository metadata", path.join(layout.semanticRepositoryPath, ".git")]
  ] as const) {
    if (lstatOrUndefined(directoryPath)) validateExistingDirectory(resolvedRoot, directoryPath, label);
  }
  for (const [label, filePath] of [
    ["operations database", layout.operationsDatabasePath],
    ["dispatch policy", path.join(layout.knowledgePath, "dispatch-policy.md")],
    ["carrier SLA", path.join(layout.knowledgePath, "carrier-sla.csv")],
    ["lineage event", path.join(layout.knowledgePath, "openlineage-event.json")],
    ["semantic contract", layout.contractFilePath]
  ] as const) {
    if (lstatOrUndefined(filePath)) validateExistingRegularFile(resolvedRoot, filePath, label);
  }
  validateDemoDatabaseSidecars(resolvedRoot, layout.operationsDatabasePath);
  const gitDir = path.join(layout.semanticRepositoryPath, ".git");
  if (lstatOrUndefined(layout.semanticRepositoryPath)) {
    validateGitWorktree(resolvedRoot, layout.semanticRepositoryPath);
  }
  if (lstatOrUndefined(gitDir)) validateGitMetadataTree(resolvedRoot, gitDir);
  if (lstatOrUndefined(gitDir)) validateGitConfiguration(resolvedRoot, gitDir);
  return layout;
}

function validateDemoDatabaseSidecars(rootPath: string, databasePath: string): void {
  const databaseExists = lstatOrUndefined(databasePath) !== undefined;
  for (const sidecarPath of sqliteSidecarPaths(databasePath)) {
    if (!lstatOrUndefined(sidecarPath)) continue;
    if (!databaseExists) {
      throw new Error("An orphaned SQLite sidecar exists for the missing operations database.");
    }
    validateExistingRegularFile(rootPath, sidecarPath, "operations database sidecar");
  }
}

function ensurePrivateDirectory(rootPath: string, directoryPath: string): string {
  const containedDirectoryPath = assertContained(rootPath, directoryPath, "reference directory", true);
  const relativePath = path.relative(rootPath, containedDirectoryPath);
  const segments = relativePath.length === 0 ? [] : relativePath.split(path.sep);
  let current = rootPath;
  setModeWhereSupported(current, PRIVATE_DIRECTORY_MODE);

  for (const segment of segments) {
    current = assertContained(rootPath, path.join(current, segment), "reference directory", true);
    if (!lstatOrUndefined(current)) {
      try {
        fs.mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
    }
    validateExistingDirectory(rootPath, current, "reference directory");
    setModeWhereSupported(current, PRIVATE_DIRECTORY_MODE);
  }
  return assertContained(rootPath, fs.realpathSync(containedDirectoryPath), "reference directory", true);
}

function preparePrivateRegularFile(rootPath: string, filePath: string): string {
  const containedFilePath = assertContained(rootPath, filePath, "reference database", false);
  validateExistingDirectory(rootPath, path.dirname(containedFilePath), "reference database parent");
  if (!lstatOrUndefined(containedFilePath)) {
    const descriptor = fs.openSync(
      containedFilePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollowFlag(),
      PRIVATE_FILE_MODE
    );
    fs.closeSync(descriptor);
  }
  const canonicalPath = validateExistingRegularFile(rootPath, containedFilePath, "reference database");
  setModeWhereSupported(canonicalPath, PRIVATE_FILE_MODE);
  return canonicalPath;
}

function validateExistingDirectory(rootPath: string, directoryPath: string, label: string): string {
  const containedDirectoryPath = assertContained(rootPath, directoryPath, label, true);
  const status = fs.lstatSync(containedDirectoryPath);
  if (status.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory.`);
  return assertContained(rootPath, fs.realpathSync(containedDirectoryPath), label, true);
}

function validateExistingRegularFile(rootPath: string, filePath: string, label: string): string {
  const containedFilePath = assertContained(rootPath, filePath, label, false);
  const status = fs.lstatSync(containedFilePath);
  if (status.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file.`);
  if (status.nlink !== 1) throw new Error(`${label} cannot have multiple hard links.`);
  return assertContained(rootPath, fs.realpathSync(containedFilePath), label, false);
}

function assertContained(rootPath: string, candidate: string, label: string, allowRoot: boolean): string {
  const relativePath = path.relative(rootPath, candidate);
  if (
    relativePath === ".."
    || relativePath.startsWith(".." + path.sep)
    || path.isAbsolute(relativePath)
    || (!allowRoot && relativePath.length === 0)
  ) {
    throw new Error(`${label} must remain inside the reference source root.`);
  }
  return candidate;
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}

function setModeWhereSupported(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    if (process.platform === "win32" && isNodeError(error) && error.code !== undefined && ["ENOSYS", "ENOTSUP", "EPERM"].includes(error.code)) return;
    throw error;
  }
}

function lstatOrUndefined(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
