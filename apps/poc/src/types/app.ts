import type {
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
