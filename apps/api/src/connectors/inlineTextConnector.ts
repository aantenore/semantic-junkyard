import type { IngestRequest, SourceArtifact } from "@semantic-junkyard/shared";
import { nowIso, sha256, stableId } from "../core/hash.js";

export class InlineTextConnector {
  id = "connector.inline-text";

  createSource(request: IngestRequest): SourceArtifact {
    const uri = request.uri ?? `inline://${encodeURIComponent(request.name)}`;
    const retainedText = request.ingestionMode === "full_data" ? request.text : "";
    const contentHash = sha256(
      request.ingestionMode === "full_data"
        ? request.text
        : JSON.stringify({ uri, name: request.name, mimeType: request.mimeType, ingestionMode: request.ingestionMode, metadata: request.metadata })
    );
    return {
      id: stableId("src", `${uri}:${contentHash}`),
      uri,
      name: request.name,
      mimeType: request.mimeType,
      contentHash,
      text: retainedText,
      ingestionMode: request.ingestionMode,
      metadata: {
        ...request.metadata,
        connector: this.id
      },
      createdAt: nowIso()
    };
  }
}
