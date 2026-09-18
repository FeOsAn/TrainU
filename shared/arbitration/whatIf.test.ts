import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE, type AthleteParams } from "../athlete";
import { measured } from "../measured";
import { addDays } from "../dates";
import { DISCIPLINES, type Goal } from "../goal";
import type { Condition } from "../conditions";
import { arbitratePlan } from "./arbitrate";
import {
  applyGoalPatch,
  feasibilityOf,
  resolveHorizon,
  whatIf,
  GOAL_ROLES,
  MAX_HORIZON_WEEKS,
  WHAT_IF_OPS,
  WHAT_IF_OP_LABELS,
  GOAL_ROLE_LABELS,
  FEASIBILITY_BASES,
  FEASIBILITY_BASIS_LABELS,
  WhatIfPatchError,
  type GoalPatch,
} from "./whatIf";

const FROM = "2026-09-14"; // a Monday
const ATHLETE: AthleteParams = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale, 14 Sep") };

function goal(over: Partial<Goal>): Goal {
  return {
    id: "goal-x",
    type: "endurance_race",
    discipline: "run",
    label: "A goal",
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

/*
 * The canonical pair, arranged so the tradeoff is real: the Ironman's taper
 * (0.5x) falls inside the wedding's cut (0.9x), which is 0.4 apart and well
 * over arbitrate's 0.15 conflict threshold.
 */
function ironman(over: Partial<Goal> = {}): Goal {
  return goal({ id: "goal-ironman", label: "Ironman 70.3", discipline: "triathlon", targetDate: "2027-06-15", priority: 2, ...over });
}
function wedding(over: Partial<Goal> = {}): Goal {
  return goal({
    id: "goal-wedding",
    label: "Wedding",
    type: "body_composition",
    discipline: "other",
    targetDate: "2027-06-21",
    priority: 1,
    targetMetrics: { targetWeightKg: 78 },
    ...over,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/* ─────────────────────── the engine is the only engine ─────────────────── */

test("before and after are exactly what arbitratePlan returns — this layer never computes a plan itself", () => {
  const goals = [ironman(), wedding()];
  const patch: GoalPatch = { op: "shift", goalId: "goal-wedding", byWeeks: 8 };
  const result = whatIf(goals, patch, { fromDate: FROM }, ATHLETE);

  assert.deepEqual(result.before, arbitratePlan(goals, FROM, result.toDate, ATHLETE));
  assert.deepEqual(result.after, arbitratePlan(applyGoalPatch(goals, patch), FROM, result.toDate, ATHLETE));
});

test("dropping a goal leaves the others exactly where they would be alone", () => {
  // The pin that matters most: if what-if ever drifts from the real engine,
  // it drifts here first. `remove` deactivates rather than splicing, so the
  // after-plan must be indistinguishable from arbitrating the reduced set.
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "remove", goalId: "goal-wedding" }, { fromDate: FROM }, ATHLETE);

  assert.deepEqual(result.after, arbitratePlan([ironman()], FROM, result.toDate, ATHLETE));
  for (const week of result.after.weeks) {
    assert.equal(week.goalPhases.find((p) => p.goalId === "goal-wedding"), undefined);
  }

  const delta = result.diff.goals.find((g) => g.goalId === "goal-wedding")!;
  assert.equal(delta.role, "removed");
  assert.deepEqual(delta.phases.after, []);
  assert.equal(delta.targetDate.after, null);
  assert.equal(delta.priority.after, null);
  assert.equal(delta.feasibility.after, null);
  assert.equal(result.diff.nutritionWeeks.after.deficit, 0);
  assert.ok(result.diff.nutritionWeeks.before.deficit > 0);
  assert.ok(result.diff.conflicts.disappeared.length > 0);
  assert.deepEqual(result.diff.conflicts.appeared, []);
  assert.ok(result.summary.includes("Dropping Wedding."));
});

/* ──────────────────────────────── purity ───────────────────────────────── */

test("nothing is mutated — not the goals, not the athlete, not a single Measured", () => {
  const goals = [ironman(), wedding()];
  const snapshot = JSON.parse(JSON.stringify(goals));
  const athleteSnapshot = JSON.parse(JSON.stringify(ATHLETE));
  const weightRef = ATHLETE.weightKg;
  deepFreeze(goals);
  deepFreeze(ATHLETE);

  assert.doesNotThrow(() => whatIf(goals, { op: "shift", goalId: "goal-ironman", byWeeks: -4 }, { fromDate: FROM }, ATHLETE));

  assert.deepEqual(JSON.parse(JSON.stringify(goals)), snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(ATHLETE)), athleteSnapshot);
  assert.equal(ATHLETE.weightKg, weightRef, "the Measured must be the same object, never replaced");
  assert.equal(ATHLETE.weightKg.verified, true);
  assert.equal(ATHLETE.weightKg.source, "scale, 14 Sep");
});

test("applyGoalPatch copies only the goal it touches", () => {
  const goals = [ironman(), wedding()];
  const patched = applyGoalPatch(goals, { op: "reprioritise", goalId: "goal-wedding", priority: 3 });

  assert.notEqual(patched, goals);
  assert.equal(patched.length, goals.length);
  assert.equal(patched[0], goals[0], "an untouched goal stays the same object");
  assert.notEqual(patched[1], goals[1], "the patched goal is a copy");
  assert.equal(goals[1]!.priority, 1, "the original is untouched");
  assert.equal(patched[1]!.priority, 3);
});

test("remove deactivates rather than splicing, so arbitrate's own active filter does the removing", () => {
  const goals = [ironman(), wedding()];
  const patched = applyGoalPatch(goals, { op: "remove", goalId: "goal-wedding" });
  assert.equal(patched.length, 2);
  assert.equal(patched[1]!.active, false);
  assert.equal(goals[1]!.active, true);
});

/* ────────────────────────────── the no-op ──────────────────────────────── */

test("a patch that changes nothing produces an empty diff and says so", () => {
  // One goal, so the priority weights cancel and the blend is unmoved. The
  // honest answer is "nothing", not a page of spans.
  const result = whatIf([ironman()], { op: "reprioritise", goalId: "goal-ironman", priority: 3 }, { fromDate: FROM }, ATHLETE);

  assert.equal(result.diff.changedWeekCount, 0);
  assert.deepEqual(result.diff.loadSpans, []);
  assert.deepEqual(result.diff.conflicts, { appeared: [], disappeared: [], changed: [] });
  assert.deepEqual(result.diff.goals[0]!.phaseChanges, []);
  assert.equal(result.diff.goals[0]!.role, "patched");
  assert.deepEqual(result.diff.nutritionWeeks.before, result.diff.nutritionWeeks.after);
  assert.deepEqual(result.summary, [
    "Making Ironman 70.3 priority 3 (it is priority 2 today).",
    "Nothing about the plan would change over this stretch.",
  ]);
});

test("reprioritising to the priority the goal already has is allowed and reads as no change", () => {
  const result = whatIf([ironman()], { op: "reprioritise", goalId: "goal-ironman", priority: 2 }, { fromDate: FROM }, ATHLETE);
  assert.equal(result.diff.changedWeekCount, 0);
  assert.ok(result.summary.includes("Nothing about the plan would change over this stretch."));
});

/* ─────────────────────────── conflicts move ────────────────────────────── */

test("moving the wedding clear of the Ironman's taper makes the conflict disappear", () => {
  const goals = [ironman(), wedding()];
  const before = whatIf(goals, { op: "shift", goalId: "goal-wedding", byWeeks: -20 }, { fromDate: FROM }, ATHLETE);

  assert.ok(before.before.conflicts.length >= 1, "the unpatched plan must actually have a tradeoff to remove");
  assert.deepEqual(before.after.conflicts, [], "with the cut finished before the race block, nothing pulls apart");
  assert.equal(before.diff.conflicts.disappeared.length, before.before.conflicts.length);
  assert.deepEqual(before.diff.conflicts.appeared, []);
  assert.deepEqual(before.diff.conflicts.changed, []);
  assert.ok(before.summary.some((line) => line.includes("disappears")));
});

test("reprioritising flips who a tradeoff resolves for, and says whose way it now goes", () => {
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "reprioritise", goalId: "goal-ironman", priority: 1 }, { fromDate: FROM }, ATHLETE);

  assert.ok(result.diff.conflicts.changed.length > 0);
  for (const { before, after } of result.diff.conflicts.changed) {
    assert.notEqual(before.resolution, after.resolution);
    assert.equal(after.resolution, "balanced", "equal priorities are weighted equally, not tie-broken");
  }
  assert.ok(result.summary.some((line) => line.includes("now goes an even split")));
  assert.ok(result.summary.some((line) => line.includes("Training load changes in")));
  // The Ironman's own ask (0.5x in the taper) now carries equal weight, so the
  // blend moves toward it.
  const taper = result.diff.weeks.find((w) => w.date === "2027-06-07")!;
  assert.ok(taper.load.after < taper.load.before);
});

