import crypto from "node:crypto";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

