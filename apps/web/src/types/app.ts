import type {
  CatalogSnapshot,
  DiscoveryRun,
  FabricModule,
  GraphSnapshot,
  ProviderConfig,
  SearchResult,
  SystemStatus
} from "@semantic-junkyard/shared";

export interface AgentManifest {
  name: string;
  version: string;
  modelAgnostic: boolean;
  autonomyBoundary: string;
  capabilities: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    risk: "read-only" | "review-required" | "blocked";
    evidenceRequired: boolean;
  }>;
  operatingRules: string[];
  stopConditions: string[];
}

export interface AppSnapshot {
  status: SystemStatus;
  catalog: CatalogSnapshot;
  graph: GraphSnapshot;
  discoveryRuns: DiscoveryRun[];
  manifest: AgentManifest;
  provider: ProviderConfig;
}

export interface SearchEnvelope {
  results: SearchResult[];
}

export interface PocAgentReport {
  useCase: string;
  question: string;
  provider: string;
  model: string;
  autonomyDecision: string;
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

export type ModuleGroup = Record<string, FabricModule[]>;