/* ───────────────────────── phases and feasibility ──────────────────────── */

test("a bystander goal's timeline is reported as unchanged rather than omitted", () => {
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "shift", goalId: "goal-wedding", byWeeks: 8 }, { fromDate: FROM }, ATHLETE);

  const iron = result.diff.goals.find((g) => g.goalId === "goal-ironman")!;
  assert.equal(iron.role, "bystander");
  assert.deepEqual(iron.phaseChanges, []);
  assert.ok(iron.phases.before.length > 0);
  assert.deepEqual(iron.phases.before, iron.phases.after);

  const bride = result.diff.goals.find((g) => g.goalId === "goal-wedding")!;
  const cut = bride.phaseChanges.find((c) => c.phaseName === "cut")!;
  assert.equal(cut.weeksBefore, cut.weeksAfter, "the same kilos at the same safe rate take the same number of weeks");
  assert.equal(cut.startAfter, addDays(cut.startBefore!, 8 * 7));
  assert.ok(result.summary.some((line) => line.includes("Wedding's cut phase starts 8 weeks later")));
});

test("a race moved closer is told it has run out of runway, not that its taper simply starts earlier", () => {
  // The plausible-but-wrong case this feature exists for: the after-plan shows
  // a perfectly normal taper. The nine build weeks underneath it are gone.
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "shift", goalId: "goal-ironman", byWeeks: -35 }, { fromDate: FROM }, ATHLETE);

  const iron = result.diff.goals.find((g) => g.goalId === "goal-ironman")!;
  assert.equal(iron.feasibility.before.adequate, true);
  assert.equal(iron.feasibility.after!.adequate, false);
  assert.equal(iron.feasibility.after!.basis, "race_runway");

  const build = iron.feasibility.after!.phaseNeeds.find((p) => p.phaseName === "build")!;
  assert.equal(build.weeksNeeded, 9);
  assert.equal(build.weeksAvailable, 2);
  // The taper still fits in full, which is exactly why the week would look fine.
  const taper = iron.feasibility.after!.phaseNeeds.find((p) => p.phaseName === "taper")!;
  assert.equal(taper.weeksAvailable, taper.weeksNeeded);
  assert.ok(result.summary.some((line) => line.includes("would not have the runway")));
});

