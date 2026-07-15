import { z } from "zod";

export const ModuleKindSchema = z.enum([
  "business-action-router",
  "connector",
  "parser",
  "chunker",
  "extractor",
  "embedding",
  "metadata-store",
  "lexical-store",
  "vector-store",
  "graph-store",
  "object-store",
  "metric-layer",
  "lineage-collector",
  "ontology-validator",
  "policy-engine",
  "reranker",
  "scheduler",
  "query-planner",
  "agent-tool",
  "agent-protocol",
  "writeback-gateway",
  "reflection-engine",
  "observability"
]);

export type ModuleKind = z.infer<typeof ModuleKindSchema>;

export const ModuleStatusSchema = z.enum(["active", "available", "disabled"]);
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

export const FabricModuleSchema = z.object({
  id: z.string(),
  kind: ModuleKindSchema,
  label: z.string(),
  status: ModuleStatusSchema,
  description: z.string(),
  interchangeableWith: z.array(z.string()).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  externalizable: z.boolean().default(true),
  risk: z.enum(["low", "medium", "high"]).default("low")
});

export type FabricModule = z.infer<typeof FabricModuleSchema>;

export const SourceArtifactSchema = z.object({
  id: z.string(),
  uri: z.string(),
  name: z.string(),
  mimeType: z.string(),
  contentHash: z.string(),
  text: z.string(),
  ingestionMode: z.enum(["full_data", "metadata_only", "external_reference"]).default("full_data"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});

export type SourceArtifact = z.infer<typeof SourceArtifactSchema>;

export const DocumentElementSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  kind: z.enum(["title", "heading", "paragraph", "table", "list", "code", "unknown"]),
  text: z.string(),
  startOffset: z.number(),
  endOffset: z.number(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type DocumentElement = z.infer<typeof DocumentElementSchema>;

export const ChunkSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  text: z.string(),
  startOffset: z.number(),
  endOffset: z.number(),
  tokenCount: z.number(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type Chunk = z.infer<typeof ChunkSchema>;

export const EntitySchema = z.object({
  id: z.string(),
  canonicalName: z.string(),
  type: z.string(),
  aliases: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  evidenceChunkIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type Entity = z.infer<typeof EntitySchema>;

export const RelationSchema = z.object({
  id: z.string(),
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  type: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceChunkId: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type Relation = z.infer<typeof RelationSchema>;

export const ClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceChunkId: z.string(),
  entityIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type Claim = z.infer<typeof ClaimSchema>;

export const GraphAnnotationSchema = z.object({
  proposalId: z.string(),
  kind: z.string(),
  predicate: z.string(),
  value: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  evidenceResourceIds: z.array(z.string()).default([])
});

export type GraphAnnotation = z.infer<typeof GraphAnnotationSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  confidence: z.number(),
  degree: z.number().default(0),
  annotations: z.array(GraphAnnotationSchema).default([])
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string(),
  confidence: z.number(),
  evidenceChunkId: z.string().nullable(),
  lifecycle: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
  authoritative: z.boolean().optional()
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSnapshotSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema)
});

export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

export const EvidenceScopeSchema = z.enum(["domain", "operational", "all"]);
export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  topK: z.number().int().positive().max(25).default(8),
  mode: z.enum(["hybrid", "lexical", "vector", "graph"]).default("hybrid"),
  scope: EvidenceScopeSchema.default("domain")
}).strict();

export type SearchRequest = z.input<typeof SearchRequestSchema>;
export type ParsedSearchRequest = z.output<typeof SearchRequestSchema>;

export const EntityLookupRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    entityId: z.string().trim().min(1).max(255).optional(),
    topK: z.number().int().positive().max(25).default(10)
  })
  .strict()
  .refine((value) => Boolean(value.name) !== Boolean(value.entityId), {
    message: "Provide exactly one of name or entityId."
  });

export type EntityLookupRequest = z.infer<typeof EntityLookupRequestSchema>;

export const GraphNeighborsRequestSchema = z
  .object({
    entityId: z.string().trim().min(1).max(255),
    depth: z.number().int().positive().max(2).default(1)
  })
  .strict();

export type GraphNeighborsRequest = z.infer<typeof GraphNeighborsRequestSchema>;

export const FindPathsRequestSchema = z
  .object({
    fromEntityId: z.string().trim().min(1).max(255),
    toEntityId: z.string().trim().min(1).max(255),
    maxDepth: z.number().int().positive().max(4).default(4)
  })
  .strict();

