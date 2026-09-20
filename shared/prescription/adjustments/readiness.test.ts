import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ATHLETE } from "../../athlete";
import { addDays } from "../../dates";
import type { Goal } from "../../goal";
import { arbitrateWeek } from "../../arbitration/arbitrate";
import { READINESS_BAND_VALUES, type CheckIn, computeReadiness, type Readiness } from "../../readiness";
import { SESSION_KINDS, type PrescribedWeek, type SessionKind, sessionCompletionKey } from "../sessionKinds";
import { buildSession, prescribeWeek } from "../prescribe";
import { KIND_MINUTES } from "../templates";
import {
  type AthleteState,
  type ModulatorSlot,
  adjustWeek,
  emptyAthleteState,
} from "../adjust";
import { SHARPNESS_MIN_MINUTES, SHARPNESS_SHORTEN_FACTOR, applyReadiness, readinessActsOn, reportedThisMorning } from "./readiness";

const MONDAY = "2026-09-14";
const TUESDAY = "2026-09-15";
const WEDNESDAY = "2026-09-16";
const THURSDAY = "2026-09-17";
const FRIDAY = "2026-09-18";
const SATURDAY = "2026-09-19";
const SUNDAY = "2026-09-20";

/** Only this slice, so every assertion is about readiness and not about the load ceiling. */
const PIPELINE: ModulatorSlot[] = [{ stage: "readiness", run: applyReadiness }];

/* ─── Fixtures ───────────────────────────────────────────────────────────── */

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

function prescribe(goals: Goal[]): PrescribedWeek {
  return prescribeWeek(arbitrateWeek(goals, MONDAY, DEFAULT_ATHLETE), goals, DEFAULT_ATHLETE);
}

/**
 * A hand-built week, for the date arithmetic the real prescriber cannot be
 * made to produce on demand (an empty tomorrow, two hard sessions on one
 * day, a Sunday). Every session still goes through `buildSession`, so the
 * fixtures are priced and targeted by exactly the code the app ships.
 */
function synth(phaseName: string, specs: Array<[SessionKind, string, number]>): PrescribedWeek {
  const sessions = specs.map(([kind, date, minutes]) =>
    buildSession(kind, date, minutes, DEFAULT_ATHLETE, ["race"], ["Marathon"]),
  );
  return {
    weekStart: MONDAY,
    sessions,
    totalMinutes: sessions.reduce((n, s) => n + s.durationMinutes, 0),
    totalTss: sessions.reduce((n, s) => n + s.tss, 0),
    loadMultiplier: 1,
    phaseName,
    note: "",
  };
}

/** `n` ordinary 3/3/3 mornings before `date` — enough of them that the athlete's own baseline exists. */
function priorMornings(date: string, n: number): CheckIn[] {
  return Array.from({ length: n }, (_, i) => ({
    date: addDays(date, -(i + 1)),
    sleepQuality: 3,
    soreness: 3,
    energy: 3,
  }));
}

const TAPS = {
  /** Self score 0, +12 normalisation → 12: a long way under this athlete's own normal. */
  veryLow: [1, 5, 1] as const,
  /** Self score 25, +12 → 37. */
  low: [2, 4, 2] as const,
  /** Self score 50, +12 → 62. */
  ready: [3, 3, 3] as const,
  /** Self score 100 → held at 100. */
  high: [5, 1, 5] as const,
};

function morning(
  date: string,
  taps: readonly [number, number, number],
  over: { override?: boolean; mornings?: number } = {},
): { checkIn: CheckIn; readiness: Readiness } {
  const checkIn: CheckIn = {
    date,
    sleepQuality: taps[0],
    soreness: taps[1],
    energy: taps[2],
    ...(over.override ? { trainAnywayOverride: true } : {}),
  };
  return { checkIn, readiness: computeReadiness(checkIn, priorMornings(date, over.mornings ?? 6)) };
}

