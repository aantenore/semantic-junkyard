import {
  SemanticContractSchema,
  type BusinessActionRequest,
  type MetricDefinition,
  type SemanticAsset,
  type SemanticContract,
  type SourceConnection,
  type SourceResource
} from "@semantic-junkyard/shared";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { nowIso, stableId } from "../core/hash.js";
import type {
  ConnectorActionCandidate,
  ConnectorSnapshot,
  ConnectorTestResult,
  ConnectorWriteResult,
  SourceConnector
} from "./connector.js";

type GitConnectionConfig = Extract<SourceConnection["config"], { kind: "git" }>;
type YamlPath = Array<string | number>;

interface GitConnectorOptions {
  authorName?: string;
  authorEmail?: string;
}

interface RepositoryState {
  rootPath: string;
  head: string;
  dirty: boolean;
  status: string[];
}

interface GitTreeEntry {
  mode: string;
  type: string;
  hash: string;
  size: number;
  relativePath: string;
}

interface LocatedMetric {
  metric: MetricDefinition;
  metricPath: YamlPath;
}

interface LocatedContract {
  contract: SemanticContract;
  contractPath: YamlPath;
  metrics: LocatedMetric[];
}

interface ParsedContractDocument {
  document: ReturnType<typeof parseDocument>;
  contracts: LocatedContract[];
  warnings: string[];
}

interface ContractSource {
  relativePath: string;
  blobHash: string;
  beforeContent: string;
  document: ReturnType<typeof parseDocument>;
  contract: LocatedContract;
}

interface MetricTarget extends ContractSource {
  locatedMetric: LocatedMetric;
}

interface MutationIntent {
  denominatorIdentifier: string | null;
  version: string | null;
  publish: boolean;
  selectionText: string;
}

interface PlannedParameters {
  relativePath: string;
  beforeContent: string;
  afterContent: string;
  expectedHead: string;
  expectedBlob: string;
  contractPath: YamlPath;
  metricPath: YamlPath | null;
  expectedContractFields: Record<string, unknown>;
  expectedMetricFields: Record<string, unknown> | null;
  commitMessage: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".csv",
  ".css",
  ".conf",
  ".graphql",
  ".htm",
  ".html",
  ".ini",
  ".js",
  ".jsx",
  ".json",
  ".jsonl",
  ".md",
  ".mdx",
  ".py",
  ".rst",
  ".sh",
  ".sql",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const SUPPORTED_EXTENSIONLESS_FILES = new Set(["dockerfile", "license", "makefile", "readme"]);
const MAX_INGEST_TEXT_BYTES = 5_000_000;
const DEFAULT_GIT_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const SAFE_GIT_CONFIG = [
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false"
];

export class GitConnector implements SourceConnector {
  readonly kind = "git" as const;

  private readonly authorName: string;
  private readonly authorEmail: string;

  constructor(options: GitConnectorOptions = {}) {
    this.authorName = options.authorName?.trim() || process.env.SEMANTIC_JUNKYARD_GIT_AUTHOR_NAME?.trim() || "Semantic Junkyard";
    this.authorEmail = options.authorEmail?.trim() || process.env.SEMANTIC_JUNKYARD_GIT_AUTHOR_EMAIL?.trim() || "semantic-junkyard@localhost";
  }

