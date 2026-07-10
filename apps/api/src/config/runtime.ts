import { z } from "zod";

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174"
].join(",");

const EnvironmentSchema = z.object({
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  SEMANTIC_JUNKYARD_DB: z.string().trim().min(1).default("data/semantic-junkyard.sqlite"),
  SEMANTIC_JUNKYARD_SOURCE_SYSTEMS_FILE: z.string().trim().min(1).optional().or(z.literal("")),
  SEMANTIC_JUNKYARD_CORS_ORIGINS: z.string().default(DEFAULT_CORS_ORIGINS),
  SEMANTIC_JUNKYARD_REQUEST_BODY_LIMIT: z.string().regex(/^\d+(?:kb|mb)$/i).default("5mb"),
  SEMANTIC_JUNKYARD_MAX_AUTONOMOUS_RISK: z.enum(["low", "medium", "high"]).default("medium"),
  SEMANTIC_JUNKYARD_ENABLE_LOCAL_POC: z.enum(["true", "false"]).default("true"),
  SEMANTIC_JUNKYARD_API_TOKEN: z.string().min(32).optional().or(z.literal("")),
  SEMANTIC_JUNKYARD_APPROVAL_TOKEN: z.string().min(32).optional().or(z.literal(""))
});

export interface RuntimeConfig {
  host: string;
  port: number;
  databasePath: string;
  sourceSystemsFile?: string;
  corsOrigins: string[];
  requestBodyLimit: string;
  maxAutonomousRisk: "low" | "medium" | "high";
  enableLocalPoc: boolean;
  apiToken?: string;
  approvalToken?: string;
}

export interface RuntimeConfigLoadOptions {
  validateHttpSecurity?: boolean;
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env, options: RuntimeConfigLoadOptions = {}): RuntimeConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const corsOrigins = parsed.SEMANTIC_JUNKYARD_CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins.length === 0) {
    throw new Error("SEMANTIC_JUNKYARD_CORS_ORIGINS must contain at least one origin.");
  }
  for (const origin of corsOrigins) {
    if (origin !== "*") z.string().url().parse(origin);
  }
  const apiToken = parsed.SEMANTIC_JUNKYARD_API_TOKEN || undefined;
  const approvalToken = parsed.SEMANTIC_JUNKYARD_APPROVAL_TOKEN || undefined;
  if (options.validateHttpSecurity ?? true) {
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.HOST) && !apiToken) {
      throw new Error("SEMANTIC_JUNKYARD_API_TOKEN is required when HOST is not loopback.");
    }
    if (apiToken && !approvalToken) {
      throw new Error("SEMANTIC_JUNKYARD_APPROVAL_TOKEN is required when SEMANTIC_JUNKYARD_API_TOKEN is configured.");
    }
    if (approvalToken && !apiToken) {
      throw new Error("SEMANTIC_JUNKYARD_API_TOKEN is required when SEMANTIC_JUNKYARD_APPROVAL_TOKEN is configured.");
    }
    if (apiToken && approvalToken && apiToken === approvalToken) {
      throw new Error("SEMANTIC_JUNKYARD_API_TOKEN and SEMANTIC_JUNKYARD_APPROVAL_TOKEN must be different.");
    }
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.SEMANTIC_JUNKYARD_DB,
    sourceSystemsFile: parsed.SEMANTIC_JUNKYARD_SOURCE_SYSTEMS_FILE || undefined,
    corsOrigins,
    requestBodyLimit: parsed.SEMANTIC_JUNKYARD_REQUEST_BODY_LIMIT,
    maxAutonomousRisk: parsed.SEMANTIC_JUNKYARD_MAX_AUTONOMOUS_RISK,
    enableLocalPoc: parsed.SEMANTIC_JUNKYARD_ENABLE_LOCAL_POC === "true",
    apiToken,
    approvalToken
  };
}
