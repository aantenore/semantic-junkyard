import type { AgentManifest } from "../agent/discoveryAgent.js";

export interface McpDescriptor {
  name: string;
  description: string;
}

export interface McpToolDescriptor extends McpDescriptor {
  inputSchema: {
    type: "object";
    additionalProperties: boolean;
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export function toMcpToolDescriptors(manifest: AgentManifest) {
  return [
    ...manifest.capabilities.map(manifestCapabilityToDescriptor),
    {
      name: "get_evidence",
      description: "Open a single evidence chunk by ID and return policy-filtered transformed-text evidence for citation.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        required: ["chunkId"],
        properties: {
          chunkId: { type: "string", description: "Evidence chunk ID returned by search or context expansion." }
        }
      }
    },
    {
      name: "run_discovery",
      description: "Profile the current semantic fabric and persist a new discovery run with audit events.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          objective: { type: "string", description: "Optional discovery objective." }
        }
      }
    }
  ] satisfies McpToolDescriptor[];
}

export function mcpResourceDescriptors(): McpDescriptor[] {
  return [
    { name: "status", description: "Current semantic fabric counts and active modules." },
    { name: "manifest", description: "Agent capability manifest, operating rules, and stop conditions." },
    { name: "catalog", description: "Governed assets, metrics, policies, lineage, contracts, and ontology classes." },
    { name: "graph", description: "Current entity and relation graph snapshot." },
    { name: "source-resources", description: "Observed tables, columns, files, datasets, jobs, metrics, and semantic contracts." },
    { name: "source-systems", description: "Configured writeback source systems and reflected source records." },
    { name: "evidence", description: "Evidence chunk resource template: semantic-junkyard://evidence/{chunkId}." }
  ];
}

export function mcpPromptDescriptors(): McpDescriptor[] {
  return [
    { name: "agent_discovery_brief", description: "Brief an agent to discover relevant governed context before answering." },
    { name: "governed_context_answer", description: "Guide an evidence-first answer over semantic contracts, graph, citations, and optional reflected business actions." },
    { name: "semantic_mapping_review", description: "Review whether extracted entities and relationships are sufficient for an agent task." }
  ];
}

export function mcpCapabilitySnapshot(manifest: AgentManifest) {
  const tools = toMcpToolDescriptors(manifest);
  const resources = mcpResourceDescriptors();
  const prompts = mcpPromptDescriptors();
  return {
    server: {
      name: "semantic-junkyard-mcp",
      version: "0.1.0",
      transport: "stdio",
      command: "node apps/mcp/dist/server.js",
      defaultAccess: "read_only",
      mutationFlags: {
        discovery: "--allow-discovery",
        sourceSync: "--allow-sync",
        businessWriteback: "--allow-write"
      }
    },
    summary: `Read-only by default; ${tools.length} contract descriptors, ${resources.length} resources, ${prompts.length} prompts`,
    tools,
    resources,
    prompts
  };
}

export function legacyMcpToolDescriptors(manifest: AgentManifest) {
  return manifest.capabilities.map(manifestCapabilityToDescriptor);
}

function manifestCapabilityToDescriptor(capability: AgentManifest["capabilities"][number]): McpToolDescriptor {
  const entries = Object.entries(capability.inputSchema);
  return {
    name: capability.name,
    description: `${capability.description} Risk: ${capability.risk}. Evidence required: ${capability.evidenceRequired}.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: entries.filter(([, value]) => !String(value).includes("optional")).map(([key]) => key),
      properties: Object.fromEntries(
        entries.map(([key, value]) => {
          const description = String(value);
          const type = description.includes("number") ? "number" : description.includes("boolean") ? "boolean" : description.includes("[]") ? "array" : "string";
          return [key, { type, description }];
        })
      )
    }
  };
}
