import type { EvidenceScope } from "@semantic-junkyard/shared";

export type EvidenceClass = "domain" | "operational";

export function sourceEvidenceClass(metadata: Record<string, unknown> | undefined): EvidenceClass {
  return metadata?.evidenceClass === "operational" || typeof metadata?.businessActionPlanId === "string"
    ? "operational"
    : "domain";
}

export function evidenceScopeIncludes(scope: EvidenceScope, metadata: Record<string, unknown> | undefined): boolean {
  return scope === "all" || scope === sourceEvidenceClass(metadata);
}