  test(connection: SourceConnection): ConnectorTestResult {
    try {
      const config = requireGitConfig(connection);
      const state = inspectRepository(config.repositoryPath);
      return {
        ok: true,
        message: `Local Git worktree is available at ${state.head.slice(0, 12)} and is ${state.dirty ? "dirty" : "clean"}.`,
        details: {
          repositoryPath: state.rootPath,
          head: state.head,
          commitSha: state.head,
          clean: !state.dirty,
          dirty: state.dirty,
          status: state.status
        }
      };
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error),
        details: {
          repositoryPath: connection.config.kind === "git" ? connection.config.repositoryPath : null,
          error: errorMessage(error)
        }
      };
    }
  }

  discover(connection: SourceConnection): ConnectorSnapshot {
    const config = requireGitConfig(connection);
    const state = inspectRepository(config.repositoryPath);
    const includePaths = config.includePaths.map((candidate) => normalizeRepositoryPath(candidate, true));
    const semanticContractPaths = new Set(config.semanticContractPaths.map((candidate) => normalizeRepositoryPath(candidate)));
    const entries = listTreeEntries(state.rootPath, state.head);
    const resources: SourceResource[] = [];
    const documents: ConnectorSnapshot["documents"] = [];
    const assets: SemanticAsset[] = [];
    const metrics: MetricDefinition[] = [];
    const contracts: SemanticContract[] = [];
    const warnings: string[] = [];
    const blobs: Record<string, string> = {};
    const observedAt = nowIso();
    let matchingSupportedFiles = 0;

    for (const entry of entries) {
      if (!isRegularGitBlob(entry) || !isSupportedTextPath(entry.relativePath) || !isWithinIncludes(entry.relativePath, includePaths)) continue;
      matchingSupportedFiles += 1;
      if (resources.length >= config.maxFiles) continue;
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > config.maxFileBytes) {
        warnings.push(`Skipped ${entry.relativePath}: blob size ${entry.size} exceeds maxFileBytes ${config.maxFileBytes}.`);
        continue;
      }

      const contentBuffer = readBlob(state.rootPath, entry, config.maxFileBytes);
      if (contentBuffer.includes(0)) {
        warnings.push(`Skipped ${entry.relativePath}: the tracked blob contains NUL bytes and is not treated as text.`);
        continue;
      }
      const content = contentBuffer.toString("utf8");
      const parsed = isYamlPath(entry.relativePath) ? parseSemanticContractDocument(content) : null;
      if (parsed) warnings.push(...parsed.warnings.map((warning) => `${entry.relativePath}: ${warning}`));

      const provenance = gitProvenance(state, entry);
      const discoveredContracts = (parsed?.contracts ?? []).map((located) => enrichContractWithProvenance(located.contract, provenance));
      for (const contract of discoveredContracts) {
        contracts.push(contract);
        assets.push(...contract.assets);
        metrics.push(...contract.metrics);
      }

      const isSemanticContract = discoveredContracts.length > 0;
      const writable =
        isSemanticContract &&
        config.writeMode !== "read_only" &&
        semanticContractPaths.has(entry.relativePath);
      const mimeType = mimeTypeFor(entry.relativePath);
      const uri = gitFileUri(state.rootPath, state.head, entry.relativePath);
      const resourceId = stableId("resource", `${connection.id}:git:${entry.relativePath}`);
      const metadata = {
        connector: this.kind,
        repositoryPath: state.rootPath,
        path: entry.relativePath,
        commitSha: state.head,
        blobSha: entry.hash,
        version: `${state.head}:${entry.hash}`,
        git: provenance
      };

      resources.push({
        id: resourceId,
        connectionId: connection.id,
        externalId: entry.relativePath,
        parentId: null,
        kind: isSemanticContract ? "semantic_contract" : "file",
        name: path.posix.basename(entry.relativePath),
        qualifiedName: `${connection.name}:${entry.relativePath}`,
        dataType: mimeType,
        description: isSemanticContract
          ? `Git-backed semantic contract at ${entry.relativePath}.`
          : `Tracked Git text resource at ${entry.relativePath}.`,
        uri,
        sensitivity: "internal",
        writable,
        profile: {
          sizeBytes: entry.size,
          contractCount: discoveredContracts.length,
          metricCount: discoveredContracts.reduce((total, contract) => total + contract.metrics.length, 0),
          assetCount: discoveredContracts.reduce((total, contract) => total + contract.assets.length, 0)
        },
        evidenceChunkIds: [],
        metadata,
        observedAt
      });
      documents.push({
        resourceExternalId: entry.relativePath,
        request: {
          name: path.posix.basename(entry.relativePath),
          text: entry.size <= MAX_INGEST_TEXT_BYTES ? content : "",
          uri,
          mimeType,
          ingestionMode: entry.size <= MAX_INGEST_TEXT_BYTES ? "full_data" : "metadata_only",
          metadata
        }
      });
      blobs[entry.relativePath] = entry.hash;
    }

    if (matchingSupportedFiles > resources.length && resources.length >= config.maxFiles) {
      warnings.push(`Discovery stopped at maxFiles ${config.maxFiles}; ${matchingSupportedFiles - resources.length} additional supported tracked file(s) were not emitted.`);
    }

    return {
      resources,
      documents,
      assets: deduplicateById(assets),
      metrics: deduplicateById(metrics),
      lineage: [],
      contracts: deduplicateById(contracts),
      ontologyClasses: [],
      relations: [],
      warnings,
      checkpoint: {
        repositoryPath: state.rootPath,
        head: state.head,
        commitSha: state.head,
        version: state.head,
        clean: !state.dirty,
        dirty: state.dirty,
        status: state.status,
        blobs,
        resources: resources.map((resource) => ({
          externalId: resource.externalId,
          commitSha: state.head,
          blobSha: blobs[resource.externalId],
          version: `${state.head}:${blobs[resource.externalId]}`
        }))
      }
    };
  }

  planAction(connection: SourceConnection, request: BusinessActionRequest, resources: SourceResource[]): ConnectorActionCandidate | null {
    const config = requireGitConfig(connection);
    if (config.writeMode === "read_only" || config.semanticContractPaths.length === 0) return null;

    const mutation = parseMutationIntent(request.intent);
    if (!mutation) return null;

    const state = inspectRepository(config.repositoryPath);
    const configuredPaths = [...new Set(config.semanticContractPaths.map((candidate) => normalizeRepositoryPath(candidate)))];
    const treeEntries = new Map(listTreeEntries(state.rootPath, state.head).map((entry) => [entry.relativePath, entry]));
    const contractSources: ContractSource[] = [];

    for (const relativePath of configuredPaths) {
      const entry = treeEntries.get(relativePath);
      if (!entry || !isRegularGitBlob(entry) || !isYamlPath(relativePath) || entry.size > config.maxFileBytes) continue;
      if (gitPathStatus(state.rootPath, relativePath).length > 0) continue;
      const beforeContent = readBlob(state.rootPath, entry, config.maxFileBytes).toString("utf8");
      const parsed = parseSemanticContractDocument(beforeContent);
      for (const contract of parsed.contracts) {
        contractSources.push({
          relativePath,
          blobHash: entry.hash,
          beforeContent,
          document: parsed.document,
          contract
        });
      }
    }

    if (contractSources.length === 0) return null;
    const metricTarget = mutation.denominatorIdentifier
      ? resolveMetricTarget(contractSources, mutation.selectionText, request.context)
      : null;
    if (mutation.denominatorIdentifier && !metricTarget) return null;
    const contractTarget = metricTarget ?? resolveContractTarget(contractSources, mutation.selectionText, request.context);
    if (!contractTarget) return null;

    const targetDocument = parseDocument(contractTarget.beforeContent, { prettyErrors: true, uniqueKeys: true });
    if (targetDocument.errors.length > 0) return null;
    const currentContract = contractTarget.contract.contract;
    const nextVersion = mutation.version ?? currentContract.version;
    const nextStatus = mutation.publish ? "active" : currentContract.status;
    targetDocument.setIn([...contractTarget.contract.contractPath, "version"], nextVersion);
    if (mutation.publish) targetDocument.setIn([...contractTarget.contract.contractPath, "status"], nextStatus);

    let expectedMetricFields: Record<string, unknown> | null = null;
    let metricPath: YamlPath | null = null;
    let metricBefore: Record<string, unknown> | null = null;
    if (metricTarget) {
      const metric = metricTarget.locatedMetric.metric;
      const expression = mutation.denominatorIdentifier
        ? replaceExpressionDenominator(metric.expression, mutation.denominatorIdentifier)
        : metric.expression;
      if (!expression) return null;
      metricPath = metricTarget.locatedMetric.metricPath;
      targetDocument.setIn([...metricPath, "expression"], expression);
      if (mutation.version) targetDocument.setIn([...metricPath, "contractVersion"], nextVersion);
      expectedMetricFields = {
        id: metric.id,
        name: metric.name,
        label: metric.label,
        expression,
        contractVersion: mutation.version ? nextVersion : metric.contractVersion
      };
      metricBefore = {
        id: metric.id,
        name: metric.name,
        label: metric.label,
        expression: metric.expression,
        contractVersion: metric.contractVersion
      };
    }

    const afterContent = targetDocument.toString();
    if (afterContent === contractTarget.beforeContent) return null;
    const expectedContractFields = {
      id: currentContract.id,
      name: currentContract.name,
      version: nextVersion,
      status: nextStatus
    };
    if (!contentMatchesExpectedFields(afterContent, contractTarget.contract.contractPath, metricPath, expectedContractFields, expectedMetricFields)) return null;

    const metricLabel = metricTarget?.locatedMetric.metric.label ?? currentContract.name;
    const commitMessage = singleLine(`Update ${metricLabel} semantic contract to version ${nextVersion}`);
    const parameters: Record<string, unknown> = {
      path: contractTarget.relativePath,
      relativePath: contractTarget.relativePath,
      beforeContent: contractTarget.beforeContent,
      afterContent,
      expectedHead: state.head,
      expectedHeadSha: state.head,
      expectedBlob: contractTarget.blobHash,
      expectedBlobSha: contractTarget.blobHash,
      contractPath: contractTarget.contract.contractPath,
      metricPath,
      contractId: currentContract.id,
      metricId: metricTarget?.locatedMetric.metric.id ?? null,
      metricName: metricTarget?.locatedMetric.metric.name ?? null,
      expectedVersion: nextVersion,
      expectedMetricExpression: expectedMetricFields?.expression ?? null,
      expectedMetricContractVersion: expectedMetricFields?.contractVersion ?? null,
      expectedContractFields,
      expectedMetricFields,
      commitMessage
    };
    const evidenceResources = resources.filter(
      (resource) => resource.connectionId === connection.id && resource.externalId === contractTarget.relativePath
    );
    const evidenceResourceIds = evidenceResources.map((resource) => resource.id);
    const evidenceChunkIds = [...new Set(evidenceResources.flatMap((resource) => resource.evidenceChunkIds))];

    return {
      connectionId: connection.id,
      capability: "semantic_contract.publish",
      technicalOperation: "git.semantic_contract.commit",
      objectType: "semantic_contract",
      objectKey: contractTarget.relativePath,
      title: `Update ${metricLabel} in ${contractTarget.relativePath}`,
      rationale: `Resolved the request to one configured semantic contract${metricTarget ? " and one metric" : ""}; the write is guarded by HEAD and blob preconditions.`,
      risk: "medium",
      requiresApproval: config.writeMode === "approval_required",
      evidenceResourceIds,
      evidenceChunkIds,
      before: {
        path: contractTarget.relativePath,
        content: contractTarget.beforeContent,
        contract: {
          id: currentContract.id,
          name: currentContract.name,
          version: currentContract.version,
          status: currentContract.status
        },
        metric: metricBefore
      },
      after: {
        path: contractTarget.relativePath,
        content: afterContent,
        contract: expectedContractFields,
        metric: expectedMetricFields
      },
      parameters
    };
  }

  executeAction(connection: SourceConnection, candidate: ConnectorActionCandidate): ConnectorWriteResult {
    const config = requireGitConfig(connection);
    if (config.writeMode === "read_only") throw new Error("Git semantic-contract writes are disabled for a read-only connection.");
    if (candidate.connectionId !== connection.id) throw new Error("The action candidate belongs to a different source connection.");

    const state = inspectRepository(config.repositoryPath);
    const parameters = readPlannedParameters(candidate);
    const configuredPaths = new Set(config.semanticContractPaths.map((configuredPath) => normalizeRepositoryPath(configuredPath)));
    if (!configuredPaths.has(parameters.relativePath)) {
      throw new Error(`Git write target is not configured as a semantic contract path: ${parameters.relativePath}`);
    }
    if (candidate.objectKey !== parameters.relativePath) throw new Error("The candidate object key does not match its planned Git path.");

    const targetPath = resolveRegularFileInsideRepository(state.rootPath, parameters.relativePath);
    assertOptimisticPreconditions(state, parameters, config.maxFileBytes, targetPath);
    if (!contentMatchesExpectedFields(
      parameters.afterContent,
      parameters.contractPath,
      parameters.metricPath,
      parameters.expectedContractFields,
      parameters.expectedMetricFields
    )) {
      throw new Error("The planned YAML does not contain the expected semantic-contract version and metric fields.");
    }

    let targetTouched = false;
    let commitCompleted = false;
    try {
      targetTouched = true;
      fs.writeFileSync(targetPath, parameters.afterContent, "utf8");
      runGit(state.rootPath, ["add", "--", parameters.relativePath]);

      const currentHead = gitLine(state.rootPath, ["rev-parse", "--verify", "HEAD"]);
      const currentEntry = treeEntryForPath(state.rootPath, currentHead, parameters.relativePath);
      if (currentHead !== parameters.expectedHead || currentEntry?.hash !== parameters.expectedBlob) {
        throw new Error("Git HEAD or target blob changed while preparing the semantic-contract commit.");
      }

      const indexedHash = indexBlobForPath(state.rootPath, parameters.relativePath);
      const plannedHash = gitLine(state.rootPath, ["hash-object", "--stdin"], {
        input: Buffer.from(parameters.afterContent, "utf8"),
        maxBuffer: byteLength(parameters.afterContent) + 1024
      });
      if (!indexedHash || indexedHash !== plannedHash) throw new Error("The staged target does not match the exact planned YAML content.");

      const commitEnvironment = {
        ...process.env,
        GIT_AUTHOR_NAME: this.authorName,
        GIT_AUTHOR_EMAIL: this.authorEmail,
        GIT_COMMITTER_NAME: this.authorName,
        GIT_COMMITTER_EMAIL: this.authorEmail
      };
      runGit(
        state.rootPath,
        ["commit", "--only", "--no-verify", "--no-gpg-sign", "-m", parameters.commitMessage, "--", parameters.relativePath],
        { env: commitEnvironment }
      );
      commitCompleted = true;

      const commitSha = gitLine(state.rootPath, ["rev-parse", "--verify", "HEAD"]);
      const parentSha = gitLine(state.rootPath, ["rev-parse", "--verify", `${commitSha}^`]);
      if (parentSha !== parameters.expectedHead) throw new Error("The semantic-contract commit was not based on the expected HEAD.");
      const changedPaths = gitNulList(state.rootPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commitSha]);
      if (changedPaths.length !== 1 || changedPaths[0] !== parameters.relativePath) {
        throw new Error("The Git commit contains paths outside the planned semantic-contract target.");
      }

      return this.readCommittedResult(state.rootPath, commitSha, candidate, parameters);
    } catch (error) {
      if (!commitCompleted && targetTouched) {
        const restorationErrors: unknown[] = [];
        try {
          fs.writeFileSync(targetPath, parameters.beforeContent, "utf8");
        } catch (restoreError) {
          restorationErrors.push(restoreError);
        }
        try {
          runGit(state.rootPath, ["add", "--", parameters.relativePath]);
        } catch (restoreError) {
          restorationErrors.push(restoreError);
        }
        if (restorationErrors.length > 0) {
          throw new AggregateError([error, ...restorationErrors], "Git action failed and the target file could not be fully restored.");
        }
      }
      throw error;
    }
  }

  readAction(connection: SourceConnection, candidate: ConnectorActionCandidate): ConnectorWriteResult {
    const config = requireGitConfig(connection);
    if (candidate.connectionId !== connection.id) throw new Error("The action candidate belongs to a different source connection.");
    const state = inspectRepository(config.repositoryPath);
    const parameters = readPlannedParameters(candidate);
    const configuredPaths = new Set(config.semanticContractPaths.map((configuredPath) => normalizeRepositoryPath(configuredPath)));
    if (!configuredPaths.has(parameters.relativePath)) throw new Error("The Git readback path is not a configured semantic contract path.");
    resolveRegularFileInsideRepository(state.rootPath, parameters.relativePath);
    return this.readCommittedResult(state.rootPath, state.head, candidate, parameters);
  }

  private readCommittedResult(
    repositoryPath: string,
    commitSha: string,
    candidate: ConnectorActionCandidate,
    parameters: PlannedParameters
  ): ConnectorWriteResult {
    const readbackContent = runGit(repositoryPath, ["show", `${commitSha}:${parameters.relativePath}`], {
      maxBuffer: Math.max(DEFAULT_GIT_BUFFER_BYTES, byteLength(parameters.afterContent) + 1024)
    }).toString("utf8");
    const entry = treeEntryForPath(repositoryPath, commitSha, parameters.relativePath);
    if (!entry) throw new Error(`Committed Git path is missing: ${parameters.relativePath}`);
    const fieldsPassed = contentMatchesExpectedFields(
      readbackContent,
      parameters.contractPath,
      parameters.metricPath,
      parameters.expectedContractFields,
      parameters.expectedMetricFields
    );
    const exactContent = readbackContent === parameters.afterContent;
    const postconditionPassed = exactContent && fieldsPassed;
    const readbackFields = readExpectedFields(readbackContent, parameters.contractPath, parameters.metricPath);
    const status = gitPathStatus(repositoryPath, parameters.relativePath);

    return {
      sourceVersion: commitSha,
      before: candidate.before,
      after: candidate.after,
      readback: {
        path: parameters.relativePath,
        content: readbackContent,
        commitSha,
        blobSha: entry.hash,
        contract: readbackFields.contract,
        metric: readbackFields.metric
      },
      postconditionPassed,
      postcondition: postconditionPassed
        ? "Committed readback exactly matches the planned YAML and expected contract/metric fields."
        : "Committed readback differs from the exact planned YAML or expected contract/metric fields.",
      metadata: {
        repositoryPath,
        previousHead: parameters.expectedHead,
        commitSha,
        blobSha: entry.hash,
        exactContent,
        fieldsPassed,
        targetClean: status.length === 0
      }
    };
  }
}