test("a cut squeezed into fewer weeks is flagged as unsafe even though the phase still appears", () => {
  const cutGoal = wedding({ targetDate: "2026-10-27", targetMetrics: { targetWeightKg: 79 } });
  const result = whatIf([cutGoal], { op: "shift", goalId: "goal-wedding", byWeeks: -2 }, { fromDate: FROM }, ATHLETE);

  const bride = result.diff.goals[0]!;
  assert.equal(bride.feasibility.before.adequate, true);
  assert.equal(bride.feasibility.after!.adequate, false);
  assert.equal(bride.feasibility.after!.basis, "body_composition");
  // The `cut` phase is still right there in the after-plan.
  assert.ok(result.after.weeks.some((w) => w.goalPhases.some((p) => p.phaseName === "cut")));
  assert.ok(result.summary.some((line) => /would need .* kg a week — above the .* kg a week/.test(line)));
});

test("the phase shape is read out of goalPhase, not restated — a strength goal reports its own shape", () => {
  const lift = goal({ id: "goal-lift", label: "Back squat 140", type: "strength", discipline: "other", targetDate: "2027-06-01" });
  const feasibility = feasibilityOf(lift, ATHLETE, FROM);
  assert.equal(feasibility.basis, "race_runway");
  // A strength goal peaks and accumulates; it has no taper and no build, and
  // this is read out of phaseForGoal rather than listed here.
  assert.deepEqual(feasibility.phaseNeeds.map((p) => p.phaseName), ["peak"]);
  assert.equal(feasibility.adequate, true);

  // Ten months out, the race's whole shape fits; four weeks out it does not,
  // and the difference is the peak block it can no longer run.
  const squeezed = feasibilityOf(goal({ ...lift, targetDate: "2026-10-05" }), ATHLETE, FROM);
  assert.equal(squeezed.adequate, false);

  // A general-fitness goal has no shaped block at all, so nothing can be short.
  const general = goal({ id: "goal-gen", label: "Stay fit", type: "general_fitness", discipline: "other" });
  assert.deepEqual(feasibilityOf(general, ATHLETE, FROM).phaseNeeds, []);
  assert.equal(feasibilityOf(general, ATHLETE, FROM).adequate, true);
});

