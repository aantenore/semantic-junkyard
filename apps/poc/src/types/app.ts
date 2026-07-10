import type {
  AuditEvent,
  BusinessActionPlan,
  BusinessActionRun,
  DiscoveryRun,
  Entity,
  EvidenceSpan,
  GraphSnapshot,
  ProviderConfig,
  SearchResult,
  SourceSystem,
  SourceSystemRecord,
  SystemStatus
} from "@semantic-junkyard/shared";

export interface PocSnapshot {
  status: SystemStatus;
  provider: ProviderConfig;
  sourceSystems: SourceSystem[];
  sourceRecords: SourceSystemRecord[];
  actionRuns: BusinessActionRun[];
  auditEvents: AuditEvent[];
}

export interface SearchEnvelope {
  results: SearchResult[];
}

export interface EntityLookupEnvelope {
  entities: Array<
    Entity & {
      degree: number;
      evidence: EvidenceSpan[];
    }
  >;
}

export interface ContextEnvelope {
  query: string | null;
  evidence: EvidenceSpan[];
  entities: Entity[];
  guidance: string;
}

export interface PermissionEnvelope {
  intent: string;
  decision: string;
  safeNextSteps: string[];
  manifest: {
    name: string;
    autonomyBoundary: string;
    stopConditions: string[];
  };
}

export interface PocAgentReport {
  useCase: string;
  question: string;
  provider: string;
  model: string;
  orchestrationProvider: "deterministic-policy-harness";
  modelRole: "trace-summarizer" | "deterministic-summary";
  overallStatus: "completed" | "degraded" | "blocked" | "failed";
  autonomyDecision: string;
  businessAction: {
    intent: string;
    status: string;
    writes: number;
    verifiedReflections: number;
    semanticChunksRefreshed: number;
  };
  steps: Array<{
    step: number;
    tool: string;
    rationale: string;
    observation: string;
  }>;
  finalAnswer: string;
  modelReasoningSummary: string;
  citations: Array<{
    sourceName: string;
    chunkId: string;
    excerpt: string;
  }>;
  stopConditionsChecked: string[];
  stopConditionEvaluations: Array<{
    condition: string;
    status: "passed" | "triggered" | "not_evaluated";
    detail: string;
  }>;
}

export type ToolProvider = "local-huggingface" | "deterministic";

export type {
  BusinessActionPlan,
  BusinessActionRun,
  DiscoveryRun,
  GraphSnapshot,
  SearchResult,
  SourceSystemRecord
};
