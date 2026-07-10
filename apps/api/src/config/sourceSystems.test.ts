import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSourceSystems } from "./sourceSystems.js";

describe("source-system configuration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("loads a validated external capability registry", () => {
    const configPath = writeConfig([
      {
        id: "source.custom",
        name: "Custom Source",
        kind: "application",
        description: "Externalized test source.",
        capabilities: [
          {
            id: "custom.annotate",
            systemId: "source.custom",
            label: "Annotate",
            businessCapability: "asset.annotate_context",
            technicalOperation: "custom.annotation.upsert",
            risk: "low",
            autonomous: true,
            requiresApproval: false,
            reversible: true,
            description: "Write an annotation."
          }
        ]
      }
    ]);

    const systems = loadSourceSystems(configPath);
    expect(systems).toHaveLength(1);
    expect(systems[0]?.capabilities[0]?.technicalOperation).toBe("custom.annotation.upsert");
  });

  it("rejects duplicate capabilities and cross-system capability references", () => {
    const configPath = writeConfig([
      {
        id: "source.one",
        name: "One",
        kind: "application",
        description: "First source.",
        capabilities: [capability("shared", "source.two")]
      },
      {
        id: "source.two",
        name: "Two",
        kind: "application",
        description: "Second source.",
        capabilities: [capability("shared", "source.two")]
      }
    ]);

    expect(() => loadSourceSystems(configPath)).toThrow();
  });

  function writeConfig(value: unknown): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-sources-"));
    tempDirs.push(directory);
    const configPath = path.join(directory, "sources.json");
    fs.writeFileSync(configPath, JSON.stringify(value), "utf8");
    return configPath;
  }
});

function capability(id: string, systemId: string) {
  return {
    id,
    systemId,
    label: "Capability",
    businessCapability: "asset.annotate_context",
    technicalOperation: "custom.annotation.upsert",
    risk: "low",
    autonomous: true,
    requiresApproval: false,
    reversible: true,
    description: "Test capability."
  };
}