/* ───────────────────────── the past-goal archetype ─────────────────────── */

test("a goal shifted behind the start of the plan counts for nothing, and is said to", () => {
  // Phase 3's bug, re-pinned one layer up: a dead goal that still blends its
  // neutral 1.0x into a taper.
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "shift", goalId: "goal-wedding", byWeeks: -52 }, { fromDate: FROM }, ATHLETE);

  const firstWeek = result.after.weeks[0]!;
  const ironPhase = firstWeek.goalPhases.find((p) => p.goalId === "goal-ironman")!;
  assert.equal(firstWeek.loadMultiplier, ironPhase.loadMultiplier, "the only live goal's own ask, unblended");
  assert.equal(firstWeek.conflicts.length, 0);
  assert.deepEqual(result.after.conflicts, []);

  for (const week of result.after.weeks) {
    const bride = week.goalPhases.find((p) => p.goalId === "goal-wedding");
    if (bride) assert.equal(bride.phaseName, "past");
  }
  const delta = result.diff.goals.find((g) => g.goalId === "goal-wedding")!;
  assert.equal(delta.phaseChanges.find((c) => c.phaseName === "past"), undefined, "'past' is a caveat, not a phase that gained weeks");
  assert.ok(result.caveats.some((c) => c.includes("is before this week")));
});

/* ──────────────────────────────── horizon ──────────────────────────────── */

test("the horizon is the union of both sides, so a race that slides later reads as moved not deleted", () => {
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "shift", goalId: "goal-ironman", byWeeks: 8 }, { fromDate: FROM }, ATHLETE);

  assert.ok(result.toDate >= "2027-08-10", `expected the horizon to reach the moved race, got ${result.toDate}`);
  const taper = result.diff.goals.find((g) => g.goalId === "goal-ironman")!.phaseChanges.find((c) => c.phaseName === "taper")!;
  assert.ok(taper.weeksAfter > 0, "the taper moved, it did not vanish");
  assert.equal(taper.startAfter, addDays(taper.startBefore!, 8 * 7));
});

test("an explicit horizon that cuts a moved goal off says so", () => {
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "shift", goalId: "goal-ironman", byWeeks: 8 }, { fromDate: FROM, toDate: "2027-06-15" }, ATHLETE);
  assert.equal(result.toDate, "2027-06-15");
  assert.ok(result.caveats.some((c) => c.includes("past the end of this comparison")));
});