export { GitConnector as GitSourceConnector };
export default GitConnector;

function requireGitConfig(connection: SourceConnection): GitConnectionConfig {
  if (connection.kind !== "git" || connection.config.kind !== "git") {
    throw new Error("GitConnector requires a source connection with kind 'git'.");
  }
  return connection.config;
}

function inspectRepository(repositoryPath: string): RepositoryState {
  const configuredPath = path.resolve(repositoryPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configuredPath);
  } catch {
    throw new Error(`Local Git repository path does not exist: ${configuredPath}`);
  }
  if (!stat.isDirectory()) throw new Error(`Local Git repository path is not a directory: ${configuredPath}`);

  const insideWorktree = gitLine(configuredPath, ["rev-parse", "--is-inside-work-tree"]);
  const bare = gitLine(configuredPath, ["rev-parse", "--is-bare-repository"]);
  if (insideWorktree !== "true" || bare === "true") throw new Error(`Path is not a local Git worktree: ${configuredPath}`);
  const rootPath = fs.realpathSync(gitLine(configuredPath, ["rev-parse", "--show-toplevel"]));
  const head = gitLine(rootPath, ["rev-parse", "--verify", "HEAD"]);
  const status = gitNulList(rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return { rootPath, head, dirty: status.length > 0, status };
}

