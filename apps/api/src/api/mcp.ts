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
    ...manifest.capabilities.map((capability) => ({
      name: capability.name,
      description: `${capability.description} Risk: ${capability.risk}. Evidence required: ${capability.evidenceRequired}.`,
      inputSchema: {
        type: "object" as const,
        additionalProperties: true,
        properties: Object.fromEntries(
          Object.entries(capability.inputSchema).map(([key, value]) => [
            key,
            {
              type: String(value).includes("number") ? "number" : String(value).includes("[]") ? "array" : "string",
              description: String(value)
            }
          ])
        )
      }
    })),
    {
      name: "get_evidence",
      description: "Open a single evidence chunk by ID and return source-spanned text for citation.",
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
      description: "Run the read-only discovery profiler over the current semantic fabric.",
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
      command: "node apps/mcp/dist/server.js"
    },
    summary: `${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`,
    tools,
    resources,
    prompts
  };
}

export function legacyMcpToolDescriptors(manifest: AgentManifest) {
  return manifest.capabilities.map((capability) => ({
    name: capability.name,
    description: `${capability.description} Risk: ${capability.risk}. Evidence required: ${capability.evidenceRequired}.`,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: Object.fromEntries(
        Object.entries(capability.inputSchema).map(([key, value]) => [
          key,
          {
            type: String(value).includes("number") ? "number" : String(value).includes("[]") ? "array" : "string",
            description: String(value)
          }
        ])
      )
    }
  }));
}