test("the horizon is capped, so a goal typo'd three years out cannot produce a 500-week answer", () => {
  const far = goal({ id: "goal-far", label: "Far race", targetDate: "2029-09-14" });
  const result = whatIf([far], { op: "shift", goalId: "goal-far", byWeeks: 4 }, { fromDate: FROM }, ATHLETE);

  assert.equal(result.toDate, addDays(FROM, MAX_HORIZON_WEEKS * 7));
  assert.equal(result.before.weeks.length, MAX_HORIZON_WEEKS + 1);
  assert.ok(result.caveats.some((c) => c.includes(`${MAX_HORIZON_WEEKS} weeks`)));
});

test("resolveHorizon takes the later of the two sides and ignores inactive goals", () => {
  const goals = [ironman(), wedding({ active: false, targetDate: "2030-01-01" })];
  const { toDate, caveats } = resolveHorizon(goals, goals, FROM);
  assert.equal(toDate, "2027-06-15");
  assert.deepEqual(caveats, []);
});

/* ─────────────────────────── week alignment ────────────────────────────── */

test("every scenario keeps the two plans aligned week for week", () => {
  const goals = [ironman(), wedding()];
  const patches: GoalPatch[] = [
    { op: "shift", goalId: "goal-wedding", byWeeks: 8 },
    { op: "shift", goalId: "goal-ironman", byWeeks: -35 },
    { op: "reprioritise", goalId: "goal-ironman", priority: 1 },
    { op: "remove", goalId: "goal-wedding" },
  ];
  for (const patch of patches) {
    const result = whatIf(goals, patch, { fromDate: FROM }, ATHLETE);
    assert.equal(result.diff.weeks.length, result.before.weeks.length);
    assert.equal(result.diff.weeks.length, result.after.weeks.length);
    assert.equal(result.diff.weekCount, result.before.weeks.length);
    result.diff.weeks.forEach((w, i) => {
      assert.equal(w.date, result.before.weeks[i]!.date);
      assert.equal(w.date, result.after.weeks[i]!.date);
    });
  }
});

test("load spans merge contiguous weeks instead of listing every one", () => {
  const goals = [ironman(), wedding()];
  const result = whatIf(goals, { op: "remove", goalId: "goal-wedding" }, { fromDate: FROM }, ATHLETE);
  const changedWeeks = result.diff.weeks.filter((w) => w.load.before !== w.load.after).length;

  assert.ok(changedWeeks > 0);
  assert.ok(result.diff.loadSpans.length < changedWeeks, "spans must be fewer than the weeks they cover");
  assert.equal(result.diff.loadSpans.reduce((n, s) => n + s.weeks, 0), changedWeeks, "and must account for all of them");
  for (const span of result.diff.loadSpans) {
    assert.notEqual(span.before, span.after);
    assert.ok(span.from <= span.to);
  }
});

/* ──────────────────────────── determinism ──────────────────────────────── */

test("the same question twice gives the same answer", () => {
  const goals = [ironman(), wedding()];
  const patch: GoalPatch = { op: "shift", goalId: "goal-wedding", byWeeks: -20 };
  assert.deepEqual(whatIf(goals, patch, { fromDate: FROM }, ATHLETE), whatIf(goals, patch, { fromDate: FROM }, ATHLETE));
});

test("goal order in the input does not change the answer", () => {
  const patch: GoalPatch = { op: "reprioritise", goalId: "goal-ironman", priority: 1 };
  const a = whatIf([ironman(), wedding()], patch, { fromDate: FROM }, ATHLETE);
  const b = whatIf([wedding(), ironman()], patch, { fromDate: FROM }, ATHLETE);
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.diff.goals.map((g) => g.goalId), b.diff.goals.map((g) => g.goalId));
  assert.deepEqual(a.diff.loadSpans, b.diff.loadSpans);
});

/* ──────────────────────────── bad input ────────────────────────────────── */

