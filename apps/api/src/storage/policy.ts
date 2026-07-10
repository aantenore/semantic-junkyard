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
  evaluateSensitivity(sensitivity: SemanticAsset["sensitivity"], actor: ActorContext): PolicyDecision {
    if (sensitivityRank[sensitivity] > sensitivityRank[actor.clearance]) {
      return {
        decision: "deny",
        reason: `Actor clearance ${actor.clearance} is lower than sensitivity ${sensitivity}.`
      };
    }
    return { decision: "allow", reason: "Sensitivity clearance check passed." };
  }

  evaluateAsset(asset: SemanticAsset, actor: ActorContext): PolicyDecision {
    const sensitivity = this.evaluateSensitivity(asset.sensitivity, actor);
    if (sensitivity.decision === "deny") return sensitivity;
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
    return results
      .map((result) => {
        const text = this.applyTextPolicies(result.text, policies);
        const summary = this.applyTextPolicies(result.summary, policies);
        return text === null || summary === null ? null : { ...result, text, summary };
      })
      .filter((result): result is SearchResult => result !== null);
  }

  applyTextPolicies(value: string, policies: PolicyRule[]): string | null {
    const deniedTerms = this.termsForEffect(policies, "deny");
    if (deniedTerms.some((term) => value.toLowerCase().includes(term))) return null;

    let result = value;
    for (const term of this.termsForEffect(policies, "mask")) {
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      result = result.replace(regex, "[masked]");
    }
    return result;
  }

  applyDataPolicies<T>(value: T, policies: PolicyRule[]): T {
    return this.redactValue(value, policies) as T;
  }

  private redactValue(value: unknown, policies: PolicyRule[]): unknown {
    if (typeof value === "string") {
      let redacted = value;
      for (const term of this.termsForEffect(policies, "deny")) {
        redacted = redacted.replace(this.termPattern(term), "[denied]");
      }
      for (const term of this.termsForEffect(policies, "mask")) {
        redacted = redacted.replace(this.termPattern(term), "[masked]");
      }
      return redacted;
    }
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item, policies));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactValue(item, policies)]));
    }
    return value;
  }

  private termsForEffect(policies: PolicyRule[], effect: PolicyRule["effect"]): string[] {
    return policies
      .filter((policy) => policy.effect === effect)
      .flatMap((policy) => policy.appliesTo)
      .map((term) => term.toLowerCase());
  }

  private termPattern(term: string): RegExp {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pluralAware = /^[a-z]+$/i.test(term) ? `${escaped}s?` : escaped;
    return new RegExp(`\\b${pluralAware}\\b`, "gi");
  }
}