export type FindPathsRequest = z.infer<typeof FindPathsRequestSchema>;

export const ExpandContextRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000).optional(),
    chunkIds: z.array(z.string().trim().min(1).max(255)).max(25).optional(),
    entityIds: z.array(z.string().trim().min(1).max(255)).max(25).optional(),
    scope: EvidenceScopeSchema.default("domain")
  })
  .strict()
  .refine((value) => Boolean(value.query) || Boolean(value.chunkIds?.length) || Boolean(value.entityIds?.length), {
    message: "Provide a query, chunkIds, or entityIds."
  });

export type ExpandContextRequest = z.infer<typeof ExpandContextRequestSchema>;

export const ExplainPermissionsRequestSchema = z
  .object({ intent: z.string().trim().min(1).max(4_000) })
  .strict();

export const DiscoveryRequestSchema = z
  .object({ objective: z.string().trim().min(1).max(2_000).optional() })
  .strict();

export const AgentIntentRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    provider: z.enum(["deterministic", "local-huggingface"]).default("deterministic")
  })
  .strict();
export type AgentIntentRequest = z.infer<typeof AgentIntentRequestSchema>;

export const AgentIntentPlanSchema = z.object({
  provider: z.enum(["deterministic", "local-huggingface-mlx"]),
  modelId: z.string().nullable(),
  objective: z.string(),
  resourceQuery: z.string(),
  searchQuery: z.string(),
  entityQuery: z.string().nullable(),
  actionIntent: z.string().nullable(),
  requestedAction: z.boolean(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  warnings: z.array(z.string()).default([])
});
export type AgentIntentPlan = z.infer<typeof AgentIntentPlanSchema>;

export const SearchResultSchema = z.object({
  chunkId: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  text: z.string(),
  summary: z.string(),
  lexicalScore: z.number(),
  vectorScore: z.number(),
  graphBoost: z.number(),
  hybridScore: z.number(),
  evidenceClass: z.enum(["domain", "operational"]),
  entityIds: z.array(z.string()).default([]),
  governance: z
    .object({
      decision: z.enum(["allow", "mask", "deny", "review"]),
      reason: z.string(),
      sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
      owner: z.string().nullable(),
      freshness: z.enum(["fresh", "aging", "stale", "unknown"]),
      qualityScore: z.number().min(0).max(1)
    })
    .optional()
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

export const DiscoveryEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  step: z.number(),
  tool: z.string(),
  title: z.string(),
  detail: z.string(),
  severity: z.enum(["info", "warning", "success"]).default("info"),
  createdAt: z.string()
});

export type DiscoveryEvent = z.infer<typeof DiscoveryEventSchema>;

export const DiscoveryRunSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  events: z.array(DiscoveryEventSchema).default([])
});

export type DiscoveryRun = z.infer<typeof DiscoveryRunSchema>;

export const IngestRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    text: z.string().max(5_000_000).default(""),
    uri: z.string().trim().min(1).max(2_048).optional(),
    mimeType: z.string().trim().min(1).max(255).default("text/plain"),
    ingestionMode: z.enum(["full_data", "metadata_only", "external_reference"]).default("full_data"),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict()
  .superRefine((request, context) => {
    if (request.ingestionMode === "full_data" && request.text.length === 0) {
      context.addIssue({ code: "custom", path: ["text"], message: "Full-data ingestion requires text." });
    }
  });

export type IngestRequest = z.infer<typeof IngestRequestSchema>;

