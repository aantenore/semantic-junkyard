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
  confidence: z.number(),
  evidenceChunkIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type Entity = z.infer<typeof EntitySchema>;

export const RelationSchema = z.object({
  id: z.string(),
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  type: z.string(),
  confidence: z.number(),
  evidenceChunkId: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type Relation = z.infer<typeof RelationSchema>;

export const ClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  confidence: z.number(),
  evidenceChunkId: z.string(),
  entityIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type Claim = z.infer<typeof ClaimSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  confidence: z.number(),
  degree: z.number().default(0)
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string(),
  confidence: z.number(),
  evidenceChunkId: z.string()
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSnapshotSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema)
});

export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(25).default(8),
  mode: z.enum(["hybrid", "lexical", "vector", "graph"]).default("hybrid")
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

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
  entityIds: z.array(z.string()).default([])
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

export const IngestRequestSchema = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
  uri: z.string().optional(),
  mimeType: z.string().default("text/plain"),
  ingestionMode: z.enum(["full_data", "metadata_only", "external_reference"]).default("full_data"),
  metadata: z.record(z.string(), z.unknown()).default({})
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
  canonicalName: z.string().min(1),
  type: z.string().min(1).default("Concept"),
  aliases: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1),
  evidenceChunkIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type CuratedEntityRequest = z.infer<typeof CuratedEntityRequestSchema>;

export const CuratedRelationRequestSchema = z.object({
  sourceName: z.string().min(1),
  sourceType: z.string().min(1).default("Concept"),
  targetName: z.string().min(1),
  targetType: z.string().min(1).default("Concept"),
  relationType: z.string().min(1).default("DEPENDS_ON"),
  confidence: z.number().min(0).max(1).default(1),
  evidenceChunkId: z.string().optional(),
  rationale: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

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

export const BusinessActionStatusSchema = z.enum(["planned", "approval_required", "executed", "reflected", "verified", "failed", "blocked"]);
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

export const BusinessActionRequestSchema = z.object({
  intent: z.string().min(1),
  mode: BusinessActionModeSchema,
  approved: z.boolean().default(false),
  actor: z.string().default("business-user"),
  maxAutonomousRisk: z.enum(["low", "medium", "high"]).default("medium"),
  context: z.record(z.string(), z.unknown()).default({})
});

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
  diff: BusinessActionDiffSchema
});

export type BusinessActionTarget = z.infer<typeof BusinessActionTargetSchema>;

export const BusinessActionPlanSchema = z.object({
  id: z.string(),
  intent: z.string(),
  actionType: z.string(),
  title: z.string(),
  summary: z.string(),
  mode: BusinessActionModeSchema,
  risk: BusinessActionRiskSchema,
  status: BusinessActionStatusSchema,
  targets: z.array(BusinessActionTargetSchema),
  warnings: z.array(z.string()).default([]),
  createdAt: z.string()
});

export type BusinessActionPlan = z.infer<typeof BusinessActionPlanSchema>;

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
  confidence: z.number(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type LineageEdge = z.infer<typeof LineageEdgeSchema>;

export const OntologyClassSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  parentId: z.string().nullable(),
  constraints: z.array(z.string()).default([])
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

export const CatalogSnapshotSchema = z.object({
  assets: z.array(SemanticAssetSchema),
  metrics: z.array(MetricDefinitionSchema),
  policies: z.array(PolicyRuleSchema),
  lineage: z.array(LineageEdgeSchema),
  contracts: z.array(SemanticContractSchema),
  ontologyClasses: z.array(OntologyClassSchema)
});

export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string(),
  kind: z.enum(["deterministic", "ollama", "openai-compatible"]),
  baseUrl: z.string().optional(),
  model: z.string(),
  embeddingModel: z.string().optional(),
  enabled: z.boolean()
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
