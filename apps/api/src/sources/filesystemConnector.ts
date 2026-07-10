import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  IngestRequest,
  LineageEdge,
  MetricDefinition,
  SemanticAsset,
  SemanticContract,
  SourceConnection,
  SourceResource
} from "@semantic-junkyard/shared";
import { parse as parseYaml } from "yaml";
import { stableId } from "../core/hash.js";
import type {
  ConnectorSemanticRelation,
  ConnectorSnapshot,
  ConnectorTestResult,
  SourceConnector
} from "./connector.js";

const SUPPORTED_EXTENSIONS = new Set(["txt", "md", "html", "json", "jsonl", "csv", "yaml", "yml", "pdf"]);
const DATASET_EXTENSIONS = new Set(["json", "jsonl", "csv"]);
const MAX_INGEST_TEXT_CHARS = 5_000_000;
const PDF_PARSE_TIMEOUT_MS = 30_000;

const MIME_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf"
};

const PDF_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.controlBuffer);
const output = new Uint8Array(workerData.outputBuffer);
const encoder = new TextEncoder();

function publish(status, value, pageCount, truncated) {
  const encoded = encoder.encode(value);
  if (encoded.length > output.length) {
    throw new Error("Extracted PDF text exceeds the connector output buffer.");
  }
  output.set(encoded);
  Atomics.store(control, 1, encoded.length);
  Atomics.store(control, 2, pageCount);
  Atomics.store(control, 3, truncated ? 1 : 0);
  Atomics.store(control, 0, status);
  Atomics.notify(control, 0);
}

