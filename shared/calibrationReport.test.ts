import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCalibrationReport, type CalibrationRecord } from "./calibrationReport";

function record(over: Partial<CalibrationRecord>): CalibrationRecord {
  return { confidenceRatio: 1, predictedProbability: 80, actualSuccess: true, ...over };
}

test("no records at all: neutral report, no adjustment", () => {
  const r = computeCalibrationReport([]);
  assert.equal(r.sampleSize, 0);
  assert.equal(r.brierScore, null);
  assert.equal(r.recommendedMultiplier, 1);
});

test("fewer than the minimum sample size: reports stats but withholds an adjustment", () => {
  const records = Array.from({ length: 5 }, () => record({}));
  const r = computeCalibrationReport(records);
  assert.equal(r.sampleSize, 5);
  assert.equal(r.recommendedMultiplier, 1, "must not adjust off a handful of predictions");
  assert.match(r.note, /need at least/);
});

test("perfectly calibrated confident predictions: no adjustment", () => {
  // 20 predictions at 90% confidence, 90% actually succeed — exactly matches the implied rate.
  const records: CalibrationRecord[] = [
    ...Array.from({ length: 18 }, () => record({ predictedProbability: 90, actualSuccess: true })),
    ...Array.from({ length: 2 }, () => record({ predictedProbability: 90, actualSuccess: false })),
  ];
  const r = computeCalibrationReport(records);
  assert.equal(r.sampleSize, 20);
  assert.equal(r.recommendedMultiplier, 1);
  assert.match(r.note, /well-calibrated/);
});

test("systematically overconfident predictions widen the recommended band", () => {
  // 20 predictions at 90% confidence, but only right half the time — badly overconfident.
  const records: CalibrationRecord[] = [
    ...Array.from({ length: 10 }, () => record({ predictedProbability: 90, actualSuccess: true })),
    ...Array.from({ length: 10 }, () => record({ predictedProbability: 90, actualSuccess: false })),
  ];
  const r = computeCalibrationReport(records);
  assert.ok(r.recommendedMultiplier > 1, `expected a widening multiplier, got ${r.recommendedMultiplier}`);
  assert.match(r.note, /widening/);
});

test("systematically underconfident predictions narrow the recommended band, with a floor", () => {
  // 20 "confident" (>=70%) predictions at 75%, but right 100% of the time — the app undersold its own accuracy.
  const records: CalibrationRecord[] = Array.from({ length: 20 }, () => record({ predictedProbability: 75, actualSuccess: true }));
  const r = computeCalibrationReport(records);
  assert.ok(r.recommendedMultiplier < 1, `expected a narrowing multiplier, got ${r.recommendedMultiplier}`);
  assert.ok(r.recommendedMultiplier >= 0.5, "narrowing must never go below the 0.5 floor");
});

test("buckets split mostly-guessed vs. mostly-measured inputs and track each one's accuracy separately", () => {
  const records: CalibrationRecord[] = [
    ...Array.from({ length: 10 }, () => record({ confidenceRatio: 0.1, predictedProbability: 80, actualSuccess: false })), // guessed, wrong a lot
    ...Array.from({ length: 10 }, () => record({ confidenceRatio: 0.9, predictedProbability: 80, actualSuccess: true })), // measured, right a lot
  ];
  const r = computeCalibrationReport(records);
  const guessed = r.buckets.find((b) => b.label.includes("guessed"))!;
  const measured = r.buckets.find((b) => b.label.includes("measured"))!;
  assert.ok(guessed.accuracy < measured.accuracy, "predictions built on guessed inputs should show up as less accurate than ones built on measured inputs");
});

test("brier score is 0 for perfect predictions and worse (higher) for confidently wrong ones", () => {
  const perfect = computeCalibrationReport(Array.from({ length: 20 }, () => record({ predictedProbability: 100, actualSuccess: true })));
  const confidentlyWrong = computeCalibrationReport(Array.from({ length: 20 }, () => record({ predictedProbability: 100, actualSuccess: false })));
  assert.equal(perfect.brierScore, 0);
  assert.equal(confidentlyWrong.brierScore, 1);
});