export const IngestResponseSchema = z.object({
  source: SourceArtifactSchema,
  chunks: z.array(ChunkSchema),
  entities: z.array(EntitySchema),
  relations: z.array(RelationSchema),
  claims: z.array(ClaimSchema)
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

export const IngestPreviewResponseSchema = IngestResponseSchema.extend({
  elements: z.array(DocumentElementSchema),
  profile: z.object({
    mode: SourceArtifactSchema.shape.ingestionMode,
    mimeType: z.string(),
    chunkCount: z.number(),
    entityCount: z.number(),
    relationCount: z.number(),
    claimCount: z.number(),
    warnings: z.array(z.string()).default([])
  })
});

export type IngestPreviewResponse = z.infer<typeof IngestPreviewResponseSchema>;

export const CuratedEntityRequestSchema = z.object({
  canonicalName: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(100).default("Concept"),
  aliases: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
  confidence: z.number().min(0).max(1).default(1),
  evidenceChunkIds: z.array(z.string().min(1).max(255)).max(100).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();

export type CuratedEntityRequest = z.infer<typeof CuratedEntityRequestSchema>;

export const CuratedRelationRequestSchema = z.object({
  sourceName: z.string().trim().min(1).max(255),
  sourceType: z.string().trim().min(1).max(100).default("Concept"),
  targetName: z.string().trim().min(1).max(255),
  targetType: z.string().trim().min(1).max(100).default("Concept"),
  relationType: z.string().trim().min(1).max(100).default("DEPENDS_ON"),
  confidence: z.number().min(0).max(1).default(1),
  evidenceChunkId: z.string().min(1).max(255).optional(),
  rationale: z.string().trim().min(1).max(2_000),
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();

export type CuratedRelationRequest = z.infer<typeof CuratedRelationRequestSchema>;

export const SystemStatusSchema = z.object({
  sources: z.number(),
  chunks: z.number(),
  entities: z.number(),
  relations: z.number(),
  claims: z.number(),
  assets: z.number(),
  metrics: z.number(),
  policies: z.number(),
  lineageEdges: z.number(),
  connections: z.number().default(0),
  resources: z.number().default(0),
  proposals: z.number().default(0),
  modules: z.array(FabricModuleSchema)
});

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const EvidenceSpanSchema = z.object({
  chunkId: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  startOffset: z.number(),
  endOffset: z.number(),
  text: z.string()
});

export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

export const CuratedRelationResponseSchema = z.object({
  sourceEntity: EntitySchema,
  targetEntity: EntitySchema,
  relation: RelationSchema,
  evidence: EvidenceSpanSchema
});

export type CuratedRelationResponse = z.infer<typeof CuratedRelationResponseSchema>;

export const BusinessActionRiskSchema = z.enum(["low", "medium", "high", "blocked"]);
export type BusinessActionRisk = z.infer<typeof BusinessActionRiskSchema>;

export const BusinessActionModeSchema = z.enum(["autonomous", "approval_required", "dry_run"]).default("autonomous");
export type BusinessActionMode = z.infer<typeof BusinessActionModeSchema>;

export const BusinessActionStatusSchema = z.enum([
  "planned",
  "approval_required",
  "executed",
  "reflected",
  "verified",
  "reconciliation_required",
  "failed",
  "blocked"
]);
export type BusinessActionStatus = z.infer<typeof BusinessActionStatusSchema>;

export const SourceSystemCapabilitySchema = z.object({
  id: z.string(),
  systemId: z.string(),
  label: z.string(),
  businessCapability: z.string(),
  technicalOperation: z.string(),
  risk: BusinessActionRiskSchema,
  autonomous: z.boolean(),
  requiresApproval: z.boolean(),
  reversible: z.boolean(),
  description: z.string()
});

export type SourceSystemCapability = z.infer<typeof SourceSystemCapabilitySchema>;

export const SourceSystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["catalog", "git", "metadata-api", "ticketing", "database", "application", "local"]),
  description: z.string(),
  capabilities: z.array(SourceSystemCapabilitySchema)
});

export type SourceSystem = z.infer<typeof SourceSystemSchema>;

export const SourceSystemRecordSchema = z.object({
  id: z.string(),
  systemId: z.string(),
  systemName: z.string(),
  objectType: z.string(),
  objectKey: z.string(),
  payload: z.record(z.string(), z.unknown()),
  version: z.number().int().positive(),
  updatedAt: z.string()
});

export type SourceSystemRecord = z.infer<typeof SourceSystemRecordSchema>;

export const SourceConnectionKindSchema = z.enum(["filesystem", "sqlite", "git"]);
export type SourceConnectionKind = z.infer<typeof SourceConnectionKindSchema>;

export const SourceWriteModeSchema = z.enum(["read_only", "approval_required", "autonomous"]);
export type SourceWriteMode = z.infer<typeof SourceWriteModeSchema>;

export const SqliteWriteRuleSchema = z
  .object({
    table: z.string().trim().min(1).max(255),
    aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    keyColumn: z.string().trim().min(1).max(255),
    allowedColumns: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
    risk: z.enum(["low", "medium", "high"]).default("medium")
  })
  .strict();

export const FilesystemConnectionConfigSchema = z
  .object({
    kind: z.literal("filesystem"),
    rootPath: z.string().trim().min(1).max(4_096),
    recursive: z.boolean().default(true),
    maxFiles: z.number().int().positive().max(10_000).default(250),
    maxFileBytes: z.number().int().positive().max(50_000_000).default(2_000_000),
    ingestionMode: z.enum(["full_data", "metadata_only", "external_reference"]).default("full_data")
  })
  .strict();

export const SqliteConnectionConfigSchema = z
  .object({
    kind: z.literal("sqlite"),
    databasePath: z.string().trim().min(1).max(4_096),
    includeTables: z.array(z.string().trim().min(1).max(255)).max(500).default([]),
    sampleRows: z.number().int().min(0).max(20).default(0),
    writeMode: SourceWriteModeSchema.default("read_only"),
    writeRules: z.array(SqliteWriteRuleSchema).max(100).default([])
  })
  .strict();

export const GitConnectionConfigSchema = z
  .object({
    kind: z.literal("git"),
    repositoryPath: z.string().trim().min(1).max(4_096),
    includePaths: z.array(z.string().trim().min(1).max(1_024)).max(500).default([]),
    maxFiles: z.number().int().positive().max(10_000).default(250),
    maxFileBytes: z.number().int().positive().max(50_000_000).default(2_000_000),
    writeMode: SourceWriteModeSchema.default("approval_required"),
    semanticContractPaths: z.array(z.string().trim().min(1).max(1_024)).max(100).default([])
  })
  .strict();

export const SourceConnectionConfigSchema = z.discriminatedUnion("kind", [
  FilesystemConnectionConfigSchema,
  SqliteConnectionConfigSchema,
  GitConnectionConfigSchema
]);
export type SourceConnectionConfig = z.infer<typeof SourceConnectionConfigSchema>;

export const CreateSourceConnectionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(2_000).default(""),
    config: SourceConnectionConfigSchema
  })
  .strict();
export type CreateSourceConnectionRequest = z.infer<typeof CreateSourceConnectionRequestSchema>;

export const SourceConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: SourceConnectionKindSchema,
  config: SourceConnectionConfigSchema,
  status: z.enum(["configured", "ready", "syncing", "degraded", "error"]),
  lastTestedAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type SourceConnection = z.infer<typeof SourceConnectionSchema>;

export const SourceConnectionTestResultSchema = z.object({
  connectionId: z.string(),
  ok: z.boolean(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
  testedAt: z.string()
});
export type SourceConnectionTestResult = z.infer<typeof SourceConnectionTestResultSchema>;

export const SourceResourceSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  externalId: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(["database", "table", "column", "file", "document", "dataset", "job", "metric", "semantic_contract"]),
  name: z.string(),
  qualifiedName: z.string(),
  dataType: z.string().nullable(),
  description: z.string(),
  uri: z.string(),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
  writable: z.boolean(),
  profile: z.record(z.string(), z.unknown()).default({}),
  evidenceChunkIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  observedAt: z.string()
});
export type SourceResource = z.infer<typeof SourceResourceSchema>;

