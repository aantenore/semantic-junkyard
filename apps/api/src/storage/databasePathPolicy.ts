import fs from "node:fs";
import path from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REFERENCE_SOURCES_DIRECTORY = "reference-sources";
export const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

export interface ControlPlaneStorageOptions {
  authorizedRoot: string;
  databasePath: string;
}

export interface ControlPlaneStoragePaths {
  authorizedRoot: string;
  databasePath: string;
  referenceSourcesRoot: string;
}

export interface PreparedControlPlaneStorage extends ControlPlaneStoragePaths {
  databaseWasCreated: boolean;
}

export class ControlPlanePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlanePathError";
  }
}

/**
 * Resolves the storage boundary without changing the file system.
 * The returned paths are canonical, absolute, and confined to the real root.
 */
export function resolveControlPlaneStoragePaths(options: ControlPlaneStorageOptions): ControlPlaneStoragePaths {
  const relativeDatabasePath = validateRelativeDatabasePath(options.databasePath);
  const authorizedRoot = resolveAuthorizedRoot(options.authorizedRoot);
  const databasePath = assertContained(
    authorizedRoot,
    path.resolve(authorizedRoot, relativeDatabasePath),
    "database path",
    false
  );
  const referenceSourcesRoot = assertContained(
    authorizedRoot,
    path.resolve(authorizedRoot, REFERENCE_SOURCES_DIRECTORY),
    "reference sources root",
    false
  );

  const databaseRelativeToReferences = path.relative(referenceSourcesRoot, databasePath);
  const databaseInsideReferences = databaseRelativeToReferences.length === 0
    || (!databaseRelativeToReferences.startsWith(".." + path.sep)
      && databaseRelativeToReferences !== ".."
      && !path.isAbsolute(databaseRelativeToReferences));
  if (databaseInsideReferences) {
    throw new ControlPlanePathError("Database path cannot overlap the reference sources directory.");
  }

  return Object.freeze({ authorizedRoot, databasePath, referenceSourcesRoot });
}

/**
 * Validates the complete layout before creating anything, then prepares a
 * private directory tree and a regular database file inside the boundary.
 */
export function prepareControlPlaneStorage(options: ControlPlaneStorageOptions): PreparedControlPlaneStorage {
  const paths = resolveControlPlaneStoragePaths(options);
  preflightLayout(paths);

  ensurePrivateDirectory(paths.authorizedRoot, paths.authorizedRoot);
  const databaseParent = ensurePrivateDirectory(paths.authorizedRoot, path.dirname(paths.databasePath));
  const referenceSourcesRoot = ensurePrivateDirectory(paths.authorizedRoot, paths.referenceSourcesRoot);

  const databaseFile = ensurePrivateRegularFile(
    paths.authorizedRoot,
    path.join(databaseParent, path.basename(paths.databasePath))
  );
  return {
    authorizedRoot: paths.authorizedRoot,
    databasePath: databaseFile.databasePath,
    referenceSourcesRoot,
    databaseWasCreated: databaseFile.created
  };
}

function validateRelativeDatabasePath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlPlanePathError("Database path must be a non-empty relative path.");
  }
  if (value.includes("\0")) {
    throw new ControlPlanePathError("Database path cannot contain a NUL byte.");
  }
  if (/^file:/i.test(value)) {
    throw new ControlPlanePathError("SQLite file URIs are not accepted as database paths.");
  }
  if (value.toLowerCase() === ":memory:") {
    throw new ControlPlanePathError("The in-memory SQLite name is not a file path.");
  }
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new ControlPlanePathError("Database path must not be absolute or drive-qualified.");
  }
  if (value.includes(":")) {
    throw new ControlPlanePathError("Database path cannot contain a colon.");
  }

  const portablePath = value.replaceAll("\\", "/");
  if (portablePath.endsWith("/")) {
    throw new ControlPlanePathError("Database path must identify a file, not a directory.");
  }

  const segments = portablePath.split("/");
  if (segments.includes("..")) {
    throw new ControlPlanePathError("Database path traversal is not allowed.");
  }

  const normalizedSegments = segments.filter((segment) => segment.length > 0 && segment !== ".");
  if (normalizedSegments.length === 0) {
    throw new ControlPlanePathError("Database path must identify a file inside the authorized root.");
  }
  for (const segment of normalizedSegments) validatePortableSegment(segment);

  return path.join(...normalizedSegments);
}

function validatePortableSegment(segment: string): void {
  if (/[\u0000-\u001f<>:"|?*]/.test(segment)) {
    throw new ControlPlanePathError("Database path contains a character that is not portable to Windows.");
  }
  if (/[. ]$/.test(segment)) {
    throw new ControlPlanePathError("Database path segments cannot end with a dot or space.");
  }

  const stem = segment.split(".", 1)[0]?.toUpperCase();
  if (stem && /^(CON|PRN|AUX|NUL|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))$/.test(stem)) {
    throw new ControlPlanePathError("Database path contains a reserved device name.");
  }
}

function resolveAuthorizedRoot(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlPlanePathError("Authorized root must be a non-empty absolute path.");
  }
  if (value.includes("\0") || !path.isAbsolute(value)) {
    throw new ControlPlanePathError("Authorized root must be a valid absolute path.");
  }

  const lexicalRoot = path.resolve(value);
  const status = lstatOrUndefined(lexicalRoot);
  if (!status) throw new ControlPlanePathError("Authorized root must already exist.");
  if (status.isSymbolicLink()) throw new ControlPlanePathError("Authorized root cannot be a symbolic link.");
  if (!status.isDirectory()) throw new ControlPlanePathError("Authorized root must be a directory.");

  return fs.realpathSync(lexicalRoot);
}

