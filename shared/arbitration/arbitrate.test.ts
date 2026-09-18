import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured } from "../measured";
import type { Goal } from "../goal";
import type { Condition } from "../conditions";
import { arbitratePlan, arbitrateWeek } from "./arbitrate";

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g",
    type: "endurance_race",
    label: "Goal",
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

test("a single active goal produces no conflicts", () => {
  const week = arbitrateWeek([goal({ id: "a" })], "2026-09-15", DEFAULT_ATHLETE);
  assert.equal(week.conflicts.length, 0);
  assert.equal(week.goalPhases.length, 1);
});

test("an inactive goal is excluded entirely", () => {
  const week = arbitrateWeek([goal({ id: "a", active: false })], "2026-09-15", DEFAULT_ATHLETE);
  assert.equal(week.goalPhases.length, 0);
});

test("two goals that both want elevated load but don't directly oppose produce no load conflict", () => {
  // strength accumulation (1.1x, surplus) far from its date + an endurance
  // base phase (1.0x, maintenance) far from its date — both mild, no clash.
  const week = arbitrateWeek(
    [goal({ id: "a", type: "strength", targetDate: "2027-06-01" }), goal({ id: "b", type: "endurance_race", targetDate: "2027-09-01" })],
    "2026-09-15",
    DEFAULT_ATHLETE,
  );
  assert.equal(week.conflicts.length, 0);
});

test("a genuine load conflict is surfaced: race build (elevated) vs. body-comp cut (reduced)", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale") };
  const race = goal({ id: "race", type: "endurance_race", targetDate: "2026-11-15", priority: 2 }); // ~9 weeks out — build phase, 1.15x
  const wedding = goal({ id: "wedding", type: "body_composition", targetDate: "2026-11-01", priority: 1, targetMetrics: { targetWeightKg: 76 } }); // cut active, 0.9x
  const week = arbitrateWeek([race, wedding], "2026-09-15", athlete);

  const loadConflict = week.conflicts.find((c) => c.betweenGoalIds.includes("race") && c.betweenGoalIds.includes("wedding"));
  assert.ok(loadConflict, "expected a load conflict between the two goals pulling in opposite directions");
  // Blended load must sit strictly between the two raw asks (0.9 and 1.15) — not equal to either.
  assert.ok(week.loadMultiplier > 0.9 && week.loadMultiplier < 1.15);
  // Wedding is higher priority (1 < 2), so it should win the resolution.
  const isWeddingA = loadConflict!.betweenGoalIds[0] === "wedding";
  assert.equal(loadConflict!.resolution, isWeddingA ? "goal_a_priority" : "goal_b_priority");
});

test("nutrition conflict: a surplus goal and a deficit goal directly contradict, priority wins", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale") };
  const bulk = goal({ id: "bulk", type: "strength", targetDate: "2027-06-01", priority: 3 }); // accumulation surplus
  const cut = goal({ id: "cut", type: "body_composition", targetDate: "2026-11-01", priority: 1, targetMetrics: { targetWeightKg: 76 } }); // deficit, higher priority
  const week = arbitrateWeek([bulk, cut], "2026-09-15", athlete);

  assert.equal(week.nutritionStance, "deficit", "the higher-priority (lower number) goal's nutrition stance must win");
  const nutritionConflict = week.conflicts.find((c) => c.betweenGoalIds.includes("bulk") && c.betweenGoalIds.includes("cut"));
  assert.ok(nutritionConflict, "a direct surplus/deficit contradiction must be surfaced, not silently resolved");
});

