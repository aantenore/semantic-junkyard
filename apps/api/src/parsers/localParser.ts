import type { DocumentElement } from "@semantic-junkyard/shared";
import { stableId } from "../core/hash.js";
import { normalizeWhitespace, stripHtml } from "../core/text.js";
import type { Parser } from "./parser.js";

export class LocalTextParser implements Parser {
  id = "parser.local-text-markdown-html";

  supports(mimeType: string): boolean {
    return [
      "text/plain",
      "text/markdown",
      "text/html",
      "text/csv",
      "text/yaml",
      "application/json",
      "application/x-ndjson",
      "application/yaml",
      "application/x-yaml",
      "application/pdf"
    ].includes(mimeType);
  }

  parse(input: { sourceId: string; text: string; mimeType: string }): DocumentElement[] {
    const normalized = normalizeWhitespace(input.mimeType === "text/html" ? stripHtml(input.text) : input.text);
    const blocks = normalized.split(/\n{2,}/).filter((block) => block.trim().length > 0);
    const elements: DocumentElement[] = [];
    let cursor = 0;

    for (const block of blocks) {
      const startOffset = normalized.indexOf(block, cursor);
      const endOffset = startOffset + block.length;
      cursor = endOffset;
      const trimmed = block.trim();
      const kind = inferElementKind(trimmed);
      elements.push({
        id: stableId("el", `${input.sourceId}:${startOffset}:${trimmed}`),
        sourceId: input.sourceId,
        kind,
        text: trimmed,
        startOffset,
        endOffset,
        metadata: {
          parser: this.id,
          offsetBasis: input.mimeType === "text/html" ? "normalized-extracted-text" : "normalized-source-text"
        }
      });
    }

    return elements;
  }
}

function inferElementKind(text: string): DocumentElement["kind"] {
  if (/^#{1,6}\s+/.test(text)) return "heading";
  if (/^[A-Z][^.!?]{3,80}$/.test(text)) return "heading";
  if (/^\s*[-*]\s+/m.test(text)) return "list";
  if (/\|.+\|/.test(text)) return "table";
  if (/^```/.test(text) || /\b(class|function|const|interface)\b/.test(text)) return "code";
  return "paragraph";
}
