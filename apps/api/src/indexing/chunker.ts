import type { Chunk, DocumentElement } from "@semantic-junkyard/shared";
import { stableId } from "../core/hash.js";
import { summarize, tokenize } from "../core/text.js";

export interface ChunkerConfig {
  targetTokens: number;
  overlapTokens: number;
}

export class SemanticWindowChunker {
  constructor(private readonly config: ChunkerConfig = { targetTokens: 120, overlapTokens: 24 }) {}

  chunk(sourceId: string, elements: DocumentElement[]): Chunk[] {
    const chunks: Chunk[] = [];
    let buffer: DocumentElement[] = [];
    let bufferTokens = 0;

    const flush = () => {
      if (buffer.length === 0) return;
      const text = buffer.map((element) => element.text).join("\n\n");
      const startOffset = Math.min(...buffer.map((element) => element.startOffset));
      const endOffset = Math.max(...buffer.map((element) => element.endOffset));
      const tokenCount = tokenize(text).length;
      chunks.push({
        id: stableId("chunk", `${sourceId}:${startOffset}:${endOffset}:${text}`),
        sourceId,
        text,
        startOffset,
        endOffset,
        tokenCount,
        summary: summarize(text),
        metadata: {
          chunker: "chunker.semantic-window",
          elementIds: buffer.map((element) => element.id)
        }
      });

      const overlap: DocumentElement[] = [];
      let overlapCount = 0;
      for (const element of [...buffer].reverse()) {
        const elementTokens = tokenize(element.text).length;
        if (overlapCount + elementTokens > this.config.overlapTokens) break;
        overlap.unshift(element);
        overlapCount += elementTokens;
      }
      buffer = overlap;
      bufferTokens = overlapCount;
    };

    for (const element of elements) {
      const elementTokens = tokenize(element.text).length;
      if (bufferTokens > 0 && bufferTokens + elementTokens > this.config.targetTokens) {
        flush();
      }
      buffer.push(element);
      bufferTokens += elementTokens;
    }
    flush();
    return chunks;
  }
}

