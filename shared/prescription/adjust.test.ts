import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { addDays } from "../dates";
import type { Goal } from "../goal";
import { arbitrateWeek } from "../arbitration/arbitrate";
import { prescribeWeek } from "./prescribe";
import { KIND_MINUTES } from "./templates";
import type { PrescribedWeek } from "./sessionKinds";
import {
  ACWR_CEILING,
  ACWR_MIN_CHRONIC_WEEKLY_TSS,
  type AdjustedSession,
  type AthleteState,
  type LoggedLoad,
  type Modulator,
  type ModulatorSlot,
  MODULATORS,
  MODULATOR_STAGES,
  ADJUSTMENT_ACTION_LABELS,
  ADJUSTMENT_SOURCE_LABELS,
  adjustSession,
  adjustSessionAt,
  adjustWeek,
  chronicWeeklyLoad,
  deriveAdjustments,
  emptyAthleteState,
  enforceAcwrCeiling,
  projectedAcwr,
  registerModulator,
  restDay,
  sessionKey,
  type WorkingWeek,
} from "./adjust";

const MONDAY = "2026-09-14";

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: "race",
    type: "endurance_race",
    discipline: "run",
    label: "Marathon",
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

function prescribe(goals: Goal[] = [goal()], weekStart = MONDAY): PrescribedWeek {
  return prescribeWeek(arbitrateWeek(goals, weekStart, DEFAULT_ATHLETE), goals, DEFAULT_ATHLETE);
}

function state(over: Partial<AthleteState> = {}): AthleteState {
  return { ...emptyAthleteState(DEFAULT_ATHLETE), ...over };
}

/**
 * A logged history of one session every two days, each priced at `tss`.
 * Explicit `tss` so the fixture states the athlete's load rather than
 * depending on how a duration happens to price.
 */
function history(today: string, tss: number, days = 84): LoggedLoad[] {
  const rows: LoggedLoad[] = [];
  for (let back = 0; back <= days; back += 2) {
    rows.push({ date: addDays(today, -back), sport: "run", durationMinutes: 45, tss });
  }
  return rows;
}

/** One session every two days over 28 days is 14 sessions — 14 × 40 ÷ 4 weeks = 140 a week. */
const CHRONIC_TSS = 40;
const EXPECTED_CHRONIC = 140;

