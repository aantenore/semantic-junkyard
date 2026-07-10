import type { SearchRequest, SearchResult } from "@semantic-junkyard/shared";
import { cosineSimilarity, embedText } from "./embeddings.js";
import type { SemanticRepository } from "../storage/repository.js";
import { tokenize } from "../core/text.js";

export class HybridQueryPlanner {
  constructor(private readonly repository: SemanticRepository) {}

  search(request: SearchRequest): SearchResult[] {
    const chunks = this.repository.getChunks();
    const vectors = this.repository.getVectors();
    const queryVector = embedText(request.query);
    const lexical = new Map(this.repository.lexicalSearch(request.query, request.topK * 3).map((result) => [result.chunkId, result]));
    const queryTerms = new Set(tokenize(request.query));
    const relations = this.repository.getRelations();
    const entities = this.repository.getEntities();
    const entityIdsByChunk = this.repository.getEntityIdsByChunk();
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const degreeByEntity = new Map<string, number>();
    for (const relation of relations) {
      degreeByEntity.set(relation.sourceEntityId, (degreeByEntity.get(relation.sourceEntityId) ?? 0) + 1);
      degreeByEntity.set(relation.targetEntityId, (degreeByEntity.get(relation.targetEntityId) ?? 0) + 1);
    }

    const results = chunks.map<SearchResult>((chunk) => {
      const vectorScore = cosineSimilarity(queryVector, vectors.get(chunk.id) ?? []);
      const lexicalHit = lexical.get(chunk.id);
      const entityIds = entityIdsByChunk.get(chunk.id) ?? [];
      const graphBoost = entityIds.reduce((score, entityId) => {
        const entity = entityById.get(entityId);
        const nameHit = entity ? tokenize(entity.canonicalName).some((term) => queryTerms.has(term)) : false;
        const degree = degreeByEntity.get(entityId) ?? 0;
        return score + (nameHit ? 0.18 : 0) + Math.min(0.12, degree * 0.015);
      }, 0);
      const lexicalScore = lexicalHit?.lexicalScore ?? lexicalFallbackScore(chunk.text, queryTerms);
      const hybridScore = fuseScore(request.mode, lexicalScore, vectorScore, graphBoost);
      return {
        chunkId: chunk.id,
        sourceId: chunk.sourceId,
        sourceName: chunk.sourceName,
        text: chunk.text,
        summary: chunk.summary,
        lexicalScore: Number(lexicalScore.toFixed(4)),
        vectorScore: Number(vectorScore.toFixed(4)),
        graphBoost: Number(graphBoost.toFixed(4)),
        hybridScore: Number(hybridScore.toFixed(4)),
        entityIds
      };
    });

    return results
      .filter((result) => result.hybridScore > 0 || result.lexicalScore > 0)
      .sort((left, right) => right.hybridScore - left.hybridScore)
      .slice(0, request.topK);
  }
}

function fuseScore(mode: SearchRequest["mode"], lexicalScore: number, vectorScore: number, graphBoost: number): number {
  if (mode === "lexical") return lexicalScore;
  if (mode === "vector") return vectorScore;
  if (mode === "graph") return graphBoost + lexicalScore * 0.25;
  return lexicalScore * 0.38 + Math.max(0, vectorScore) * 0.42 + graphBoost * 0.2;
}

function lexicalFallbackScore(text: string, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  const terms = new Set(tokenize(text));
  let hits = 0;
  for (const term of queryTerms) {
    if (terms.has(term)) hits += 1;
  }
  return hits / queryTerms.size;
}