(async () => {
  let parser;
  try {
    const { PDFParse } = await import(workerData.moduleUrl);
    parser = new PDFParse({ data: workerData.pdfData });
    const result = await parser.getText();
    const fullText = typeof result.text === "string" ? result.text : "";
    const truncated = fullText.length > workerData.maxChars;
    await parser.destroy();
    parser = undefined;
    publish(1, fullText.slice(0, workerData.maxChars), Number(result.total) || 0, truncated);
  } catch (error) {
    if (parser) {
      try {
        await parser.destroy();
      } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      publish(2, message.slice(0, 16_000), 0, false);
    } catch {
      Atomics.store(control, 0, 2);
      Atomics.notify(control, 0);
    }
  } finally {
    parentPort?.close();
  }
})();
`;

type FilesystemConfig = Extract<SourceConnection["config"], { kind: "filesystem" }>;

interface RootInspection {
  realPath: string;
}

interface FileCandidate {
  absolutePath: string;
  relativePath: string;
  extension: string;
  stats: Stats;
}

interface ReadFileResult {
  buffer: Buffer;
  stats: Stats;
}

interface PdfText {
  text: string;
  pageCount: number;
  truncated: boolean;
}

interface SchemaField {
  name: string;
  type: string;
  types: string[];
  nullable: boolean;
  required: boolean;
}

interface StructuredProfile {
  profile: Record<string, unknown>;
  values: unknown[];
  warnings: string[];
}

interface ParsedMetric {
  name: string;
  label: string;
  description: string;
  expression: string;
  dimensions: string[];
  owner: string;
  domain: string;
  declaredFields: string[];
}

interface ParsedSemanticContract {
  name: string;
  version: string;
  domain: string;
  status: SemanticContract["status"];
  owner: string;
  description: string;
  metrics: ParsedMetric[];
  declaredFields: string[];
}

interface OpenLineageEvent {
  eventType: string;
  runId: string;
  job: OpenLineageObject;
  inputs: OpenLineageObject[];
  outputs: OpenLineageObject[];
}

interface OpenLineageObject {
  namespace: string;
  name: string;
  facets: Record<string, unknown>;
}

interface SnapshotState {
  resources: Map<string, SourceResource>;
  documents: ConnectorSnapshot["documents"];
  assets: Map<string, SemanticAsset>;
  metrics: Map<string, MetricDefinition>;
  lineage: Map<string, LineageEdge>;
  contracts: Map<string, SemanticContract>;
  relations: Map<string, ConnectorSemanticRelation>;
  warnings: string[];
}

export class FilesystemConnector implements SourceConnector {
  readonly kind = "filesystem" as const;

  test(connection: SourceConnection): ConnectorTestResult {
    const config = filesystemConfig(connection);
    if (!config) {
      return {
        ok: false,
        message: "Connection kind and configuration must both be filesystem.",
        details: { connectionKind: connection.kind, configKind: connection.config.kind }
      };
    }

    try {
      const root = inspectRoot(config.rootPath);
      const warnings: string[] = [];
      const candidates = collectCandidates(root.realPath, config.recursive, warnings);
      return {
        ok: true,
        message: "Filesystem source is a readable directory.",
        details: {
          rootPath: root.realPath,
          recursive: config.recursive,
          supportedFiles: candidates.length,
          maxFiles: config.maxFiles,
          maxFileBytes: config.maxFileBytes,
          warnings
        }
      };
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error),
        details: { rootPath: path.resolve(config.rootPath) }
      };
    }
  }

  discover(connection: SourceConnection): ConnectorSnapshot {
    const config = filesystemConfig(connection);
    if (!config) {
      throw new Error("FilesystemConnector requires a filesystem connection and configuration.");
    }

    const root = inspectRoot(config.rootPath);
    const observedAt = new Date().toISOString();
    const state: SnapshotState = {
      resources: new Map(),
      documents: [],
      assets: new Map(),
      metrics: new Map(),
      lineage: new Map(),
      contracts: new Map(),
      relations: new Map(),
      warnings: []
    };
    const candidates = collectCandidates(root.realPath, config.recursive, state.warnings);
    const eligible = candidates.filter((candidate) => {
      if (candidate.stats.size <= config.maxFileBytes) return true;
      state.warnings.push(
        `Skipped ${candidate.relativePath}: ${candidate.stats.size} bytes exceeds maxFileBytes (${config.maxFileBytes}).`
      );
      return false;
    });
    const selected = eligible.slice(0, config.maxFiles);
    if (eligible.length > selected.length) {
      state.warnings.push(
        `maxFiles limit (${config.maxFiles}) reached; skipped ${eligible.length - selected.length} supported file(s).`
      );
    }

    const fingerprints: string[] = [];
    for (const candidate of selected) {
      try {
        const file = readRegularFile(candidate.absolutePath);
        if (file.stats.size > config.maxFileBytes) {
          state.warnings.push(
            `Skipped ${candidate.relativePath}: file grew to ${file.stats.size} bytes, exceeding maxFileBytes (${config.maxFileBytes}).`
          );
          continue;
        }
        const contentHash = hashBuffer(file.buffer);
        fingerprints.push(`${candidate.relativePath}:${contentHash}`);
        this.inspectFile(connection, config, candidate, file, contentHash, observedAt, state);
      } catch (error) {
        state.warnings.push(`Skipped ${candidate.relativePath}: ${errorMessage(error)}`);
      }
    }

    return {
      resources: sortBy([...state.resources.values()], (resource) => resource.externalId),
      documents: sortBy(state.documents, (document) => document.resourceExternalId),
      assets: sortBy([...state.assets.values()], (asset) => asset.id),
      metrics: sortBy([...state.metrics.values()], (metric) => metric.id),
      lineage: sortBy([...state.lineage.values()], (edge) => edge.id),
      contracts: sortBy([...state.contracts.values()], (contract) => contract.id),
      ontologyClasses: [],
      relations: sortBy([...state.relations.values()], relationKey),
      warnings: state.warnings,
      checkpoint: {
        rootPath: root.realPath,
        recursive: config.recursive,
        filesConsidered: candidates.length,
        filesProcessed: fingerprints.length,
        fingerprint: hashText(fingerprints.sort(compareStrings).join("\n"))
      }
    };
  }

  private inspectFile(
    connection: SourceConnection,
    config: FilesystemConfig,
    candidate: FileCandidate,
    file: ReadFileResult,
    contentHash: string,
    observedAt: string,
    state: SnapshotState
  ): void {
    const uri = pathToFileURL(candidate.absolutePath).href;
    const mimeType = MIME_TYPES[candidate.extension];
    const baseProfile: Record<string, unknown> = {
      format: normalizedFormat(candidate.extension),
      sizeBytes: file.stats.size,
      contentHash,
      modifiedAt: file.stats.mtime.toISOString()
    };
    let extractedText: string;
    let values: unknown[] = [];
    let semanticContract: ParsedSemanticContract | null = null;

    if (candidate.extension === "pdf") {
      const pdf = extractPdfText(file.buffer);
      extractedText = pdf.text;
      baseProfile.pageCount = pdf.pageCount;
      if (pdf.truncated) {
        state.warnings.push(
          `Truncated extracted PDF text for ${candidate.relativePath} to ${MAX_INGEST_TEXT_CHARS} characters.`
        );
      }
    } else {
      extractedText = decodeUtf8(file.buffer);
    }

    if (candidate.extension === "json" || candidate.extension === "jsonl") {
      const structured = profileJson(extractedText, candidate.extension);
      Object.assign(baseProfile, structured.profile);
      values = structured.values;
      state.warnings.push(...structured.warnings.map((warning) => `${candidate.relativePath}: ${warning}`));
    } else if (candidate.extension === "csv") {
      const structured = profileCsv(extractedText);
      Object.assign(baseProfile, structured.profile);
      state.warnings.push(...structured.warnings.map((warning) => `${candidate.relativePath}: ${warning}`));
    } else if (candidate.extension === "yaml" || candidate.extension === "yml") {
      try {
        semanticContract = parseSemanticContract(parseYaml(extractedText));
      } catch (error) {
        state.warnings.push(`${candidate.relativePath}: invalid YAML (${errorMessage(error)}).`);
      }
    }

    const openLineageEvents = values.flatMap(readOpenLineageEvent);
    if (openLineageEvents.length > 0) baseProfile.openLineageEventCount = openLineageEvents.length;
    if (semanticContract) {
      Object.assign(baseProfile, {
        semanticContract: true,
        contractName: semanticContract.name,
        contractVersion: semanticContract.version,
        contractDomain: semanticContract.domain,
        contractStatus: semanticContract.status,
        metricCount: semanticContract.metrics.length
      });
    }

    const fileExternalId = `file:${candidate.relativePath}`;
    const fileResource = makeResource({
      connection,
      externalId: fileExternalId,
      parentId: null,
      kind: "file",
      name: path.basename(candidate.absolutePath),
      qualifiedName: candidate.relativePath,
      dataType: mimeType,
      description: `Filesystem file ${candidate.relativePath}`,
      uri,
      profile: baseProfile,
      metadata: {
        connector: this.kind,
        relativePath: candidate.relativePath,
        extension: candidate.extension,
        ingestionMode: config.ingestionMode
      },
      observedAt
    });
    addResource(state, fileResource);

    const typedExternalId = semanticContract
      ? `semantic_contract:${candidate.relativePath}`
      : DATASET_EXTENSIONS.has(candidate.extension)
        ? `dataset:${candidate.relativePath}`
        : `document:${candidate.relativePath}`;
    const typedKind: SourceResource["kind"] = semanticContract
      ? "semantic_contract"
      : DATASET_EXTENSIONS.has(candidate.extension)
        ? "dataset"
        : "document";
    const typedResource = makeResource({
      connection,
      externalId: typedExternalId,
      parentId: fileResource.id,
      kind: typedKind,
      name: semanticContract?.name ?? path.basename(candidate.absolutePath),
      qualifiedName: semanticContract
        ? `${semanticContract.domain}.${semanticContract.name}@${semanticContract.version}`
        : candidate.relativePath,
      dataType: mimeType,
      description: semanticContract?.description ?? `${formatLabel(candidate.extension)} indexed from ${candidate.relativePath}`,
      uri,
      profile: baseProfile,
      metadata: {
        connector: this.kind,
        sourceFileExternalId: fileExternalId,
        relativePath: candidate.relativePath
      },
      observedAt
    });
    addResource(state, typedResource);

    addRelation(state, {
      subjectExternalId: typedExternalId,
      predicate: "INDEXED_FROM",
      objectExternalId: fileExternalId,
      confidence: 1,
      explanation: "The typed resource is a deterministic representation of this filesystem file.",
      authoritative: false
    });

    let requestText = config.ingestionMode === "full_data" ? extractedText : "";
    if (requestText.length > MAX_INGEST_TEXT_CHARS) {
      requestText = requestText.slice(0, MAX_INGEST_TEXT_CHARS);
      state.warnings.push(
        `Truncated ${candidate.relativePath} to ${MAX_INGEST_TEXT_CHARS} characters to satisfy the ingestion contract.`
      );
    }
    if (config.ingestionMode !== "full_data" || requestText.length > 0) {
      const request: IngestRequest = {
        name: path.basename(candidate.absolutePath),
        text: requestText,
        uri,
        mimeType,
        ingestionMode: config.ingestionMode,
        metadata: {
          connector: this.kind,
          connectionId: connection.id,
          resourceExternalId: typedExternalId,
          relativePath: candidate.relativePath,
          sizeBytes: file.stats.size,
          modifiedAt: file.stats.mtime.toISOString(),
          contentHash,
          profile: baseProfile
        }
      };
      state.documents.push({ resourceExternalId: typedExternalId, request });
    } else {
      state.warnings.push(`Skipped empty full-data document ${candidate.relativePath}.`);
    }

    if (semanticContract) {
      this.publishSemanticContract(
        connection,
        candidate,
        semanticContract,
        typedResource,
        uri,
        observedAt,
        state
      );
    }
    for (const event of openLineageEvents) {
      this.publishOpenLineage(connection, candidate, event, fileResource, uri, observedAt, state);
    }
  }

  private publishSemanticContract(
    connection: SourceConnection,
    candidate: FileCandidate,
    parsed: ParsedSemanticContract,
    contractResource: SourceResource,
    uri: string,
    observedAt: string,
    state: SnapshotState
  ): void {
    const contractId = stableId("contract", `${parsed.domain}:${parsed.name}:${parsed.version}`);
    const metricDefinitions = parsed.metrics.map<MetricDefinition>((metric) => ({
      id: stableId("metric", `${contractId}:${metric.name}`),
      name: metric.name,
      label: metric.label,
      description: metric.description,
      expression: metric.expression,
      dimensions: metric.dimensions,
      owner: metric.owner,
      domain: metric.domain,
      contractVersion: parsed.version,
      metadata: {
        source: "filesystem-semantic-contract",
        sourceResourceExternalId: contractResource.externalId,
        declaredFields: metric.declaredFields
      }
    }));
    const contract: SemanticContract = {
      id: contractId,
      name: parsed.name,
      version: parsed.version,
      domain: parsed.domain,
      status: parsed.status,
      assets: [],
      metrics: metricDefinitions,
      policies: [],
      ontologyClasses: [],
      metadata: {
        source: "filesystem-semantic-contract",
        sourceUri: uri,
        sourceResourceExternalId: contractResource.externalId,
        declaredFields: parsed.declaredFields
      }
    };
    state.contracts.set(contract.id, contract);

    const contractAsset: SemanticAsset = {
      id: stableId("asset", `semantic-contract:${contract.id}`),
      kind: "semantic_contract",
      name: contract.name,
      domain: contract.domain,
      owner: parsed.owner,
      description: parsed.description,
      sensitivity: "internal",
      freshness: "unknown",
      qualityScore: 1,
      uri,
      metadata: {
        externalId: contractResource.externalId,
        contractId: contract.id,
        version: contract.version,
        status: contract.status,
        sourceResourceExternalId: contractResource.externalId
      }
    };
    state.assets.set(contractAsset.id, contractAsset);

    for (const metric of metricDefinitions) {
      state.metrics.set(metric.id, metric);
      const metricExternalId = `metric:${candidate.relativePath}:${metric.name}`;
      const metricResource = makeResource({
        connection,
        externalId: metricExternalId,
        parentId: contractResource.id,
        kind: "metric",
        name: metric.name,
        qualifiedName: `${metric.domain}.${metric.name}`,
        dataType: "metric",
        description: metric.description,
        uri: `${uri}#metric=${encodeURIComponent(metric.name)}`,
        profile: {
          label: metric.label,
          expression: metric.expression,
          dimensions: metric.dimensions,
          owner: metric.owner,
          domain: metric.domain,
          contractVersion: metric.contractVersion
        },
        metadata: {
          connector: this.kind,
          contractId,
          contractResourceExternalId: contractResource.externalId
        },
        observedAt
      });
      addResource(state, metricResource);
      addRelation(state, {
        subjectExternalId: contractResource.externalId,
        predicate: "DEFINES_METRIC",
        objectExternalId: metricExternalId,
        confidence: 1,
        explanation: "The metric is explicitly declared by the semantic contract.",
        authoritative: true
      });

      const metricAsset: SemanticAsset = {
        id: stableId("asset", `metric:${metric.id}`),
        kind: "metric",
        name: metric.name,
        domain: metric.domain,
        owner: metric.owner,
        description: metric.description,
        sensitivity: "internal",
        freshness: "unknown",
        qualityScore: 1,
        uri: metricResource.uri,
        metadata: { externalId: metricExternalId, metricId: metric.id, contractId, sourceResourceExternalId: metricExternalId }
      };
      state.assets.set(metricAsset.id, metricAsset);
      const edge: LineageEdge = {
        id: stableId("lineage", `${contractAsset.id}:GOVERNS:${metricAsset.id}`),
        fromAssetId: contractAsset.id,
        toAssetId: metricAsset.id,
        type: "GOVERNS",
        confidence: 1,
        metadata: { source: "semantic-contract", contractId }
      };
      state.lineage.set(edge.id, edge);
    }
  }

  private publishOpenLineage(
    connection: SourceConnection,
    candidate: FileCandidate,
    event: OpenLineageEvent,
    fileResource: SourceResource,
    sourceUri: string,
    observedAt: string,
    state: SnapshotState
  ): void {
    const jobAsset = openLineageAsset("job", event.job, sourceUri, event);
    state.assets.set(jobAsset.id, state.assets.get(jobAsset.id) ?? jobAsset);
    addResource(
      state,
      openLineageResource(connection, "job", event.job, fileResource, sourceUri, observedAt, event)
    );

    for (const input of event.inputs) {
      const datasetAsset = openLineageAsset("dataset", input, sourceUri, event);
      state.assets.set(datasetAsset.id, state.assets.get(datasetAsset.id) ?? datasetAsset);
      addResource(
        state,
        openLineageResource(connection, "dataset", input, fileResource, sourceUri, observedAt, event, "input")
      );
      const edge: LineageEdge = {
        id: stableId("lineage", `${jobAsset.id}:READS:${datasetAsset.id}`),
        fromAssetId: jobAsset.id,
        toAssetId: datasetAsset.id,
        type: "READS",
        confidence: 1,
        metadata: {
          source: "OpenLineage",
          eventType: event.eventType,
          runId: event.runId,
          sourcePath: candidate.relativePath
        }
      };
      state.lineage.set(edge.id, state.lineage.get(edge.id) ?? edge);
    }

    for (const output of event.outputs) {
      const datasetAsset = openLineageAsset("dataset", output, sourceUri, event);
      state.assets.set(datasetAsset.id, state.assets.get(datasetAsset.id) ?? datasetAsset);
      addResource(
        state,
        openLineageResource(connection, "dataset", output, fileResource, sourceUri, observedAt, event, "output")
      );
      const edge: LineageEdge = {
        id: stableId("lineage", `${jobAsset.id}:WRITES:${datasetAsset.id}`),
        fromAssetId: jobAsset.id,
        toAssetId: datasetAsset.id,
        type: "WRITES",
        confidence: 1,
        metadata: {
          source: "OpenLineage",
          eventType: event.eventType,
          runId: event.runId,
          sourcePath: candidate.relativePath
        }
      };
      state.lineage.set(edge.id, state.lineage.get(edge.id) ?? edge);
    }
  }
}