export const GovernedSourceResourceSchema = SourceResourceSchema.extend({
  governance: z.object({
    decision: z.enum(["allow", "mask", "deny", "review"]),
    reason: z.string(),
    sensitivity: z.enum(["public", "internal", "confidential", "restricted"])
  })
});
export type GovernedSourceResource = z.infer<typeof GovernedSourceResourceSchema>;

export const SourceResourceSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    kinds: z.array(SourceResourceSchema.shape.kind).max(20).default([]),
    connectionId: z.string().trim().min(1).max(255).optional(),
    topK: z.number().int().positive().max(50).default(10)
  })
  .strict();
export type SourceResourceSearchRequest = z.infer<typeof SourceResourceSearchRequestSchema>;

export const SourceSyncEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  step: z.number().int().positive(),
  phase: z.enum(["connect", "inspect", "profile", "parse", "extract", "propose", "publish", "complete"]),
  title: z.string(),
  detail: z.string(),
  severity: z.enum(["info", "warning", "success", "error"]),
  evidenceResourceIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});
export type SourceSyncEvent = z.infer<typeof SourceSyncEventSchema>;

export const SourceSyncRunSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  objective: z.string(),
  provider: z.enum(["deterministic", "local-huggingface"]),
  status: z.enum(["running", "completed", "partial", "failed"]),
  resourcesDiscovered: z.number().int().nonnegative(),
  assetsPublished: z.number().int().nonnegative(),
  proposalsCreated: z.number().int().nonnegative(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  events: z.array(SourceSyncEventSchema).default([])
});
export type SourceSyncRun = z.infer<typeof SourceSyncRunSchema>;

