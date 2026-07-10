import crypto from "node:crypto";
import type { CorsOptions } from "cors";
import type express from "express";
import { ZodError } from "zod";
import { DomainError } from "../core/errors.js";
import type { ActorContext } from "../storage/policy.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function requestIdMiddleware(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const candidate = request.header("x-request-id");
  const requestId = candidate && /^[A-Za-z0-9._-]{1,100}$/.test(candidate) ? candidate : crypto.randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
}

export function requestActor(request: express.Request): string {
  const authenticatedActor = request.res?.locals.authenticatedActor;
  if (typeof authenticatedActor === "string") return authenticatedActor;
  const candidate = request.header("x-semantic-junkyard-actor")?.trim();
  return candidate && /^[A-Za-z0-9@._ -]{1,255}$/.test(candidate) ? candidate : "local-user";
}

export function requestActorContext(request: express.Request): ActorContext {
  const role = request.res?.locals.authRole;
  if (role === "local-owner") {
    return { actor: requestActor(request), roles: ["semantic-reader", "semantic-operator", "approver"], clearance: "confidential" };
  }
  if (role === "operator") return { actor: requestActor(request), roles: ["semantic-reader", "semantic-operator"], clearance: "confidential" };
  if (role === "approver") return { actor: requestActor(request), roles: ["semantic-reader", "approver"], clearance: "confidential" };
  return { actor: requestActor(request), roles: ["semantic-reader", "business-action-planner"], clearance: "internal" };
}

export function apiTokenMiddleware(apiToken?: string, operatorToken?: string, approvalToken?: string) {
  return (request: express.Request, response: express.Response, next: express.NextFunction): void => {
    if (!apiToken) {
      response.locals.authRole = "local-owner";
      response.locals.authenticatedActor = "local-user";
      next();
      return;
    }
    if (request.method === "OPTIONS" || request.path === "/api/health" || request.path === "/api/ready") {
      next();
      return;
    }
    const authorization = request.header("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (secureTokenEquals(supplied, approvalToken)) {
      response.locals.authRole = "approver";
      response.locals.authenticatedActor = "authenticated-approver";
      next();
      return;
    }
    if (secureTokenEquals(supplied, operatorToken)) {
      response.locals.authRole = "operator";
      response.locals.authenticatedActor = "authenticated-operator";
      next();
      return;
    }
    if (secureTokenEquals(supplied, apiToken)) {
      response.locals.authRole = "agent";
      response.locals.authenticatedActor = "authenticated-agent";
      next();
      return;
    }
    next(new HttpError(401, "AUTHENTICATION_REQUIRED", "A valid API bearer token is required."));
  };
}

export function requireApprovalRole(_request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (response.locals.authRole === "approver" || response.locals.authRole === "local-owner") {
    next();
    return;
  }
  next(new HttpError(403, "APPROVAL_ROLE_REQUIRED", "A distinct authenticated approver credential is required."));
}

export function requireOperatorRole(_request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (response.locals.authRole === "operator" || response.locals.authRole === "local-owner") {
    next();
    return;
  }
  next(new HttpError(403, "OPERATOR_ROLE_REQUIRED", "An authenticated operator credential is required for source, ingestion, catalog, or semantic-governance changes."));
}

function secureTokenEquals(supplied: string, expected?: string): boolean {
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function createCorsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new HttpError(403, "ORIGIN_NOT_ALLOWED", `Origin ${origin} is not allowed.`));
    },
    methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id", "X-Semantic-Junkyard-Actor"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 600
  };
}

export function notFoundHandler(request: express.Request, _response: express.Response, next: express.NextFunction): void {
  next(new HttpError(404, "ROUTE_NOT_FOUND", `Route ${request.method} ${request.path} was not found.`));
}

export function errorHandler(error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction): void {
  const requestId = String(response.locals.requestId ?? "unknown");

  if (error instanceof ZodError) {
    response.status(400).json({
      error: "Request validation failed.",
      code: "INVALID_REQUEST",
      requestId,
      details: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message }))
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message, code: error.code, requestId, details: error.details });
    return;
  }

  if (error instanceof DomainError) {
    response.status(error.status).json({ error: error.message, code: error.code, requestId, details: error.details });
    return;
  }

  const bodyError = error as { status?: number; type?: string } | null;
  if (bodyError?.type === "entity.too.large") {
    response.status(413).json({ error: "Request body is too large.", code: "REQUEST_TOO_LARGE", requestId });
    return;
  }
  if (bodyError?.status === 400 && error instanceof SyntaxError) {
    response.status(400).json({ error: "Request body contains invalid JSON.", code: "INVALID_JSON", requestId });
    return;
  }

  console.error(`[${requestId}] Unhandled API error`, error);
  response.status(500).json({ error: "Unexpected server error.", code: "INTERNAL_ERROR", requestId });
}