function filesystemConfig(connection: SourceConnection): FilesystemConfig | null {
  return connection.kind === "filesystem" && connection.config.kind === "filesystem" ? connection.config : null;
}

function inspectRoot(rootPath: string): RootInspection {
  const configuredPath = path.resolve(rootPath);
  const stats = lstatSync(configuredPath);
  if (stats.isSymbolicLink()) throw new Error("Filesystem root must not be a symbolic link.");
  if (!stats.isDirectory()) throw new Error("Filesystem root must be a directory.");
  accessSync(configuredPath, constants.R_OK);
  return { realPath: realpathSync(configuredPath) };
}

function collectCandidates(rootPath: string, recursive: boolean, warnings: string[]): FileCandidate[] {
  const candidates: FileCandidate[] = [];

  const visit = (directory: string, relativeDirectory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareStrings(left.name, right.name));
    } catch (error) {
      warnings.push(`Could not inspect ${relativeDirectory || "."}: ${errorMessage(error)}`);
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.join(relativeDirectory, entry.name));
      let stats: Stats;
      try {
        stats = lstatSync(absolutePath);
      } catch (error) {
        warnings.push(`Could not inspect ${relativePath}: ${errorMessage(error)}`);
        continue;
      }
      if (stats.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link: ${relativePath}`);
        continue;
      }
      if (stats.isDirectory()) {
        if (recursive) {
          let realDirectory: string;
          try {
            realDirectory = realpathSync(absolutePath);
          } catch (error) {
            warnings.push(`Could not resolve ${relativePath}: ${errorMessage(error)}`);
            continue;
          }
          if (!isWithinRoot(rootPath, realDirectory)) {
            warnings.push(`Skipped directory outside root: ${relativePath}`);
          } else {
            visit(absolutePath, relativePath);
          }
        }
        continue;
      }
      if (!stats.isFile()) continue;
      const extension = extensionOf(entry.name);
      if (!SUPPORTED_EXTENSIONS.has(extension)) continue;
      candidates.push({ absolutePath, relativePath, extension, stats });
    }
  };

  visit(rootPath, "");
  return sortBy(candidates, (candidate) => candidate.relativePath);
}

function readRegularFile(filePath: string): ReadFileResult {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("Path is no longer a regular file.");
    return { buffer: readFileSync(descriptor), stats };
  } finally {
    closeSync(descriptor);
  }
}

function extractPdfText(buffer: Buffer): PdfText {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
  const outputBuffer = new SharedArrayBuffer(MAX_INGEST_TEXT_CHARS * 4 + 16_384);
  const control = new Int32Array(controlBuffer);
  const output = new Uint8Array(outputBuffer);
  const require = createRequire(import.meta.url);
  const moduleUrl = pathToFileURL(require.resolve("pdf-parse")).href;
  const worker = new Worker(PDF_WORKER_SOURCE, {
    eval: true,
    workerData: {
      controlBuffer,
      outputBuffer,
      pdfData: buffer,
      moduleUrl,
      maxChars: MAX_INGEST_TEXT_CHARS
    }
  });
  worker.on("error", () => undefined);
  const waitResult = Atomics.wait(control, 0, 0, PDF_PARSE_TIMEOUT_MS);
  if (waitResult === "timed-out") {
    void worker.terminate().catch(() => undefined);
    throw new Error(`PDF parsing timed out after ${PDF_PARSE_TIMEOUT_MS}ms.`);
  }
  const status = Atomics.load(control, 0);
  const length = Atomics.load(control, 1);
  const value = new TextDecoder().decode(output.subarray(0, length));
  void worker.terminate().catch(() => undefined);
  if (status !== 1) throw new Error(`PDF parsing failed${value ? `: ${value}` : "."}`);
  return {
    text: value,
    pageCount: Atomics.load(control, 2),
    truncated: Atomics.load(control, 3) === 1
  };
}

function profileJson(text: string, extension: "json" | "jsonl"): StructuredProfile {
  const values: unknown[] = [];
  const warnings: string[] = [];
  if (extension === "json") {
    try {
      const value: unknown = JSON.parse(text);
      values.push(...(Array.isArray(value) ? value : [value]));
    } catch (error) {
      warnings.push(`invalid JSON (${errorMessage(error)}).`);
      return { profile: { recordCount: 0, schema: { fields: [] }, parseError: true }, values, warnings };
    }
  } else {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        values.push(JSON.parse(line) as unknown);
      } catch (error) {
        warnings.push(`invalid JSONL record on line ${index + 1} (${errorMessage(error)}).`);
      }
    }
  }
  const fields = inferObjectFields(values);
  return {
    profile: {
      recordCount: values.length,
      objectRecordCount: values.filter(isRecord).length,
      rootTypes: orderedTypes(new Set(values.map(jsonType))),
      schema: { fields }
    },
    values,
    warnings
  };
}

function profileCsv(text: string): StructuredProfile {
  try {
    const rows = parseCsv(text);
    if (rows.length === 0) {
      return { profile: { recordCount: 0, schema: { fields: [] } }, values: [], warnings: [] };
    }
    const header = rows[0];
    const records = rows.slice(1).filter((row) => row.some((value) => value.length > 0));
    const width = Math.max(header.length, ...records.map((row) => row.length));
    const names = uniqueColumnNames(header, width);
    const fields: SchemaField[] = names.map((name, index) => {
      const values = records.map((record) => record[index]);
      const types = orderedTypes(new Set(values.map(csvType)));
      const nonNullTypes = types.filter((type) => type !== "null");
      const nullable = values.some((value) => value === undefined || value.trim() === "");
      return {
        name,
        type: collapsedType(nonNullTypes.length > 0 ? nonNullTypes : ["null"]),
        types,
        nullable,
        required: !nullable
      };
    });
    return {
      profile: { recordCount: records.length, columnCount: fields.length, schema: { fields } },
      values: [],
      warnings: []
    };
  } catch (error) {
    return {
      profile: { recordCount: 0, schema: { fields: [] }, parseError: true },
      values: [],
      warnings: [`invalid CSV (${errorMessage(error)}).`]
    };
  }
}

function inferObjectFields(values: unknown[]): SchemaField[] {
  const records = values.filter(isRecord);
  const names = new Set<string>();
  for (const record of records) {
    for (const name of Object.keys(record)) names.add(name);
  }
  return [...names].sort(compareStrings).map((name) => {
    const presentValues = records.filter((record) => Object.hasOwn(record, name)).map((record) => record[name]);
    const types = orderedTypes(new Set(presentValues.map(jsonType)));
    const nonNullTypes = types.filter((type) => type !== "null");
    const nullable = presentValues.length < values.length || types.includes("null");
    return {
      name,
      type: collapsedType(nonNullTypes.length > 0 ? nonNullTypes : ["null"]),
      types,
      nullable,
      required: !nullable
    };
  });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

function uniqueColumnNames(header: string[], width: number): string[] {
  const counts = new Map<string, number>();
  const names: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const base = header[index]?.trim() || `column_${index + 1}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    names.push(count === 1 ? base : `${base}_${count}`);
  }
  return names;
}