export const SyncSourceConnectionRequestSchema = z
  .object({
    objective: z.string().trim().min(1).max(2_000).default("Discover source structure, semantics, governance signals, and safe action capabilities."),
    provider: z.enum(["deterministic", "local-huggingface"]).default("deterministic")
  })
  .strict();
export type SyncSourceConnectionRequest = z.infer<typeof SyncSourceConnectionRequestSchema>;

export const SourceDiscoveryMissionRequestSchema = z
  .object({
    objective: z.string().trim().min(1).max(2_000).default("Discover source structure, semantics, governance signals, and safe action capabilities."),
    provider: z.enum(["deterministic", "local-huggingface"]).default("deterministic"),
    connectionIds: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    continueOnError: z.boolean().default(true)
  })
  .strict();
export type SourceDiscoveryMissionRequest = z.infer<typeof SourceDiscoveryMissionRequestSchema>;

export const SourceDiscoveryMissionFailureSchema = z.object({
  connectionId: z.string(),
  connectionName: z.string(),
  code: z.string(),
  message: z.string()
});
export type SourceDiscoveryMissionFailure = z.infer<typeof SourceDiscoveryMissionFailureSchema>;

export const SourceDiscoveryMissionReportSchema = z.object({
  id: z.string(),
  objective: z.string(),
  provider: z.enum(["deterministic", "local-huggingface"]),
  status: z.enum(["completed", "partial", "failed"]),
  requestedConnectionIds: z.array(z.string()),
  syncRuns: z.array(SourceSyncRunSchema),
  failures: z.array(SourceDiscoveryMissionFailureSchema),
  discoveryRun: DiscoveryRunSchema.nullable(),
  summary: z.object({
    connectionsAttempted: z.number().int().nonnegative(),
    completedSyncs: z.number().int().nonnegative(),
    partialSyncs: z.number().int().nonnegative(),
    failedSyncs: z.number().int().nonnegative(),
    resourcesDiscovered: z.number().int().nonnegative(),
    assetsPublished: z.number().int().nonnegative(),
    proposalsCreated: z.number().int().nonnegative(),
    proposalsAwaitingReview: z.number().int().nonnegative()
  }),
  startedAt: z.string(),
  completedAt: z.string()
});
export type SourceDiscoveryMissionReport = z.infer<typeof SourceDiscoveryMissionReportSchema>;

export const SemanticProposalSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  runId: z.string(),
  kind: z.enum(["relation", "classification", "description", "ontology_class", "metric", "conflict"]),
  subjectId: z.string(),
  predicate: z.string(),
  objectId: z.string().nullable(),
  value: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  origin: z.enum(["source_fact", "deterministic_inference", "local_model", "manual"]),
  authoritative: z.boolean().default(false),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
  evidenceResourceIds: z.array(z.string()).default([]),
  evidenceChunkIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionRationale: z.string().nullable()
});
export type SemanticProposal = z.infer<typeof SemanticProposalSchema>;

export const SemanticProposalDecisionRequestSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    rationale: z.string().trim().min(1).max(2_000)
  })
  .strict();
export type SemanticProposalDecisionRequest = z.infer<typeof SemanticProposalDecisionRequestSchema>;

export const BusinessActionRequestSchema = z.object({
  intent: z.string().trim().min(1).max(4_000),
  mode: BusinessActionModeSchema,
  maxAutonomousRisk: z.enum(["low", "medium", "high"]).default("medium"),
  context: z.record(z.string(), z.unknown()).default({})
}).strict();

export type BusinessActionRequest = z.infer<typeof BusinessActionRequestSchema>;

export const BusinessActionDiffSchema = z.object({
  summary: z.string(),
  before: z.string().nullable(),
  after: z.string()
});

export type BusinessActionDiff = z.infer<typeof BusinessActionDiffSchema>;

export const BusinessActionTargetSchema = z.object({
  stepId: z.string(),
  systemId: z.string(),
  systemName: z.string(),
  capability: z.string(),
  technicalOperation: z.string(),
  objectType: z.string(),
  objectKey: z.string(),
  risk: BusinessActionRiskSchema,
  autonomy: z.enum(["autonomous", "approval_required", "blocked"]),
  status: BusinessActionStatusSchema,
  rationale: z.string(),
  evidenceChunkIds: z.array(z.string()).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  diff: BusinessActionDiffSchema
});