function only(stage: (typeof MODULATOR_STAGES)[number], run: Modulator): ModulatorSlot[] {
  return [{ stage, run }];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/*
 * ─── Invariant 4: nothing known, nothing changed ─────────────────────────
 */

test("an empty state is a byte-identical no-op", () => {
  const week = prescribe();
  const adjusted = adjustWeek(week, state(), MONDAY, { strict: true });

  assert.deepEqual(adjusted.sessions, week.sessions, "no state means no reason to touch a single session");
  assert.deepEqual(adjusted.adjustments, []);
  assert.deepEqual(adjusted.dropped, []);
  assert.equal(adjusted.totalMinutes, week.totalMinutes);
  assert.equal(adjusted.totalTss, week.totalTss);
  assert.equal(adjusted.phaseName, week.phaseName);
  assert.equal(adjusted.loadMultiplier, week.loadMultiplier);
  assert.deepEqual(adjusted.original, { totalMinutes: week.totalMinutes, totalTss: week.totalTss });
});

test("an empty week (no live goals) adjusts to an empty week rather than throwing", () => {
  const week = prescribe([goal({ targetDate: "2020-01-01" })]);
  const adjusted = adjustWeek(week, state(), MONDAY, { strict: true });
  assert.deepEqual(adjusted.sessions, []);
  assert.equal(adjusted.totalTss, 0);
});

test("the prescription and the state are never mutated", () => {
  const week = deepFreeze(prescribe());
  const athleteState = deepFreeze(
    state({ recentLoad: history(MONDAY, CHRONIC_TSS), params: DEFAULT_ATHLETE }),
  );

  const adjusted = adjustWeek(week, athleteState, MONDAY, { strict: true });

  assert.ok(adjusted.adjustments.length > 0, "this fixture is only meaningful if the layer actually changed something");
  assert.equal(week.totalTss, prescribe().totalTss, "the input week must come back out the way it went in");
});

/*
 * ─── Invariant 1: an answered session is history ─────────────────────────
 */

test("a modulator that rewrites an answered session has its whole step rolled back", () => {
  const week = prescribe();
  const target = week.sessions[0]!;
  const answered = state({ answeredKeys: [sessionKey(target)] });

  const vandal: Modulator = (w) => {
    w.sessions[0] = { ...w.sessions[0]!, durationMinutes: 5, tss: 1 };
    return w;
  };

  const problems: string[] = [];
  const adjusted = adjustWeek(week, answered, MONDAY, {
    modulators: only("conditions", vandal),
    onProblem: (m) => problems.push(m),
  });

  assert.deepEqual(adjusted.sessions, week.sessions, "the athlete already said what they did with this session");
  assert.equal(adjusted.adjustments.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /already answered/);
});

test("the same violation throws under strict, so a test can never miss it", () => {
  const week = prescribe();
  const answered = state({ answeredKeys: [sessionKey(week.sessions[0]!)] });
  const vandal: Modulator = (w) => {
    w.sessions.splice(0, 1);
    return w;
  };
  assert.throws(
    () => adjustWeek(week, answered, MONDAY, { strict: true, modulators: only("conditions", vandal) }),
    /already answered/,
  );
});

test("the mutators refuse an answered session themselves, and report that they did nothing", () => {
  const week = prescribe();
  const working: WorkingWeek = { ...week, sessions: [...week.sessions], dropped: [] };
  const answered = state({ answeredKeys: [sessionKey(week.sessions[0]!)] });

  const changed = adjustSessionAt(working, 0, { durationMinutes: 20 }, { reason: "x", source: "condition" }, answered);
  assert.equal(changed, false);
  assert.deepEqual(working.sessions[0], week.sessions[0]);
});

test("an answered session keeps its load even when the ceiling has to cut the week", () => {
  const week = prescribe();
  const answered = week.sessions.find((s) => s.kind === "run_long")!;
  const adjusted = adjustWeek(
    week,
    state({ answeredKeys: [sessionKey(answered)], recentLoad: history(MONDAY, CHRONIC_TSS) }),
    MONDAY,
    { strict: true },
  );

  const after = adjusted.sessions.find((s) => sessionKey(s) === sessionKey(answered))!;
  assert.deepEqual(after, answered, "the week is trimmed around it, never through it");
  assert.ok(adjusted.adjustments.length > 0, "the rest of the week still absorbs the cut");
});

/*
 * ─── Invariant 3: one completion key, one card ───────────────────────────
 */

test("two sessions sharing a completion key are caught: strict throws, production keeps the first", () => {
  const week = prescribe();
  const twin: Modulator = (w) => {
    w.sessions.push({ ...w.sessions[0]! });
    return w;
  };

  assert.throws(
    () => adjustWeek(week, state(), MONDAY, { strict: true, modulators: only("conditions", twin) }),
    /one completion key/,
  );

  const problems: string[] = [];
  const repaired = adjustWeek(week, state(), MONDAY, {
    modulators: only("conditions", twin),
    onProblem: (m) => problems.push(m),
  });
  assert.equal(repaired.sessions.length, week.sessions.length);
  assert.equal(new Set(repaired.sessions.map(sessionKey)).size, repaired.sessions.length);
  assert.equal(repaired.dropped.length, 1, "the unreachable card is kept where it can still be shown, not deleted");
  assert.match(problems[0]!, /one completion key/);
});

test("every session in an adjusted week has a unique key, drops and rest days included", () => {
  const week = prescribe();
  const rester: Modulator = (w, s) => {
    restDay(w, w.sessions[0]!.date, { reason: "Resting today.", source: "checkin" }, s);
    restDay(w, w.sessions[0]!.date, { reason: "Resting today.", source: "checkin" }, s);
    return w;
  };
  const adjusted = adjustWeek(week, state(), MONDAY, { strict: true, modulators: only("readiness", rester) });
  assert.equal(new Set(adjusted.sessions.map(sessionKey)).size, adjusted.sessions.length);
});

/*
 * ─── Invariant 2: one provenance chain, one derived changelog ────────────
 */

test("a second layer touching the same session appends a reason rather than overwriting who changed it", () => {
  const week = prescribe();
  const long = week.sessions.findIndex((s) => s.kind === "run_long");

  const first: Modulator = (w, s) => {
    adjustSessionAt(
      w,
      long,
      { kind: "bike_endurance", durationMinutes: 60 },
      { reason: "Your calf rules out running this week.", source: "condition", conditionId: "cond-1" },
      s,
    );
    return w;
  };
  const second: Modulator = (w, s) => {
    adjustSessionAt(w, long, { durationMinutes: 40 }, { reason: "You slept badly.", source: "checkin" }, s);
    return w;
  };

  const adjusted = adjustWeek(week, state(), MONDAY, {
    strict: true,
    modulators: [
      { stage: "conditions", run: first },
      { stage: "readiness", run: second },
    ],
  });

  const session = adjusted.sessions.find((s) => s.kind === "bike_endurance") as AdjustedSession;
  assert.deepEqual(session.adjustedFrom!.sources, ["condition", "checkin"]);
  assert.equal(session.adjustedFrom!.reasons.length, 2);
  assert.equal(session.adjustedFrom!.kind, "run_long", "the ORIGINAL kind survives both changes");

  const row = adjusted.adjustments.find((a) => a.originalKind === "run_long")!;
  assert.equal(row.action, "substituted", "run to bike is a swap, whatever happened to it afterwards");
  assert.equal(row.source, "checkin", "the source names who changed it last; the chain is on the session");
  assert.equal(row.conditionId, "cond-1");
  assert.equal(row.minutesAfter, 40);
  assert.ok(row.reason.includes("calf") && row.reason.includes("slept"), `both reasons survive: ${row.reason}`);
});

test("the changelog is derived from the sessions, so it cannot say something they do not", () => {
  const week = prescribe();
  const adjusted = adjustWeek(week, state({ recentLoad: history(MONDAY, CHRONIC_TSS) }), MONDAY, { strict: true });
  assert.deepEqual(adjusted.adjustments, deriveAdjustments(adjusted.sessions, adjusted.dropped));

  for (const row of adjusted.adjustments) {
    const session = adjusted.sessions.find((s) => s.date === row.date && s.kind === row.kind);
    assert.ok(session, `${row.date} has a changelog row and no session to match it`);
    assert.equal(session!.durationMinutes, row.minutesAfter);
    assert.equal(session!.adjustedFrom!.durationMinutes, row.minutesBefore);
  }
});

test("each action is derived from what actually happened to the session", () => {
  const week = prescribe();
  const idx = (kind: string) => week.sessions.findIndex((s) => s.kind === kind);
  const change = { reason: "Because." as string, source: "condition" as const };

  const mixed: Modulator = (w, s) => {
    adjustSessionAt(w, idx("run_long"), { kind: "bike_endurance" }, change, s); // sport changed
    adjustSessionAt(w, idx("run_threshold"), { kind: "run_easy" }, change, s); // same sport, less intensity
    adjustSessionAt(w, idx("run_easy"), { durationMinutes: 31 }, change, s); // just shorter
    return w;
  };
  const adjusted = adjustWeek(week, state(), MONDAY, { strict: true, modulators: only("conditions", mixed) });
  const byOriginal = new Map(adjusted.adjustments.map((a) => [a.originalKind, a.action]));

  assert.equal(byOriginal.get("run_long"), "substituted");
  assert.equal(byOriginal.get("run_threshold"), "capped");
  assert.equal(byOriginal.get("run_easy"), "shortened");
});

test("a dropped session is reported as rest at zero minutes, and stays tickable", () => {
  const week = prescribe();
  const day = week.sessions[0]!.date;
  const onThatDay = week.sessions.filter((s) => s.date === day).length;

  const rester: Modulator = (w, s) => {
    restDay(w, day, { reason: "A fever is not a training stimulus — today is rest.", source: "condition" }, s);
    return w;
  };
  const adjusted = adjustWeek(week, state(), MONDAY, { strict: true, modulators: only("conditions", rester) });

  assert.equal(adjusted.dropped.length, onThatDay);
  assert.ok(adjusted.sessions.some((s) => s.date === day && s.kind === "rest"), "the day says rest rather than going blank");

  const row = adjusted.adjustments.find((a) => a.date === day)!;
  assert.equal(row.action, "rested");
  assert.equal(row.kind, "rest");
  assert.equal(row.minutesAfter, 0);
  assert.ok(row.minutesBefore > 0);
  // B7: the athlete who trains anyway must still be able to record it.
  assert.ok(adjusted.dropped.every((s) => s.kind !== "rest" && s.durationMinutes > 0));
});

test("a rest day never overrides what the athlete has already recorded", () => {
  const week = prescribe();
  const done = week.sessions[0]!;
  const answered = state({ answeredKeys: [sessionKey(done)] });

  let removed = -1;
  const rester: Modulator = (w, s) => {
    removed = restDay(w, done.date, { reason: "Resting.", source: "condition" }, s);
    return w;
  };
  const adjusted = adjustWeek(week, answered, done.date, { strict: true, modulators: only("conditions", rester) });

  assert.equal(removed, 0, "there was nothing left on that day the app was allowed to take back");
  assert.deepEqual(adjusted.sessions, week.sessions, "what they already did stands, and no phantom rest card appears");
  assert.deepEqual(adjusted.dropped, []);
  assert.deepEqual(adjusted.adjustments, []);
});

test("a rebuilt session's targets are rebuilt with it, so the card cannot contradict its own duration", () => {
  const week = prescribe();
  const long = week.sessions.find((s) => s.kind === "run_long")!;
  const shorter = adjustSession(long, { durationMinutes: 55 }, { reason: "Half the week is gone.", source: "ramp" }, DEFAULT_ATHLETE);

  assert.equal(shorter.durationMinutes, 55);
  assert.ok(shorter.tss < long.tss, "a shorter session costs less; the price is rebuilt, not carried over");
  assert.ok(shorter.targets.some((t) => t.includes("55")), `targets should quote the new length: ${shorter.targets.join(" | ")}`);
  assert.equal(shorter.note, "Half the week is gone.", "the card says why it looks like this");
  assert.equal(long.durationMinutes, week.sessions.find((s) => s.kind === "run_long")!.durationMinutes, "the original is untouched");
});

/*
 * ─── DECISIONS B2: the pipeline, and why the guard is a different function ─
 */

test("the stage order is the one B2 requires, and an unregistered stage is simply skipped", () => {
  assert.deepEqual([...MODULATOR_STAGES], ["conditions", "readiness", "acwr", "conditions_guard"]);
  assert.deepEqual(MODULATORS.map((s) => s.stage), [...MODULATOR_STAGES]);
  assert.ok(MODULATORS.find((s) => s.stage === "acwr")!.run, "the load ceiling is always present");

  // The three slices that are not built here contribute nothing, and the
  // week still comes out.
  const week = prescribe();
  const adjusted = adjustWeek(week, state(), MONDAY, { strict: true });
  assert.deepEqual(adjusted.sessions, week.sessions);
});

test("a slice can register into its stage and is then run in that position", () => {
  const seen: string[] = [];
  const mark = (name: string): Modulator => (w) => {
    seen.push(name);
    return w;
  };
  registerModulator("conditions", mark("conditions"));
  registerModulator("conditions_guard", mark("guard"));
  try {
    adjustWeek(prescribe(), state(), MONDAY, { strict: true });
    assert.deepEqual(seen, ["conditions", "guard"]);
  } finally {
    registerModulator("conditions", null);
    registerModulator("conditions_guard", null);
  }
});

test("running the whole pipeline again over its own output adds ZERO adjustments", () => {
  // The real regression B2 is about: every step that is scheduled must be
  // safe to meet the week it already produced.
  const athleteState = state({ recentLoad: history(MONDAY, CHRONIC_TSS) });
  const week = prescribe();

  const once = adjustWeek(week, athleteState, MONDAY, { strict: true });
  assert.ok(once.adjustments.length > 0, "the fixture has to actually trigger something to be a regression test");

  const twice = adjustWeek(once, athleteState, MONDAY, { strict: true });
  assert.deepEqual(twice.adjustments, once.adjustments, "a second pass must not append a single new reason");
  assert.deepEqual(twice.sessions, once.sessions);
  assert.equal(twice.totalTss, once.totalTss);
});

test("the final guard stage, meeting the finished week, changes nothing", () => {
  // Stand-ins for the two real slices: a scaling one at the conditions
  // stage, and a guard that only applies an idempotent predicate on the
  // session's CURRENT kind. That difference is the whole of B2.
  const scaler: Modulator = (w, s) => {
    for (let i = 0; i < w.sessions.length; i++) {
      const session = w.sessions[i]!;
      if (session.kind === "rest") continue;
      adjustSessionAt(
        w,
        i,
        { durationMinutes: Math.round(session.durationMinutes * 0.85) },
        { reason: "An open injury takes 15% off every session this week.", source: "condition" },
        s,
      );
    }
    return w;
  };
  const guard: Modulator = (w, s) => {
    for (let i = 0; i < w.sessions.length; i++) {
      const session = w.sessions[i]!;
      if (session.kind !== "run_long") continue; // predicate on the CURRENT kind
      adjustSessionAt(w, i, { kind: "bike_endurance" }, { reason: "Running is out while the calf settles.", source: "condition" }, s);
    }
    return w;
  };

  const pipeline: ModulatorSlot[] = [
    { stage: "conditions", run: scaler },
    { stage: "acwr", run: enforceAcwrCeiling },
    { stage: "conditions_guard", run: guard },
  ];
  const once = adjustWeek(prescribe(), state(), MONDAY, { strict: true, modulators: pipeline });

  const guardOnly = adjustWeek(once, state(), MONDAY, {
    strict: true,
    modulators: [{ stage: "conditions_guard", run: guard }],
  });
  assert.deepEqual(guardOnly.sessions, once.sessions, "the guard has nothing left to do — it is a predicate, not a scale");
  assert.deepEqual(guardOnly.adjustments, once.adjustments);
});

test("a scaling step compounds if it is run twice — which is why the guard is a DIFFERENT function", () => {
  const scaler: Modulator = (w, s) => {
    for (let i = 0; i < w.sessions.length; i++) {
      const session = w.sessions[i]!;
      if (session.kind === "rest") continue;
      adjustSessionAt(w, i, { durationMinutes: Math.round(session.durationMinutes * 0.85) }, { reason: "15% off.", source: "condition" }, s);
    }
    return w;
  };
  const week = prescribe();
  const once = adjustWeek(week, state(), MONDAY, { strict: true, modulators: only("conditions", scaler) });
  const twice = adjustWeek(once, state(), MONDAY, { strict: true, modulators: only("conditions", scaler) });

  assert.ok(
    twice.totalMinutes < once.totalMinutes,
    "0.85 × 0.85 = 0.72: scheduling the full conditions rules twice would quietly shrink an ill athlete's week again",
  );
  assert.equal(twice.adjustments[0]!.reason.split("15% off.").length - 1, 2, "and the second cut would be blamed on the first reason");
});

/*
 * ─── The weekly load ceiling ─────────────────────────────────────────────
 */

test("the chronic baseline is the athlete's own four-week average, out of the engine that already computes it", () => {
  assert.equal(chronicWeeklyLoad(state({ recentLoad: history(MONDAY, CHRONIC_TSS) }), MONDAY), EXPECTED_CHRONIC);
  assert.equal(projectedAcwr(EXPECTED_CHRONIC * 2, EXPECTED_CHRONIC), 2);
  assert.equal(projectedAcwr(200, null), null, "no baseline means no opinion, never a made-up ratio");
});

test("no history, or too little of it, means the ceiling says nothing at all", () => {
  assert.equal(chronicWeeklyLoad(state(), MONDAY), null);
  assert.equal(chronicWeeklyLoad(state({ recentLoad: history(MONDAY, CHRONIC_TSS, 14) }), MONDAY), null, "under four weeks there is no four-week average");

  // An athlete who trains without a watch looks detrained to this step.
  // Cutting a real week against a phantom baseline would be worse than not
  // cutting it, so below the floor the step stands down.
  const sparse = state({ recentLoad: history(MONDAY, 5) });
  assert.ok(5 * 14 / 4 < ACWR_MIN_CHRONIC_WEEKLY_TSS);
  assert.equal(chronicWeeklyLoad(sparse, MONDAY), null);

  const week = prescribe();
  assert.deepEqual(adjustWeek(week, sparse, MONDAY, { strict: true }).sessions, week.sessions);
});

test("a spike is clamped to 1.3x the athlete's own recent normal, and says so in real numbers", () => {
  const week = prescribe();
  const athleteState = state({ recentLoad: history(MONDAY, CHRONIC_TSS) });
  const allowed = EXPECTED_CHRONIC * ACWR_CEILING;
  assert.ok(week.totalTss > allowed, `the fixture must actually be a spike: ${week.totalTss} vs ${allowed}`);

  const adjusted = adjustWeek(week, athleteState, MONDAY, { strict: true });

  assert.ok(adjusted.totalTss <= allowed, `clamped week ${adjusted.totalTss} must sit under ${allowed}`);
  assert.ok(adjusted.totalTss > allowed * 0.9, "and it must not overshoot into an accidental rest week");
  assert.equal(adjusted.original.totalTss, week.totalTss);
  assert.equal(adjusted.sessions.length, week.sessions.length, "nothing is dropped — the week keeps its shape");
  assert.equal(adjusted.dropped.length, 0);

  const row = adjusted.adjustments[0]!;
  assert.equal(row.source, "acwr");
  assert.equal(row.action, "shortened");
  assert.ok(row.minutesAfter < row.minutesBefore);
  assert.ok(row.reason.includes(String(row.minutesBefore)) && row.reason.includes(String(row.minutesAfter)), `per-session numbers: ${row.reason}`);
  assert.ok(row.reason.includes(String(Math.round(week.totalTss))), `the week's planned load: ${row.reason}`);
  assert.ok(row.reason.includes(String(EXPECTED_CHRONIC)), `the athlete's own average: ${row.reason}`);
  assert.ok(row.reason.includes(String(Math.round(adjusted.totalTss))), `and where the week landed: ${row.reason}`);
  assert.ok(!/acwr|run_long|tss/i.test(row.reason), `no enum or field names reach the athlete: ${row.reason}`);
});

test("the anchor survives the clamp and is still the week's biggest session", () => {
  const week = prescribe();
  const longBefore = week.sessions.find((s) => s.kind === "run_long")!;
  const adjusted = adjustWeek(week, state({ recentLoad: history(MONDAY, CHRONIC_TSS) }), MONDAY, { strict: true });

  const longAfter = adjusted.sessions.find((s) => s.kind === "run_long");
  assert.ok(longAfter, "the long run is never dropped, however hard the week has to be cut");
  assert.ok(longAfter!.durationMinutes < longBefore.durationMinutes, "it takes its share of the cut");
  for (const session of adjusted.sessions) {
    if (session.kind === "run_long" || session.sport === "strength") continue;
    assert.ok(longAfter!.durationMinutes >= session.durationMinutes, `${session.kind} outgrew the long run`);
  }
});

test("no session is ever cut below what that kind of session is worth doing", () => {
  const week = prescribe();
  // A brutal baseline: the ceiling cannot be reached without hitting floors.
  const adjusted = adjustWeek(week, state({ recentLoad: history(MONDAY, 30) }), MONDAY, { strict: true });
  for (const session of adjusted.sessions) {
    assert.ok(
      session.durationMinutes >= KIND_MINUTES[session.kind].min,
      `${session.kind} cut to ${session.durationMinutes}, below its floor of ${KIND_MINUTES[session.kind].min}`,
    );
  }
  assert.equal(adjusted.sessions.length, week.sessions.length, "a floor is reached by shortening, never by deleting");
});

test("totals are recomputed from the sessions that are actually there", () => {
  const adjusted = adjustWeek(prescribe(), state({ recentLoad: history(MONDAY, CHRONIC_TSS) }), MONDAY, { strict: true });
  assert.equal(adjusted.totalMinutes, adjusted.sessions.reduce((n, s) => n + s.durationMinutes, 0));
  assert.equal(adjusted.totalTss, adjusted.sessions.reduce((n, s) => n + s.tss, 0));
});

test("a week already lived is not rewritten: only days from today forward can be cut", () => {
  const lastWeek = prescribe([goal()], addDays(MONDAY, -7));
  const adjusted = adjustWeek(lastWeek, state({ recentLoad: history(MONDAY, CHRONIC_TSS) }), MONDAY, { strict: true });
  assert.deepEqual(adjusted.sessions, lastWeek.sessions, "the athlete already trained these days; there is nothing to clamp");
  assert.deepEqual(adjusted.adjustments, []);
});

test("mid-week, the days already behind the athlete keep their load and the rest absorb the cut", () => {
  const week = prescribe();
  const today = addDays(MONDAY, 3);
  const before = week.sessions.filter((s) => s.date < today);
  assert.ok(before.length > 0, "this fixture needs sessions earlier in the week");

  const adjusted = adjustWeek(week, state({ recentLoad: history(today, CHRONIC_TSS) }), today, { strict: true });
  for (const past of before) {
    assert.deepEqual(adjusted.sessions.find((s) => sessionKey(s) === sessionKey(past)), past);
  }
  assert.ok(adjusted.adjustments.every((a) => a.date >= today));
});

/*
 * ─── Words, not enum values (DECISIONS C7) ───────────────────────────────
 */

test("every action and every source has athlete-facing words", () => {
  for (const [value, label] of Object.entries(ADJUSTMENT_ACTION_LABELS)) {
    assert.ok(label.length > 0 && !label.includes(value), `${value} needs words, not its own name`);
  }
  for (const [value, label] of Object.entries(ADJUSTMENT_SOURCE_LABELS)) {
    assert.ok(label.length > 0 && !label.includes(value), `${value} needs words, not its own name`);
  }
});
