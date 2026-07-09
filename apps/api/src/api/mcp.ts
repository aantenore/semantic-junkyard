import type { AgentManifest } from "../agent/discoveryAgent.js";

export function toMcpToolDescriptors(manifest: AgentManifest) {
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