export type BusinessActionTarget = z.infer<typeof BusinessActionTargetSchema>;

export const BusinessActionPrincipalSchema = z.object({
  actor: z.string().min(1).max(255),
  roles: z.array(z.string().min(1).max(100)).max(20),
  clearance: z.enum(["public", "internal", "confidential", "restricted"]),
  policyVersion: z.string().min(1).max(100)
});

export type BusinessActionPrincipal = z.infer<typeof BusinessActionPrincipalSchema>;

export const BusinessActionPlanSchema = z.object({
  id: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  intent: z.string(),
  actionType: z.string(),
  title: z.string(),
  summary: z.string(),
  mode: BusinessActionModeSchema,
  maxAutonomousRisk: z.enum(["low", "medium", "high"]),
  risk: BusinessActionRiskSchema,
  status: BusinessActionStatusSchema,
  principal: BusinessActionPrincipalSchema,
  targets: z.array(BusinessActionTargetSchema),
  warnings: z.array(z.string()).default([]),
  createdAt: z.string()
});

export type BusinessActionPlan = z.infer<typeof BusinessActionPlanSchema>;

export const BusinessActionExecutionRequestSchema = z
  .object({
    planId: z.string().trim().min(1).max(255),
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    intent: z.string().trim().min(1).max(4_000),
    mode: BusinessActionModeSchema,
    maxAutonomousRisk: z.enum(["low", "medium", "high"]).default("medium"),
    approvalId: z.string().trim().min(1).max(255).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
    context: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type BusinessActionExecutionRequest = z.infer<typeof BusinessActionExecutionRequestSchema>;

export const BusinessActionApprovalRequestSchema = z
  .object({
    planId: z.string().trim().min(1).max(255),
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    intent: z.string().trim().min(1).max(4_000),
    mode: BusinessActionModeSchema,
    maxAutonomousRisk: z.enum(["low", "medium", "high"]).default("medium"),
    rationale: z.string().trim().min(1).max(2_000),
    context: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type BusinessActionApprovalRequest = z.infer<typeof BusinessActionApprovalRequestSchema>;

export const BusinessActionApprovalSchema = z.object({
  id: z.string(),
  planId: z.string(),
  planFingerprint: z.string(),
  approvedBy: z.string(),
  rationale: z.string(),
  status: z.enum(["active", "consumed", "revoked"]),
  createdAt: z.string(),
  consumedAt: z.string().nullable()
});

export type BusinessActionApproval = z.infer<typeof BusinessActionApprovalSchema>;

export const SourceWriteSchema = z.object({
  id: z.string(),
  planId: z.string(),
  stepId: z.string(),
  systemId: z.string(),
  systemName: z.string(),
  objectType: z.string(),
  objectKey: z.string(),
  operation: z.string(),
  status: z.enum(["executed", "skipped", "failed"]),
  dryRun: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

export type SourceWrite = z.infer<typeof SourceWriteSchema>;

export const ReflectionResultSchema = z.object({
  id: z.string(),
  writeId: z.string(),
  sourceRecordId: z.string().nullable(),
  status: z.enum(["verified", "missing", "drift"]),
  summary: z.string(),
  evidenceChunkId: z.string().nullable(),
  observedAt: z.string()
});

export type ReflectionResult = z.infer<typeof ReflectionResultSchema>;

export const SemanticUpdateSchema = z.object({
  sourceId: z.string().nullable(),
  chunkIds: z.array(z.string()).default([]),
  entityIds: z.array(z.string()).default([]),
  relationIds: z.array(z.string()).default([]),
  searchQuery: z.string()
});

export type SemanticUpdate = z.infer<typeof SemanticUpdateSchema>;

export const BusinessActionRunSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  intent: z.string(),
  actionType: z.string(),
  status: BusinessActionStatusSchema,
  mode: BusinessActionModeSchema,
  risk: BusinessActionRiskSchema,
  plan: BusinessActionPlanSchema,
  writes: z.array(SourceWriteSchema),
  reflections: z.array(ReflectionResultSchema),
  semanticUpdates: z.array(SemanticUpdateSchema),
  createdAt: z.string(),
  completedAt: z.string().nullable()
});

export type BusinessActionRun = z.infer<typeof BusinessActionRunSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  decision: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const SemanticAssetSchema = z.object({
  id: z.string(),
  kind: z.enum(["dataset", "table", "column", "dashboard", "pipeline", "api", "document", "semantic_contract", "metric", "glossary_term"]),
  name: z.string(),
  domain: z.string(),
  owner: z.string(),
  description: z.string(),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
  freshness: z.enum(["fresh", "aging", "stale", "unknown"]).default("unknown"),
  qualityScore: z.number().min(0).max(1).default(0.5),
  uri: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type SemanticAsset = z.infer<typeof SemanticAssetSchema>;

export const MetricDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  description: z.string(),
  expression: z.string(),
  dimensions: z.array(z.string()).default([]),
  owner: z.string(),
  domain: z.string(),
  contractVersion: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  effect: z.enum(["allow", "mask", "deny", "review"]),
  appliesTo: z.array(z.string()).default([]),
  condition: z.string(),
  rationale: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const LineageEdgeSchema = z.object({
  id: z.string(),
  fromAssetId: z.string(),
  toAssetId: z.string(),
  type: z.enum(["READS", "WRITES", "DERIVES", "FEEDS", "DOCUMENTS", "GOVERNS"]),
  confidence: z.number().min(0).max(1),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type LineageEdge = z.infer<typeof LineageEdgeSchema>;

export const OntologyClassSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  parentId: z.string().nullable(),
  constraints: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type OntologyClass = z.infer<typeof OntologyClassSchema>;

export const SemanticContractSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  domain: z.string(),
  status: z.enum(["draft", "active", "deprecated"]),
  assets: z.array(SemanticAssetSchema).default([]),
  metrics: z.array(MetricDefinitionSchema).default([]),
  policies: z.array(PolicyRuleSchema).default([]),
  ontologyClasses: z.array(OntologyClassSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type SemanticContract = z.infer<typeof SemanticContractSchema>;

export const CatalogSnapshotSchema = z
  .object({
    assets: z.array(SemanticAssetSchema).max(100_000),
    metrics: z.array(MetricDefinitionSchema).max(100_000),
    policies: z.array(PolicyRuleSchema).max(10_000),
    lineage: z.array(LineageEdgeSchema).max(500_000),
    contracts: z.array(SemanticContractSchema).max(10_000),
    ontologyClasses: z.array(OntologyClassSchema).max(100_000)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const assetIds = new Set(snapshot.assets.map((asset) => asset.id));
    snapshot.lineage.forEach((edge, index) => {
      if (!assetIds.has(edge.fromAssetId)) {
        context.addIssue({ code: "custom", path: ["lineage", index, "fromAssetId"], message: "Lineage source asset does not exist." });
      }
      if (!assetIds.has(edge.toAssetId)) {
        context.addIssue({ code: "custom", path: ["lineage", index, "toAssetId"], message: "Lineage target asset does not exist." });
      }
    });
  });

export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string(),
  kind: z.enum(["deterministic", "ollama", "openai-compatible"]),
  baseUrl: z.string().optional(),
  model: z.string(),
  embeddingModel: z.string().optional(),
  enabled: z.boolean(),
  runtimeUsage: z.enum(["semantic-runtime", "configuration-only"])
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface ApiErrorPayload {
  error: string;
  code?: string;
  requestId?: string;
  details?: unknown;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly requestId?: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function resolveApiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export function createJsonRequester(baseUrl = "", timeoutMs = 15_000) {
  return async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await fetch(resolveApiUrl(baseUrl, path), {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {})
        }
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: response.statusText }))) as Partial<ApiErrorPayload>;
        throw new ApiRequestError(payload.error ?? response.statusText, response.status, payload.code, payload.requestId, payload.details);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ApiRequestError)) {
        throw new ApiRequestError("The API request was cancelled or timed out.", 0, "REQUEST_ABORTED");
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

export interface ApiStartupRetryOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export async function retryApiStartup<T>(
  operation: () => Promise<T>,
  options: ApiStartupRetryOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  let delayMs = options.initialDelayMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const apiError = findApiRequestError(error);
      const retryable = !apiError || apiError.status === 0 || apiError.status >= 500;
      if (!retryable || Date.now() >= deadline) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    }
  }
}

function findApiRequestError(error: unknown): ApiRequestError | null {
  if (error instanceof ApiRequestError) return error;
  if (error instanceof Error && error.cause && error.cause !== error) return findApiRequestError(error.cause);
  return null;
}