function parseSemanticContract(value: unknown): ParsedSemanticContract | null {
  if (!isRecord(value)) return null;
  if (!("name" in value && "version" in value && "domain" in value && "status" in value && "metrics" in value)) {
    return null;
  }
  const name = stringValue(value.name);
  const version = scalarString(value.version);
  const domain = stringValue(value.domain);
  const normalizedStatus = stringValue(value.status).toLowerCase();
  if (!name || !version || !domain || !isContractStatus(normalizedStatus)) return null;

  const owner = stringValue(value.owner);
  const declaredMetrics = value.metrics;
  const metricEntries: Array<{ key: string | null; value: unknown }> = Array.isArray(declaredMetrics)
    ? declaredMetrics.map((metric) => ({ key: null, value: metric }))
    : isRecord(declaredMetrics)
      ? Object.keys(declaredMetrics).sort(compareStrings).map((key) => ({ key, value: declaredMetrics[key] }))
      : [];
  const metrics = metricEntries.flatMap(({ key, value: metricValue }) => {
    if (typeof metricValue === "string" && key) {
      return [{
        name: key,
        label: key,
        description: "",
        expression: metricValue,
        dimensions: [],
        owner,
        domain,
        declaredFields: ["expression", "name"]
      } satisfies ParsedMetric];
    }
    if (!isRecord(metricValue)) return [];
    const metricName = stringValue(metricValue.name) || key || "";
    if (!metricName) return [];
    return [{
      name: metricName,
      label: stringValue(metricValue.label) || metricName,
      description: stringValue(metricValue.description),
      expression: stringValue(metricValue.expression),
      dimensions: Array.isArray(metricValue.dimensions) ? metricValue.dimensions.filter(isString) : [],
      owner: stringValue(metricValue.owner) || owner,
      domain: stringValue(metricValue.domain) || domain,
      declaredFields: Object.keys(metricValue).sort(compareStrings)
    } satisfies ParsedMetric];
  }).sort((left, right) => compareStrings(left.name, right.name));

  return {
    name,
    version,
    domain,
    status: normalizedStatus,
    owner,
    description: stringValue(value.description),
    metrics,
    declaredFields: Object.keys(value).sort(compareStrings)
  };
}