function listTreeEntries(repositoryPath: string, commitSha: string): GitTreeEntry[] {
  const output = runGit(repositoryPath, ["ls-tree", "-r", "-l", "-z", commitSha]);
  return parseTreeEntries(output).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function treeEntryForPath(repositoryPath: string, commitSha: string, relativePath: string): GitTreeEntry | null {
  const output = runGit(repositoryPath, ["ls-tree", "-l", "-z", commitSha, "--", relativePath]);
  return parseTreeEntries(output).find((entry) => entry.relativePath === relativePath) ?? null;
}

function parseTreeEntries(output: Buffer): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of splitNulBuffers(output)) {
    const tabIndex = record.indexOf(9);
    if (tabIndex < 0) continue;
    const header = record.subarray(0, tabIndex).toString("utf8").trim().split(/\s+/u);
    if (header.length !== 4) continue;
    const [mode, type, hash, sizeText] = header as [string, string, string, string];
    const size = Number(sizeText);
    entries.push({
      mode,
      type,
      hash,
      size,
      relativePath: record.subarray(tabIndex + 1).toString("utf8")
    });
  }
  return entries;
}

function readBlob(repositoryPath: string, entry: GitTreeEntry, maxFileBytes: number): Buffer {
  const output = runGit(repositoryPath, ["cat-file", "blob", entry.hash], {
    maxBuffer: Math.max(DEFAULT_GIT_BUFFER_BYTES, Math.min(maxFileBytes, entry.size) + 1024)
  });
  if (output.length !== entry.size) throw new Error(`Git blob size changed while reading ${entry.relativePath}.`);
  return output;
}

