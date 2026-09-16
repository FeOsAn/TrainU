import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured, seeded } from "../measured";
import { predictRunRace, predictTriathlon, TRIATHLON_DISTANCES } from "./enduranceRace";

test("predictRunRace anchors on a verified marathon PB when available", () => {
  const a = { ...DEFAULT_ATHLETE, marathonPbMinutes: measured(180, "Berlin Marathon 2026") }; // 3:00:00
  const p = predictRunRace(a, 21.0975); // half marathon
  assert.equal(p.anchor, "marathon_pb");
  assert.ok(p.predictedTimeMinutes < 180, "a half marathon must predict faster than the full marathon PB");
  assert.equal(p.confidence.verifiedCount, 1);
});

test("predictRunRace falls back to threshold pace when the PB is only a seed but threshold is verified", () => {
  const a = { ...DEFAULT_ATHLETE, marathonPbMinutes: seeded(203), runThresholdSecPerKm: measured(240, "1 km time trial") };
  const p = predictRunRace(a, 10);
  assert.equal(p.anchor, "threshold_pace");
});

test("runThresholdSecPerKm is read as a FRESH KILOMETRE, not as threshold pace", () => {
  // The bug this pins: calibration.ts writes an all-out 1 km time trial into
  // this field, but the predictor anchored it straight onto 15 km — treating
  // a 3-4 minute effort as an hour-long one. It called a 3:00 marathon for a
  // 4:00/km kilometre. Converting first lands at ~3:30, which is also where
  // Riegel straight off the kilometre lands independently.
  const a = { ...DEFAULT_ATHLETE, marathonPbMinutes: seeded(203), runThresholdSecPerKm: measured(240, "1 km time trial") };
  const p = predictRunRace(a, 42.195);
  assert.equal(p.anchor, "threshold_pace");
  assert.ok(p.predictedTimeMinutes > 200, `a 4:00/km kilometre should not imply a sub-3:20 marathon, got ${p.predictedTimeFormatted}`);
  assert.ok(p.predictedTimeMinutes < 225, `...nor a 3:45+ one, got ${p.predictedTimeFormatted}`);

  // And it must agree with the independent cross-check within a few minutes.
  const riegelFromKm = (240 / 60) * Math.pow(42.195, 1.06);
  assert.ok(Math.abs(p.predictedTimeMinutes - riegelFromKm) < 8, `predicted ${p.predictedTimeMinutes} vs cross-check ${riegelFromKm}`);
});

test("a longer race predicts a slower pace than a shorter one off the same anchor (Riegel)", () => {
  const a = { ...DEFAULT_ATHLETE, marathonPbMinutes: measured(200, "PB") };
  const p10k = predictRunRace(a, 10);
  const pMarathon = predictRunRace(a, 42.195);
  assert.ok(pMarathon.predictedPaceSecPerKm > p10k.predictedPaceSecPerKm);
});

test("predictRunRace reports goal probability only when a goal time is given", () => {
  const a = { ...DEFAULT_ATHLETE, marathonPbMinutes: measured(200, "PB") };
  const withoutGoal = predictRunRace(a, 42.195);
  assert.equal(withoutGoal.goalProbability, undefined);

  const withGoal = predictRunRace(a, 42.195, 210);
  assert.ok(withGoal.goalProbability !== undefined);
  assert.ok(withGoal.goalProbabilityLow! <= withGoal.goalProbability!);
  assert.ok(withGoal.goalProbabilityHigh! >= withGoal.goalProbability!);
});

test("predictTriathlon: a more aero bike position (lower CdA) predicts a faster bike split, same watts", () => {
  const relaxed = { ...DEFAULT_ATHLETE, bikeCdA: measured(0.32, "profile default") };
  const aero = { ...DEFAULT_ATHLETE, bikeCdA: measured(0.25, "TT bike fitting, 3 Sep") };
  const p1 = predictTriathlon(relaxed, TRIATHLON_DISTANCES["70.3"]);
  const p2 = predictTriathlon(aero, TRIATHLON_DISTANCES["70.3"]);
  assert.ok(p2.bikeTimeMinutes < p1.bikeTimeMinutes, "a lower CdA at the same FTP must be faster, not slower");
});

test("predictTriathlon's confidence band is narrower when every input is verified than when they're all seeds", () => {
  const allSeeded = { ...DEFAULT_ATHLETE };
  const allVerified = {
    ...DEFAULT_ATHLETE,
    cssSecPer100m: measured(112, "test"),
    ftpWatts: measured(285, "test"),
    bikeCdA: measured(0.28, "fitting"),
    weightKg: measured(75, "scale"),
    marathonPbMinutes: measured(203, "race"),
  };
  const goalMinutes = 300;
  const seededPrediction = predictTriathlon(allSeeded, TRIATHLON_DISTANCES["70.3"], goalMinutes);
  const verifiedPrediction = predictTriathlon(allVerified, TRIATHLON_DISTANCES["70.3"], goalMinutes);

  const seededBandWidth = seededPrediction.goalProbabilityHigh! - seededPrediction.goalProbabilityLow!;
  const verifiedBandWidth = verifiedPrediction.goalProbabilityHigh! - verifiedPrediction.goalProbabilityLow!;
  assert.ok(seededBandWidth > verifiedBandWidth, "an all-guessed prediction must carry a wider band than an all-verified one — this is the whole point of the confidence system");
});

test("a full-distance run carries a larger brick penalty than a 70.3 half marathon, off the same PB", () => {
  const a = { ...DEFAULT_ATHLETE, marathonPbMinutes: measured(200, "PB") };
  const half = predictTriathlon(a, TRIATHLON_DISTANCES["70.3"]);
  const full = predictTriathlon(a, TRIATHLON_DISTANCES.full);
  const halfPaceSecPerKm = (half.runTimeMinutes * 60) / TRIATHLON_DISTANCES["70.3"].runKm;
  const fullPaceSecPerKm = (full.runTimeMinutes * 60) / TRIATHLON_DISTANCES.full.runKm;
  assert.ok(fullPaceSecPerKm > halfPaceSecPerKm, "the marathon leg of a full-distance race should be modeled as relatively slower than a 70.3's half marathon");
});
