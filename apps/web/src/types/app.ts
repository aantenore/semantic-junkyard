import type {
  BusinessActionPlan,
  BusinessActionRun,
  CatalogSnapshot,
  DiscoveryRun,
  FabricModule,
  GraphSnapshot,
  ProviderConfig,
  SearchResult,
  SemanticProposal,
  SourceConnection,
  SourceResource,
  SourceSyncRun,
  SourceSystem,
  SourceSystemRecord,
  SystemStatus
} from "@semantic-junkyard/shared";

export type SnapshotSurface =
  | "discoveryRuns"
  | "manifest"
  | "provider"
  | "mcp"
  | "actionRuns"
  | "sourceSystems"
  | "sourceConnections"
  | "sourceResources"
  | "sourceSyncRuns"
  | "semanticProposals";

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
  manifest: AgentManifest | null;
  provider: ProviderConfig | null;
  mcp: McpCapabilitySnapshot | null;
  actionRuns: BusinessActionRun[];
  sourceSystems: SourceSystem[];
  sourceRecords: SourceSystemRecord[];
  sourceConnections: SourceConnection[];
  sourceResources: SourceResource[];
  sourceSyncRuns: SourceSyncRun[];
  semanticProposals: SemanticProposal[];
  degraded: string[];
  surfaceErrors: Partial<Record<SnapshotSurface, string>>;
}

export interface SearchEnvelope {
  results: SearchResult[];
}

export interface SourceResourceSearchEnvelope {
  resources: SourceResource[];
}

export interface IngestPreviewReport {
  profile: {
    mode: "full_data" | "metadata_only" | "external_reference";
    mimeType: string;
    chunkCount: number;
    entityCount: number;
    relationCount: number;
    claimCount: number;
    warnings: string[];
  };
  entities: Array<{
    id: string;
    canonicalName: string;
    type: string;
    confidence: number;
  }>;
  relations: Array<{
    id: string;
    type: string;
    confidence: number;
    sourceEntityId: string;
    targetEntityId: string;
  }>;
}

export interface CuratedRelationReport {
  relation: {
    id: string;
    type: string;
    confidence: number;
  };
  sourceEntity: {
    id: string;
    canonicalName: string;
    type: string;
  };
  targetEntity: {
    id: string;
    canonicalName: string;
    type: string;
  };
  evidence: {
    chunkId: string;
    sourceName: string;
    text: string;
  };
}

export interface McpCapabilitySnapshot {
  server: {
    name: string;
    version: string;
    transport: string;
    command: string;
    defaultAccess?: string;
    mutationFlags?: Record<string, string>;
  };
  summary: string;
  tools: Array<{
    name: string;
    description: string;
  }>;
  resources: Array<{
    name: string;
    description: string;
  }>;
  prompts: Array<{
    name: string;
    description: string;
  }>;
}

export type ModuleGroup = Record<string, FabricModule[]>;
