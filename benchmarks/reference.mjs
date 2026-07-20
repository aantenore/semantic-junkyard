import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createApp, openMemoryDatabase } from "@semantic-junkyard/api";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(benchmarkRoot, "fixtures", "reference-corpus.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const includeTimings = process.argv.includes("--timings");
const timingMarks = {};
const totalStartedAt = performance.now();

validateFixture(fixture);

const retrievalStartedAt = performance.now();
const retrievalCases = runRetrievalCases(fixture);
timingMarks.retrieval = performance.now() - retrievalStartedAt;

const actionStartedAt = performance.now();
const actionResult = await runActionCases(fixture);
timingMarks.actions = performance.now() - actionStartedAt;
timingMarks.total = performance.now() - totalStartedAt;

const scores = [
  ratioMetric(
    "evidence_recall_at_5",
    retrievalCases.reduce((total, item) => total + item.relevantFound, 0),
    retrievalCases.reduce((total, item) => total + item.relevantTotal, 0),
    "maximize",
    1
  ),
  ratioMetric(
    "exact_target_match",
    actionResult.targeting.filter((item) => item.passed).length,
    actionResult.targeting.length,
    "maximize",
    1
  ),
  ratioMetric(
    "unsupported_intent_abstention",
    actionResult.abstention.filter((item) => item.passed).length,
    actionResult.abstention.length,
    "maximize",
    1
  ),
  ratioMetric(
    "false_verified_rate",
    actionResult.verification.filter((item) => item.falseVerified).length,
    actionResult.verification.length,
    "minimize",
    0
  ),
  ratioMetric(
    "idempotent_replay",
    actionResult.replay.filter((item) => item.passed).length,
    actionResult.replay.length,
    "maximize",
    1
  ),
  ratioMetric(
    "stale_precondition_rejection",
    actionResult.stalePrecondition.filter((item) => item.passed).length,
    actionResult.stalePrecondition.length,
    "maximize",
    1
  )
];
const functionalCases = {
  retrieval: retrievalCases,
  targeting: actionResult.targeting,
  abstention: actionResult.abstention,
  verification: actionResult.verification,
  replay: actionResult.replay,
  stalePrecondition: actionResult.stalePrecondition
};
const caseGatePassed = Object.values(functionalCases).flat().every((testCase) => testCase.passed);

const report = {
  schemaVersion: 1,
  benchmark: "semantic-junkyard-reference",
  claimBoundary:
    "Deterministic regression signal over one fixed synthetic fixture; not a claim of general retrieval quality, production safety, or comparative model performance.",
  functional: {
    passed: scores.every((score) => score.passed) && caseGatePassed,
    caseGatePassed,
    scores,
    cases: functionalCases
  },
  timings: {
    classification: "hardware-dependent",
    included: includeTimings,
    regressionGate: false,
    units: "milliseconds",
    ...(includeTimings
      ? {
          measurements: {
            retrieval: roundTiming(timingMarks.retrieval),
            actions: roundTiming(timingMarks.actions),
            total: roundTiming(timingMarks.total)
          }
        }
      : {})
  }
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.functional.passed) process.exitCode = 1;

function runRetrievalCases(input) {
  const controlDatabase = openMemoryDatabase();
  try {
    const { engine } = createApp(controlDatabase, { seed: false });
    for (const item of input.corpus) {
      engine.ingest({
        name: item.name,
        mimeType: item.mimeType,
        ingestionMode: "full_data",
        text: item.text,
        metadata: { fixtureId: item.id }
      });
    }

    return input.retrievalCases.map((testCase) => {
      const observedTop5 = engine
        .search({ query: testCase.query, topK: 5, mode: "hybrid" })
        .map((result) => result.sourceName);
      const observed = new Set(observedTop5);
      const relevantFound = testCase.expectedSourceNames.filter((name) => observed.has(name)).length;
      return {
        id: testCase.id,
        expectedSourceNames: testCase.expectedSourceNames,
        observedTop5,
        relevantFound,
        relevantTotal: testCase.expectedSourceNames.length,
        passed: relevantFound === testCase.expectedSourceNames.length
      };
    });
  } finally {
    controlDatabase.close();
  }
}

async function runActionCases(input) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-junkyard-benchmark-"));
  const sourcePath = path.join(temporaryRoot, "operations.sqlite");
  createActionFixture(sourcePath);
  const controlDatabase = openMemoryDatabase();

  try {
    const { engine, repository } = createApp(controlDatabase, { seed: false });
    const connection = engine.createSourceConnection({
      name: "Benchmark Operations",
      description: "Fixed synthetic source used only by the deterministic reference benchmark.",
      config: {
        kind: "sqlite",
        databasePath: sourcePath,
        includeTables: ["orders"],
        sampleRows: 1,
        writeMode: "autonomous",
        writeRules: [
          {
            table: "orders",
            aliases: ["order", "orders"],
            keyColumn: "order_id",
            allowedColumns: ["status"],
            risk: "low"
          }
        ]
      }
    });
    await engine.syncSourceConnection(connection.id, {
      objective: "Discover the fixed order-status fixture and its bounded write rule.",
      provider: "deterministic"
    });

    const planned = input.targetCases.map((testCase) => ({
      testCase,
      plan: engine.planBusinessAction({
        intent: testCase.intent,
        mode: "autonomous",
        maxAutonomousRisk: "medium"
      })
    }));
    const targeting = planned.map(({ testCase, plan }) => evaluateTarget(testCase, plan));

    const verifiedPlan = requirePlannedCase(planned, "target-verified-write");
    const verifiedRequest = executionRequest(verifiedPlan.plan, "benchmark-ok-replay");
    const firstRun = engine.executeBusinessAction(verifiedRequest);
    const replayRun = engine.executeBusinessAction(verifiedRequest);
    const verifiedRow = readOrder(sourcePath, "ORD-BENCH-OK");
    const mutationCount = countMutations(sourcePath, "ORD-BENCH-OK");
    const sourceRecordsForTarget = repository
      .listSourceSystemRecords()
      .filter((record) => record.objectKey === firstRun.writes[0]?.objectKey);
    const verifiedOracle =
      verifiedRow?.status === "dispatched" &&
      firstRun.writes.length === 1 &&
      firstRun.reflections.length === 1 &&
      firstRun.reflections.every((reflection) => reflection.status === "verified");

    const replay = [
      {
        id: "replay-same-execution-key",
        sameRunId: replayRun.id === firstRun.id,
        authoritativeMutations: mutationCount,
        persistedSourceRecords: sourceRecordsForTarget.length,
        passed: replayRun.id === firstRun.id && mutationCount === 1 && sourceRecordsForTarget.length === 1
      }
    ];

    const driftPlan = requirePlannedCase(planned, "target-drifted-write");
    const driftRun = engine.executeBusinessAction(executionRequest(driftPlan.plan, "benchmark-drift-case"));
    const driftRow = readOrder(sourcePath, "ORD-BENCH-DRIFT");
    const driftOracle = driftRow?.status === "dispatched";

    const stalePlan = requirePlannedCase(planned, "target-stale-write");
    mutateNoteConcurrently(sourcePath, "ORD-BENCH-STALE");
    let staleError = null;
    let staleRun = null;
    try {
      staleRun = engine.executeBusinessAction(executionRequest(stalePlan.plan, "benchmark-stale-case"));
    } catch (error) {
      staleError = error instanceof Error ? error.message : String(error);
    }
    const staleRow = readOrder(sourcePath, "ORD-BENCH-STALE");
    const staleRejected =
      staleRun === null &&
      typeof staleError === "string" &&
      /plan no longer matches current source state|precondition|stale/i.test(staleError) &&
      staleRow?.status === "ready" &&
      staleRow?.note === "changed-concurrently";
    const stalePrecondition = [
      {
        id: "reject-concurrent-source-change",
        outcome: staleRun ? staleRun.status : "rejected",
        requestedStatusApplied: staleRow?.status === "dispatched",
        concurrentStatePreserved: staleRow?.note === "changed-concurrently",
        passed: staleRejected
      }
    ];

    const sourceBeforeAbstention = sourceState(sourcePath);
    const abstention = input.unsupportedIntentCases.map((testCase, index) => {
      const plan = engine.planBusinessAction({
        intent: testCase.intent,
        mode: "autonomous",
        maxAutonomousRisk: "high"
      });
      const run = engine.executeBusinessAction(executionRequest(plan, `benchmark-abstain-${index + 1}`));
      const sourceUnchanged = sourceState(sourcePath) === sourceBeforeAbstention;
      return {
        id: testCase.id,
        planStatus: plan.status,
        runStatus: run.status,
        targetCount: plan.targets.length,
        writeCount: run.writes.length,
        sourceUnchanged,
        passed: plan.status === "blocked" && run.status === "blocked" && run.writes.length === 0 && sourceUnchanged
      };
    });

    const verification = [
      verificationCase("verified-write", true, firstRun.status, verifiedOracle),
      verificationCase("drifted-readback", false, driftRun.status, driftOracle),
      verificationCase("stale-precondition", false, staleRun?.status ?? "rejected", staleRow?.status === "dispatched"),
      ...abstention.map((item) => verificationCase(item.id, false, item.runStatus, !item.sourceUnchanged))
    ];

    return { targeting, abstention, verification, replay, stalePrecondition };
  } finally {
    controlDatabase.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function createActionFixture(databasePath) {
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        dispatch_eligible INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE mutation_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        requested_status TEXT NOT NULL
      );
      CREATE TRIGGER log_order_status_update
      AFTER UPDATE OF status ON orders
      BEGIN
        INSERT INTO mutation_log (order_id, requested_status) VALUES (NEW.order_id, NEW.status);
      END;
      CREATE TRIGGER force_drifted_readback
      AFTER UPDATE OF status ON orders
      WHEN NEW.order_id = 'ORD-BENCH-DRIFT'
      BEGIN
        UPDATE orders SET status = 'quarantined' WHERE order_id = NEW.order_id;
      END;
    `);
    const insert = db.prepare("INSERT INTO orders (order_id, dispatch_eligible, status, note) VALUES (?, 1, 'ready', '')");
    insert.run("ORD-BENCH-OK");
    insert.run("ORD-BENCH-DRIFT");
    insert.run("ORD-BENCH-STALE");
  } finally {
    db.close();
  }
}

function evaluateTarget(testCase, plan) {
  const target = plan.targets[0] ?? null;
  const observedAfter = target ? JSON.parse(target.diff.after) : null;
  const observed = target
    ? {
        systemName: target.systemName,
        objectType: target.objectType,
        objectKey: target.objectKey,
        technicalOperation: target.technicalOperation,
        after: observedAfter
      }
    : null;
  return {
    id: testCase.id,
    expected: testCase.expected,
    observed,
    targetCount: plan.targets.length,
    passed: plan.status === "planned" && plan.targets.length === 1 && deepEqual(observed, testCase.expected)
  };
}

function verificationCase(id, expectedVerified, reportedStatus, authoritativePostconditionPassed) {
  const reportedVerified = reportedStatus === "verified";
  const falseVerified = reportedVerified && (!expectedVerified || !authoritativePostconditionPassed);
  return {
    id,
    expectedVerified,
    reportedStatus,
    authoritativePostconditionPassed,
    falseVerified,
    passed: !falseVerified && reportedVerified === expectedVerified
  };
}

function executionRequest(plan, idempotencyKey) {
  return {
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    intent: plan.intent,
    mode: plan.mode,
    maxAutonomousRisk: plan.maxAutonomousRisk,
    idempotencyKey
  };
}

function requirePlannedCase(planned, id) {
  const item = planned.find((candidate) => candidate.testCase.id === id);
  assert(item, `Missing target case ${id}.`);
  return item;
}

function readOrder(databasePath, orderId) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT order_id, dispatch_eligible, status, note FROM orders WHERE order_id = ?").get(orderId) ?? null;
  } finally {
    db.close();
  }
}

function countMutations(databasePath, orderId) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM mutation_log WHERE order_id = ?").get(orderId).count);
  } finally {
    db.close();
  }
}

function mutateNoteConcurrently(databasePath, orderId) {
  const db = new Database(databasePath);
  try {
    db.prepare("UPDATE orders SET note = ? WHERE order_id = ?").run("changed-concurrently", orderId);
  } finally {
    db.close();
  }
}

function sourceState(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return JSON.stringify({
      orders: db.prepare("SELECT order_id, dispatch_eligible, status, note FROM orders ORDER BY order_id").all(),
      mutations: db.prepare("SELECT sequence, order_id, requested_status FROM mutation_log ORDER BY sequence").all()
    });
  } finally {
    db.close();
  }
}

function ratioMetric(id, numerator, denominator, direction, requiredValue) {
  assert(denominator > 0, `${id} requires at least one case.`);
  const value = numerator / denominator;
  return {
    id,
    value: Number(value.toFixed(6)),
    numerator,
    denominator,
    direction,
    requiredValue,
    passed: value === requiredValue
  };
}

function deepEqual(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function roundTiming(value) {
  return Number(value.toFixed(3));
}

function validateFixture(input) {
  assert.equal(input.schemaVersion, 1, "Unsupported fixture schema version.");
  for (const field of ["corpus", "retrievalCases", "targetCases", "unsupportedIntentCases"]) {
    assert(Array.isArray(input[field]) && input[field].length > 0, `Fixture field ${field} must be a non-empty array.`);
  }
  const ids = [
    ...input.corpus.map((item) => item.id),
    ...input.retrievalCases.map((item) => item.id),
    ...input.targetCases.map((item) => item.id),
    ...input.unsupportedIntentCases.map((item) => item.id)
  ];
  assert.equal(new Set(ids).size, ids.length, "Fixture identifiers must be unique.");
}