function parseSemanticContractDocument(content: string): ParsedContractDocument {
  const document = parseDocument(content, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      document,
      contracts: [],
      warnings: document.errors.map((error) => error.message)
    };
  }

  const root = document.toJS({ mapAsMap: false }) as unknown;
  const candidates = locateContractCandidates(root);
  const contracts: LocatedContract[] = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeContractValue(candidate.value);
    const parsed = SemanticContractSchema.safeParse(normalized);
    if (!parsed.success) {
      warnings.push(`Semantic contract candidate at ${formatYamlPath(candidate.path)} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      continue;
    }
    contracts.push({
      contract: parsed.data,
      contractPath: candidate.path,
      metrics: parsed.data.metrics.map((metric, index) => ({
        metric,
        metricPath: [...candidate.path, "metrics", index]
      }))
    });
  }
  return { document, contracts, warnings };
}

function locateContractCandidates(root: unknown): Array<{ value: unknown; path: YamlPath }> {
  const candidates: Array<{ value: unknown; path: YamlPath }> = [];
  const append = (value: unknown, candidatePath: YamlPath) => {
    if (looksLikeSemanticContract(value)) candidates.push({ value, path: candidatePath });
  };

  append(root, []);
  if (Array.isArray(root)) root.forEach((value, index) => append(value, [index]));
  if (!isRecord(root)) return candidates;

  for (const key of ["contract", "semanticContract", "semantic_contract"] as const) {
    if (key in root) append(root[key], [key]);
  }
  for (const key of ["contracts", "semanticContracts", "semantic_contracts"] as const) {
    const value = root[key];
    if (Array.isArray(value)) value.forEach((item, index) => append(item, [key, index]));
  }
  return candidates;
}

function looksLikeSemanticContract(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return "id" in value && "name" in value && "version" in value && "domain" in value && "status" in value;
}

function normalizeContractValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = structuredClone(value);
  if (typeof normalized.version === "number") normalized.version = String(normalized.version);
  if (Array.isArray(normalized.metrics)) {
    normalized.metrics = normalized.metrics.map((metric) => {
      if (!isRecord(metric)) return metric;
      const normalizedMetric = { ...metric };
      if (typeof normalizedMetric.contractVersion === "number") normalizedMetric.contractVersion = String(normalizedMetric.contractVersion);
      return normalizedMetric;
    });
  }
  return normalized;
}

function enrichContractWithProvenance(contract: SemanticContract, provenance: Record<string, unknown>): SemanticContract {
  const sourceMetadata = {
    externalId: provenance.path,
    commitSha: provenance.commitSha,
    blobSha: provenance.blobSha,
    sourceVersion: provenance.version,
    git: provenance
  };
  const assets = contract.assets.map((asset) => ({ ...asset, metadata: { ...asset.metadata, ...sourceMetadata } }));
  const metrics = contract.metrics.map((metric) => ({ ...metric, metadata: { ...metric.metadata, ...sourceMetadata } }));
  return {
    ...contract,
    assets,
    metrics,
    metadata: { ...contract.metadata, ...sourceMetadata }
  };
}

function resolveMetricTarget(contractSources: ContractSource[], selectionText: string, context: Record<string, unknown>): MetricTarget | null {
  let targets: MetricTarget[] = contractSources.flatMap((source) =>
    source.contract.metrics.map((locatedMetric) => ({ ...source, locatedMetric }))
  );
  targets = filterByContext(targets, context);
  if (targets.length === 0) return null;

  const normalizedIntent = normalizePhrase(selectionText);
  const metricMatches = targets.filter((target) => aliasesForMetric(target.locatedMetric.metric).some((alias) => phraseContains(normalizedIntent, alias)));
  if (metricMatches.length === 1) return metricMatches[0] ?? null;
  if (metricMatches.length > 1) return null;

  const contractMatches = targets.filter((target) => aliasesForContract(target.contract.contract).some((alias) => phraseContains(normalizedIntent, alias)));
  if (contractMatches.length === 1) return contractMatches[0] ?? null;
  if (contractMatches.length > 1) targets = contractMatches;
  return targets.length === 1 ? targets[0] ?? null : null;
}

function resolveContractTarget(contractSources: ContractSource[], selectionText: string, context: Record<string, unknown>): ContractSource | null {
  let targets = filterContractSourcesByContext(contractSources, context);
  if (targets.length === 0) return null;
  const normalizedIntent = normalizePhrase(selectionText);
  const matches = targets.filter((target) => aliasesForContract(target.contract.contract).some((alias) => phraseContains(normalizedIntent, alias)));
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1) return null;
  return targets.length === 1 ? targets[0] ?? null : null;
}

function filterByContext(targets: MetricTarget[], context: Record<string, unknown>): MetricTarget[] {
  const pathSelector = contextString(context, ["path", "relativePath", "semanticContractPath"]);
  const contractSelector = contextString(context, ["contractId", "contractName"]);
  const metricSelector = contextString(context, ["metricId", "metricName", "metricLabel"]);
  return targets.filter((target) =>
    (!pathSelector || normalizePhrase(target.relativePath) === normalizePhrase(pathSelector)) &&
    (!contractSelector || aliasesForContract(target.contract.contract).includes(normalizePhrase(contractSelector))) &&
    (!metricSelector || aliasesForMetric(target.locatedMetric.metric).includes(normalizePhrase(metricSelector)))
  );
}

function filterContractSourcesByContext(targets: ContractSource[], context: Record<string, unknown>): ContractSource[] {
  const pathSelector = contextString(context, ["path", "relativePath", "semanticContractPath"]);
  const contractSelector = contextString(context, ["contractId", "contractName"]);
  return targets.filter((target) =>
    (!pathSelector || normalizePhrase(target.relativePath) === normalizePhrase(pathSelector)) &&
    (!contractSelector || aliasesForContract(target.contract.contract).includes(normalizePhrase(contractSelector)))
  );
}

function contextString(context: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseMutationIntent(intent: string): MutationIntent | null {
  const denominatorPatterns = [
    /\buse\s+([\s\S]{1,160}?)\s+as\s+(?:the\s+)?denominator\b/iu,
    /\b(?:set|change|update|replace)\s+(?:the\s+)?denominator\s+(?:to|with|as)\s+([\s\S]{1,160}?)(?=\s+(?:and|then)\s+|[,.;]|$)/iu,
    /\bdenominator\s+(?:should\s+be|is|to|as)\s+([\s\S]{1,160}?)(?=\s+(?:and|then)\s+|[,.;]|$)/iu
  ];
  const versionPatterns = [
    /\b(?:publish|release|bump|set|update|change)(?:\s+(?:the\s+)?)?(?:contract\s+)?version(?:\s+(?:to|as))?\s+["'`]?([A-Za-z0-9][A-Za-z0-9._-]*)["'`]?/iu,
    /\bversion\s+["'`]?([0-9][A-Za-z0-9._-]*)["'`]?/iu
  ];
  const denominatorMatch = denominatorPatterns.map((pattern) => pattern.exec(intent)).find((match) => match !== null) ?? null;
  const versionMatch = versionPatterns.map((pattern) => pattern.exec(intent)).find((match) => match !== null) ?? null;
  const denominatorIdentifier = denominatorMatch?.[1] ? expressionIdentifier(denominatorMatch[1]) : null;
  const version = versionMatch?.[1]?.trim().replace(/[.,;:!?]+$/u, "") || null;
  const publish = /\b(?:publish|release)\b/iu.test(intent);
  if (!denominatorIdentifier && !version && !publish) return null;

  let selectionText = intent;
  if (denominatorMatch?.[0]) selectionText = selectionText.replace(denominatorMatch[0], " ");
  if (versionMatch?.[0]) selectionText = selectionText.replace(versionMatch[0], " ");
  return { denominatorIdentifier, version, publish, selectionText };
}

function expressionIdentifier(value: string): string | null {
  const unquoted = value.trim().replace(/^["'`]+|["'`]+$/gu, "").replace(/^the\s+/iu, "");
  const identifier = unquoted
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9.]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  return identifier.length > 0 && identifier.length <= 255 ? identifier : null;
}

function replaceExpressionDenominator(expression: string, denominator: string): string | null {
  const slashIndex = expression.lastIndexOf("/");
  if (slashIndex < 0 || expression.slice(0, slashIndex).trim().length === 0) return null;
  return `${expression.slice(0, slashIndex).trimEnd()} / ${denominator}`;
}

function readPlannedParameters(candidate: ConnectorActionCandidate): PlannedParameters {
  const relativePath = normalizeRepositoryPath(requiredString(candidate.parameters, ["path", "relativePath"]));
  const beforeContent = requiredString(candidate.parameters, ["beforeContent"]);
  const afterContent = requiredString(candidate.parameters, ["afterContent"]);
  const expectedHead = requiredString(candidate.parameters, ["expectedHead", "expectedHeadSha"]);
  const expectedBlob = requiredString(candidate.parameters, ["expectedBlob", "expectedBlobSha"]);
  const contractPath = yamlPathParameter(candidate.parameters.contractPath, "contractPath", false)!;
  const metricPath = yamlPathParameter(candidate.parameters.metricPath, "metricPath", true);
  const expectedContractFields = recordParameter(candidate.parameters.expectedContractFields, "expectedContractFields");
  const expectedMetricFields = candidate.parameters.expectedMetricFields === null
    ? null
    : recordParameter(candidate.parameters.expectedMetricFields, "expectedMetricFields");
  const commitMessage = singleLine(requiredString(candidate.parameters, ["commitMessage"]));
  if (!commitMessage) throw new Error("The planned Git commit message is empty.");
  if (candidate.before?.content !== beforeContent || candidate.after.content !== afterContent) {
    throw new Error("The candidate diff content does not match its exact planned Git content.");
  }
  return {
    relativePath,
    beforeContent,
    afterContent,
    expectedHead,
    expectedBlob,
    contractPath,
    metricPath,
    expectedContractFields,
    expectedMetricFields,
    commitMessage
  };
}

function assertOptimisticPreconditions(
  state: RepositoryState,
  parameters: PlannedParameters,
  maxFileBytes: number,
  targetPath: string
): void {
  if (state.head !== parameters.expectedHead) {
    throw new Error(`Stale Git HEAD precondition: expected ${parameters.expectedHead}, found ${state.head}.`);
  }
  const entry = treeEntryForPath(state.rootPath, state.head, parameters.relativePath);
  if (!entry || entry.hash !== parameters.expectedBlob) {
    throw new Error(`Stale Git blob precondition for ${parameters.relativePath}: expected ${parameters.expectedBlob}, found ${entry?.hash ?? "missing"}.`);
  }
  if (byteLength(parameters.beforeContent) > maxFileBytes || byteLength(parameters.afterContent) > maxFileBytes) {
    throw new Error(`Planned Git content exceeds maxFileBytes ${maxFileBytes}.`);
  }
  const committedContent = runGit(state.rootPath, ["show", `${state.head}:${parameters.relativePath}`], {
    maxBuffer: Math.max(DEFAULT_GIT_BUFFER_BYTES, byteLength(parameters.beforeContent) + 1024)
  }).toString("utf8");
  if (committedContent !== parameters.beforeContent) throw new Error("The planned before content does not match the expected Git blob.");
  if (fs.readFileSync(targetPath, "utf8") !== parameters.beforeContent || gitPathStatus(state.rootPath, parameters.relativePath).length > 0) {
    throw new Error(`Git target has uncommitted changes and will not be overwritten: ${parameters.relativePath}`);
  }
}

function contentMatchesExpectedFields(
  content: string,
  contractPath: YamlPath,
  metricPath: YamlPath | null,
  expectedContractFields: Record<string, unknown>,
  expectedMetricFields: Record<string, unknown> | null
): boolean {
  try {
    const fields = readExpectedFields(content, contractPath, metricPath);
    if (!recordContains(fields.contract, expectedContractFields)) return false;
    if (expectedMetricFields && !recordContains(fields.metric, expectedMetricFields)) return false;
    return !expectedMetricFields || fields.metric !== null;
  } catch {
    return false;
  }
}

function readExpectedFields(content: string, contractPath: YamlPath, metricPath: YamlPath | null): {
  contract: Record<string, unknown> | null;
  metric: Record<string, unknown> | null;
} {
  const document = parseDocument(content, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join("; "));
  const root = document.toJS({ mapAsMap: false }) as unknown;
  return {
    contract: valueAtPath(root, contractPath),
    metric: metricPath ? valueAtPath(root, metricPath) : null
  };
}

function valueAtPath(root: unknown, valuePath: YamlPath): Record<string, unknown> | null {
  let value = root;
  for (const segment of valuePath) {
    if (typeof segment === "number") {
      if (!Array.isArray(value) || segment < 0 || segment >= value.length) return null;
      value = value[segment];
    } else {
      if (!isRecord(value) || !(segment in value)) return null;
      value = value[segment];
    }
  }
  return isRecord(value) ? value : null;
}

function recordContains(actual: Record<string, unknown> | null, expected: Record<string, unknown>): boolean {
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => Object.is(actual[key], value));
}

function resolveRegularFileInsideRepository(repositoryPath: string, relativePath: string): string {
  const normalized = normalizeRepositoryPath(relativePath);
  const rootPath = fs.realpathSync(repositoryPath);
  const targetPath = path.resolve(rootPath, ...normalized.split("/"));
  assertPathInside(rootPath, targetPath);
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Git semantic-contract target must be a regular file: ${normalized}`);
  const realTargetPath = fs.realpathSync(targetPath);
  assertPathInside(rootPath, realTargetPath);
  return realTargetPath;
}

function assertPathInside(repositoryPath: string, candidatePath: string): void {
  const relative = path.relative(repositoryPath, candidatePath);
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Git path escapes or resolves to the repository root: ${candidatePath}`);
  }
}