function state(date: string, taps: readonly [number, number, number], over: { override?: boolean; mornings?: number; answered?: string[] } = {}): AthleteState {
  const { checkIn, readiness } = morning(date, taps, over);
  return { ...emptyAthleteState(DEFAULT_ATHLETE), checkIn, readiness, answeredKeys: over.answered ?? [] };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function run(week: PrescribedWeek, athleteState: AthleteState, today: string) {
  return adjustWeek(week, athleteState, today, { strict: true, modulators: PIPELINE });
}

function kindsOn(week: { sessions: { date: string; kind: SessionKind }[] }, date: string): SessionKind[] {
  return week.sessions.filter((s) => s.date === date).map((s) => s.kind).sort();
}

/* ─── The bands that must do nothing ─────────────────────────────────────── */

test("a ready morning changes nothing at all", () => {
  const week = prescribe([goal()]);
  const adjusted = run(week, state(TUESDAY, TAPS.ready), TUESDAY);
  assert.equal(adjusted.sessions.length, week.sessions.length);
  assert.deepEqual(adjusted.sessions, week.sessions);
  assert.deepEqual(adjusted.adjustments, []);
  assert.deepEqual(adjusted.dropped, []);
});

test("a high morning never adds a minute or a point of load", () => {
  const week = prescribe([goal()]);
  const adjusted = run(week, state(TUESDAY, TAPS.high), TUESDAY);
  assert.deepEqual(adjusted.sessions, week.sessions);
  assert.equal(adjusted.totalMinutes, week.totalMinutes);
  assert.equal(adjusted.totalTss, week.totalTss);
});

test("a morning that has not earned a baseline is flagged but never acts", () => {
  const { readiness } = morning(TUESDAY, TAPS.veryLow, { mornings: 4 });
  assert.equal(readiness.band, "very_low", "the score still says what it says on day one");
  assert.equal(readiness.acting, false, "…and is still not allowed to restructure a week");

  const week = prescribe([goal()]);
  const adjusted = run(week, state(TUESDAY, TAPS.veryLow, { mornings: 4 }), TUESDAY);
  assert.deepEqual(adjusted.sessions, week.sessions);
  assert.deepEqual(adjusted.adjustments, []);
});

test("train-anyway on the check-in stops the slice even when the readiness record forgot to say so", () => {
  const week = prescribe([goal()]);
  // The readiness is computed WITHOUT the override, so `acting` is true: this
  // pins the gate on the check-in record itself, not just on the derived flag.
  const base = state(TUESDAY, TAPS.veryLow);
  assert.equal(base.readiness!.acting, true);
  const overridden: AthleteState = { ...base, checkIn: { ...base.checkIn!, trainAnywayOverride: true } };

  assert.equal(readinessActsOn(overridden, TUESDAY), null);
  assert.deepEqual(run(week, overridden, TUESDAY).sessions, week.sessions);
});

test("train-anyway recorded on the readiness stops the slice too", () => {
  const week = prescribe([goal()]);
  const adjusted = run(week, state(TUESDAY, TAPS.veryLow, { override: true }), TUESDAY);
  assert.deepEqual(adjusted.sessions, week.sessions);
});

test("yesterday's morning is not today's", () => {
  const week = prescribe([goal()]);
  const stale = state(MONDAY, TAPS.veryLow);
  assert.equal(readinessActsOn(stale, TUESDAY), null);
  assert.deepEqual(run(week, stale, TUESDAY).sessions, week.sessions);
});

test("no check-in at all is a no-op", () => {
  const week = prescribe([goal()]);
  assert.deepEqual(run(week, emptyAthleteState(DEFAULT_ATHLETE), TUESDAY).sessions, week.sessions);
});

/* ─── DECISIONS B3: the phase gate ───────────────────────────────────────── */

test("B3 — in a taper a low morning shortens the hard session and never changes its kind", () => {
  // 70 minutes so there is real room above the floor for this kind; the
  // point of the test is the KIND, and the minutes prove it actually acted.
  const week = synth("taper", [
    ["run_threshold", TUESDAY, 70],
    ["run_easy", WEDNESDAY, 40],
  ]);
  const adjusted = run(week, state(TUESDAY, TAPS.low), TUESDAY);

  const hard = adjusted.sessions.find((s) => s.date === TUESDAY)!;
  assert.equal(hard.kind, "run_threshold", "race week keeps its sharpness — the kind is untouchable");
  assert.equal(hard.intensity, "hard");
  assert.equal(hard.durationMinutes, Math.round(70 * SHARPNESS_SHORTEN_FACTOR));
  assert.ok(hard.tss < week.sessions[0]!.tss, "shorter means less load, priced by the same function");

  assert.equal(adjusted.adjustments.length, 1);
  assert.equal(adjusted.adjustments[0]!.action, "shortened");
  assert.equal(adjusted.adjustments[0]!.originalKind, "run_threshold");
  assert.equal(adjusted.adjustments[0]!.minutesBefore, 70);
});

test("B3 — in a peak week the same rule holds, against a real prescription", () => {
  const week = prescribe([goal({ targetDate: "2026-10-01" })]);
  assert.equal(week.phaseName, "peak");
  const before = week.sessions.filter((s) => s.intensity === "hard").map((s) => s.kind);
  assert.ok(before.length > 0, "a peak week has hard work in it to protect");

  const adjusted = run(week, state(TUESDAY, TAPS.low), TUESDAY);
  const after = adjusted.sessions.filter((s) => s.date === TUESDAY).map((s) => s.kind);
  assert.deepEqual(after, kindsOn(week, TUESDAY), "no kind on today changed");
  assert.ok(adjusted.totalTss <= week.totalTss);
});

test("B3 — a taper blended with a cut is still a taper, and a loadMultiplier guard would have missed it", () => {
  const goals = [
    goal({ targetDate: "2026-09-20", priority: 1 }),
    goal({
      id: "cut",
      type: "body_composition",
      discipline: "other",
      label: "Wedding",
      targetDate: "2026-12-01",
      priority: 2,
      targetMetrics: { targetWeightKg: 72 },
    }),
  ];
  const week = prescribe(goals);

  assert.equal(week.phaseName, "taper", "the phase is carried, not inferred");
  assert.ok(week.loadMultiplier > 0.6, `the blend hid the taper behind ${week.loadMultiplier}`);

  const hardBefore = week.sessions.filter((s) => s.date === TUESDAY && s.intensity === "hard");
  assert.equal(hardBefore.length, 1);
  assert.ok(
    week.sessions.some((s) => s.date === WEDNESDAY),
    "tomorrow is occupied, so an ungated rule would have downgraded the kind",
  );

  const adjusted = run(week, state(TUESDAY, TAPS.low), TUESDAY);
  const hardAfter = adjusted.sessions.find((s) => s.date === TUESDAY && s.kind === hardBefore[0]!.kind);
  assert.ok(hardAfter, "the hard session kept its kind through a blended multiplier of " + week.loadMultiplier);
  assert.ok(!adjusted.sessions.some((s) => s.date === TUESDAY && s.kind === "run_easy" && s.adjustedFrom));
});

test("B3 — a low morning in a REAL taper week actually shortens the hard session", () => {
  /*
   * The defect this pins: `shortenedMinutes` ran its 70% cut back through
   * `clampKind`, which raises anything under `KIND_MINUTES[kind].min` to that
   * floor — and `PHASE_SHAPES.taper` has already sized every session in a
   * race week to exactly that floor. So `round(40 × 0.7) = 28` came back out
   * as 40, `shortenForSharpness` bailed on "no smaller than before", and
   * `applyLowBand`'s sharpness branch `continue`d with no fallback. A low
   * morning in taper produced ZERO adjustments: B3 was implemented and inert
   * in the one phase it exists for, and the check-in screen told the athlete
   * "nothing needed to change".
   *
   * It survived 568 green tests because every taper fixture in this file was
   * hand-built by `synth` at 70 minutes — a length no taper week produces.
   * So this test uses the real prescriber and asserts the minutes actually
   * move, and the two after it pin the boundary either side.
   */
  const week = prescribe([goal({ targetDate: SUNDAY })]);
  assert.equal(week.phaseName, "taper");
  const before = week.sessions.find((s) => s.date === TUESDAY && s.intensity === "hard")!;
  assert.ok(before, "the fixture must actually have hard work on today for this to mean anything");
  assert.equal(
    before.durationMinutes,
    KIND_MINUTES[before.kind].min,
    "…and it must sit at its kind floor, which is what a real taper week produces and what defeated the old clamp",
  );

  const adjusted = run(week, state(TUESDAY, TAPS.low), TUESDAY);

  assert.equal(adjusted.adjustments.length, 1, "a low morning in race week must do something, and say so");
  assert.equal(adjusted.adjustments[0]!.action, "shortened");
  const after = adjusted.sessions.find((s) => s.date === TUESDAY)!;
  assert.equal(after.kind, before.kind, "the kind is the one thing race week keeps");
  assert.equal(after.intensity, "hard");
  assert.ok(after.durationMinutes < before.durationMinutes, `minutes must really drop: ${before.durationMinutes} -> ${after.durationMinutes}`);
  assert.equal(after.durationMinutes, SHARPNESS_MIN_MINUTES + 3, "40 minutes at 70% is 28, and 28 is above the sharpness floor");
  assert.ok(after.tss < before.tss, "shorter means less load, priced by the same function");
});

test("B3 — the sharpness cut stops at its own floor, one case either side", () => {
  // Above the floor: 35 × 0.7 = 24.5 → 25, exactly SHARPNESS_MIN_MINUTES.
  const atFloor = run(
    synth("taper", [["run_intervals", TUESDAY, 35]]),
    state(TUESDAY, TAPS.low),
    TUESDAY,
  );
  assert.equal(atFloor.sessions[0]!.durationMinutes, SHARPNESS_MIN_MINUTES);
  assert.equal(atFloor.sessions[0]!.kind, "run_intervals");

  // AT the floor already: there is genuinely nothing honest left to take off,
  // so nothing is reported as a change. This is the no-op the old code
  // claimed to be — it just applied to every real taper week instead of to
  // the handful of sessions this short.
  const nothingLeft = run(
    synth("taper", [["run_intervals", TUESDAY, SHARPNESS_MIN_MINUTES]]),
    state(TUESDAY, TAPS.low),
    TUESDAY,
  );
  assert.deepEqual(nothingLeft.adjustments, [], "no change happened, so nothing is reported as one");
});

test("a shortened session outside race week is not told it is race week", () => {
  /*
   * `downgradeToday` falls back into `shortenForSharpness` whenever the easy
   * version of a kind already sits on today — which happens in an ordinary
   * base week in February. The sentence was hardcoded, so it told that
   * athlete "This is race week".
   */
  const week = synth("base", [
    ["run_intervals", THURSDAY, 50],
    ["run_easy", THURSDAY, 45],
    ["run_long", FRIDAY, 90],
  ]);
  const adjusted = run(week, state(THURSDAY, TAPS.low), THURSDAY);
  const shortened = adjusted.adjustments.find((a) => a.action === "shortened")!;
  assert.ok(shortened, "the collision forces a shorten rather than a downgrade");
  assert.ok(!/race week|start line|taper/i.test(shortened.reason), `a base week claimed to be race week: ${shortened.reason}`);
  assert.match(shortened.reason, /no easier version/, "and it says the true reason instead");

  // …while a genuine taper still says what it means.
  const taper = run(synth("taper", [["run_threshold", TUESDAY, 70]]), state(TUESDAY, TAPS.low), TUESDAY);
  assert.match(taper.adjustments[0]!.reason, /This is race week/);
});

/* ─── The low band outside taper and peak ────────────────────────────────── */

test("low in a base week with a free tomorrow moves the hard session, unchanged", () => {
  const week = synth("base", [
    ["run_intervals", THURSDAY, 50],
    ["run_long", SATURDAY, 100],
  ]);
  const adjusted = run(week, state(THURSDAY, TAPS.low), THURSDAY);

  assert.deepEqual(kindsOn(adjusted, THURSDAY), [], "today is clear");
  const moved = adjusted.sessions.find((s) => s.date === FRIDAY)!;
  assert.equal(moved.kind, "run_intervals", "the work is postponed, not diluted");
  assert.equal(moved.durationMinutes, 50);
  assert.equal(moved.tss, week.sessions[0]!.tss);
  assert.equal(moved.adjustedFrom!.date, THURSDAY);

  assert.equal(adjusted.adjustments.length, 1);
  assert.equal(adjusted.adjustments[0]!.action, "moved");
  assert.equal(adjusted.totalMinutes, week.totalMinutes, "moving a session adds no load to the week");
});

test("low with tomorrow occupied downgrades all the way to easy, not one step", () => {
  const week = synth("base", [
    ["run_intervals", THURSDAY, 50],
    ["run_easy", FRIDAY, 40],
  ]);
  const adjusted = run(week, state(THURSDAY, TAPS.low), THURSDAY);

  const today = adjusted.sessions.find((s) => s.date === THURSDAY)!;
  assert.equal(today.kind, "run_easy", "DOWNGRADE's single step would have left a threshold run here");
  assert.notEqual(today.kind, "run_threshold");
  assert.equal(today.intensity, "easy");
  assert.ok(today.tss < week.sessions[0]!.tss);
  assert.ok(today.targets.join(" ").length > 0, "re-materialised through buildSession, so it carries real easy-pace targets");
  assert.equal(adjusted.adjustments[0]!.action, "capped");
  assert.equal(adjusted.adjustments[0]!.originalKind, "run_intervals");
});

test("low will not move a hard session next to another hard day", () => {
  const week = synth("base", [
    ["run_threshold", TUESDAY, 60],
    ["run_intervals", THURSDAY, 50],
  ]);
  // Tomorrow (Wednesday) is free, but Thursday is hard — moving would stack them.
  const adjusted = run(week, state(TUESDAY, TAPS.low), TUESDAY);
  assert.deepEqual(kindsOn(adjusted, WEDNESDAY), [], "nothing landed on the free day");
  assert.equal(adjusted.sessions.find((s) => s.date === TUESDAY)!.kind, "run_easy");
  assert.equal(adjusted.sessions.find((s) => s.date === THURSDAY)!.kind, "run_intervals", "no other day is touched");
});

test("low on the last day of the week downgrades — nothing is ever placed outside the week", () => {
  const week = synth("base", [["run_threshold", SUNDAY, 60]]);
  const adjusted = run(week, state(SUNDAY, TAPS.low), SUNDAY);
  assert.equal(adjusted.sessions.length, 1);
  assert.equal(adjusted.sessions[0]!.date, SUNDAY);
  assert.equal(adjusted.sessions[0]!.kind, "run_easy");
  assert.ok(!adjusted.sessions.some((s) => s.date > addDays(MONDAY, 6)));
});

test("low leaves today's easy work alone — that is the session that most deserves to survive", () => {
  const week = synth("base", [
    ["run_easy", THURSDAY, 45],
    ["strength_lower", THURSDAY, 50],
  ]);
  const adjusted = run(week, state(THURSDAY, TAPS.low), THURSDAY);
  assert.deepEqual(adjusted.sessions, week.sessions);
  assert.deepEqual(adjusted.adjustments, []);
});

test("low never leaves a hard session on today, even when today holds two of them", () => {
  const week = synth("base", [
    ["run_threshold", THURSDAY, 60],
    ["run_intervals", THURSDAY, 50],
    ["run_long", SUNDAY, 100],
  ]);
  const adjusted = run(week, state(THURSDAY, TAPS.low), THURSDAY);
  assert.deepEqual(
    adjusted.sessions.filter((s) => s.date === THURSDAY && s.intensity === "hard"),
    [],
    "today is no longer a hard day by any route",
  );
  assert.ok(adjusted.totalTss <= week.totalTss);
});

test("a downgrade that would collide with a session already on today shortens instead", () => {
  const week = synth("base", [
    ["run_intervals", THURSDAY, 50],
    ["run_easy", THURSDAY, 45],
    ["run_long", FRIDAY, 90],
  ]);
  const adjusted = run(week, state(THURSDAY, TAPS.low), THURSDAY);

  const keys = adjusted.sessions.map((s) => sessionCompletionKey(s.date, s.kind));
  assert.equal(new Set(keys).size, keys.length, "two cards sharing a completion key means one can never be ticked");
  const hard = adjusted.sessions.find((s) => s.date === THURSDAY && s.kind === "run_intervals")!;
  assert.ok(hard.durationMinutes < 50, "it could not become an easy run, so it became a shorter hard one");
});

/* ─── very_low ───────────────────────────────────────────────────────────── */

test("very_low turns today into rest and leaves what was planned recoverable", () => {
  const week = synth("base", [
    ["run_threshold", TUESDAY, 60],
    ["strength_lower", TUESDAY, 50],
    ["run_long", SATURDAY, 100],
  ]);
  const adjusted = run(week, state(TUESDAY, TAPS.veryLow), TUESDAY);

  assert.deepEqual(kindsOn(adjusted, TUESDAY), ["rest"]);
  assert.equal(adjusted.sessions.find((s) => s.date === TUESDAY)!.tss, 0);

  // DECISIONS B7: still there, still tickable, still carrying why it moved.
  assert.equal(adjusted.dropped.length, 2);
  assert.deepEqual(adjusted.dropped.map((s) => s.kind).sort(), ["run_threshold", "strength_lower"]);
  for (const session of adjusted.dropped) {
    assert.equal(session.date, TUESDAY, "it keeps its date, so 'actually, I did this' writes the right completion");
    assert.ok(session.adjustedFrom, "and it carries the reason it was taken out");
    assert.ok(session.durationMinutes > 0, "a dropped session is not a zeroed one");
  }

  assert.equal(adjusted.sessions.find((s) => s.date === SATURDAY)!.kind, "run_long", "no other day is touched");
  assert.ok(adjusted.totalTss < week.totalTss);
});

test("very_low on a day with nothing planned changes nothing and throws nothing", () => {
  const week = synth("base", [["run_long", SATURDAY, 100]]);
  const adjusted = run(week, state(THURSDAY, TAPS.veryLow), THURSDAY);
  assert.deepEqual(adjusted.sessions, week.sessions);
  assert.deepEqual(adjusted.adjustments, []);
  assert.deepEqual(adjusted.dropped, []);
});

/* ─── Answered sessions ──────────────────────────────────────────────────── */

test("a ticked session is untouched by a very low morning, and stays on the day", () => {
  const week = synth("base", [
    ["run_threshold", TUESDAY, 60],
    ["run_easy", TUESDAY, 45],
  ]);
  const answered = [sessionCompletionKey(TUESDAY, "run_threshold")];
  const adjusted = run(week, state(TUESDAY, TAPS.veryLow, { answered }), TUESDAY);

  const kept = adjusted.sessions.find((s) => s.kind === "run_threshold")!;
  assert.deepEqual(kept, week.sessions[0], "history is history — the app does not get to rewrite what they did");
  assert.deepEqual(adjusted.dropped.map((s) => s.kind), ["run_easy"]);
});

test("a ticked hard session is neither moved nor downgraded by a low morning", () => {
  const week = synth("base", [["run_intervals", THURSDAY, 50]]);
  const answered = [sessionCompletionKey(THURSDAY, "run_intervals")];
  const adjusted = run(week, state(THURSDAY, TAPS.low, { answered }), THURSDAY);
  assert.deepEqual(adjusted.sessions, week.sessions);
  assert.deepEqual(adjusted.adjustments, []);
});

/* ─── Answered SLOTS, not just answered sessions ─────────────────────────── */

test("a downgrade will not land on a (date, kind) the athlete has already ticked off", () => {
  /*
   * The defect this pins: `kindTakenOn` asked `week.sessions` only. The week
   * is re-derived on every request, so a card the athlete answered may well
   * no longer be IN it — and the downgrade then minted the same completion
   * key a second time, re-attaching their old completion (and its snapshotted
   * numbers) to a session they never did.
   */
  const week = synth("base", [
    ["run_intervals", THURSDAY, 50],
    ["run_long", FRIDAY, 90], // tomorrow is occupied, so the move route is closed
  ]);
  const answered = [sessionCompletionKey(THURSDAY, "run_easy")];
  const adjusted = run(week, state(THURSDAY, TAPS.low, { answered }), THURSDAY);

  const today = adjusted.sessions.find((s) => s.date === THURSDAY)!;
  assert.equal(today.kind, "run_intervals", "the easy slot on today is spoken for, so it is shortened instead");
  assert.ok(today.durationMinutes < 50, "…and something really did happen");
  assert.equal(
    adjusted.sessions.filter((s) => sessionCompletionKey(s.date, s.kind) === answered[0]).length,
    0,
    "nothing may be served on a key the athlete has already answered",
  );
});

test("a day the athlete has already ticked something off on is not a free tomorrow", () => {
  // `canMoveToTomorrow` tested `week.sessions` for tomorrow only. Moving a
  // hard session onto a day they had already trained doubles that day — the
  // exact thing the free-tomorrow rule exists to prevent.
  const week = synth("base", [
    ["run_intervals", THURSDAY, 50],
    ["run_long", SATURDAY, 100],
  ]);
  const answered = [sessionCompletionKey(FRIDAY, "strength_lower")];
  const adjusted = run(week, state(THURSDAY, TAPS.low, { answered }), THURSDAY);

  assert.deepEqual(kindsOn(adjusted, FRIDAY), [], "nothing was stacked onto a day they had already trained");
  const today = adjusted.sessions.find((s) => s.date === THURSDAY)!;
  assert.equal(today.kind, "run_easy", "nowhere to move it to, so the intensity comes out instead");
});

/* ─── Properties ─────────────────────────────────────────────────────────── */

test("the slice never adds load, for any band on any fixture", () => {
  const weeks = [
    prescribe([goal()]),
    prescribe([goal({ targetDate: "2026-09-20" })]),
    prescribe([goal({ targetDate: "2026-10-01" })]),
    prescribe([goal({ targetDate: "2026-11-15" })]),
    synth("base", [["run_intervals", THURSDAY, 50], ["run_long", SATURDAY, 100]]),
    synth("taper", [["run_threshold", TUESDAY, 70]]),
  ];
  for (const week of weeks) {
    for (const band of READINESS_BAND_VALUES) {
      const taps = TAPS[band === "very_low" ? "veryLow" : band];
      for (const today of [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY]) {
        const adjusted = run(week, state(today, taps), today);
        assert.ok(
          adjusted.totalMinutes <= week.totalMinutes,
          `${band} on ${today} added minutes: ${adjusted.totalMinutes} > ${week.totalMinutes}`,
        );
        assert.ok(adjusted.totalTss <= week.totalTss, `${band} on ${today} added load`);
      }
    }
  }
});

test("neither the prescription nor the athlete's numbers are ever mutated", () => {
  const week = deepFreeze(synth("base", [["run_intervals", THURSDAY, 50]]));
  const athleteState = deepFreeze(state(THURSDAY, TAPS.low));
  assert.doesNotThrow(() => run(week, athleteState, THURSDAY));
  assert.equal(week.sessions[0]!.kind, "run_intervals");
  assert.equal(athleteState.params.runEasySecPerKm.verified, DEFAULT_ATHLETE.runEasySecPerKm.verified);
});

test("DECISIONS C7 — no reason the athlete reads contains an id, a kind or a band value", () => {
  const cases: Array<[PrescribedWeek, string, readonly [number, number, number]]> = [
    [synth("base", [["run_intervals", THURSDAY, 50], ["run_long", SATURDAY, 100]]), THURSDAY, TAPS.low],
    [synth("base", [["run_intervals", THURSDAY, 50], ["run_easy", FRIDAY, 40]]), THURSDAY, TAPS.low],
    [synth("taper", [["run_threshold", TUESDAY, 70]]), TUESDAY, TAPS.low],
    [synth("base", [["run_threshold", TUESDAY, 60], ["strength_lower", TUESDAY, 50]]), TUESDAY, TAPS.veryLow],
  ];
  let seen = 0;
  for (const [week, today, taps] of cases) {
    const adjusted = run(week, state(today, taps), today);
    const texts = [
      ...adjusted.adjustments.map((a) => a.reason),
      ...adjusted.sessions.map((s) => s.note),
      ...adjusted.dropped.flatMap((s) => s.adjustedFrom?.reasons ?? []),
    ];
    assert.ok(texts.length > 0);
    for (const text of texts) {
      // Only the identifier-shaped values: "rest" and "low" are also
      // ordinary English words, and label tables exist precisely so the
      // athlete can read those words without reading an id.
      for (const kind of SESSION_KINDS) {
        if (kind.includes("_")) assert.ok(!text.includes(kind), `"${kind}" leaked into: ${text}`);
      }
      for (const band of READINESS_BAND_VALUES) {
        if (band.includes("_")) assert.ok(!text.includes(band), `"${band}" leaked into: ${text}`);
      }
      assert.ok(!/[A-Za-z]_[A-Za-z]/.test(text), `an identifier leaked into: ${text}`);
      seen++;
    }
  }
  assert.ok(seen >= 8);
});

test("every reason reads back what the athlete actually reported", () => {
  const week = synth("base", [["run_intervals", THURSDAY, 50], ["run_easy", FRIDAY, 40]]);
  const adjusted = run(week, state(THURSDAY, TAPS.low), THURSDAY);
  const reason = adjusted.adjustments[0]!.reason;
  assert.match(reason, /You reported sleep poor, soreness sore and energy low this morning/);
  assert.match(reason, /37 out of 100/);
  assert.match(reason, /under par/);
});

test("the opener degrades honestly when the check-in row itself is missing", () => {
  const { readiness } = morning(THURSDAY, TAPS.low);
  const text = reportedThisMorning(readiness, null);
  assert.match(text, /This morning's check-in put you at 37 out of 100/);
  assert.ok(!text.includes("You reported sleep"));
});