function readOpenLineageEvent(value: unknown): OpenLineageEvent[] {
  if (!isRecord(value) || typeof value.eventType !== "string" || !isRecord(value.job) || !isRecord(value.run)) return [];
  const [job] = readOpenLineageObject(value.job);
  const runId = stringValue(value.run.runId);
  if (!job || !runId) return [];
  return [{
    eventType: value.eventType,
    runId,
    job,
    inputs: Array.isArray(value.inputs) ? value.inputs.flatMap(readOpenLineageObject) : [],
    outputs: Array.isArray(value.outputs) ? value.outputs.flatMap(readOpenLineageObject) : []
  }];
}

function readOpenLineageObject(value: unknown): OpenLineageObject[] {
  if (!isRecord(value)) return [];
  const namespace = stringValue(value.namespace);
  const name = stringValue(value.name);
  if (!namespace || !name) return [];
  return [{ namespace, name, facets: isRecord(value.facets) ? value.facets : {} }];
}

function openLineageAsset(
  type: "job" | "dataset",
  object: OpenLineageObject,
  sourceUri: string,
  event: OpenLineageEvent
): SemanticAsset {
  const id = stableId("asset", `openlineage:${type}:${object.namespace}:${object.name}`);
  const externalId = `openlineage:${type}:${object.namespace}:${object.name}`;
  return {
    id,
    kind: type === "job" ? "pipeline" : "dataset",
    name: object.name,
    domain: object.namespace,
    owner: facetOwner(object.facets),
    description: facetDescription(object.facets),
    sensitivity: "internal",
    freshness: "unknown",
    qualityScore: 1,
    uri: `${sourceUri}#openlineage-${type}=${encodeURIComponent(`${object.namespace}/${object.name}`)}`,
    metadata: {
      externalId,
      source: "OpenLineage",
      namespace: object.namespace,
      eventType: event.eventType,
      runId: event.runId
    }
  };
}

