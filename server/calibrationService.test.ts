import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { outcomeLog } from "@shared/schema";
import { getCalibrationMultiplier, getCalibrationReport, OutcomeNotFoundError, recordOutcome } from "./calibrationService";

function logFakePrediction(kind: string, goalProbability: number, verifiedCount: number, totalCount: number): string {
  const id = randomUUID();
  db.insert(outcomeLog)
    .values({
      id,
      goalId: null,
      kind,
      predictedAt: new Date().toISOString(),
      predictionJson: JSON.stringify({ goalProbability, confidence: { verifiedCount, totalCount, unverifiedFields: [] } }),
      actualJson: null,
      observedAt: null,
    })
    .run();
  return id;
}

test("recordOutcome throws on an id that was never logged", () => {
  assert.throws(() => recordOutcome("does-not-exist", { achieved: true }), OutcomeNotFoundError);
});

test("recordOutcome persists actualJson and observedAt on the right row", () => {
  const id = logFakePrediction("prediction:run", 80, 2, 2);
  recordOutcome(id, { achieved: true, note: "beat it by 3 minutes" });
  const row = db.select().from(outcomeLog).all().find((r) => r.id === id)!;
  assert.ok(row.actualJson);
  assert.ok(row.observedAt);
  assert.deepEqual(JSON.parse(row.actualJson!), { achieved: true, note: "beat it by 3 minutes" });
});

test("getCalibrationReport only counts probability-bearing kinds with a resolved, well-formed outcome", () => {
  // Other tests in this file (and this service's real behavior) log rows too
  // — the report reads the whole table, so measure the DELTA this test
  // causes rather than asserting an absolute count.
  const before = getCalibrationReport().sampleSize;

  // Not a probability kind — must be excluded even with a recorded outcome.
  const bodyCompId = logFakePrediction("prediction:body_composition", 0, 1, 1);
  recordOutcome(bodyCompId, { achieved: true });

  // A probability kind, but never resolved — must be excluded.
  logFakePrediction("prediction:run", 80, 1, 1);

  // A probability kind, resolved, well-formed — must count.
  const goodId = logFakePrediction("prediction:hyrox", 70, 1, 1);
  recordOutcome(goodId, { achieved: false });

  const after = getCalibrationReport().sampleSize;
  assert.equal(after - before, 1, "only the one well-formed, resolved, probability-bearing prediction added here should count");
});

test("getCalibrationMultiplier returns 1 when there isn't enough history yet — the honest state for a brand-new app", () => {
  assert.equal(getCalibrationMultiplier(), 1);
});
