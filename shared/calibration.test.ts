import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrateBenchmark, calibrateRunning, type RunEvidence } from "./calibration";

const TODAY = "2026-10-01";
const SEED_THRESHOLD = 260;
const SEED_LTHR = 175;
const SEED_MAXHR = 185;

function run(over: Partial<RunEvidence>): RunEvidence {
  return { date: "2026-09-20", sport: "run", distanceKm: 5, durationMinutes: 22, avgPaceSecPerKm: null, avgHeartRate: null, rpe: null, ...over };
}

test("with no evidence at all, every field stands on its seed and says so", () => {
  const c = calibrateRunning(SEED_THRESHOLD, SEED_LTHR, SEED_MAXHR, [], [], TODAY);
  assert.equal(c.runThresholdSecPerKm.value, SEED_THRESHOLD);
  assert.equal(c.runThresholdSecPerKm.verified, false);
  assert.match(c.runThresholdSecPerKm.source, /seed/);
  assert.equal(c.runEasySecPerKm.value, Math.round(SEED_THRESHOLD * 1.36));
});

test("a recent 1 km time trial becomes the verified anchor", () => {
  const c = calibrateRunning(SEED_THRESHOLD, SEED_LTHR, SEED_MAXHR, [{ testId: "run_1k_tt", date: "2026-09-25", value: 218 }], [], TODAY);
  assert.equal(c.runThresholdSecPerKm.value, 218);
  assert.equal(c.runThresholdSecPerKm.verified, true);
  assert.match(c.runThresholdSecPerKm.source, /1 km time trial/);
});

test("evidence older than the fresh window is used but flagged for a retest", () => {
  const c = calibrateRunning(SEED_THRESHOLD, SEED_LTHR, SEED_MAXHR, [{ testId: "run_1k_tt", date: "2026-01-01", value: 218 }], [], TODAY);
  assert.equal(c.runThresholdSecPerKm.value, 218);
  assert.match(c.runThresholdSecPerKm.source, /retest/);
});

test("two agreeing hard runs can lower LTHR below the seed; one alone cannot", () => {
  // isHard() requires avgHR >= 92% of the CURRENT lthr (161 here, seed 175),
  // so both runs must clear 161 to count as "hard" evidence at all.
  const oneHardRun = calibrateRunning(SEED_THRESHOLD, SEED_LTHR, SEED_MAXHR, [], [run({ date: "2026-09-25", durationMinutes: 25, avgHeartRate: 165 })], TODAY);
  assert.equal(oneHardRun.lthrBpm.value, SEED_LTHR, "a single hard run can only prove LTHR is at least what it averaged, never lower");

  const twoHardRuns = calibrateRunning(
    SEED_THRESHOLD,
    SEED_LTHR,
    SEED_MAXHR,
    [],
    [run({ date: "2026-09-20", durationMinutes: 25, avgHeartRate: 165 }), run({ date: "2026-09-25", durationMinutes: 30, avgHeartRate: 168 })],
    TODAY,
  );
  assert.equal(twoHardRuns.lthrBpm.value, 168);
  assert.equal(twoHardRuns.lthrBpm.verified, true);
});

test("calibrateBenchmark falls back to the seed, unverified, with no matching tests", () => {
  const b = calibrateBenchmark("wall_balls", 240, [], TODAY);
  assert.equal(b.value, 240);
  assert.equal(b.verified, false);
});

test("calibrateBenchmark prefers the best recent result when betterIsLower", () => {
  const tests = [
    { testId: "wall_balls", date: "2026-09-01", value: 230 },
    { testId: "wall_balls", date: "2026-09-20", value: 210 },
    { testId: "sled_push", date: "2026-09-20", value: 999 }, // different test id, must be ignored
  ];
  const b = calibrateBenchmark("wall_balls", 240, tests, TODAY);
  assert.equal(b.value, 210);
  assert.equal(b.verified, true);
});

test("calibrateBenchmark honors betterIsLower=false for a strength test (higher is better)", () => {
  const tests = [
    { testId: "squat_1rm", date: "2026-09-01", value: 100 },
    { testId: "squat_1rm", date: "2026-09-20", value: 110 },
  ];
  const b = calibrateBenchmark("squat_1rm", 90, tests, TODAY, 84, false);
  assert.equal(b.value, 110);
});

test("calibrateBenchmark uses stale evidence over no evidence, flagged for a retest", () => {
  const b = calibrateBenchmark("wall_balls", 240, [{ testId: "wall_balls", date: "2026-01-01", value: 220 }], TODAY);
  assert.equal(b.value, 220);
  assert.match(b.source, /retest/);
});