function openLineageResource(
  connection: SourceConnection,
  type: "job" | "dataset",
  object: OpenLineageObject,
  fileResource: SourceResource,
  sourceUri: string,
  observedAt: string,
  event: OpenLineageEvent,
  role?: "input" | "output"
): SourceResource {
  const externalId = `openlineage:${type}:${object.namespace}:${object.name}`;
  return makeResource({
    connection,
    externalId,
    parentId: fileResource.id,
    kind: type,
    name: object.name,
    qualifiedName: `${object.namespace}/${object.name}`,
    dataType: null,
    description: facetDescription(object.facets),
    uri: `${sourceUri}#${encodeURIComponent(externalId)}`,
    profile: {
      openLineage: true,
      namespace: object.namespace,
      eventType: event.eventType,
      runId: event.runId,
      ...(role ? { role } : {})
    },
    metadata: { connector: "filesystem", sourceFileExternalId: fileResource.externalId },
    observedAt
  });
}

function facetOwner(facets: Record<string, unknown>): string {
  const ownership = facets.ownership;
  if (!isRecord(ownership) || !Array.isArray(ownership.owners)) return "";
  for (const owner of ownership.owners) {
    if (isRecord(owner) && typeof owner.name === "string") return owner.name;
  }
  return "";
}

function facetDescription(facets: Record<string, unknown>): string {
  const documentation = facets.documentation;
  return isRecord(documentation) ? stringValue(documentation.description) : "";
}

