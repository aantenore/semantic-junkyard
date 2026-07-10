import type {
  BusinessActionRequest,
  BusinessActionRisk,
  IngestRequest,
  LineageEdge,
  MetricDefinition,
  OntologyClass,
  SemanticAsset,
  SemanticContract,
  SourceConnection,
  SourceConnectionKind,
  SourceResource
} from "@semantic-junkyard/shared";

export interface ConnectorDocument {
  resourceExternalId: string;
  request: IngestRequest;
}

export interface ConnectorSemanticRelation {
  subjectExternalId: string;
  predicate: string;
  objectExternalId: string;
  confidence: number;
  explanation: string;
  authoritative: boolean;
}

export interface ConnectorSnapshot {
  resources: SourceResource[];
  documents: ConnectorDocument[];
  assets: SemanticAsset[];
  metrics: MetricDefinition[];
  lineage: LineageEdge[];
  contracts: SemanticContract[];
  ontologyClasses: OntologyClass[];
  relations: ConnectorSemanticRelation[];
  warnings: string[];
  checkpoint: Record<string, unknown>;
}

export interface ConnectorTestResult {
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
}

export interface ConnectorActionCandidate {
  connectionId: string;
  capability: string;
  technicalOperation: string;
  objectType: string;
  objectKey: string;
  title: string;
  rationale: string;
  risk: BusinessActionRisk;
  requiresApproval: boolean;
  evidenceResourceIds: string[];
  evidenceChunkIds: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

export interface ConnectorWriteResult {
  sourceVersion: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  readback: Record<string, unknown>;
  postconditionPassed: boolean;
  postcondition: string;
  metadata: Record<string, unknown>;
}

export interface SourceConnector {
  readonly kind: SourceConnectionKind;
  test(connection: SourceConnection): ConnectorTestResult;
  discover(connection: SourceConnection): ConnectorSnapshot;
  planAction?(connection: SourceConnection, request: BusinessActionRequest, resources: SourceResource[]): ConnectorActionCandidate | null;
  executeAction?(connection: SourceConnection, candidate: ConnectorActionCandidate): ConnectorWriteResult;
  readAction?(connection: SourceConnection, candidate: ConnectorActionCandidate): ConnectorWriteResult;
}
