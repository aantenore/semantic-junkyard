import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSupplyChainDemoSources } from "./demoSources.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("reference source bootstrap paths", () => {
  it.each(["knowledge", "semantic-contracts"])("rejects a symbolic-link %s directory before writing outside", (child) => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "unchanged");
    fs.symlinkSync(outside, path.join(root, child), process.platform === "win32" ? "junction" : "dir");

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual(["sentinel.txt"]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "operations.sqlite"))).toBe(false);
  });

  it("rejects symbolic-link Git metadata before creating any source fixture", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const repository = path.join(root, "semantic-contracts");
    fs.mkdirSync(repository);
    fs.symlinkSync(outside, path.join(repository, ".git"), process.platform === "win32" ? "junction" : "dir");

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/metadata cannot be a symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
    expect(fs.existsSync(path.join(root, "operations.sqlite"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link operations database without touching its target", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const target = path.join(outside, "operations.sqlite");
    fs.writeFileSync(target, "unchanged");
    fs.symlinkSync(target, path.join(root, "operations.sqlite"), "file");

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/database cannot be a symbolic link/);
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
  });

  it("rejects a multiply linked operations database without changing its peer", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const target = path.join(outside, "operations.sqlite");
    fs.writeFileSync(target, "unchanged");
    fs.linkSync(target, path.join(root, "operations.sqlite"));

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/multiple hard links/);
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
  });

  it.each(["-journal", "-shm", "-wal"])("rejects an orphan operations database %s sidecar", (suffix) => {
    const root = temporaryRoot();
    const sidecar = path.join(root, `operations.sqlite${suffix}`);
    fs.writeFileSync(sidecar, "unchanged");

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/orphaned SQLite sidecar/);
    expect(fs.readFileSync(sidecar, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "operations.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
  });

  it("rejects a multiply linked sidecar beside an existing operations database", () => {
    const root = temporaryRoot();
    const first = ensureSupplyChainDemoSources(root);
    const outside = temporaryRoot();
    const sentinel = path.join(outside, "sentinel");
    fs.writeFileSync(sentinel, "unchanged");
    fs.linkSync(sentinel, `${first.operationsDatabasePath}-journal`);

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/multiple hard links/);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
  });

  it("rejects a symbolic link inside existing Git metadata before writing fixtures", () => {
    const root = temporaryRoot();
    const first = ensureSupplyChainDemoSources(root);
    const outside = temporaryRoot();
    const objects = path.join(first.semanticRepositoryPath, ".git", "objects");
    fs.rmSync(objects, { recursive: true });
    fs.symlinkSync(outside, objects, process.platform === "win32" ? "junction" : "dir");

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/metadata cannot contain symbolic links/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("ignores inherited Git object-directory overrides", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const previous = process.env.GIT_OBJECT_DIRECTORY;
    process.env.GIT_OBJECT_DIRECTORY = outside;
    try {
      const sources = ensureSupplyChainDemoSources(root);
      expect(fs.existsSync(path.join(sources.semanticRepositoryPath, ".git", "objects"))).toBe(true);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
      else process.env.GIT_OBJECT_DIRECTORY = previous;
    }
  });

  it("rejects repository attributes before invoking Git", () => {
    const root = temporaryRoot();
    const repository = path.join(root, "semantic-contracts");
    fs.mkdirSync(repository);
    fs.writeFileSync(path.join(repository, ".gitattributes"), "* filter=external\n");

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/cannot define Git attributes/);
    expect(fs.existsSync(path.join(repository, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(root, "operations.sqlite"))).toBe(false);
  });

  it("rejects attributes stored in Git metadata", () => {
    const root = temporaryRoot();
    const first = ensureSupplyChainDemoSources(root);
    fs.writeFileSync(path.join(first.semanticRepositoryPath, ".git", "info", "attributes"), "* filter=external\n");

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/info\/attributes/);
  });

  it("rejects non-minimal local Git configuration", () => {
    const root = temporaryRoot();
    const first = ensureSupplyChainDemoSources(root);
    fs.appendFileSync(
      path.join(first.semanticRepositoryPath, ".git", "config"),
      '\n[filter "external"]\n\tclean = external-command\n'
    );

    expect(() => ensureSupplyChainDemoSources(root)).toThrow(/unsupported section/);
  });

  it("force-adds the contract despite repository excludes and verifies exact committed bytes", () => {
    const root = temporaryRoot();
    const repository = path.join(root, "semantic-contracts");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--initial-branch=main", repository], { stdio: "ignore" });
    fs.appendFileSync(path.join(repository, ".git", "info", "exclude"), "contracts/\n");

    const sources = ensureSupplyChainDemoSources(root);
    const source = fs.readFileSync(path.join(repository, sources.semanticContractPath));
    const committed = execFileSync("git", ["-C", repository, "show", `HEAD:${sources.semanticContractPath}`]);
    expect(committed.equals(source)).toBe(true);
  });

  it("creates an idempotent confined fixture and stages only its semantic contract", () => {
    const root = temporaryRoot();
    const first = ensureSupplyChainDemoSources(root);
    const second = ensureSupplyChainDemoSources(root);
    const canonicalRoot = fs.realpathSync(root);

    expect(first).toEqual(second);
    for (const candidate of [first.operationsDatabasePath, first.knowledgePath, first.semanticRepositoryPath]) {
      const relative = path.relative(canonicalRoot, fs.realpathSync(candidate));
      expect(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)).toBe(false);
    }
    expect(fs.existsSync(path.join(first.knowledgePath, "dispatch-policy.md"))).toBe(true);
    expect(fs.existsSync(path.join(first.semanticRepositoryPath, first.semanticContractPath))).toBe(true);
    const source = fs.readFileSync(path.join(first.semanticRepositoryPath, first.semanticContractPath));
    const committed = execFileSync("git", ["-C", first.semanticRepositoryPath, "show", `HEAD:${first.semanticContractPath}`]);
    expect(committed.equals(source)).toBe(true);
  });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-reference-"));
  temporaryRoots.push(root);
  return root;
}
