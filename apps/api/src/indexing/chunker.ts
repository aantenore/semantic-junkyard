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

    for (const element of elements.flatMap((item) => splitOversizedElement(item, this.config.targetTokens))) {
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

const MAX_ELEMENT_CHARS = 4_000;

function splitOversizedElement(element: DocumentElement, targetTokens: number): DocumentElement[] {
  const words = [...element.text.matchAll(/\S+/g)];
  if (words.length <= targetTokens && element.text.length <= MAX_ELEMENT_CHARS) return [element];

  const slices: Array<{ start: number; end: number }> = [];
  if (words.length <= 1) {
    for (let start = 0; start < element.text.length; start += MAX_ELEMENT_CHARS) {
      slices.push({ start, end: Math.min(start + MAX_ELEMENT_CHARS, element.text.length) });
    }
  } else {
    for (let index = 0; index < words.length; index += targetTokens) {
      const first = words[index];
      const last = words[Math.min(index + targetTokens - 1, words.length - 1)];
      if (!first || first.index === undefined || !last || last.index === undefined) continue;
      const rangeStart = first.index;
      const rangeEnd = last.index + last[0].length;
      for (let start = rangeStart; start < rangeEnd; start += MAX_ELEMENT_CHARS) {
        slices.push({ start, end: Math.min(start + MAX_ELEMENT_CHARS, rangeEnd) });
      }
    }
  }

  return slices.map(({ start, end }, index) => {
    const text = element.text.slice(start, end).trim();
    const leadingWhitespace = element.text.slice(start, end).indexOf(text);
    const adjustedStart = start + Math.max(leadingWhitespace, 0);
    return {
      ...element,
      id: stableId("el", `${element.id}:fragment:${index}:${adjustedStart}:${text}`),
      text,
      startOffset: element.startOffset + adjustedStart,
      endOffset: element.startOffset + adjustedStart + text.length,
      metadata: { ...element.metadata, parentElementId: element.id, fragment: index }
    };
  });
}