function normalizeRepositoryPath(value: string, allowRoot = false): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    throw new Error(`Unsafe repository-relative path: ${value}`);
  }
  const portable = trimmed.replace(/\\/gu, "/");
  const segments = portable.split("/");
  if (segments.some((segment) => segment === ".." || segment.toLowerCase() === ".git")) {
    throw new Error(`Unsafe repository-relative path: ${value}`);
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//u, "").replace(/\/$/u, "");
  if ((!allowRoot && normalized === ".") || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Unsafe repository-relative path: ${value}`);
  }
  return normalized;
}

function isWithinIncludes(relativePath: string, includePaths: string[]): boolean {
  return includePaths.length === 0 || includePaths.some((includePath) =>
    includePath === "." || relativePath === includePath || relativePath.startsWith(`${includePath}/`)
  );
}

function isRegularGitBlob(entry: GitTreeEntry): boolean {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

function isSupportedTextPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  const extension = path.posix.extname(basename);
  return SUPPORTED_EXTENSIONS.has(extension) || SUPPORTED_EXTENSIONLESS_FILES.has(basename);
}

function isYamlPath(relativePath: string): boolean {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return extension === ".yaml" || extension === ".yml";
}

function mimeTypeFor(relativePath: string): string {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case ".csv": return "text/csv";
    case ".css": return "text/css";
    case ".htm":
    case ".html": return "text/html";
    case ".js":
    case ".jsx": return "text/javascript";
    case ".json": return "application/json";
    case ".jsonl": return "application/x-ndjson";
    case ".md":
    case ".mdx": return "text/markdown";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".xml": return "application/xml";
    default: return "text/plain";
  }
}

function gitFileUri(repositoryPath: string, commitSha: string, relativePath: string): string {
  const url = pathToFileURL(repositoryPath);
  url.protocol = "git+file:";
  url.searchParams.set("ref", commitSha);
  url.hash = encodeURIComponent(relativePath);
  return url.href;
}

function gitProvenance(state: RepositoryState, entry: GitTreeEntry): Record<string, unknown> {
  return {
    repositoryPath: state.rootPath,
    path: entry.relativePath,
    commitSha: state.head,
    blobSha: entry.hash,
    version: `${state.head}:${entry.hash}`
  };
}

function gitPathStatus(repositoryPath: string, relativePath: string): string[] {
  return gitNulList(repositoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", relativePath]);
}

function indexBlobForPath(repositoryPath: string, relativePath: string): string | null {
  const output = runGit(repositoryPath, ["ls-files", "--stage", "-z", "--", relativePath]);
  const record = splitNulBuffers(output)[0];
  if (!record) return null;
  const tabIndex = record.indexOf(9);
  if (tabIndex < 0) return null;
  const fields = record.subarray(0, tabIndex).toString("utf8").trim().split(/\s+/u);
  return fields[1] ?? null;
}

function runGit(
  repositoryPath: string,
  args: string[],
  options: { input?: Buffer; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}
): Buffer {
  const result = spawnSync("git", [...SAFE_GIT_CONFIG, "-C", repositoryPath, ...args], {
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    cwd: repositoryPath,
    env: {
      ...(options.env ?? process.env),
      GIT_TERMINAL_PROMPT: "0"
    },
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_GIT_BUFFER_BYTES,
    windowsHide: true
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  if (result.error) throw new Error(`Unable to execute Git: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    const detail = stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || `exit status ${String(result.status)}`;
    throw new Error(`Git ${args[0] ?? "command"} failed: ${detail}`);
  }
  return stdout;
}

