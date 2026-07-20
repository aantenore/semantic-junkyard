import { loadRuntimeConfig, openControlPlaneDatabase } from "@semantic-junkyard/api";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMcpLaunchOptions } from "./launchOptions.js";

describe("MCP launch options", () => {
  it("uses runtime configuration unless a relative CLI database path overrides it", () => {
    expect(parseMcpLaunchOptions([], "configured.sqlite").databaseRelativePath).toBe("configured.sqlite");
    expect(parseMcpLaunchOptions(["--db", "sessions/agent.sqlite"], "configured.sqlite").databaseRelativePath)
      .toBe("sessions/agent.sqlite");
  });

  it("fails closed for missing, duplicate, and unknown options", () => {
    expect(() => parseMcpLaunchOptions(["--db"], "configured.sqlite")).toThrow(/requires/);
    expect(() => parseMcpLaunchOptions(["--db", "one.sqlite", "--db", "two.sqlite"], "configured.sqlite"))
      .toThrow(/only once/);
    expect(() => parseMcpLaunchOptions(["--memory", "--db", "control.sqlite"], "configured.sqlite"))
      .toThrow(/mutually exclusive/);
    expect(() => parseMcpLaunchOptions(["--unexpected"], "configured.sqlite")).toThrow(/Unknown/);
  });

  it("keeps memory seeding and mutation capabilities explicit", () => {
    expect(parseMcpLaunchOptions(["--memory", "--allow-sync"], "ignored.sqlite")).toMatchObject({
      memory: true,
      seed: true,
      allowSourceSync: true,
      allowBusinessWrites: false
    });
    expect(parseMcpLaunchOptions(["--memory", "--no-seed", "--allow-write"], "ignored.sqlite"))
      .toMatchObject({ memory: true, seed: false, allowBusinessWrites: true });
  });

  it.each([
    ["CLI traversal", ["--db", "../escape.sqlite"], {}],
    ["environment absolute path", [], { SEMANTIC_JUNKYARD_DB: path.resolve(os.tmpdir(), "escape.sqlite") }]
  ])("routes unsafe %s through the shared control-plane policy", (_label, argv, environment) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-mcp-options-"));
    try {
      const config = loadRuntimeConfig(environment, { validateHttpSecurity: false });
      const launch = parseMcpLaunchOptions(argv, config.databaseRelativePath);
      expect(() => openControlPlaneDatabase({
        authorizedRoot: root,
        databasePath: launch.databaseRelativePath
      })).toThrow();
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