function preflightLayout(paths: ControlPlaneStoragePaths): void {
  validateExistingDirectory(paths.authorizedRoot, paths.authorizedRoot, "authorized root");
  validateDirectoryChain(paths.authorizedRoot, path.dirname(paths.databasePath));

  const referenceStatus = lstatOrUndefined(paths.referenceSourcesRoot);
  if (referenceStatus) {
    validateExistingDirectory(paths.authorizedRoot, paths.referenceSourcesRoot, "reference sources root");
  }

  const databaseStatus = lstatOrUndefined(paths.databasePath);
  if (databaseStatus) {
    validateExistingRegularFile(paths.authorizedRoot, paths.databasePath, "Database file");
    validateExistingSidecars(paths.authorizedRoot, paths.databasePath);
    return;
  }

  for (const sidecarPath of sqliteSidecarPaths(paths.databasePath)) {
    if (lstatOrUndefined(sidecarPath)) {
      throw new ControlPlanePathError(
        "An orphaned SQLite sidecar exists for a missing database; remove or recover it before startup."
      );
    }
  }
}

function validateExistingSidecars(root: string, databasePath: string): void {
  for (const sidecarPath of sqliteSidecarPaths(databasePath)) {
    if (lstatOrUndefined(sidecarPath)) {
      validateExistingRegularFile(root, sidecarPath, "SQLite sidecar");
    }
  }
}

export function sqliteSidecarPaths(databasePath: string): string[] {
  return SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`);
}

function validateDirectoryChain(root: string, directoryPath: string): void {
  const containedDirectoryPath = assertContained(root, directoryPath, "database parent", true);
  if (containedDirectoryPath === root) return;

  let current = root;
  for (const segment of path.relative(root, containedDirectoryPath).split(path.sep)) {
    current = assertContained(root, path.join(current, segment), "database parent", true);
    const status = lstatOrUndefined(current);
    if (!status) return;
    validateExistingDirectory(root, current, "database parent");
  }
}

function validateExistingDirectory(root: string, directoryPath: string, label: string): void {
  const containedDirectoryPath = assertContained(root, directoryPath, label, true);
  const status = fs.lstatSync(containedDirectoryPath);
  if (status.isSymbolicLink()) throw new ControlPlanePathError(`${label} cannot be a symbolic link.`);
  if (!status.isDirectory()) throw new ControlPlanePathError(`${label} must be a directory.`);

  const realDirectory = fs.realpathSync(containedDirectoryPath);
  assertContained(root, realDirectory, label, true);
}

function validateExistingRegularFile(root: string, filePath: string, label = "Database file"): string {
  const containedFilePath = assertContained(root, filePath, label.toLowerCase(), false);
  const status = fs.lstatSync(containedFilePath);
  if (status.isSymbolicLink()) throw new ControlPlanePathError(`${label} cannot be a symbolic link.`);
  if (!status.isFile()) throw new ControlPlanePathError(`${label} must be a regular file.`);
  if (status.nlink !== 1) throw new ControlPlanePathError(`${label} cannot have multiple hard links.`);

  const realFile = fs.realpathSync(containedFilePath);
  return assertContained(root, realFile, label.toLowerCase(), false);
}

function ensurePrivateDirectory(root: string, directoryPath: string): string {
  const containedDirectoryPath = assertContained(root, directoryPath, "directory", true);
  const relativePath = path.relative(root, containedDirectoryPath);
  const segments = relativePath.length === 0 ? [] : relativePath.split(path.sep);
  let current = root;

  setModeWhereSupported(current, DIRECTORY_MODE);
  for (const segment of segments) {
    current = assertContained(root, path.join(current, segment), "storage directory", true);
    const status = lstatOrUndefined(current);
    if (!status) {
      try {
        fs.mkdirSync(current, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
    }
    validateExistingDirectory(root, current, "storage directory");
    setModeWhereSupported(current, DIRECTORY_MODE);
  }
  return assertContained(root, fs.realpathSync(containedDirectoryPath), "storage directory", true);
}

function ensurePrivateRegularFile(root: string, filePath: string): { databasePath: string; created: boolean } {
  const containedFilePath = assertContained(root, filePath, "database file", false);
  const existing = lstatOrUndefined(containedFilePath);
  if (existing) {
    const databasePath = validateExistingRegularFile(root, containedFilePath);
    setModeWhereSupported(databasePath, FILE_MODE);
    return { databasePath, created: false };
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(containedFilePath, "wx+", FILE_MODE);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  const databasePath = validateExistingRegularFile(root, containedFilePath);
  setModeWhereSupported(databasePath, FILE_MODE);
  return { databasePath, created: true };
}

function assertContained(root: string, candidate: string, label: string, allowRoot: boolean): string {
  const relativePath = path.relative(root, candidate);
  if (
    relativePath === ".."
    || relativePath.startsWith(".." + path.sep)
    || path.isAbsolute(relativePath)
    || (!allowRoot && relativePath.length === 0)
  ) {
    throw new ControlPlanePathError(`${label} must remain inside the authorized root.`);
  }
  return candidate;
}

function setModeWhereSupported(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    if (process.platform === "win32" && isNodeError(error) && error.code !== undefined && ["ENOSYS", "ENOTSUP", "EPERM"].includes(error.code)) {
      return;
    }
    throw error;
  }
}

function lstatOrUndefined(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