test("an invalid patch is rejected, and the message names what is wrong", () => {
  const goals = [ironman(), wedding({ id: "goal-old", active: false })];
  const cases: Array<[unknown, RegExp]> = [
    [{ op: "shift", goalId: "goal-nope", byWeeks: 2 }, /goalId/],
    [{ op: "shift", goalId: "goal-old", byWeeks: 2 }, /not active/],
    [{ op: "shift", goalId: "goal-ironman", byWeeks: 0 }, /byWeeks/],
    [{ op: "shift", goalId: "goal-ironman", byWeeks: 1.5 }, /byWeeks/],
    [{ op: "shift", goalId: "goal-ironman", byWeeks: 53 }, /byWeeks/],
    [{ op: "shift", goalId: "goal-ironman", byWeeks: -53 }, /byWeeks/],
    [{ op: "shift", goalId: "goal-ironman", byWeeks: 5200 }, /byWeeks/],
    [{ op: "reprioritise", goalId: "goal-ironman", priority: 0 }, /priority/],
    [{ op: "reprioritise", goalId: "goal-ironman", priority: 2.5 }, /priority/],
    [{ op: "reprioritise", goalId: "goal-ironman", priority: 999 }, /priority/],
    [{ op: "delete", goalId: "goal-ironman" }, /op must be one of/],
    [{ op: "shift", byWeeks: 2 }, /goalId/],
    [null, /patch must be an object/],
    ["remove", /patch must be an object/],
    [[{ op: "remove", goalId: "goal-ironman" }], /patch must be an object/],
  ];
  for (const [patch, message] of cases) {
    assert.throws(
      () => applyGoalPatch(goals, patch as GoalPatch),
      (error: unknown) => error instanceof WhatIfPatchError && message.test((error as Error).message),
      `expected ${JSON.stringify(patch)} to be rejected with ${message}`,
    );
  }
});

test("an absurd date range is rejected before any plan is built", () => {
  const goals = [ironman()];
  const patch: GoalPatch = { op: "shift", goalId: "goal-ironman", byWeeks: 2 };
  assert.throws(() => whatIf(goals, patch, { fromDate: "16/09/2026" }, ATHLETE), WhatIfPatchError);
  assert.throws(() => whatIf(goals, patch, { fromDate: "2026-02-30" }, ATHLETE), WhatIfPatchError);
  assert.throws(() => whatIf(goals, patch, { fromDate: FROM, toDate: "nope" }, ATHLETE), WhatIfPatchError);
  assert.throws(() => whatIf(goals, patch, { fromDate: FROM, toDate: "2026-09-07" }, ATHLETE), /toDate must not be before/);
  assert.throws(() => whatIf(goals, patch, { fromDate: FROM, today: "2026-13-01" }, ATHLETE), WhatIfPatchError);
});

test("a goal whose stored target date is not a real date is refused rather than shifted into nonsense", () => {
  const broken = [ironman({ targetDate: "2027-02-30" })];
  assert.throws(() => applyGoalPatch(broken, { op: "shift", goalId: "goal-ironman", byWeeks: 2 }), /not a real date/);
});

/* ───────────────────── nothing machine-shaped reaches the athlete ──────── */