function makeResource(input: {
  connection: SourceConnection;
  externalId: string;
  parentId: string | null;
  kind: SourceResource["kind"];
  name: string;
  qualifiedName: string;
  dataType: string | null;
  description: string;
  uri: string;
  profile: Record<string, unknown>;
  metadata: Record<string, unknown>;
  observedAt: string;
}): SourceResource {
  return {
    id: stableId("resource", `${input.connection.id}:${input.externalId}`),
    connectionId: input.connection.id,
    externalId: input.externalId,
    parentId: input.parentId,
    kind: input.kind,
    name: input.name,
    qualifiedName: input.qualifiedName,
    dataType: input.dataType,
    description: input.description,
    uri: input.uri,
    sensitivity: "internal",
    writable: false,
    profile: input.profile,
    evidenceChunkIds: [],
    metadata: input.metadata,
    observedAt: input.observedAt
  };
}

function addResource(state: SnapshotState, resource: SourceResource): void {
  if (!state.resources.has(resource.id)) state.resources.set(resource.id, resource);
}

function addRelation(state: SnapshotState, relation: ConnectorSemanticRelation): void {
  const key = relationKey(relation);
  if (!state.relations.has(key)) state.relations.set(key, relation);
}

function relationKey(relation: ConnectorSemanticRelation): string {
  return `${relation.subjectExternalId}:${relation.predicate}:${relation.objectExternalId}`;
}

