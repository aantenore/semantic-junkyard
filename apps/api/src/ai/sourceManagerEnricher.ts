import type { SourceResource } from "@semantic-junkyard/shared";
import { LocalSemanticEnricher, LOCAL_SEMANTIC_ENRICHMENT_LIMITS } from "./localSemanticEnricher.js";
import type { SemanticEnrichmentCandidate, SemanticEnrichmentProvider, SemanticEnrichmentResult } from "../sources/sourceManager.js";

export class LocalSourceSemanticEnrichmentProvider implements SemanticEnrichmentProvider {
  constructor(private readonly enricher = new LocalSemanticEnricher()) {}

  async enrich(objective: string, resources: SourceResource[]): Promise<SemanticEnrichmentResult> {
    const bounded = resources
      .filter((resource) => resource.evidenceChunkIds.length > 0)
      .slice(0, LOCAL_SEMANTIC_ENRICHMENT_LIMITS.maxResources)
      .map(({ id, parentId, kind, name, qualifiedName, dataType, description, sensitivity, writable }) => ({
        id,
        parentId,
        kind,
        name,
        qualifiedName,
        dataType,
        description,
        sensitivity,
        writable
      }));
    const result = await this.enricher.enrich({ objective, resources: bounded });
    return {
      provider: "local-huggingface",
      modelId: result.modelId,
      summary: result.audit.summary,
      candidates: result.proposals.map((proposal): SemanticEnrichmentCandidate => {
        if (proposal.kind === "relation") {
          return {
            kind: "relation",
            subjectId: proposal.sourceResourceId,
            predicate: proposal.type,
            objectId: proposal.targetResourceId,
            value: { relationType: proposal.type },
            confidence: proposal.confidence,
            explanation: proposal.explanation,
            evidenceResourceIds: proposal.evidenceResourceIds
          };
        }
        if (proposal.kind === "classification") {
          return {
            kind: "classification",
            subjectId: proposal.resourceId,
            predicate: "CLASSIFIED_AS",
            objectId: null,
            value: { label: proposal.label },
            confidence: proposal.confidence,
            explanation: proposal.explanation,
            evidenceResourceIds: proposal.evidenceResourceIds
          };
        }
        if (proposal.kind === "conflict") {
          return {
            kind: "conflict",
            subjectId: proposal.resourceIds[0] ?? proposal.evidenceResourceIds[0] ?? "unknown",
            predicate: "CONFLICTS_WITH",
            objectId: proposal.resourceIds[1] ?? null,
            value: { issue: proposal.issue, resourceIds: proposal.resourceIds },
            confidence: proposal.confidence,
            explanation: proposal.explanation,
            evidenceResourceIds: proposal.evidenceResourceIds
          };
        }
        return {
          kind: "description",
          subjectId: proposal.resourceId,
          predicate: "HAS_BUSINESS_CONCEPT",
          objectId: null,
          value: { name: proposal.name, description: proposal.description },
          confidence: proposal.confidence,
          explanation: proposal.explanation,
          evidenceResourceIds: proposal.evidenceResourceIds
        };
      })
    };
  }
}
