import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "./athlete";
import { measured } from "./measured";
import { dailyTargets, fatFreeMassKg, maintenanceKcal, restingEnergyKcal, MAX_DEFICIT_FRACTION } from "./nutrition";

const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale"), bodyFatPercent: measured(18, "DEXA") };

test("fat-free mass and resting energy use lean mass, not bodyweight", () => {
  assert.equal(Math.round(fatFreeMassKg(82, 18) * 10) / 10, 67.2);
  // Katch-McArdle: 370 + 21.6 × FFM
  assert.equal(restingEnergyKcal(82, 18), Math.round(370 + 21.6 * 67.24));
});

test("maintenance rises with the day's training load, not a flat activity multiplier", () => {
  const rest = maintenanceKcal(82, 18, 0);
  const hard = maintenanceKcal(82, 18, 120);
  assert.ok(hard > rest + 500, `a 120-TSS day should cost hundreds of kcal more than a rest day, got ${rest} vs ${hard}`);
});

test("maintenance stance eats at maintenance", () => {
  const t = dailyTargets(athlete, { stance: "maintenance", dailyTss: 50 });
  assert.equal(t.dailyDeltaKcal, 0);
  assert.equal(t.kcal, t.maintenanceKcal);
});

test("the deficit is sized off the rate the deadline demands, not a stock percentage", () => {
  // 0.5 kg/week × 7700 kcal/kg ÷ 7 days ≈ 550 kcal/day.
  const t = dailyTargets(athlete, { stance: "deficit", requiredWeeklyChangeKg: -0.5, dailyTss: 50 });
  assert.ok(Math.abs(t.dailyDeltaKcal + 550) < 15, `expected about -550 kcal/day, got ${t.dailyDeltaKcal}`);
  assert.equal(t.capped, false);
});

test("a faster required rate produces a bigger deficit, up to the safety cap", () => {
  const gentle = dailyTargets(athlete, { stance: "deficit", requiredWeeklyChangeKg: -0.3, dailyTss: 50 });
  const aggressive = dailyTargets(athlete, { stance: "deficit", requiredWeeklyChangeKg: -0.8, dailyTss: 50 });
  assert.ok(Math.abs(aggressive.dailyDeltaKcal) > Math.abs(gentle.dailyDeltaKcal));
});

test("an impossible deadline is capped at 25% rather than prescribing a crash diet", () => {
  const t = dailyTargets(athlete, { stance: "deficit", requiredWeeklyChangeKg: -3, dailyTss: 50 });
  assert.equal(t.capped, true);
  assert.ok(Math.abs(t.dailyDeltaKcal) <= t.maintenanceKcal * MAX_DEFICIT_FRACTION + 1);
  assert.match(t.note, /Capped/);
});

test("protein goes UP in a deficit — it's what decides fat loss vs muscle loss", () => {
  const maintaining = dailyTargets(athlete, { stance: "maintenance", dailyTss: 50 });
  const cutting = dailyTargets(athlete, { stance: "deficit", requiredWeeklyChangeKg: -0.5, dailyTss: 50 });
  assert.ok(cutting.proteinG > maintaining.proteinG, "protein must rise in a deficit, not fall");
});

test("protein rises again once genuinely lean", () => {
  const lean = { ...athlete, bodyFatPercent: measured(9, "DEXA") };
  const normal = dailyTargets(athlete, { stance: "deficit", requiredWeeklyChangeKg: -0.5, dailyTss: 50 });
  const leanTarget = dailyTargets(lean, { stance: "deficit", requiredWeeklyChangeKg: -0.5, dailyTss: 50 });
  // Per kg of fat-free mass, the lean athlete gets more.
  const perKgNormal = normal.proteinG / fatFreeMassKg(82, 18);
  const perKgLean = leanTarget.proteinG / fatFreeMassKg(82, 9);
  assert.ok(perKgLean > perKgNormal);
});

test("carbohydrate flexes with the day's load; protein and fat hold", () => {
  const restDay = dailyTargets(athlete, { stance: "maintenance", dailyTss: 0 });
  const hardDay = dailyTargets(athlete, { stance: "maintenance", dailyTss: 130 });
  assert.ok(hardDay.carbG > restDay.carbG + 100, "carbs are the fuel that should move with training");
  assert.equal(hardDay.proteinG, restDay.proteinG, "protein shouldn't swing with the session");
});

test("macros actually add up to the energy target", () => {
  const t = dailyTargets(athlete, { stance: "deficit", requiredWeeklyChangeKg: -0.5, dailyTss: 60 });
  const fromMacros = t.proteinG * 4 + t.fatG * 9 + t.carbG * 4;
  assert.ok(Math.abs(fromMacros - t.kcal) < 25, `macros sum to ${fromMacros} but the target is ${t.kcal}`);
});

test("never prescribes a starvation intake even on absurd inputs", () => {
  const tiny = { ...athlete, weightKg: measured(45, "scale"), bodyFatPercent: measured(5, "DEXA") };
  const t = dailyTargets(tiny, { stance: "deficit", requiredWeeklyChangeKg: -5, dailyTss: 0 });
  assert.ok(t.kcal >= 1200, `floor should hold, got ${t.kcal}`);
});

test("a surplus with no stated rate still produces a sane, capped bump", () => {
  const t = dailyTargets(athlete, { stance: "surplus", dailyTss: 50 });
  assert.ok(t.dailyDeltaKcal > 0);
  assert.ok(t.dailyDeltaKcal < t.maintenanceKcal * 0.2);
});
