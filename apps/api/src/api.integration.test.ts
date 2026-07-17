import Database from "better-sqlite3";
import request, { type Test } from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { RuntimeConfig } from "./config/runtime.js";
import { DEFAULT_HTML_TEXT_LIMITS } from "./core/text.js";
import { openMemoryDatabase } from "./storage/database.js";

const baseConfig: RuntimeConfig = {
  host: "127.0.0.1",
  port: 8787,
  databasePath: ":memory:",
  corsOrigins: ["http://localhost:5173", "http://localhost:5174"],
  requestBodyLimit: "5mb",
  htmlTextLimits: { ...DEFAULT_HTML_TEXT_LIMITS },
  maxAutonomousRisk: "medium",
  enableLocalPoc: true,
  bootstrapReferenceSources: false
};

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) fs.rmSync(temporaryPath, { recursive: true, force: true });
});

describe("Semantic Junkyard HTTP boundary", () => {
  it("returns JSON errors, request IDs, security headers, and no framework fingerprint", async () => {
    const { app } = testApp();
    const response = await request(app).get("/api/not-found");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "ROUTE_NOT_FOUND" });
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects untrusted browser origins and supports optional bearer authentication", async () => {
    const { app } = testApp();
    const deniedOrigin = await request(app).get("/api/status").set("Origin", "https://attacker.example");
    expect(deniedOrigin.status).toBe(403);
    expect(deniedOrigin.body.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(deniedOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    const token = "a".repeat(32);
    const approvalToken = "b".repeat(32);
    const operatorToken = "c".repeat(32);
    const authenticated = (await testAppWithWritableSource({ apiToken: token, operatorToken, approvalToken }, "approval_required")).app;
    expect((await request(authenticated).get("/api/status")).status).toBe(401);
    expect((await request(authenticated).get("/api/status").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    const action = {
      intent: "Set order ORD-API status to dispatched",
      mode: "approval_required",
      maxAutonomousRisk: "low"
    };
    const plan = await request(authenticated).post("/api/business/actions/plan").set("Authorization", `Bearer ${token}`).send(action);
    const approvalBody = {
      ...action,
      planId: plan.body.id,
      planFingerprint: plan.body.fingerprint,
      rationale: "Reviewed target systems and source diffs."
    };
    const crossPrincipalExecution = await request(authenticated)
      .post("/api/business/actions/execute")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        planId: plan.body.id,
        planFingerprint: plan.body.fingerprint,
        intent: plan.body.intent,
        mode: plan.body.mode,
        maxAutonomousRisk: plan.body.maxAutonomousRisk,
        idempotencyKey: `${plan.body.id}-cross-principal`
      });
    expect(crossPrincipalExecution.status).toBe(403);
    expect(crossPrincipalExecution.body.code).toBe("PLAN_PRINCIPAL_MISMATCH");
    const agentApproval = await request(authenticated)
      .post("/api/business/actions/approve")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Semantic-Junkyard-Actor", "spoofed-human")
      .send(approvalBody);
    expect(agentApproval.status).toBe(403);
    expect(agentApproval.body.code).toBe("APPROVAL_ROLE_REQUIRED");

    const humanApproval = await request(authenticated)
      .post("/api/business/actions/approve")
      .set("Authorization", `Bearer ${approvalToken}`)
      .send(approvalBody);
    expect(humanApproval.status).toBe(201);
    expect(humanApproval.body.approvedBy).toBe("authenticated-approver");
    expect((await request(authenticated).get("/api/business/actions/approvals").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await request(authenticated).get("/api/business/actions/approvals").set("Authorization", `Bearer ${approvalToken}`)).status).toBe(200);
  });

  it("separates agent reads and governed actions from operator configuration mutations", async () => {
    const apiToken = "c".repeat(32);
    const operatorToken = "d".repeat(32);
    const approvalToken = "e".repeat(32);
    const { app } = await testAppWithWritableSource({ apiToken, operatorToken, approvalToken }, "approval_required");
    const agent = (operation: Test) => operation.set("Authorization", `Bearer ${apiToken}`);
    const operator = (operation: Test) => operation.set("Authorization", `Bearer ${operatorToken}`);
    const approver = (operation: Test) => operation.set("Authorization", `Bearer ${approvalToken}`);

    expect((await agent(request(app).post("/api/ingest").send({ name: "blocked.txt", text: "blocked" }))).status).toBe(403);
    expect((await agent(request(app).post("/api/catalog/import").send({}))).status).toBe(403);
    expect(
      (
        await agent(
          request(app)
            .post("/api/source-connections")
            .send({ name: "blocked", description: "", config: { kind: "filesystem", rootPath: "/tmp" } })
        )
      ).status
    ).toBe(403);
    expect((await agent(request(app).get("/api/source-resources"))).status).toBe(200);
    expect((await agent(request(app).post("/api/discovery/missions").send({ objective: "Unauthorized source sync" }))).status).toBe(403);
    expect((await operator(request(app).post("/api/ingest").send({ name: "allowed.txt", text: "Operator-owned ingestion" }))).status).toBe(201);
    expect((await approver(request(app).post("/api/ingest").send({ name: "blocked-for-approver.txt", text: "blocked" }))).status).toBe(403);

    const plan = await agent(request(app).post("/api/business/actions/plan").send({
      intent: "Set order ORD-API status to dispatched",
      mode: "approval_required",
      maxAutonomousRisk: "low"
    }));
    const approvalRequest = {
      planId: plan.body.id,
      planFingerprint: plan.body.fingerprint,
      intent: plan.body.intent,
      mode: plan.body.mode,
      maxAutonomousRisk: plan.body.maxAutonomousRisk,
      rationale: "Reviewed by the independent approver."
    };
    expect((await operator(request(app).post("/api/business/actions/approve").send(approvalRequest))).status).toBe(403);
    const approval = await approver(request(app).post("/api/business/actions/approve").send(approvalRequest));
    expect(approval.status).toBe(201);
    const agentAudit = await agent(request(app).get("/api/audit/events"));
    expect(JSON.stringify(agentAudit.body)).not.toContain(approval.body.id);
    expect(JSON.stringify(agentAudit.body)).toContain("approval:[redacted]");
    const approverAudit = await approver(request(app).get("/api/audit/events"));
    expect(JSON.stringify(approverAudit.body)).toContain(approval.body.id);
  });

  it("validates tool inputs instead of coercing them into bulk disclosure", async () => {
    const { app } = testApp();
    const emptyLookup = await request(app).post("/api/tools/entity_lookup").send({});
    expect(emptyLookup.status).toBe(400);
    expect(emptyLookup.body.code).toBe("INVALID_REQUEST");

    const invalidDepth = await request(app)
      .post("/api/tools/find_paths")
      .send({ fromEntityId: "a", toEntityId: "b", maxDepth: "not-a-number" });
    expect(invalidDepth.status).toBe(400);
  });

  it("orchestrates and persists an auditable multi-source discovery mission", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-mission-"));
    fs.writeFileSync(path.join(root, "operations.md"), "Late Dispatch Rate depends on dispatch eligible orders. Operations owns the metric.");
    try {
      const { app } = testApp();
      const connection = await request(app).post("/api/source-connections").send({
        name: "Mission knowledge",
        description: "Temporary integration source",
        config: { kind: "filesystem", rootPath: root }
      });
      expect(connection.status).toBe(201);

      const mission = await request(app).post("/api/discovery/missions").send({
        objective: "Discover the Late Dispatch Rate definition and its owner.",
        provider: "deterministic",
        connectionIds: [connection.body.id],
        continueOnError: true
      });
      expect(mission.status).toBe(201);
      expect(mission.body).toMatchObject({
        status: "completed",
        provider: "deterministic",
        requestedConnectionIds: [connection.body.id],
        summary: { connectionsAttempted: 1, completedSyncs: 1, failedSyncs: 0 }
      });
      expect(mission.body.summary.resourcesDiscovered).toBeGreaterThan(0);
      expect(mission.body.discoveryRun.events.some((event: { tool: string }) => event.tool === "source_registry.inspect")).toBe(true);

      const history = await request(app).get("/api/discovery/missions");
      expect(history.status).toBe(200);
      expect(history.body[0].id).toBe(mission.body.id);
      const audit = await request(app).get("/api/audit/events");
      expect(audit.body.some((event: { action: string; target: string }) => event.action === "source_discovery.mission" && event.target === mission.body.id)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds execution to an exact reviewed plan and ignores caller-supplied approval flags", async () => {
    const { app } = await testAppWithWritableSource();
    const planResponse = await request(app).post("/api/business/actions/plan").send({
      intent: "Set order ORD-API status to dispatched",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    expect(planResponse.status).toBe(200);

    const legacyBypass = await request(app).post("/api/business/actions/execute").send({
      intent: planResponse.body.intent,
      mode: "approval_required",
      approved: true,
      maxAutonomousRisk: "low"
    });
    expect(legacyBypass.status).toBe(400);

    const mismatch = await request(app).post("/api/business/actions/execute").send({
      planId: planResponse.body.id,
      planFingerprint: "0".repeat(64),
      intent: planResponse.body.intent,
      mode: planResponse.body.mode,
      maxAutonomousRisk: planResponse.body.maxAutonomousRisk,
      idempotencyKey: `${planResponse.body.id}-mismatch`
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("PLAN_CHANGED");

    const executed = await request(app).post("/api/business/actions/execute").send({
      planId: planResponse.body.id,
      planFingerprint: planResponse.body.fingerprint,
      intent: planResponse.body.intent,
      mode: planResponse.body.mode,
      maxAutonomousRisk: planResponse.body.maxAutonomousRisk,
      idempotencyKey: `${planResponse.body.id}-execute`
    });
    expect(executed.status).toBe(201);
    expect(executed.body.status).toBe("verified");

    const otherPlan = await request(app).post("/api/business/actions/plan").send({
      intent: "Set order ORD-API status to ready",
      mode: "autonomous",
      maxAutonomousRisk: "medium"
    });
    const conflict = await request(app).post("/api/business/actions/execute").send({
      planId: otherPlan.body.id,
      planFingerprint: otherPlan.body.fingerprint,
      intent: otherPlan.body.intent,
      mode: otherPlan.body.mode,
      maxAutonomousRisk: otherPlan.body.maxAutonomousRisk,
      idempotencyKey: `${planResponse.body.id}-execute`
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("blocks destructive intent and invalid catalog imports without side effects", async () => {
    const { app, repository } = testApp();
    const before = repository.catalog();
    const blocked = await request(app).post("/api/business/actions/plan").send({
      intent: "Delete all production customer records and rotate API secrets",
      mode: "autonomous",
      maxAutonomousRisk: "high"
    });
    expect(blocked.body.status).toBe("blocked");
    expect(blocked.body.targets).toHaveLength(0);

    const invalidCatalog = await request(app).post("/api/catalog/import").send({ assets: [], metrics: [] });
    expect(invalidCatalog.status).toBe(400);
    expect(repository.catalog()).toEqual(before);
  });

  it("applies masking consistently to search, evidence, and source routes", async () => {
    const { app } = testApp();
    const search = await request(app).post("/api/tools/semantic_search").send({ query: "customer_id email Billing Pipeline", topK: 5, mode: "hybrid" });
    const result = search.body.results.find((item: { text: string }) => item.text.includes("[masked]"));
    expect(result).toBeTruthy();

    const evidence = await request(app).get(`/api/evidence/${result.chunkId}`);
    expect(evidence.body.text).toContain("[masked]");
    expect(evidence.body.text).not.toContain("customer_id");

    const sources = await request(app).get("/api/sources");
    const billing = sources.body.find((item: { name: string }) => item.name === "billing-context.html");
    expect(billing.text).toContain("[masked]");
    expect(billing.text).not.toContain("customer_id");

    const operationalSurfaces = await Promise.all([
      request(app).get("/api/source-systems"),
      request(app).get("/api/business/actions/runs"),
      request(app).get("/api/audit/events")
    ]);
    for (const surface of operationalSurfaces) {
      expect(JSON.stringify(surface.body)).not.toContain("customer_id");
    }
  });

  it("preserves body-size status and exposes the expensive PoC only as POST", async () => {
    const { app } = testApp({ requestBodyLimit: "1kb" });
    const tooLarge = await request(app).post("/api/ingest").send({ name: "large.txt", text: "x".repeat(2_000) });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.code).toBe("REQUEST_TOO_LARGE");
    expect((await request(app).get("/api/poc/local-agent?provider=deterministic")).status).toBe(404);
  });

  it("returns a controlled error for deeply nested HTML and remains healthy", async () => {
    const { app } = testApp();
    const deeplyNested = `${"<div>".repeat(5_000)}visible${"</div>".repeat(5_000)}`;
    expect(deeplyNested.length).toBeLessThan(DEFAULT_HTML_TEXT_LIMITS.maxInputLength);

    const rejected = await request(app).post("/api/ingest").send({
      name: "deeply-nested.html",
      mimeType: "text/html",
      text: deeplyNested
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ code: "HTML_STRUCTURE_LIMIT_EXCEEDED" });

    expect((await request(app).get("/api/health")).status).toBe(200);
    expect((await request(app).post("/api/ingest").send({
      name: "bounded.html",
      mimeType: "text/html",
      text: "<p>Bounded semantic content</p>"
    })).status).toBe(201);
  });
});

function testApp(overrides: Partial<RuntimeConfig> = {}) {
  return createApp(openMemoryDatabase(), { seed: true, runtimeConfig: { ...baseConfig, ...overrides } });
}

async function testAppWithWritableSource(
  overrides: Partial<RuntimeConfig> = {},
  writeMode: "autonomous" | "approval_required" = "autonomous"
) {
  const runtime = testApp(overrides);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-api-source-"));
  temporaryPaths.push(root);
  const databasePath = path.join(root, "operations.sqlite");
  const source = new Database(databasePath);
  source.exec("CREATE TABLE orders (order_id TEXT PRIMARY KEY, dispatch_eligible INTEGER NOT NULL, status TEXT NOT NULL)");
  source.prepare("INSERT INTO orders VALUES (?, ?, ?)").run("ORD-API", 1, "ready");
  source.close();
  const connection = runtime.engine.createSourceConnection({
    name: "API Operations",
    description: "Authoritative API integration fixture",
    config: {
      kind: "sqlite",
      databasePath,
      includeTables: ["orders"],
      sampleRows: 1,
      writeMode,
      writeRules: [{ table: "orders", aliases: ["order"], keyColumn: "order_id", allowedColumns: ["status"], risk: "low" }]
    }
  });
  await runtime.engine.syncSourceConnection(connection.id, {
    objective: "Discover order dispatch eligibility and governed status actions.",
    provider: "deterministic"
  });
  return runtime;
}
