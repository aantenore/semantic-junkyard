import type {
  AgentIntentPlan,
  AuditEvent,
  BusinessActionPlan,
  BusinessActionRun,
  DiscoveryRun,
  Entity,
  EvidenceSpan,
  GraphSnapshot,
  ProviderConfig,
  SearchResult,
  SourceResource,
  SourceSyncRun,
  SourceSystem,
  SourceSystemRecord,
  SystemStatus
} from "@semantic-junkyard/shared";

export interface PocSnapshot {
  status: SystemStatus;
  provider: ProviderConfig;
  sourceSystems: SourceSystem[];
  sourceRecords: SourceSystemRecord[];
  sourceResources: SourceResource[];
  sourceSyncRuns: SourceSyncRun[];
  actionRuns: BusinessActionRun[];
  auditEvents: AuditEvent[];
}

export interface SourceSystemsEnvelope {
  systems: SourceSystem[];
  records: SourceSystemRecord[];
}

export interface SourceResourceSearchEnvelope {
  resources: SourceResource[];
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

export type IntentInterpreterProvider = "local-huggingface" | "deterministic";

export type {
  AgentIntentPlan,
  BusinessActionPlan,
  BusinessActionRun,
  DiscoveryRun,
  EvidenceSpan,
  GraphSnapshot,
  SearchResult,
  SourceResource,
  SourceSyncRun,
  SourceSystemRecord
};
