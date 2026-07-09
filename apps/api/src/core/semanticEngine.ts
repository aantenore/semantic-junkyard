import type {
  CatalogSnapshot,
  IngestRequest,
  IngestResponse,
  SearchRequest,
  SearchResult
} from "@semantic-junkyard/shared";
import { IngestRequestSchema, SearchRequestSchema } from "@semantic-junkyard/shared";
import { DiscoveryAgent } from "../agent/discoveryAgent.js";
import { InlineTextConnector } from "../connectors/inlineTextConnector.js";
import { DeterministicSemanticExtractor } from "../extractors/deterministicExtractor.js";
import { embedText } from "../indexing/embeddings.js";
import { SemanticWindowChunker } from "../indexing/chunker.js";
import { HybridQueryPlanner } from "../indexing/queryPlanner.js";
import { LocalTextParser } from "../parsers/localParser.js";
import { PolicyEngine } from "../storage/policy.js";
import type { SemanticRepository } from "../storage/repository.js";

export class SemanticEngine {
  private readonly connector = new InlineTextConnector();
  private readonly parser = new LocalTextParser();
  private readonly chunker = new SemanticWindowChunker();
  private readonly extractor = new DeterministicSemanticExtractor();
  private readonly planner: HybridQueryPlanner;
  private readonly policy = new PolicyEngine();
  private readonly discoveryAgent: DiscoveryAgent;

  constructor(private readonly repository: SemanticRepository) {
    this.planner = new HybridQueryPlanner(repository);
    this.discoveryAgent = new DiscoveryAgent(repository);
  }

  ingest(rawRequest: IngestRequest): IngestResponse {
    const request = IngestRequestSchema.parse(rawRequest);
    if (!this.parser.supports(request.mimeType)) {
      throw new Error(`Unsupported MIME type ${request.mimeType}. Configure a Docling, Tika, or Unstructured parser adapter for this source.`);
    }
    const source = this.connector.createSource(request);
    const textForIndexing = request.ingestionMode === "external_reference"
      ? `External reference registered: ${source.name}. URI: ${source.uri}. Metadata: ${JSON.stringify(source.metadata)}`
      : request.ingestionMode === "metadata_only"
        ? `Metadata-only source registered: ${source.name}. URI: ${source.uri}. Metadata: ${JSON.stringify(source.metadata)}`
        : source.text;
    const elements = this.parser.parse({ sourceId: source.id, text: textForIndexing, mimeType: source.mimeType });
    const chunks = this.chunker.chunk(source.id, elements);
    const vectors = new Map(chunks.map((chunk) => [chunk.id, embedText(chunk.text)]));
    const extraction = this.extractor.extract(chunks);

    this.repository.saveSource(source);
    this.repository.saveElements(elements);
    this.repository.saveChunks(chunks, vectors);
    this.repository.saveEntities(extraction.entities);
    this.repository.saveRelations(extraction.relations);
    this.repository.saveClaims(extraction.claims);
    this.repository.audit("system", "ingest", source.id, "allow", {
      chunks: chunks.length,
      entities: extraction.entities.length,
      relations: extraction.relations.length
    });

    return {
      source,
      chunks,
      entities: extraction.entities,
      relations: extraction.relations,
      claims: extraction.claims
    };
  }

  importCatalog(snapshot: CatalogSnapshot): CatalogSnapshot {
    this.repository.upsertCatalog(snapshot);
    this.repository.audit("system", "catalog.import", "catalog", "allow", {
      assets: snapshot.assets.length,
      metrics: snapshot.metrics.length,
      policies: snapshot.policies.length
    });
    return this.repository.catalog();
  }

  search(rawRequest: SearchRequest): SearchResult[] {
    const request = SearchRequestSchema.parse(rawRequest);
    const results = this.planner.search(request);
    const policies = this.repository.catalog().policies;
    const filtered = this.policy.applyResultPolicies(results, policies);
    this.repository.audit("agent", "semantic_search", request.query, "allow", {
      mode: request.mode,
      returned: filtered.length
    });
    return filtered;
  }

