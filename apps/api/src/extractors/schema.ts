export interface SemanticSchema {
  entityTypes: Array<{
    type: string;
    patterns: string[];
    description: string;
  }>;
  relationPatterns: Array<{
    type: string;
    verbs: string[];
    confidence: number;
  }>;
}

export const defaultSemanticSchema: SemanticSchema = {
  entityTypes: [
    {
      type: "System",
      patterns: ["platform", "database", "api", "service", "engine", "framework", "runtime", "store"],
      description: "A software system, platform, or infrastructure component."
    },
    {
      type: "Dataset",
      patterns: ["dataset", "corpus", "document", "source", "artifact", "table", "file"],
      description: "A data asset or collection of records."
    },
    {
      type: "Process",
      patterns: ["pipeline", "workflow", "ingestion", "indexing", "extraction", "discovery", "evaluation"],
      description: "A transformation, operational process, or workflow."
    },
    {
      type: "Concept",
      patterns: ["semantic", "ontology", "provenance", "claim", "entity", "relation", "context", "governance"],
      description: "A semantic or architectural concept."
    },
    {
      type: "Organization",
      patterns: ["inc", "corp", "foundation", "lab", "team", "company"],
      description: "An organization, team, or company."
    }
  ],
  relationPatterns: [
    { type: "USES", verbs: ["uses", "use", "runs on", "powered by"], confidence: 0.82 },
    { type: "INTEGRATES_WITH", verbs: ["integrates with", "connects to", "connects with", "adapts to"], confidence: 0.84 },
    { type: "STORES_IN", verbs: ["stores in", "persists in", "writes to", "indexes into"], confidence: 0.86 },
    { type: "EXPOSES", verbs: ["exposes", "provides", "publishes"], confidence: 0.8 },
    { type: "DEPENDS_ON", verbs: ["depends on", "requires", "needs"], confidence: 0.78 },
    { type: "DISCOVERS", verbs: ["discovers", "extracts", "identifies", "detects"], confidence: 0.8 }
  ]
};