function gitLine(
  repositoryPath: string,
  args: string[],
  options: { input?: Buffer; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}
): string {
  return runGit(repositoryPath, args, options).toString("utf8").trim();
}

function gitNulList(repositoryPath: string, args: string[]): string[] {
  return splitNulBuffers(runGit(repositoryPath, args)).map((value) => value.toString("utf8"));
}

function splitNulBuffers(value: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index > start) records.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start < value.length) records.push(value.subarray(start));
  return records;
}

function yamlPathParameter(value: unknown, label: string, nullable: boolean): YamlPath | null {
  if (nullable && value === null) return null;
  if (!Array.isArray(value) || value.some((segment) =>
    !(typeof segment === "string" && segment.length > 0) && !(typeof segment === "number" && Number.isInteger(segment) && segment >= 0)
  )) {
    throw new Error(`Invalid planned YAML ${label}.`);
  }
  return [...value] as YamlPath;
}

function requiredString(parameters: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`Missing planned Git parameter: ${keys.join(" or ")}.`);
}

function recordParameter(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid planned Git parameter: ${label}.`);
  return value;
}

function aliasesForMetric(metric: MetricDefinition): string[] {
  return [...new Set([metric.id, metric.name, metric.label].map(normalizePhrase).filter((value) => value.length >= 3))];
}

function aliasesForContract(contract: SemanticContract): string[] {
  return [...new Set([
    contract.id,
    contract.name,
    contract.id.replace(/^contract[_\s-]+/iu, ""),
    contract.name.replace(/\bsemantic\s+contract\b/iu, "")
  ].map(normalizePhrase).filter((value) => value.length >= 3))];
}

function normalizePhrase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function phraseContains(normalizedText: string, normalizedAlias: string): boolean {
  return normalizedText === normalizedAlias || normalizedText.startsWith(`${normalizedAlias} `) ||
    normalizedText.endsWith(` ${normalizedAlias}`) || normalizedText.includes(` ${normalizedAlias} `);
}

function deduplicateById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function formatYamlPath(valuePath: YamlPath): string {
  return valuePath.length === 0 ? "$" : `$.${valuePath.join(".")}`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim().slice(0, 240);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
