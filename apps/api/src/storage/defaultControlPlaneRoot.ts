import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * Returns the product-owned data directory. The same path is derived from the
 * TypeScript source tree and the compiled distribution tree.
 */
export function defaultControlPlaneRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../data");
}

/**
 * Creates only the deterministic product root. Custom embedding roots remain
 * an explicit host responsibility and must already exist before policy checks.
 */
export function ensureDefaultControlPlaneRoot(moduleUrl: string = import.meta.url): string {
  const root = defaultControlPlaneRoot(moduleUrl);
  try {
    fs.mkdirSync(root, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  return root;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
