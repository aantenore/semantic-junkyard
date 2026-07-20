import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultControlPlaneRoot } from "./defaultControlPlaneRoot.js";

describe("default control-plane root", () => {
  it("resolves source and compiled modules to the same product data directory", () => {
    const apiRoot = path.resolve(import.meta.dirname, "../..");
    const sourceModule = new URL("./defaultControlPlaneRoot.ts", import.meta.url).href;
    const compiledModule = new URL("../../dist/storage/defaultControlPlaneRoot.js", import.meta.url).href;

    expect(defaultControlPlaneRoot(sourceModule)).toBe(path.join(apiRoot, "data"));
    expect(defaultControlPlaneRoot(compiledModule)).toBe(path.join(apiRoot, "data"));
  });
});
