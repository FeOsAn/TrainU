import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured } from "../measured";
import type { Goal } from "../goal";
import { phaseForGoal } from "./goalPhase";

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g1",
    type: "endurance_race",
    label: "Test Goal",
    targetDate: "2027-06-01",
    priority: 1,
    successCriteria: "",
    targetMetrics: {},
    constraints: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    active: true,
    ...over,
  };
}

test("an endurance race far out is in base phase with a neutral load", () => {
  const p = phaseForGoal(goal({ targetDate: "2027-09-01" }), "2026-09-15", DEFAULT_ATHLETE);
  assert.equal(p.phaseName, "base");
  assert.equal(p.loadMultiplier, 1.0);
  assert.equal(p.nutritionStance, "maintenance");
});

test("an endurance race inside 12 weeks is a build phase with elevated load", () => {
  const p = phaseForGoal(goal({ targetDate: "2026-11-15" }), "2026-09-15", DEFAULT_ATHLETE); // ~9 weeks out
  assert.equal(p.phaseName, "build");
  assert.ok(p.loadMultiplier > 1.0);
});

test("an endurance race inside 1.5 weeks tapers hard", () => {
  const p = phaseForGoal(goal({ targetDate: "2026-09-24" }), "2026-09-15", DEFAULT_ATHLETE);
  assert.equal(p.phaseName, "taper");
  assert.ok(p.loadMultiplier < 1.0);
});

test("a goal whose target date has passed reports 'past'", () => {
  const p = phaseForGoal(goal({ targetDate: "2020-01-01" }), "2026-09-15", DEFAULT_ATHLETE);
  assert.equal(p.phaseName, "past");
});

test("body composition: far from the required start date, the goal just maintains", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale") };
  const g = goal({ type: "body_composition", targetDate: "2028-01-01", targetMetrics: { targetWeightKg: 76 } });
  const p = phaseForGoal(g, "2026-09-15", athlete);
  assert.equal(p.phaseName, "maintain");
  assert.equal(p.nutritionStance, "maintenance");
});

test("body composition: once the required weekly rate reaches the safe ceiling, the cut starts", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale") };
  // 4kg to lose, safe rate ~0.6 kg/week (0.75% of 80kg) => needs ~6.7 weeks.
  const g = goal({ type: "body_composition", targetDate: "2026-11-01", targetMetrics: { targetWeightKg: 76 } }); // ~6.6 weeks from "today" below
  const p = phaseForGoal(g, "2026-09-15", athlete);
  assert.equal(p.phaseName, "cut");
  assert.equal(p.nutritionStance, "deficit");
  assert.ok(p.loadMultiplier < 1.0);
});

test("strength accumulation runs a slight surplus far from the target date", () => {
  const p = phaseForGoal(goal({ type: "strength", targetDate: "2027-06-01" }), "2026-09-15", DEFAULT_ATHLETE);
  assert.equal(p.phaseName, "accumulation");
  assert.equal(p.nutritionStance, "surplus");
});
