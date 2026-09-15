import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured } from "../measured";
import { predictHyrox } from "./hyrox";

test("predictHyrox produces a total that's the sum of runs, stations, and roxzone", () => {
  const p = predictHyrox(DEFAULT_ATHLETE, 4800);
  const sum = p.runSeconds + p.stationSeconds + p.roxzoneSeconds;
  assert.equal(p.totalSeconds, sum);
  assert.equal(p.runSplits.length, 8);
  assert.equal(p.stationSplits.length, 8);
});

test("a higher strengthEnduranceIndex makes the predicted race slower, all else equal", () => {
  const strong = { ...DEFAULT_ATHLETE, strengthEnduranceIndex: measured(0.8, "measured from race sim") };
  const weak = { ...DEFAULT_ATHLETE, strengthEnduranceIndex: measured(1.3, "measured from race sim") };
  const pStrong = predictHyrox(strong, 4800);
  const pWeak = predictHyrox(weak, 4800);
  assert.ok(pWeak.totalSeconds > pStrong.totalSeconds, "a worse strength-endurance index must predict a slower total time");
});

test("run 1 carries no local penalty (run fresh); run 8 (off sandbag lunges) carries the largest", () => {
  const p = predictHyrox(DEFAULT_ATHLETE, 4800);
  const run1 = p.runSplits.find((r) => r.runIndex === 1)!;
  const run8 = p.runSplits.find((r) => r.runIndex === 8)!;
  assert.equal(run1.localPenalty, 0);
  assert.equal(run1.precededBy, null);
  assert.ok(run8.localPenalty > run1.localPenalty);
  assert.equal(run8.precededBy, "sandbag_lunges");
});

test("goalProbability's band is wider when strengthEnduranceIndex and station benchmarks are all still seeds", () => {
  const seededAthlete = { ...DEFAULT_ATHLETE };
  const verifiedAthlete = {
    ...DEFAULT_ATHLETE,
    strengthEnduranceIndex: measured(1.0, "race sim"),
    benchmarks: Object.fromEntries(
      ["ski_erg", "sled_push", "sled_pull", "burpee_broad_jump", "row", "farmers_carry", "sandbag_lunges", "wall_balls"].map((id) => [id, measured(200, "measured")]),
    ),
  };
  const seededBand = predictHyrox(seededAthlete, 4800);
  const verifiedBand = predictHyrox(verifiedAthlete, 4800);
  const seededWidth = seededBand.goalProbabilityHigh - seededBand.goalProbabilityLow;
  const verifiedWidth = verifiedBand.goalProbabilityHigh - verifiedBand.goalProbabilityLow;
  assert.ok(seededWidth > verifiedWidth, "the whole point: an all-guessed HYROX prediction must show a wider band than a fully-measured one");
});

test("wall balls — the latest, most anaerobic station — surfaces as a limiter for the default athlete", () => {
  // Degradation ratio (seconds/benchmark) depends only on station order,
  // anaerobic demand, and strengthEnduranceIndex — not the benchmark's own
  // value, since seconds = benchmark * degradation. Wall balls (order 8,
  // anaerobic 0.95) has the highest degradation of any station under a
  // uniform SEI, so it's the one guaranteed to show up here.
  const p = predictHyrox(DEFAULT_ATHLETE, 4800);
  const wallBallsLimiter = p.limiters.find((l) => l.stationId === "wall_balls");
  assert.ok(wallBallsLimiter, "expected wall_balls to surface as a limiter for a default (uniform) athlete profile");
});