test("no summary line or caveat leaks an enum value or a goal id", () => {
  const goals = [ironman(), wedding()];
  const patches: GoalPatch[] = [
    { op: "shift", goalId: "goal-wedding", byWeeks: 8 },
    { op: "shift", goalId: "goal-wedding", byWeeks: -20 },
    { op: "shift", goalId: "goal-wedding", byWeeks: -52 },
    { op: "shift", goalId: "goal-ironman", byWeeks: -35 },
    { op: "shift", goalId: "goal-ironman", byWeeks: 8 },
    { op: "reprioritise", goalId: "goal-ironman", priority: 1 },
    { op: "reprioritise", goalId: "goal-wedding", priority: 4 },
    { op: "remove", goalId: "goal-wedding" },
    { op: "remove", goalId: "goal-ironman" },
  ];

  /*
   * Phase NAMES (base, build, peak, taper, cut) are deliberately absent from
   * this list: they are what a coach calls those blocks, they are already in
   * arbitrate's own conflict descriptions, and they are the words that make
   * "your build phase loses seven weeks" mean anything. Everything below is
   * a value that exists for code.
   */
  const forbiddenWords = [
    ...WHAT_IF_OPS,
    ...GOAL_ROLES,
    ...FEASIBILITY_BASES,
    "surplus",
    "maintenance",
    "deficit",
    "goal_a_priority",
    "goal_b_priority",
    "balanced",
    "endurance_race",
    "body_composition",
    "general_fitness",
    "hyrox",
    "loadMultiplier",
    "nutritionStance",
    "phaseName",
    "targetDate",
    "byWeeks",
    ...DISCIPLINES.filter((d) => d !== "other" && d !== "run"),
  ];
  const forbiddenIds = goals.map((g) => g.id);

  for (const patch of patches) {
    const result = whatIf(goals, patch, { fromDate: FROM }, ATHLETE);
    for (const line of [...result.summary, ...result.caveats]) {
      for (const word of forbiddenWords) {
        assert.ok(
          !new RegExp(`\\b${word}\\b`, "i").test(line),
          `"${word}" reached the athlete in: ${line}`,
        );
      }
      for (const id of forbiddenIds) {
        assert.ok(!line.includes(id), `goal id "${id}" reached the athlete in: ${line}`);
      }
    }
    assert.ok(result.summary.length >= 2, "there is always a headline and at least one finding");
    for (const line of result.summary) {
      assert.ok(line.trim().length > 0 && line.endsWith("."), `a summary line must be a sentence: ${line}`);
    }
  }
});

test("every enum in this module has athlete-facing words", () => {
  for (const op of WHAT_IF_OPS) assert.ok(WHAT_IF_OP_LABELS[op].length > 0);
  for (const role of GOAL_ROLES) assert.ok(GOAL_ROLE_LABELS[role].length > 0);
  for (const basis of FEASIBILITY_BASES) assert.ok(FEASIBILITY_BASIS_LABELS[basis].length > 0);
  const words = [...Object.values(WHAT_IF_OP_LABELS), ...Object.values(GOAL_ROLE_LABELS), ...Object.values(FEASIBILITY_BASIS_LABELS)];
  for (const word of words) {
    assert.ok(!/_/.test(word), `"${word}" reads like an identifier, not like words`);
  }
});

/* ───────────────────────────── conditions ──────────────────────────────── */

test("conditions are passed straight through to both sides, so the comparison stays like-for-like", () => {
  const goals = [ironman(), wedding()];
  const strain: Condition[] = [
    {
      id: "c1",
      kind: "injury",
      label: "Left calf strain",
      bodyPart: "calf",
      severity: 3,
      restrictions: ["no_running"],
      openedAt: "2026-09-10",
      closedAt: null,
      note: null,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
  ];
  const patch: GoalPatch = { op: "remove", goalId: "goal-wedding" };
  const withCondition = whatIf(goals, patch, { fromDate: FROM, today: FROM }, ATHLETE, strain);
  const without = whatIf(goals, patch, { fromDate: FROM, today: FROM }, ATHLETE);

  // A severity-3 injury open today forces maintenance, so the first week the
  // cut would otherwise run must differ — which is what proves the parameter
  // actually reaches arbitrate rather than being quietly dropped here.
  const cutWeek = without.before.weeks.findIndex((w) => w.nutritionStance === "deficit");
  assert.ok(cutWeek >= 0, "the unpatched plan must have a deficit week to pause");
  assert.equal(withCondition.before.weeks[cutWeek]!.nutritionStance, "maintenance");
  assert.equal(withCondition.diff.nutritionWeeks.before.deficit, 0);

  // And it reaches both sides equally: the diff is about the patch, never
  // about the injury.
  assert.deepEqual(
    withCondition.before.weeks.map((w) => w.date),
    withCondition.after.weeks.map((w) => w.date),
  );
  assert.deepEqual(withCondition.after, without.after, "with the cut goal dropped, the injury changes nothing about what is left");
});
