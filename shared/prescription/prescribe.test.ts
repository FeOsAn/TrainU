import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured } from "../measured";
import type { Goal } from "../goal";
import { arbitrateWeek } from "../arbitration/arbitrate";
import { prescribeWeek } from "./prescribe";

const MONDAY = "2026-09-14";

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

function prescribe(goals: Goal[], athlete = DEFAULT_ATHLETE, daysPerWeek?: number) {
  const week = arbitrateWeek(goals, MONDAY, athlete);
  return prescribeWeek(week, goals, athlete, { daysPerWeek });
}

test("no active goals prescribes nothing rather than inventing a week", () => {
  const w = prescribe([]);
  assert.equal(w.sessions.length, 0);
  assert.match(w.note, /No active goals/);
});

test("a single endurance goal gets the qualities that matter, long run included", () => {
  const w = prescribe([goal({ id: "race" })]);
  const kinds = w.sessions.map((s) => s.kind);
  assert.ok(kinds.includes("run_long"), "the long run is the highest-return session for a distance goal");
  assert.ok(kinds.includes("run_easy"));
  assert.equal(w.sessions.length, 5, "should fill the default 5 training days");
});

test("every prescribed session carries real numbers, not vague instructions", () => {
  const athlete = { ...DEFAULT_ATHLETE, runThresholdSecPerKm: measured(240, "1 km TT"), runEasySecPerKm: measured(330, "median easy") };
  const w = prescribe([goal({ id: "race" })], athlete);
  for (const session of w.sessions) {
    assert.ok(session.targets.length > 0, `${session.kind} has no targets`);
    assert.ok(session.durationMinutes >= 20, `${session.kind} duration is implausible`);
    assert.ok(session.tss > 0, `${session.kind} priced at zero TSS`);
  }
  const easy = w.sessions.find((s) => s.kind === "run_easy")!;
  assert.ok(easy.targets[0]!.includes("5:30/km"), `easy pace should come off the athlete's own easy pace, got: ${easy.targets[0]}`);
});

test("threshold pace is derived from the fresh kilometre, not mistaken for it", () => {
  // 240 s/km all-out kilometre → threshold ~17% slower, i.e. about 4:41/km.
  const athlete = { ...DEFAULT_ATHLETE, runThresholdSecPerKm: measured(240, "1 km TT") };
  const w = prescribe([goal({ id: "race", targetDate: "2026-11-15" })], athlete); // build phase allows threshold
  const threshold = w.sessions.find((s) => s.kind === "run_threshold");
  assert.ok(threshold, "a build phase should include threshold work");
  assert.ok(threshold!.targets[0]!.includes("4:41"), `expected ~4:41/km threshold off a 4:00 km, got: ${threshold!.targets[0]}`);
});

test("two goals that both want an easy run get ONE easy run serving both", () => {
  const race = goal({ id: "race", type: "endurance_race", label: "Marathon", priority: 1 });
  const fitness = goal({ id: "fit", type: "general_fitness", label: "General fitness", priority: 2 });
  const w = prescribe([race, fitness]);

  const easyRuns = w.sessions.filter((s) => s.kind === "run_easy");
  assert.ok(easyRuns.length >= 1);
  const shared = easyRuns.find((s) => s.servesGoalIds.length > 1);
  assert.ok(shared, "an easy run wanted by both goals should be one session serving both, not two sessions");
  assert.match(shared!.note, /at once/);
});

test("the higher-priority goal gets more of the week", () => {
  const race = goal({ id: "race", type: "endurance_race", label: "Marathon", priority: 1 });
  const lift = goal({ id: "lift", type: "strength", label: "Squat PR", priority: 3 });
  const w = prescribe([race, lift], DEFAULT_ATHLETE, 5);

  const raceSessions = w.sessions.filter((s) => s.servesGoalIds.includes("race")).length;
  const liftSessions = w.sessions.filter((s) => s.servesGoalIds.includes("lift")).length;
  assert.ok(raceSessions > liftSessions, `priority 1 should out-allocate priority 3, got ${raceSessions} vs ${liftSessions}`);
});

test("a body-composition goal contributes lifting, not cardio it can't recover from", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  const cut = goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-11-01", targetMetrics: { targetWeightKg: 78 } });
  const w = prescribe([cut], athlete);
  const kinds = w.sessions.map((s) => s.kind);
  assert.ok(kinds.includes("strength_lower"), "lifting is what protects lean mass in a deficit");
  assert.ok(!kinds.includes("run_intervals"), "a deficit phase shouldn't prescribe intensity it can't recover from");
});