function jsonType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "object") return "object";
  return typeof value;
}

function csvType(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "null";
  const normalized = value.trim();
  if (/^(true|false)$/i.test(normalized)) return "boolean";
  if (/^-?(0|[1-9]\d*)$/.test(normalized)) return "integer";
  if (/^-?(?:0|[1-9]\d*)\.\d+(?:e[+-]?\d+)?$/i.test(normalized) || /^-?(?:0|[1-9]\d*)e[+-]?\d+$/i.test(normalized)) {
    return "number";
  }
  return "string";
}

function orderedTypes(types: Set<string>): string[] {
  const order = ["null", "boolean", "integer", "number", "string", "array", "object", "bigint", "undefined"];
  return [...types].sort((left, right) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    if (leftIndex === -1 || rightIndex === -1) return compareStrings(left, right);
    return leftIndex - rightIndex;
  });
}

function collapsedType(types: string[]): string {
  return types.length === 1 ? types[0] : `union<${types.join("|")}>`;
}

function extensionOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

function normalizedFormat(extension: string): string {
  return extension === "yml" ? "yaml" : extension;
}

function formatLabel(extension: string): string {
  if (extension === "pdf") return "PDF document";
  if (extension === "md") return "Markdown document";
  if (extension === "html") return "HTML document";
  if (extension === "yaml" || extension === "yml") return "YAML document";
  return "Document";
}

function decodeUtf8(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scalarString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isContractStatus(value: string): value is SemanticContract["status"] {
  return value === "draft" || value === "active" || value === "deprecated";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((left, right) => compareStrings(key(left), key(right)));
}
