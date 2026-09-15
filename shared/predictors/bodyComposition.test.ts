import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured } from "../measured";
import { predictBodyComposition } from "./bodyComposition";

test("a modest cut over a generous timeline is achievable", () => {
  const a = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale, this morning") };
  const p = predictBodyComposition(a, { targetWeightKg: 76, targetDate: "2027-01-01", today: "2026-09-15" }); // ~15.4 weeks for 4kg
  assert.equal(p.achievable, true);
  assert.ok(p.requiredWeeklyChangeKg! < 0);
});

test("an aggressive cut in a short window is flagged as not achievable", () => {
  const a = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale, this morning") };
  const p = predictBodyComposition(a, { targetWeightKg: 70, targetDate: "2026-10-15", today: "2026-09-15" }); // 10kg in ~4.3 weeks
  assert.equal(p.achievable, false);
  assert.match(p.note, /above the/);
});

test("a target body-fat percent is solved for an equivalent target weight, holding lean mass constant", () => {
  const a = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale"), bodyFatPercent: measured(20, "DEXA") };
  const p = predictBodyComposition(a, { targetBodyFatPercent: 15, targetDate: "2027-06-01", today: "2026-09-15" });
  assert.ok(p.requiredWeeklyChangeKg! < 0, "dropping body fat % at the same lean mass implies a lower target weight");
});

test("a target date in the past is not achievable and says so, without dividing by zero", () => {
  const p = predictBodyComposition(DEFAULT_ATHLETE, { targetWeightKg: 70, targetDate: "2020-01-01", today: "2026-09-15" });
  assert.equal(p.achievable, false);
  assert.match(p.note, /passed/);
});

test("confidence reflects whether weight/body-fat are actually measured", () => {
  const seededAthlete = DEFAULT_ATHLETE;
  const measuredAthlete = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale"), bodyFatPercent: measured(18, "DEXA") };
  const seededResult = predictBodyComposition(seededAthlete, { targetWeightKg: 76, targetDate: "2027-01-01", today: "2026-09-15" });
  const measuredResult = predictBodyComposition(measuredAthlete, { targetWeightKg: 76, targetDate: "2027-01-01", today: "2026-09-15" });
  assert.equal(seededResult.confidence.verifiedCount, 0);
  assert.equal(measuredResult.confidence.verifiedCount, 2);
});
