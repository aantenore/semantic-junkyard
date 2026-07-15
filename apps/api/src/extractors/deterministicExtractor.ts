import type { Chunk, Claim, Entity, Relation } from "@semantic-junkyard/shared";
import { stableId } from "../core/hash.js";
import { summarize, titleCase, tokenize } from "../core/text.js";
import type { SemanticSchema } from "./schema.js";
import { defaultSemanticSchema } from "./schema.js";

export interface ExtractionResult {
  entities: Entity[];
  relations: Relation[];
  claims: Claim[];
}

interface CandidateEntity {
  name: string;
  type: string;
  confidence: number;
  chunkIds: Set<string>;
}

export class DeterministicSemanticExtractor {
  constructor(private readonly schema: SemanticSchema = defaultSemanticSchema) {}

  extract(chunks: Chunk[]): ExtractionResult {
    const candidates = new Map<string, CandidateEntity>();

    for (const chunk of chunks) {
      for (const candidate of this.findEntityCandidates(chunk.text)) {
        const key = candidate.name.toLowerCase();
        const current = candidates.get(key) ?? {
          name: candidate.name,
          type: candidate.type,
          confidence: candidate.confidence,
          chunkIds: new Set<string>()
        };
        current.confidence = Math.max(current.confidence, candidate.confidence);
        current.chunkIds.add(chunk.id);
        candidates.set(key, current);
      }
    }

    const entities = [...candidates.values()].map<Entity>((candidate) => ({
      id: stableId("ent", candidate.name.toLowerCase()),
      canonicalName: candidate.name,
      type: candidate.type,
      aliases: [],
      confidence: Number(candidate.confidence.toFixed(2)),
      evidenceChunkIds: [...candidate.chunkIds],
      metadata: {
        extractor: "extractor.deterministic",
        strategy: "schema-patterns+proper-nouns"
      }
    }));

    const entityByName = new Map(entities.map((entity) => [entity.canonicalName.toLowerCase(), entity]));
    const relations: Relation[] = [];
    const claims: Claim[] = [];

    for (const chunk of chunks) {
      const chunkEntities = entities.filter((entity) => chunk.text.toLowerCase().includes(entity.canonicalName.toLowerCase()));
      if (chunkEntities.length > 0) {
        claims.push({
          id: stableId("claim", `${chunk.id}:${summarize(chunk.text, 120)}`),
          text: summarize(chunk.text, 240),
          confidence: 0.68,
          evidenceChunkId: chunk.id,
          entityIds: chunkEntities.slice(0, 8).map((entity) => entity.id),
          metadata: {
            extractor: "extractor.deterministic",
            claimKind: "source-summary"
          }
        });
      }

      for (const pattern of this.schema.relationPatterns) {
        for (const verb of pattern.verbs) {
          const regex = new RegExp(`([A-Z][A-Za-z0-9+_.-]*(?:[ \\t]+[A-Z][A-Za-z0-9+_.-]*){0,4})[ \\t]+${escapeRegExp(verb)}[ \\t]+([A-Z][A-Za-z0-9+_.-]*(?:[ \\t]+[A-Z][A-Za-z0-9+_.-]*){0,4})`, "g");
          for (const match of chunk.text.matchAll(regex)) {
            const left = entityByName.get(match[1].trim().toLowerCase());
            const right = entityByName.get(match[2].trim().toLowerCase());
            if (!left || !right || left.id === right.id) continue;
            relations.push({
              id: stableId("rel", `${left.id}:${pattern.type}:${right.id}:${chunk.id}`),
              sourceEntityId: left.id,
              targetEntityId: right.id,
              type: pattern.type,
              confidence: pattern.confidence,
              evidenceChunkId: chunk.id,
              metadata: {
                extractor: "extractor.deterministic",
                matchedVerb: verb,
                origin: "deterministic_ingest",
                authoritative: false,
                lifecycle: "proposed"
              }
            });
          }
        }
      }

      for (let index = 0; index < Math.min(chunkEntities.length - 1, 8); index += 1) {
        const left = chunkEntities[index];
        const right = chunkEntities[index + 1];
        if (!left || !right || left.id === right.id) continue;
        relations.push({
          id: stableId("rel", `${left.id}:MENTIONS_WITH:${right.id}:${chunk.id}`),
          sourceEntityId: left.id,
          targetEntityId: right.id,
          type: "MENTIONS_WITH",
          confidence: 0.55,
          evidenceChunkId: chunk.id,
          metadata: {
            extractor: "extractor.deterministic",
            strategy: "chunk-cooccurrence",
            origin: "deterministic_ingest",
            authoritative: false,
            lifecycle: "proposed"
          }
        });
      }
    }

    return {
      entities,
      relations: uniqueById(relations),
      claims: uniqueById(claims)
    };
  }

  private findEntityCandidates(text: string): Array<{ name: string; type: string; confidence: number }> {
    const candidates: Array<{ name: string; type: string; confidence: number }> = [];
    const properNouns = text.match(/\b[A-Z][A-Za-z0-9+_.-]*(?:[ \t]+[A-Z][A-Za-z0-9+_.-]*){0,4}\b/g) ?? [];
    for (const rawName of properNouns) {
      const name = rawName.trim().replace(/[.,;:!?)]$/, "");
      if (name.length < 3 || /^[A-Z]$/.test(name)) continue;
      candidates.push({
        name,
        type: this.inferType(name, text),
        confidence: name.includes(" ") ? 0.74 : 0.62
      });
    }

    for (const typeConfig of this.schema.entityTypes) {
      for (const token of tokenize(text)) {
        if (!typeConfig.patterns.includes(token)) continue;
        candidates.push({
          name: titleCase(token),
          type: typeConfig.type,
          confidence: 0.58
        });
      }
    }

    return candidates;
  }

  private inferType(name: string, context: string): string {
    const lower = `${name} ${context.slice(0, 300)}`.toLowerCase();
    for (const typeConfig of this.schema.entityTypes) {
      if (typeConfig.patterns.some((pattern) => lower.includes(pattern))) {
        return typeConfig.type;
      }
    }
    if (/\b(api|db|sql|rag|ai|mcp|sdk|llm)\b/i.test(name)) return "System";
    return "Concept";
  }
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