test("a base week doesn't get two threshold runs just because the ceiling downgraded the intervals slot", () => {
  const w = prescribe([goal({ id: "race", targetDate: "2027-06-01" })]); // far out → base, ceiling "threshold"
  const hard = w.sessions.filter((s) => s.intensity === "hard");
  assert.ok(hard.length <= 1, `a base week should carry at most one hard session, got ${hard.map((s) => s.kind).join(", ")}`);
  assert.ok(w.sessions.filter((s) => s.kind === "run_easy").length >= 2, "the surplus intensity should become aerobic volume");
});

test("a build week still gets BOTH threshold and intervals — they're different qualities", () => {
  const w = prescribe([goal({ id: "race", targetDate: "2026-11-15" })]); // ~9 weeks → build, ceiling "full"
  const kinds = w.sessions.map((s) => s.kind);
  assert.ok(kinds.includes("run_threshold"));
  assert.ok(kinds.includes("run_intervals"));
});

test("the week's size scales with the arbitrated load multiplier", () => {
  const taperGoal = goal({ id: "race", targetDate: "2026-09-18" }); // days out → taper, ~0.5x
  const baseGoal = goal({ id: "race2", targetDate: "2027-09-01" }); // far out → base, 1.0x

  const taperWeek = prescribe([taperGoal]);
  const baseWeek = prescribe([baseGoal]);
  assert.ok(taperWeek.totalMinutes < baseWeek.totalMinutes, "a taper week must be smaller than a base week");
});

test("fewer available days drops the least important qualities, never the long run", () => {
  const w3 = prescribe([goal({ id: "race" })], DEFAULT_ATHLETE, 3);
  assert.equal(w3.sessions.length, 3);
  assert.ok(w3.sessions.some((s) => s.kind === "run_long"), "the long run survives a squeezed week");
});

test("hard sessions don't land on back-to-back days", () => {
  const w = prescribe([goal({ id: "race", type: "hyrox", targetDate: "2026-11-15" })], DEFAULT_ATHLETE, 6);
  const hardDates = w.sessions.filter((s) => s.intensity === "hard").map((s) => Date.parse(`${s.date}T00:00:00Z`)).sort();
  for (let i = 1; i < hardDates.length; i++) {
    assert.ok(hardDates[i]! - hardDates[i - 1]! > 86_400_000, "two hard sessions landed on consecutive days");
  }
});

test("no session gets an absurd duration, however the budget falls", () => {
  // The bug this guards: a week whose slots are mostly strength handed the
  // entire remaining aerobic budget to the one easy run in it — 225 minutes.
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  const cut = goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-11-01", priority: 1, targetMetrics: { targetWeightKg: 78 } });
  const race = goal({ id: "race", type: "endurance_race", label: "Ironman", targetDate: "2027-06-13", priority: 2 });
  const w = prescribe([cut, race], athlete, 5);

  for (const session of w.sessions) {
    assert.ok(session.durationMinutes <= 210, `${session.kind} is ${session.durationMinutes} min — nobody does that session`);
    if (session.kind === "run_easy") {
      assert.ok(session.durationMinutes <= 80, `an easy run of ${session.durationMinutes} min is not an easy run`);
    }
  }
});

test("the long run is always the week's longest aerobic session", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  const cut = goal({ id: "cut", type: "body_composition", targetDate: "2026-11-01", priority: 1, targetMetrics: { targetWeightKg: 78 } });
  const race = goal({ id: "race", type: "endurance_race", targetDate: "2027-06-13", priority: 2 });

  for (const goals of [[race], [cut, race], [race, cut]]) {
    const w = prescribe(goals, athlete, 5);
    const long = w.sessions.find((s) => s.kind === "run_long");
    if (!long) continue;
    const otherAerobic = w.sessions.filter((s) => s.kind !== "run_long" && s.sport !== "strength");
    for (const other of otherAerobic) {
      assert.ok(long.durationMinutes > other.durationMinutes, `long run (${long.durationMinutes}) should exceed ${other.kind} (${other.durationMinutes})`);
    }
  }
});

test("prescription is deterministic — same inputs, same week, every time", () => {
  const goals = [goal({ id: "race", priority: 1 }), goal({ id: "cut", type: "body_composition", priority: 2, targetDate: "2026-11-01", targetMetrics: { targetWeightKg: 78 } })];
  const a = prescribe(goals);
  const b = prescribe(goals);
  assert.deepEqual(a, b);
});

test("a past goal contributes no sessions", () => {
  const past = goal({ id: "old", targetDate: "2020-01-01" });
  const live = goal({ id: "live", targetDate: "2027-06-01" });
  const w = prescribe([past, live]);
  assert.ok(w.sessions.every((s) => !s.servesGoalIds.includes("old")), "a goal that already happened shouldn't be prescribed for");
});
