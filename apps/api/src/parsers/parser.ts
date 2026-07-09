import type { DocumentElement } from "@semantic-junkyard/shared";

export interface Parser {
  id: string;
  supports(mimeType: string): boolean;
  parse(input: { sourceId: string; text: string; mimeType: string }): DocumentElement[];
}

