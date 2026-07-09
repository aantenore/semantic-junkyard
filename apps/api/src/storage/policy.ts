import type { PolicyRule, SearchResult, SemanticAsset } from "@semantic-junkyard/shared";

export interface ActorContext {
  actor: string;
  roles: string[];
  clearance: "public" | "internal" | "confidential" | "restricted";
}

export interface PolicyDecision {
  decision: "allow" | "mask" | "deny" | "review";
  reason: string;
}

const sensitivityRank = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3
};

export class PolicyEngine {
  evaluateAsset(asset: SemanticAsset, actor: ActorContext): PolicyDecision {
    if (sensitivityRank[asset.sensitivity] > sensitivityRank[actor.clearance]) {
      return {
        decision: "deny",
        reason: `Actor clearance ${actor.clearance} is lower than asset sensitivity ${asset.sensitivity}.`
      };
    }
    if (asset.freshness === "stale") {
      return {
        decision: "review",
        reason: "Asset is stale and should be reviewed before automated action."
      };
    }
    if (asset.qualityScore < 0.45) {
      return {
        decision: "review",
        reason: "Asset quality score is below the safe autonomous threshold."
      };
    }
    return { decision: "allow", reason: "Policy checks passed." };
  }

  evaluateTool(toolName: string, actor: ActorContext): PolicyDecision {
    if (toolName === "open_source_span" && actor.clearance === "public") {
      return {
        decision: "mask",
        reason: "Public actors can inspect summaries but source spans may be masked."
      };
    }
    return { decision: "allow", reason: "Tool is read-only and evidence-scoped." };
  }

  applyResultPolicies(results: SearchResult[], policies: PolicyRule[]): SearchResult[] {
    const deniedTerms = policies
      .filter((policy) => policy.effect === "deny")
      .flatMap((policy) => policy.appliesTo)
      .map((term) => term.toLowerCase());
    const maskTerms = policies
      .filter((policy) => policy.effect === "mask")
      .flatMap((policy) => policy.appliesTo)
      .map((term) => term.toLowerCase());

    return results
      .filter((result) => !deniedTerms.some((term) => result.text.toLowerCase().includes(term)))
      .map((result) => {
        let text = result.text;
        let summary = result.summary;
        for (const term of maskTerms) {
          const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
          text = text.replace(regex, "[masked]");
          summary = summary.replace(regex, "[masked]");
        }
        return { ...result, text, summary };
      });
  }
}
