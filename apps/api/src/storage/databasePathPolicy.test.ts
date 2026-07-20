import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openControlPlaneDatabase } from "./database.js";
import {
  ControlPlanePathError,
  resolveControlPlaneStoragePaths
} from "./databasePathPolicy.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("control-plane database path policy", () => {
  it("creates a private contained layout and returns canonical paths", () => {
    const root = temporaryRoot();
    if (process.platform !== "win32") fs.chmodSync(root, 0o755);
    const openSpy = vi.spyOn(fs, "openSync");

    const opened = openControlPlaneDatabase({
      authorizedRoot: root,
      databasePath: "state/control.sqlite"
    });
    try {
      const canonicalRoot = fs.realpathSync(root);
      expect(opened.authorizedRoot).toBe(canonicalRoot);
      expect(opened.databasePath).toBe(path.join(canonicalRoot, "state", "control.sqlite"));
      expect(opened.referenceSourcesRoot).toBe(path.join(canonicalRoot, "reference-sources"));
      expect(opened.databaseWasCreated).toBe(true);
      expect(fs.statSync(opened.databasePath).isFile()).toBe(true);
      expect(fs.statSync(opened.referenceSourcesRoot).isDirectory()).toBe(true);
      expect(openSpy).toHaveBeenCalledWith(opened.databasePath, "wx+", 0o600);
      expect(opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sources'").get()).toEqual({ name: "sources" });

      if (process.platform !== "win32") {
        expect(modeOf(opened.authorizedRoot)).toBe(0o700);
        expect(modeOf(path.dirname(opened.databasePath))).toBe(0o700);
        expect(modeOf(opened.referenceSourcesRoot)).toBe(0o700);
        expect(modeOf(opened.databasePath)).toBe(0o600);
      }
    } finally {
      opened.db.close();
    }
  });

  it("reopens an existing regular database without replacing its contents", () => {
    const root = temporaryRoot();
    const first = openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" });
    first.db.exec("CREATE TABLE persistence_probe (value TEXT NOT NULL)");
    first.db.prepare("INSERT INTO persistence_probe (value) VALUES (?)").run("kept");
    first.db.close();

    const openSpy = vi.spyOn(fs, "openSync");
    const second = openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" });
    try {
      expect(second.databaseWasCreated).toBe(false);
      expect(second.db.prepare("SELECT value FROM persistence_probe").get()).toEqual({ value: "kept" });
      expect(openSpy.mock.calls.some((call) => call[1] === "wx+")).toBe(false);
    } finally {
      second.db.close();
    }
  });

  it("resolves valid paths without any file-system mutation", () => {
    const root = temporaryRoot();
    if (process.platform !== "win32") fs.chmodSync(root, 0o755);
    const before = fs.statSync(root);

    const resolved = resolveControlPlaneStoragePaths({
      authorizedRoot: root,
      databasePath: "nested/control.sqlite"
    });

    expect(resolved.databasePath).toBe(path.join(fs.realpathSync(root), "nested", "control.sqlite"));
    expect(fs.existsSync(path.join(root, "nested"))).toBe(false);
    expect(fs.existsSync(path.join(root, "reference-sources"))).toBe(false);
    if (process.platform !== "win32") expect(modeOf(root)).toBe(before.mode & 0o777);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["POSIX absolute", "/var/tmp/control.sqlite"],
    ["POSIX network", "//host/share/control.sqlite"],
    ["Windows drive", String.raw`C:\data\control.sqlite`],
    ["Windows drive-relative", String.raw`C:control.sqlite`],
    ["Windows rooted", String.raw`\data\control.sqlite`],
    ["UNC", String.raw`\\host\share\control.sqlite`],
    ["device namespace", String.raw`\\?\C:\data\control.sqlite`],
    ["file URI", "file:control.sqlite?mode=rwc"],
    ["uppercase file URI", "FILE:control.sqlite"],
    ["SQLite memory name", ":memory:"],
    ["NUL byte", "state/\0control.sqlite"],
    ["parent traversal", "../control.sqlite"],
    ["nested traversal", "state/../../control.sqlite"],
    ["Windows traversal", String.raw`state\..\control.sqlite`],
    ["Windows wildcard", "state/control?.sqlite"],
    ["Windows angle bracket", "state/control<backup>.sqlite"],
    ["Windows quoted name", 'state/control"backup.sqlite'],
    ["Windows pipe", "state/control|backup.sqlite"],
    ["Windows control character", "state/control\u001f.sqlite"],
    ["current directory", "."],
    ["directory target", "state/"],
    ["reference source overlap", "reference-sources/control.sqlite"],
    ["reserved device", "state/NUL.sqlite"],
    ["reserved superscript COM device", "state/COM¹.sqlite"],
    ["reserved superscript LPT device", "state/LPT³.sqlite"]
  ])("rejects %s input before changing the authorized root", (_label, databasePath) => {
    const root = temporaryRoot();
    const sentinel = path.join(root, "sentinel.txt");
    fs.writeFileSync(sentinel, "unchanged", { mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(root, 0o755);
    const modeBefore = modeOf(root);

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath })).toThrow(ControlPlanePathError);
    expect(fs.readdirSync(root)).toEqual(["sentinel.txt"]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    if (process.platform !== "win32") expect(modeOf(root)).toBe(modeBefore);
  });

  it("does not create a missing authorized root", () => {
    const parent = temporaryRoot();
    const missingRoot = path.join(parent, "not-created");
    const sentinel = path.join(parent, "sentinel.txt");
    fs.writeFileSync(sentinel, "unchanged");

    expect(() => openControlPlaneDatabase({
      authorizedRoot: missingRoot,
      databasePath: "control.sqlite"
    })).toThrow(/already exist/);
    expect(fs.existsSync(missingRoot)).toBe(false);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
  });

  it("rejects a non-directory authorized root without changing it", () => {
    const parent = temporaryRoot();
    const rootFile = path.join(parent, "root-file");
    fs.writeFileSync(rootFile, "unchanged");

    expect(() => openControlPlaneDatabase({
      authorizedRoot: rootFile,
      databasePath: "control.sqlite"
    })).toThrow(/must be a directory/);
    expect(fs.readFileSync(rootFile, "utf8")).toBe("unchanged");
  });

  it("rejects a directory at the database target before creating support directories", () => {
    const root = temporaryRoot();
    const target = path.join(root, "control.sqlite");
    fs.mkdirSync(target);

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow(/regular file/);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, "reference-sources"))).toBe(false);
  });

  it("does not alter an existing non-SQLite file or leave journal files", () => {
    const root = temporaryRoot();
    const target = path.join(root, "control.sqlite");
    fs.writeFileSync(target, "sentinel-not-a-database", { mode: 0o600 });

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("sentinel-not-a-database");
    expect(fs.existsSync(`${target}-wal`)).toBe(false);
    expect(fs.existsSync(`${target}-shm`)).toBe(false);
  });

  it.each(["-journal", "-shm", "-wal"])("rejects an orphan SQLite %s sidecar before creating a database", (suffix) => {
    const root = temporaryRoot();
    const target = path.join(root, "control.sqlite");
    const sidecar = `${target}${suffix}`;
    fs.writeFileSync(sidecar, "orphaned-sidecar", { mode: 0o600 });

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow(
      /orphaned SQLite sidecar/
    );
    expect(fs.readFileSync(sidecar, "utf8")).toBe("orphaned-sidecar");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(root, "reference-sources"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not remove an orphan sidecar symbolic link", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const target = path.join(root, "control.sqlite");
    const sidecar = `${target}-shm`;
    const sentinel = path.join(outside, "sentinel");
    fs.writeFileSync(sentinel, "unchanged");
    fs.symlinkSync(sentinel, sidecar, "file");

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow(
      /orphaned SQLite sidecar/
    );
    expect(fs.lstatSync(sidecar).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("rejects a multiply linked database without changing the shared inode", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const target = path.join(root, "control.sqlite");
    const sentinel = path.join(outside, "sentinel.sqlite");
    fs.writeFileSync(sentinel, "unchanged", { mode: 0o600 });
    fs.linkSync(sentinel, target);

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow(
      /multiple hard links/
    );
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "reference-sources"))).toBe(false);
  });

  it("rejects a multiply linked SQLite sidecar before reopening an existing database", () => {
    const root = temporaryRoot();
    const target = path.join(root, "control.sqlite");
    const first = openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" });
    first.db.close();

    const outside = temporaryRoot();
    const sentinel = path.join(outside, "sentinel");
    fs.writeFileSync(sentinel, "unchanged", { mode: 0o600 });
    fs.linkSync(sentinel, `${target}-wal`);

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow(
      /multiple hard links/
    );
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
  });

  it("rejects a symbolic-link authorized root", () => {
    const parent = temporaryRoot();
    const realRoot = path.join(parent, "real-root");
    const linkedRoot = path.join(parent, "linked-root");
    fs.mkdirSync(realRoot);
    fs.symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    expect(() => openControlPlaneDatabase({
      authorizedRoot: linkedRoot,
      databasePath: "control.sqlite"
    })).toThrow(/cannot be a symbolic link/);
    expect(fs.readdirSync(realRoot)).toEqual([]);
  });

  it("rejects a symbolic-link parent without touching its destination", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "unchanged");
    fs.symlinkSync(outside, path.join(root, "state"), process.platform === "win32" ? "junction" : "dir");

    expect(() => openControlPlaneDatabase({
      authorizedRoot: root,
      databasePath: "state/control.sqlite"
    })).toThrow(/cannot be a symbolic link/);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(outside, "control.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(root, "reference-sources"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link database file without touching its destination", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const sentinel = path.join(outside, "sentinel.sqlite");
    fs.writeFileSync(sentinel, "unchanged");
    fs.symlinkSync(sentinel, path.join(root, "control.sqlite"), "file");

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow(/cannot be a symbolic link/);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "reference-sources"))).toBe(false);
  });

  it("rejects a symbolic-link reference root before creating the database", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "unchanged");
    fs.symlinkSync(outside, path.join(root, "reference-sources"), process.platform === "win32" ? "junction" : "dir");

    expect(() => openControlPlaneDatabase({ authorizedRoot: root, databasePath: "control.sqlite" })).toThrow(/cannot be a symbolic link/);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "control.sqlite"))).toBe(false);
  });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sj-control-plane-"));
  temporaryRoots.push(root);
  return root;
}

function modeOf(targetPath: string): number {
  return fs.statSync(targetPath).mode & 0o777;
}