  runDiscovery(objective?: string) {
    return this.discoveryAgent.run(objective);
  }

  agentManifest() {
    return this.discoveryAgent.manifest();
  }

  entityLookup(name: string) {
    const normalized = name.toLowerCase();
    const graph = this.repository.graphSnapshot();
    return this.repository
      .getEntities()
      .filter((entity) => entity.canonicalName.toLowerCase().includes(normalized) || entity.aliases.some((alias) => alias.toLowerCase().includes(normalized)))
      .map((entity) => ({
        ...entity,
        degree: graph.edges.filter((edge) => edge.source === entity.id || edge.target === entity.id).length,
        evidence: entity.evidenceChunkIds.map((chunkId) => this.repository.evidence(chunkId)).filter(Boolean)
      }));
  }

  graphNeighbors(entityId: string, depth = 1) {
    const maxDepth = Math.min(Math.max(depth, 1), 2);
    const graph = this.repository.graphSnapshot();
    const visited = new Set([entityId]);
    const frontier = new Set([entityId]);
    const selectedEdges = new Map<string, (typeof graph.edges)[number]>();
    for (let level = 0; level < maxDepth; level += 1) {
      const next = new Set<string>();
      for (const edge of graph.edges) {
        if (frontier.has(edge.source) || frontier.has(edge.target)) {
          selectedEdges.set(edge.id, edge);
          const other = frontier.has(edge.source) ? edge.target : edge.source;
          if (!visited.has(other)) {
            visited.add(other);
            next.add(other);
          }
        }
      }
      frontier.clear();
      for (const item of next) frontier.add(item);
    }
    return {
      nodes: graph.nodes.filter((node) => visited.has(node.id)),
      edges: [...selectedEdges.values()]
    };
  }

  findPaths(fromEntityId: string, toEntityId: string, maxDepth = 4) {
    const graph = this.repository.graphSnapshot();
    const boundedDepth = Math.min(Math.max(maxDepth, 1), 4);
    const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: fromEntityId, path: [] }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (current.nodeId === toEntityId) {
        return current.path.map((edgeId) => graph.edges.find((edge) => edge.id === edgeId)).filter(Boolean);
      }
      if (current.path.length >= boundedDepth || visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);
      for (const edge of graph.edges.filter((candidate) => candidate.source === current.nodeId || candidate.target === current.nodeId)) {
        const nextNode = edge.source === current.nodeId ? edge.target : edge.source;
        queue.push({ nodeId: nextNode, path: [...current.path, edge.id] });
      }
    }
    return [];
  }

  expandContext(input: { query?: string; chunkIds?: string[]; entityIds?: string[] }) {
    const searchResults = input.query ? this.search({ query: input.query, topK: 5, mode: "hybrid" }) : [];
    const chunkIds = new Set([...(input.chunkIds ?? []), ...searchResults.map((result) => result.chunkId)]);
    for (const entityId of input.entityIds ?? []) {
      for (const entity of this.repository.getEntities().filter((candidate) => candidate.id === entityId)) {
        for (const chunkId of entity.evidenceChunkIds) chunkIds.add(chunkId);
      }
    }
    const evidence = [...chunkIds].map((chunkId) => this.repository.evidence(chunkId)).filter(Boolean);
    return {
      query: input.query ?? null,
      evidence,
      entities: this.repository.getEntities().filter((entity) => evidence.some((item) => item?.chunkId && entity.evidenceChunkIds.includes(item.chunkId))),
      guidance: "Use these evidence spans as citations. If evidence is insufficient, stop instead of guessing."
    };
  }

  explainPermissions(intent: string) {
    return {
      intent,
      manifest: this.agentManifest(),
      decision: "read-only autonomous access allowed; writes and privileged actions require external approval-gated adapters",
      safeNextSteps: [
        "Run semantic_search to identify candidate context.",
        "Use entity_lookup and graph_neighbors to ground concepts.",
        "Open evidence spans before producing an answer.",
        "Stop or ask for approval if action requires source mutation, SQL execution, secrets, restricted data, or external communication."
      ]
    };
  }
}