test("the canonical example: Ironman nine months out + a wedding six weeks out", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale, 15 Sep") };
  const today = "2026-09-15";
  const ironman = goal({ id: "ironman", type: "endurance_race", label: "Ironman 70.3", targetDate: "2027-06-15", priority: 2 }); // ~39 weeks out
  const wedding = goal({ id: "wedding", type: "body_composition", label: "Wedding", targetDate: "2026-10-27", priority: 1, targetMetrics: { targetWeightKg: 78 } }); // ~6 weeks out, 4kg to lose

  const plan = arbitratePlan([ironman, wedding], today, "2026-12-01", athlete);

  const beforeWedding = plan.weeks.find((w) => w.date === today)!;
  const afterWedding = plan.weeks.find((w) => w.date > "2026-10-27")!;

  // "still train hard for the Ironman" during the cut: base-phase load
  // shouldn't collapse just because a deficit is running.
  assert.equal(beforeWedding.goalPhases.find((p) => p.goalId === "ironman")!.phaseName, "base");
  assert.ok(beforeWedding.loadMultiplier >= 0.85, "the Ironman goal should keep the week's load from dropping too far during the cut");

  // "go on a cut" — nutrition must actually reflect the deficit while the
  // wedding's safe-rate window is active.
  const cutWeek = plan.weeks.find((w) => w.goalPhases.some((p) => p.goalId === "wedding" && p.phaseName === "cut"));
  assert.ok(cutWeek, "expected the wedding goal to enter a cut phase before its date");
  assert.equal(cutWeek!.nutritionStance, "deficit");

  // "once the wedding is done, back to eating more and pushing more" —
  // after the target date the body-composition goal reports 'past', and
  // nutrition reverts since nothing else is asking for a deficit.
  assert.equal(afterWedding.goalPhases.find((p) => p.goalId === "wedding")!.phaseName, "past");
  assert.equal(afterWedding.nutritionStance, "maintenance");
});

test("a goal whose date has passed does not drag a later goal's taper — it takes no part in arbitration", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  // The bug this guards: the wedding finished in October at a neutral 1.0x,
  // but kept being blended in — at priority 1, so weighted heavily — through
  // the following June's race week, pulling a 0.5x taper up to 0.83x.
  const race = goal({ id: "race", type: "endurance_race", label: "Ironman", targetDate: "2027-06-13", priority: 2 });
  const wedding = goal({ id: "wedding", type: "body_composition", label: "Wedding", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } });

  const raceWeek = arbitrateWeek([race, wedding], "2027-06-08", athlete);
  const racePhase = raceWeek.goalPhases.find((p) => p.goalId === "race")!;

  assert.equal(racePhase.phaseName, "taper");
  assert.equal(raceWeek.loadMultiplier, racePhase.loadMultiplier, "race-week load must be the taper itself, untouched by a goal that finished seven months earlier");
  assert.equal(raceWeek.conflicts.length, 0, "a goal that has already happened cannot conflict with anything");
});

test("a past goal is still reported in goalPhases so the UI can show it, even though it doesn't arbitrate", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  const race = goal({ id: "race", type: "endurance_race", targetDate: "2027-06-13", priority: 2 });
  const wedding = goal({ id: "wedding", type: "body_composition", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } });

  const week = arbitrateWeek([race, wedding], "2027-06-08", athlete);
  const weddingPhase = week.goalPhases.find((p) => p.goalId === "wedding");
  assert.ok(weddingPhase, "the past goal should still be listed");
  assert.equal(weddingPhase!.phaseName, "past");
});

test("when every goal has passed, the week falls back to a neutral instruction rather than an empty blend", () => {
  const past = goal({ id: "old", type: "endurance_race", targetDate: "2020-01-01" });
  const week = arbitrateWeek([past], "2026-09-16", DEFAULT_ATHLETE);
  assert.equal(week.loadMultiplier, 1);
  assert.equal(week.nutritionStance, "maintenance");
  assert.equal(week.conflicts.length, 0);
});

test("arbitratePlan merges the same conflict across contiguous weeks into one window", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(80, "scale") };
  const race = goal({ id: "race", type: "endurance_race", targetDate: "2026-12-01", priority: 2 });
  const cut = goal({ id: "cut", type: "body_composition", targetDate: "2026-11-15", priority: 1, targetMetrics: { targetWeightKg: 76 } });
  const plan = arbitratePlan([race, cut], "2026-09-15", "2026-11-15", athlete);

  const pairConflicts = plan.conflicts.filter((c) => c.betweenGoalIds.includes("race") && c.betweenGoalIds.includes("cut"));
  assert.ok(pairConflicts.length >= 1, "expected at least one merged conflict window for this goal pair");
  assert.ok(pairConflicts.length < plan.weeks.length, "weekly conflicts for the same pair must be merged, not repeated once per week");
});

// ─── Conditions ──────────────────────────────────────────────────────────────

function condition(over: Partial<Condition> = {}): Condition {
  return {
    id: "c",
    kind: "injury",
    label: "Left calf strain",
    bodyPart: "calf",
    severity: 2,
    restrictions: ["no_running"],
    openedAt: "2026-09-10",
    closedAt: null,
    note: null,
    createdAt: "2026-09-10T08:00:00.000Z",
    updatedAt: "2026-09-10T08:00:00.000Z",
    ...over,
  };
}

function cutAthlete() {
  return { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
}

test("with no conditions the arbitrated week is byte-identical to what it always was", () => {
  const athlete = cutAthlete();
  const goals = [
    goal({ id: "race", type: "endurance_race", label: "Ironman", targetDate: "2027-06-13", priority: 2 }),
    goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } }),
  ];
  // The default empty list and an explicit empty list must both leave every
  // number exactly where it was — conditions are additive or they are a
  // regression in the engine that is the whole product.
  const implicit = arbitrateWeek(goals, "2026-09-21", athlete);
  const explicit = arbitrateWeek(goals, "2026-09-21", athlete, [], "2026-09-21");
  assert.deepEqual(explicit, implicit);
  assert.equal(implicit.nutritionStance, "deficit", "the fixture must actually be running a deficit for the next test to mean anything");

  const planImplicit = arbitratePlan(goals, "2026-09-15", "2026-10-15", athlete);
  const planExplicit = arbitratePlan(goals, "2026-09-15", "2026-10-15", athlete, [], "2026-09-15");
  assert.deepEqual(planExplicit, planImplicit);
});

test("a cut is paused while a real injury is open, and the athlete is told why", () => {
  const athlete = cutAthlete();
  const goals = [goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } })];
  const week = arbitrateWeek(goals, "2026-09-21", athlete, [condition()], "2026-09-21");

  assert.equal(week.nutritionStance, "maintenance", "a deficit on top of a week the injury already shrank is a double cut while tissue is repairing");
  const explained = week.conflicts.find((c) => c.description.includes("Left calf strain"));
  assert.ok(explained, "the pause must be explained in the same channel a goal-vs-goal tradeoff uses");
  assert.match(explained!.description, /Wedding/, "and it must name the goal it paused");
  assert.ok(!/severity|no_running|deficit_/.test(explained!.description), "no enum values reach the athlete");
});

test("a niggle does not pause a cut", () => {
  const athlete = cutAthlete();
  const goals = [goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } })];
  const week = arbitrateWeek(goals, "2026-09-21", athlete, [condition({ severity: 1, label: "Tight achilles" })], "2026-09-21");
  assert.equal(week.nutritionStance, "deficit", "severity 1 is something you train around, not something you have to eat for");
  assert.equal(week.conflicts.length, 0);
});

test("a closed condition stops pausing the cut the day after it closes", () => {
  // The Phase 3 archetype: state that should have stopped influencing output.
  const athlete = cutAthlete();
  const goals = [goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } })];
  const healed = [condition({ closedAt: "2026-09-20" })];

  const during = arbitrateWeek(goals, "2026-09-14", athlete, healed, "2026-09-28");
  const after = arbitrateWeek(goals, "2026-09-21", athlete, healed, "2026-09-28");
  assert.equal(during.nutritionStance, "maintenance", "the week it was open");
  assert.equal(after.nutritionStance, "deficit", "the week after it closed");
});

test("conditions never move the load multiplier or the phases", () => {
  const athlete = cutAthlete();
  const goals = [
    goal({ id: "race", type: "endurance_race", label: "Ironman", targetDate: "2027-06-13", priority: 2 }),
    goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } }),
  ];
  const without = arbitrateWeek(goals, "2026-09-21", athlete);
  const with3 = arbitrateWeek(goals, "2026-09-21", athlete, [condition({ kind: "illness", severity: 3, label: "Flu" })], "2026-09-21");

  assert.equal(with3.loadMultiplier, without.loadMultiplier, "what the goals want is unchanged by how the athlete feels — the prescription layer handles that, and it can be checked separately");
  assert.deepEqual(with3.goalPhases, without.goalPhases);
});

test("a future week is arbitrated against what is known TODAY, not a guess about recovery", () => {
  const athlete = cutAthlete();
  const goals = [goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-10-31", priority: 1, targetMetrics: { targetWeightKg: 78 } })];
  const open = [condition()];
  const nextMonth = arbitrateWeek(goals, "2026-10-19", athlete, open, "2026-09-21");
  assert.equal(nextMonth.nutritionStance, "maintenance", "the app cannot know the strain will have healed by then, and pretending it will is the guess-as-fact pattern");
});
