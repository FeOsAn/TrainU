import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../../athlete";
import { addDays } from "../../dates";
import type { Goal } from "../../goal";
import { arbitrateWeek } from "../../arbitration/arbitrate";
import {
  type Condition,
  RESTRICTIONS,
  type Restriction,
  SUBSTITUTE_LOAD_FACTOR,
  type Severity,
  isForbidden,
} from "../../conditions";
import { measured } from "../../measured";
import { buildSession, prescribeWeek } from "../prescribe";
import { SESSION_KINDS, type PrescribedWeek, type SessionKind, sessionCompletionKey } from "../sessionKinds";
import { INTENSITY_OF, KIND_MINUTES } from "../templates";
import {
  type AthleteState,
  type ModulatorSlot,
  adjustWeek,
  emptyAthleteState,
  modulatorFor,
} from "../adjust";
import {
  EQUIPMENT_FIX_LABELS,
  EQUIPMENT_LABELS,
  MIN_REDUCED_MINUTES,
  applyConditions,
  enforceConditions,
  reducedMinutes,
  substituteMinutes,
} from "./conditions";

const MONDAY = "2026-09-14";
const SUNDAY = "2026-09-20";

/*
 * Fixtures. The weeks below are REAL `prescribeWeek` output — the point of
 * this slice is what it does to the week an athlete is actually handed, and
 * a hand-written week would let a rule pass here and fail in the app. The
 * two synthetic weeks at the bottom exist only for the day-collision cases
 * the prescriber cannot currently produce, and they say so.
 */

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

function prescribe(over: Partial<Goal> = {}, daysPerWeek?: number): PrescribedWeek {
  const goals = [goal(over)];
  return prescribeWeek(arbitrateWeek(goals, MONDAY, DEFAULT_ATHLETE), goals, DEFAULT_ATHLETE, {
    ...(daysPerWeek ? { daysPerWeek } : {}),
  });
}

/** A base week: three easy runs, a threshold run and a long run, one per day. */
const BASE_WEEK = prescribe();
/** A build week, which is the one that carries two genuinely hard sessions plus a lift. */
const BUILD_WEEK = prescribe({ targetDate: "2026-12-06" }, 6);
/**
 * Race week. The week where every session is already near its kind's healthy
 * minimum, which is exactly where the substitution floor used to swallow the
 * severity dose whole and hand an injured athlete a BIGGER week than a
 * healthy one.
 */
const TAPER_WEEK = prescribe({ targetDate: "2026-09-20" });

function condition(over: Partial<Condition> = {}): Condition {
  return {
    id: "calf",
    kind: "injury",
    label: "Left calf strain",
    bodyPart: "calf",
    severity: 2,
    restrictions: ["no_running"],
    openedAt: "2026-09-01",
    closedAt: null,
    note: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: `${MONDAY}T00:00:00.000Z`,
    ...over,
  };
}

function illness(over: Partial<Condition> = {}): Condition {
  return condition({
    id: "bug",
    kind: "illness",
    label: "Head cold",
    bodyPart: null,
    severity: 1,
    restrictions: [],
    openedAt: "2026-09-12",
    ...over,
  });
}

function state(over: Partial<AthleteState> = {}): AthleteState {
  return { ...emptyAthleteState(DEFAULT_ATHLETE), available: { bike: true, swim: true }, ...over };
}

/** The pipeline this slice owns: its own two stages and nothing else, so a failure here is this slice's. */
const PAIR: ModulatorSlot[] = [
  { stage: "conditions", run: applyConditions },
  { stage: "conditions_guard", run: enforceConditions },
];
const GUARD_ONLY: ModulatorSlot[] = [{ stage: "conditions_guard", run: enforceConditions }];

function adjust(week: PrescribedWeek, s: AthleteState, today = MONDAY, modulators = PAIR) {
  return adjustWeek(week, s, today, { strict: true, modulators });
}

function kindsOn(week: { sessions: Array<{ date: string; kind: SessionKind }> }, date: string): SessionKind[] {
  return week.sessions.filter((s) => s.date === date).map((s) => s.kind).sort();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/*
 * ─── The no-op ────────────────────────────────────────────────────────────
 */

test("a healthy athlete's week comes back exactly as prescribed", () => {
  const out = adjust(BASE_WEEK, state());
  assert.deepEqual(out.sessions, BASE_WEEK.sessions);
  assert.deepEqual(out.adjustments, []);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.totalMinutes, BASE_WEEK.totalMinutes);
});

test("both stages register themselves into the pipeline on import", () => {
  assert.equal(modulatorFor("conditions"), applyConditions);
  assert.equal(modulatorFor("conditions_guard"), enforceConditions);
});

test("the prescription and the state are never mutated", () => {
  const frozenWeek = deepFreeze(structuredClone(BASE_WEEK));
  const frozenState = deepFreeze(state({ conditions: [condition()] }));
  const out = adjust(frozenWeek, frozenState);
  assert.ok(out.adjustments.length > 0);
  assert.deepEqual(frozenWeek.sessions, BASE_WEEK.sessions);
});

/*
 * ─── (a) Illness that means rest ──────────────────────────────────────────
 */

test("a fever rests the whole day, and every session on it stays visible and tickable", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [illness({ severity: 3 })] }));
  assert.ok(out.sessions.every((s) => s.kind === "rest"), "no training is prescribed with a fever");
  assert.equal(out.dropped.length, BASE_WEEK.sessions.length, "every prescribed session is kept as dropped, not deleted");
  assert.equal(out.totalTss, 0);
  for (const dropped of out.dropped) {
    assert.match(dropped.adjustedFrom!.reasons.join(" "), /fever/);
    assert.equal(dropped.adjustedFrom!.sources.at(-1), "condition");
  }
  const rested = out.adjustments.filter((a) => a.action === "rested");
  assert.equal(rested.length, BASE_WEEK.sessions.length);
  assert.ok(rested.every((a) => a.minutesAfter === 0 && a.conditionId === "bug"));
});

test("a fever does not rewrite a session the athlete already ticked off", () => {
  const monday = BASE_WEEK.sessions.find((s) => s.date === MONDAY)!;
  const out = adjust(
    BASE_WEEK,
    state({ conditions: [illness({ severity: 3 })], answeredKeys: [sessionCompletionKey(MONDAY, monday.kind)] }),
  );
  assert.deepEqual(out.sessions.find((s) => s.date === MONDAY), monday);
  assert.ok(out.dropped.every((d) => d.date !== MONDAY));
});

test("an illness that closed before the week starts rests nothing", () => {
  const out = adjust(
    BASE_WEEK,
    state({ conditions: [illness({ severity: 3, openedAt: "2026-08-01", closedAt: "2026-08-20" })] }),
  );
  assert.deepEqual(out.adjustments, []);
});

/*
 * ─── (b) A ruled-out kind ─────────────────────────────────────────────────
 */

/*
 * ─── What a substitute costs (defects 1 and 2) ────────────────────────────
 *
 * The table this slice is pinned to. A substitute carries the session's
 * VOLUME and then the severity dose. It does NOT carry a cross-sport energy
 * conversion: nothing the prescriber emits is priced by one, because
 * `buildSession` prices a planned session through `rpeTss`, which is
 * sport-blind. Sizing a ride off `SPORT_EQUIVALENCE` multiplied the week's
 * planned load, and `KIND_MINUTES.bike_endurance.min` (45) then clamped the
 * severity dose away entirely — so severity 1, 2 and 3 all produced the same
 * 45-minute ride, and a severity-3 injury in race week came out 40 minutes
 * LONGER than being healthy did.
 */

/** 40 minutes of easy running, substituted. Each severity, each kit combination. */
const SUBSTITUTE_TABLE: Array<{ severity: Severity; minutes: number }> = [
  { severity: 1, minutes: 40 },
  { severity: 2, minutes: 34 },
  { severity: 3, minutes: 28 },
];

test("a 40-minute easy run substitutes to exactly these lengths (defects 1 and 2)", () => {
  // 40 minutes sits deliberately UNDER bike_endurance's healthy floor of 45.
  // That is the boundary the old clamp swallowed the whole dose at, and every
  // existing fixture used the 93-minute long run, which sits above it — which
  // is why the suite was green.
  assert.ok(40 < KIND_MINUTES.bike_endurance.min, "the fixture must sit under the floor or it proves nothing");
  const week = synthetic([["run_easy", MONDAY, 40]]);
  const original = week.sessions[0]!;

  for (const { severity, minutes } of SUBSTITUTE_TABLE) {
    const withBike = adjust(week, state({ conditions: [condition({ severity })], available: { bike: true, swim: true } }));
    assert.equal(withBike.sessions[0]!.kind, "bike_endurance", `severity ${severity}`);
    assert.equal(withBike.sessions[0]!.durationMinutes, minutes, `severity ${severity}, with a bike`);
    assert.ok(withBike.sessions[0]!.tss <= original.tss, `severity ${severity} costs more than the run it replaced`);

    const poolOnly = adjust(week, state({ conditions: [condition({ severity })], available: { bike: false, swim: true } }));
    assert.equal(poolOnly.sessions[0]!.kind, "swim_technique", `severity ${severity}`);
    assert.equal(poolOnly.sessions[0]!.durationMinutes, minutes, `severity ${severity}, with only a pool`);
    assert.ok(poolOnly.sessions[0]!.tss <= original.tss, `severity ${severity} costs more than the run it replaced`);

    const neither = adjust(week, state({ conditions: [condition({ severity })], available: { bike: false, swim: false } }));
    assert.equal(neither.sessions[0]!.kind, "rest", `severity ${severity}`);
    assert.equal(neither.totalMinutes, 0, `severity ${severity}`);
  }

  // The severity dose is the ONLY thing that differentiates them, and it is
  // monotone. Before the fix these three were byte-identical 45-minute rides.
  const lengths = SUBSTITUTE_TABLE.map((row) => row.minutes);
  assert.deepEqual([...lengths].sort((a, b) => b - a), lengths, "a worse injury must ask for less");
  assert.equal(new Set(lengths).size, lengths.length);
});

test("a forbidden long run keeps the week's shape, and never outgrows the run it replaced", () => {
  const longRun = BASE_WEEK.sessions.find((s) => s.kind === "run_long")!;
  const out = adjust(BASE_WEEK, state({ conditions: [condition()] }));
  const ride = out.sessions.find((s) => s.date === longRun.date)!;

  assert.equal(ride.kind, "bike_endurance");
  assert.ok(
    ride.durationMinutes <= longRun.durationMinutes,
    `a substitute is never longer than the session it replaces: ${ride.durationMinutes} against ${longRun.durationMinutes}`,
  );
  assert.ok(ride.tss <= longRun.tss, `and never more expensive: ${ride.tss} against ${longRun.tss}`);
  assert.equal(ride.durationMinutes, substituteMinutes("bike_endurance", longRun.durationMinutes, SUBSTITUTE_LOAD_FACTOR[2]));
  // It is still the biggest thing in the week: substitution must not flatten
  // a week into five identical sessions with no shape.
  assert.ok(out.sessions.every((s) => s === ride || s.durationMinutes <= ride.durationMinutes));
  assert.equal(ride.adjustedFrom!.kind, "run_long");
  assert.equal(ride.adjustedFrom!.durationMinutes, longRun.durationMinutes);
  assert.match(ride.note, /Left calf strain/);
});

test("the worst injury band produces the smallest race week, not the biggest (defect 1)", () => {
  assert.equal(TAPER_WEEK.phaseName, "taper", "the fixture has to be race week or this proves nothing");
  let previousMinutes = Number.POSITIVE_INFINITY;
  let previousTss = Number.POSITIVE_INFINITY;
  for (const severity of [1, 2, 3] as const) {
    const out = adjust(TAPER_WEEK, state({ conditions: [condition({ severity })] }));
    assert.ok(
      out.totalMinutes <= TAPER_WEEK.totalMinutes,
      `severity ${severity}: ${out.totalMinutes} min against a healthy ${TAPER_WEEK.totalMinutes}`,
    );
    assert.ok(out.totalTss <= TAPER_WEEK.totalTss, `severity ${severity}: ${out.totalTss} TSS`);
    assert.ok(out.totalMinutes < previousMinutes, `severity ${severity} is not smaller than severity ${severity - 1}`);
    assert.ok(out.totalTss < previousTss, `severity ${severity} is not cheaper than severity ${severity - 1}`);
    previousMinutes = out.totalMinutes;
    previousTss = out.totalTss;

    // Not five identical sessions: the ride replacing the long run still
    // dominates, and the recovery run is still the smallest thing in the week.
    const fromLong = out.sessions.find((s) => s.adjustedFrom?.kind === "run_long")!;
    assert.ok(
      out.sessions.every((s) => s === fromLong || s.durationMinutes < fromLong.durationMinutes),
      `severity ${severity} lost the week's shape`,
    );
  }
});

test("the substitute is scaled by the worst open severity, and a niggle is not scaled at all", () => {
  const longRun = BASE_WEEK.sessions.find((s) => s.kind === "run_long")!;
  for (const severity of [1, 2, 3] as const) {
    const out = adjust(BASE_WEEK, state({ conditions: [condition({ severity })] }));
    const ride = out.sessions.find((s) => s.date === longRun.date)!;
    assert.equal(
      ride.durationMinutes,
      substituteMinutes("bike_endurance", longRun.durationMinutes, SUBSTITUTE_LOAD_FACTOR[severity]),
      `severity ${severity}`,
    );
  }
});

test("a ride priced off an untested FTP says so; a measured one does not", () => {
  const seeded = adjust(BASE_WEEK, state({ conditions: [condition()] }));
  assert.ok(seeded.adjustments.every((a) => /untested FTP/.test(a.reason)));

  const tested = {
    ...DEFAULT_ATHLETE,
    ftpWatts: measured(272, "20 min test, 3 Sep", "2026-09-03"),
  };
  const out = adjustWeek(
    BASE_WEEK,
    { ...state({ conditions: [condition()] }), params: tested },
    MONDAY,
    { strict: true, modulators: PAIR },
  );
  assert.ok(out.adjustments.every((a) => !/untested/.test(a.reason)));
});

test("with no bike and no pool the session becomes rest, and the reason says what to change", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition()], available: { bike: false, swim: false } }));
  assert.ok(out.sessions.every((s) => s.kind === "rest"));
  assert.equal(out.dropped.length, BASE_WEEK.sessions.length);
  const reason = out.adjustments[0]!.reason;
  assert.match(reason, new RegExp(EQUIPMENT_LABELS.bike));
  assert.match(reason, new RegExp(EQUIPMENT_LABELS.swim));
  assert.ok(reason.includes(EQUIPMENT_FIX_LABELS.bike), "names the box to tick for a bike");
  assert.ok(reason.includes(EQUIPMENT_FIX_LABELS.swim), "names the box to tick for a pool");
});

test("with only a pool, running becomes swimming rather than rest", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition()], available: { bike: false, swim: true } }));
  assert.ok(out.sessions.every((s) => s.kind === "swim_technique"));
  assert.ok(out.adjustments.every((a) => /untested swim threshold/.test(a.reason)));
});

test("a restriction that rules out every candidate too ends in an honest rest day", () => {
  // Legs and impact both out: the ride is ruled out as well, and the swim is
  // the only thing left — so with no pool there is genuinely nothing.
  const out = adjust(
    BASE_WEEK,
    state({
      conditions: [condition({ restrictions: ["no_running", "no_lower"] })],
      available: { bike: true, swim: false },
    }),
  );
  assert.ok(out.sessions.every((s) => s.kind === "rest"));
  assert.match(out.adjustments[0]!.reason, /Endurance ride is ruled out too/);
  assert.match(out.adjustments[0]!.reason, /needs a pool/);
});

test("the substitute never lands on a kind the day already holds", () => {
  // The prescriber does not currently put a run and a ride on one day, so
  // this week is built by hand — the rule it pins is the completion-key
  // invariant, which would otherwise make one of the two cards untickable.
  const week = synthetic([
    ["run_easy", MONDAY, 60],
    ["bike_endurance", MONDAY, 90],
  ]);
  const out = adjust(week, state({ conditions: [condition()] }));
  assert.deepEqual(kindsOn(out, MONDAY), ["bike_endurance", "swim_technique"]);
});

test("with the only alternative already on the day, the session rests rather than doubling up", () => {
  const week = synthetic([
    ["run_easy", MONDAY, 60],
    ["bike_endurance", MONDAY, 90],
  ]);
  const out = adjust(week, state({ conditions: [condition()], available: { bike: true, swim: false } }));
  assert.deepEqual(kindsOn(out, MONDAY), ["bike_endurance"]);
  assert.equal(out.dropped.length, 1);
  assert.match(out.dropped[0]!.adjustedFrom!.reasons.join(" "), /Endurance ride is already on that day/);
  // The ride that was legitimately there is untouched.
  assert.equal(out.sessions.find((s) => s.kind === "bike_endurance")!.durationMinutes, 90);
});

test("a restriction that rules out nothing in the week changes nothing", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition({ restrictions: ["no_upper"] })] }));
  assert.deepEqual(out.sessions, BASE_WEEK.sessions);
});

/*
 * ─── (c) Illness that still permits training — the B1 regression ──────────
 */

test("no session survives an open illness at hard intensity (DECISIONS B1)", () => {
  assert.ok(
    BUILD_WEEK.sessions.some((s) => INTENSITY_OF[s.kind] === "hard"),
    "the fixture has to contain hard sessions or this test proves nothing",
  );
  for (const severity of [1, 2] as const) {
    for (const week of [BASE_WEEK, BUILD_WEEK]) {
      const out = adjust(week, state({ conditions: [illness({ severity })] }));
      assert.ok(
        out.sessions.every((s) => s.intensity !== "hard"),
        `severity ${severity}: ${out.sessions.filter((s) => s.intensity === "hard").map((s) => s.kind).join(",")}`,
      );
      // And specifically not the one-step downgrade that started this rule:
      // intervals under an easy ceiling must not come out as a threshold run.
      assert.ok(out.sessions.every((s) => s.kind !== "run_threshold"));
    }
  }
});

test("an illness shortens what it leaves in, and says which illness and why", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [illness({ severity: 2 })] }));
  for (const session of out.sessions) {
    const before = BASE_WEEK.sessions.find((s) => s.date === session.date)!;
    assert.ok(session.durationMinutes < before.durationMinutes, session.date);
    assert.equal(session.durationMinutes, reducedMinutes(before.durationMinutes, 0.5));
    assert.match(session.note, /Head cold/);
    assert.match(session.note, /below the neck/);
  }
  assert.ok(out.totalTss < BASE_WEEK.totalTss);
});

test("a shortened session is rebuilt, so its targets match its new length", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [illness({ severity: 2 })] }));
  const easy = out.sessions.find((s) => s.kind === "run_easy")!;
  assert.ok(
    easy.targets.some((t) => t.includes(`${easy.durationMinutes} min`)),
    `targets ${JSON.stringify(easy.targets)} should carry ${easy.durationMinutes}`,
  );
});

test("an illness-shortened session may go under the kind's healthy minimum, but never under the floor", () => {
  const week = synthetic([["run_easy", MONDAY, KIND_MINUTES.run_easy.min]]);
  const out = adjust(week, state({ conditions: [illness({ severity: 2 })] }));
  const session = out.sessions[0]!;
  assert.ok(session.durationMinutes < KIND_MINUTES.run_easy.min);
  assert.ok(session.durationMinutes >= MIN_REDUCED_MINUTES);
  assert.equal(reducedMinutes(2, 0.1), MIN_REDUCED_MINUTES);
});

test("an injury outranks an illness for a session both have an opinion about", () => {
  const out = adjust(
    BASE_WEEK,
    state({ conditions: [condition({ severity: 2 }), illness({ severity: 2 })] }),
  );
  const long = out.sessions.find((s) => s.adjustedFrom?.kind === "run_long")!;
  assert.equal(long.kind, "bike_endurance", "the ruled-out kind is substituted, not merely shortened");
  assert.match(long.note, /Left calf strain/);
});

test("a downgrade onto a kind the day already holds takes the session out instead", () => {
  const week = synthetic([
    ["run_threshold", MONDAY, 60],
    ["run_easy", MONDAY, 50],
  ]);
  const out = adjust(week, state({ conditions: [illness({ severity: 1 })] }));
  assert.deepEqual(kindsOn(out, MONDAY), ["run_easy"]);
  assert.equal(out.sessions.length, 1);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]!.adjustedFrom!.kind, "run_threshold");
  assert.match(out.dropped[0]!.adjustedFrom!.reasons.join(" "), /already have that session/);
});

/*
 * ─── (d) The return-to-training ramp ──────────────────────────────────────
 */

test("a condition closed yesterday stops ruling sessions out, and only shapes the return", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition({ closedAt: "2026-09-13" })] }));
  assert.ok(out.sessions.every((s) => s.sport === "run"), "running is allowed again the day after it closed");
  assert.ok(out.adjustments.every((a) => a.source === "ramp"));
  assert.ok(out.sessions.every((s) => s.intensity !== "hard"));
});

test("the ramp's stages land on the right dates and then stop", () => {
  // Open 4 days (12th–15th) at severity 2: stage length is round(4 × 0.4 × 1.0) = 2 days.
  const healed = condition({ openedAt: "2026-09-12", closedAt: "2026-09-15", updatedAt: "2026-09-15T00:00:00.000Z" });
  const week = synthetic(
    ["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"].map(
      (date) => ["run_threshold", date, 60] as [SessionKind, string, number],
    ),
  );
  const out = adjust(week, state({ conditions: [healed] }), "2026-09-16");
  const byDate = new Map(out.sessions.map((s) => [s.date, s]));

  // Days 1–2 after it closed: easy only, all the way down.
  for (const date of ["2026-09-16", "2026-09-17"]) {
    assert.equal(byDate.get(date)!.kind, "run_easy", date);
    assert.equal(byDate.get(date)!.durationMinutes, reducedMinutes(60, 0.6), date);
    assert.match(byDate.get(date)!.note, /easy work only/);
  }
  // Days 3–4: steady work back, so the threshold run survives as itself.
  for (const date of ["2026-09-18", "2026-09-19"]) {
    assert.equal(byDate.get(date)!.kind, "run_threshold", date);
    assert.equal(byDate.get(date)!.durationMinutes, reducedMinutes(60, 0.8), date);
    assert.match(byDate.get(date)!.note, /nothing flat out/);
  }
  // Day 5: out of the ramp entirely.
  assert.deepEqual(byDate.get("2026-09-20"), week.sessions.find((s) => s.date === "2026-09-20"));
});

test("the ramp says when the next step up arrives", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition({ closedAt: "2026-09-13" })] }));
  assert.match(out.adjustments[0]!.reason, /Steady work comes back in \d+ days?\./);
  assert.match(out.adjustments[0]!.reason, /Day 1 back from Left calf strain/);
});

test("two returns running at once are held to the more careful of the two", () => {
  const gentle = condition({ id: "gentle", label: "Sore heel", severity: 1, openedAt: "2026-09-10", closedAt: "2026-09-13" });
  const bad = condition({ id: "bad", label: "Hamstring tear", severity: 3, openedAt: "2026-09-01", closedAt: "2026-09-13" });
  const out = adjust(BASE_WEEK, state({ conditions: [gentle, bad] }));
  const easy = out.sessions.find((s) => s.adjustedFrom?.kind === "run_easy")!;
  assert.match(easy.note, /Hamstring tear/);
  assert.equal(easy.durationMinutes, reducedMinutes(easy.adjustedFrom!.durationMinutes, 0.5));
});

test("a condition whose ramp is long finished changes nothing at all", () => {
  const out = adjust(
    BASE_WEEK,
    state({ conditions: [condition({ openedAt: "2026-05-01", closedAt: "2026-06-01" })] }),
  );
  assert.deepEqual(out.sessions, BASE_WEEK.sessions);
  assert.deepEqual(out.adjustments, []);
});

test("a condition nobody has touched for four weeks stops steering the week", () => {
  const stale = condition({ updatedAt: "2026-08-01T00:00:00.000Z" });
  assert.ok(adjust(BASE_WEEK, state({ conditions: [stale] }), MONDAY).adjustments.length === 0);
  // The same condition, touched yesterday, still acts.
  const fresh = condition({ updatedAt: "2026-09-13T00:00:00.000Z" });
  assert.ok(adjust(BASE_WEEK, state({ conditions: [fresh] }), MONDAY).adjustments.length > 0);
});

/*
 * ─── Per-date, not per-today ──────────────────────────────────────────────
 */

test("each day is judged against the conditions that were open on that day", () => {
  // Open from Wednesday, healed on Thursday: Monday and Tuesday are
  // untouched, Wednesday and Thursday are substituted, and Friday onwards is
  // in the return ramp rather than still forbidden.
  const mid = condition({ openedAt: "2026-09-16", closedAt: "2026-09-17", updatedAt: "2026-09-17T00:00:00.000Z" });
  const week = synthetic(
    ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"].map(
      (date) => ["run_easy", date, 60] as [SessionKind, string, number],
    ),
  );
  const out = adjust(week, state({ conditions: [mid] }), MONDAY);
  const byDate = new Map(out.sessions.map((s) => [s.date, s]));
  assert.equal(byDate.get("2026-09-14")!.kind, "run_easy");
  assert.equal(byDate.get("2026-09-15")!.kind, "run_easy");
  assert.equal(byDate.get("2026-09-16")!.kind, "bike_endurance");
  assert.equal(byDate.get("2026-09-17")!.kind, "bike_endurance");
  assert.equal(byDate.get("2026-09-18")!.kind, "run_easy");
  assert.match(byDate.get("2026-09-18")!.note, /back from Left calf strain/);
});

/*
 * ─── The guard (DECISIONS B2) ─────────────────────────────────────────────
 */

test("the guard alone still refuses to prescribe a ruled-out kind", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition()] }), MONDAY, GUARD_ONLY);
  assert.ok(out.sessions.every((s) => !isForbidden(s.kind, ["no_running"])));
});

test("the guard does not dose: it swaps the kind minute for minute and stops there", () => {
  const longRun = BASE_WEEK.sessions.find((s) => s.kind === "run_long")!;
  const guarded = adjust(BASE_WEEK, state({ conditions: [condition()] }), MONDAY, GUARD_ONLY);
  const ride = guarded.sessions.find((s) => s.date === longRun.date)!;
  assert.equal(ride.durationMinutes, longRun.durationMinutes);
  const dosed = adjust(BASE_WEEK, state({ conditions: [condition()] }));
  assert.ok(dosed.sessions.find((s) => s.date === longRun.date)!.durationMinutes < ride.durationMinutes);
});

test("the guard leaves an illness's ceiling and dose alone — they are the once-only pass's job", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [illness({ severity: 2 })] }), MONDAY, GUARD_ONLY);
  assert.deepEqual(out.sessions, BASE_WEEK.sessions);
});

test("running the whole pair a second time over its own output adds nothing", () => {
  for (const conditions of [
    [condition()],
    [illness({ severity: 1 })],
    [illness({ severity: 2 })],
    [condition({ closedAt: "2026-09-13" })],
    [condition(), illness({ severity: 2 })],
  ]) {
    const s = state({ conditions });
    const once = adjust(BASE_WEEK, s);
    const twice = adjust(once, s);
    assert.deepEqual(twice.sessions, once.sessions, JSON.stringify(conditions.map((c) => c.id)));
    assert.deepEqual(twice.adjustments, once.adjustments);
    assert.equal(twice.totalMinutes, once.totalMinutes);
  }
});

test("a fever's rest week is also stable under a second pass", () => {
  const s = state({ conditions: [illness({ severity: 3 })] });
  const once = adjust(BASE_WEEK, s);
  const twice = adjust(once, s);
  assert.deepEqual(twice.sessions, once.sessions);
  assert.deepEqual(twice.adjustments, []);
});

/*
 * ─── What the athlete reads ───────────────────────────────────────────────
 */

test("no reason string leaks an identifier (DECISIONS C7)", () => {
  const scenarios = [
    state({ conditions: [condition()] }),
    state({ conditions: [condition()], available: { bike: false, swim: false } }),
    state({ conditions: [illness({ severity: 1 })] }),
    state({ conditions: [illness({ severity: 2 })] }),
    state({ conditions: [illness({ severity: 3 })] }),
    state({ conditions: [condition({ closedAt: "2026-09-13" })] }),
  ];
  // Every identifier that is not also an ordinary English word: "rest" is
  // both a session kind and what an athlete calls a day off, so banning the
  // string would ban the sentence.
  const banned = [...SESSION_KINDS.filter((k) => k.includes("_")), ...RESTRICTIONS, "severity", "restOnly", "loadFactor", "adjustedFrom"];
  for (const s of scenarios) {
    for (const week of [BASE_WEEK, BUILD_WEEK]) {
      const out = adjust(week, s);
      for (const row of out.adjustments) {
        for (const token of banned) {
          assert.ok(!row.reason.includes(token), `"${token}" in: ${row.reason}`);
        }
        assert.ok(/[.!]$/.test(row.reason.trim()), `not a sentence: ${row.reason}`);
        assert.ok(row.reason.length > 30);
      }
    }
  }
});

test("every recorded change is a change: no row says a session became itself", () => {
  for (const conditions of [
    [condition()],
    [illness({ severity: 1 })],
    [condition({ closedAt: "2026-09-13", severity: 1 })],
  ]) {
    for (const row of adjust(BUILD_WEEK, state({ conditions })).adjustments) {
      assert.ok(
        row.kind !== row.originalKind || row.minutesAfter !== row.minutesBefore,
        `${row.date} ${row.reason}`,
      );
    }
  }
});

test("a change carries the condition that caused it, so the card can link back to it", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition()] }));
  assert.ok(out.adjustments.every((a) => a.conditionId === "calf"));
  const ramped = adjust(BASE_WEEK, state({ conditions: [condition({ closedAt: "2026-09-13" })] }));
  assert.ok(ramped.adjustments.every((a) => a.conditionId === "calf" && a.source === "ramp"));
});

test("an answered session is immune to substitution as well as to rest", () => {
  const longRun = BASE_WEEK.sessions.find((s) => s.kind === "run_long")!;
  const out = adjust(
    BASE_WEEK,
    state({ conditions: [condition()], answeredKeys: [sessionCompletionKey(longRun.date, longRun.kind)] }),
  );
  assert.deepEqual(out.sessions.find((s) => s.date === longRun.date), longRun);
  assert.ok(out.adjustments.every((a) => a.date !== longRun.date));
});

test("the registered pipeline honours conditions without being handed them", () => {
  // Not `PAIR`: this goes through the layer's own MODULATORS list, which is
  // the arrangement the server will actually run.
  const out = adjustWeek(BASE_WEEK, state({ conditions: [illness({ severity: 3 })] }), MONDAY, { strict: true });
  assert.ok(out.sessions.every((s) => s.kind === "rest"));
  assert.equal(out.dropped.length, BASE_WEEK.sessions.length);
});

test("a lower-body injury swaps the lift for one that loads what still works", () => {
  const lift = BUILD_WEEK.sessions.find((s) => s.kind === "strength_lower")!;
  const out = adjust(
    BUILD_WEEK,
    state({ conditions: [condition({ restrictions: ["no_lower"], severity: 2 })], available: { bike: false, swim: false } }),
  );
  const swapped = out.sessions.find((s) => s.adjustedFrom?.kind === "strength_lower")!;
  assert.equal(swapped.kind, "strength_pull");
  assert.equal(swapped.date, lift.date);
  assert.equal(
    swapped.durationMinutes,
    substituteMinutes("strength_pull", lift.durationMinutes, SUBSTITUTE_LOAD_FACTOR[2]),
  );
});

test("an illness or a return ramp only ever takes load away", () => {
  for (const conditions of [
    [illness({ severity: 1 })],
    [illness({ severity: 2 })],
    [illness({ severity: 3 })],
    [condition({ closedAt: "2026-09-13" })],
    [condition({ closedAt: "2026-09-13", severity: 1 })],
  ]) {
    for (const week of [BASE_WEEK, BUILD_WEEK]) {
      const out = adjust(week, state({ conditions }));
      assert.ok(out.totalMinutes <= week.totalMinutes, JSON.stringify(conditions));
      assert.ok(out.totalTss <= week.totalTss, JSON.stringify(conditions));
    }
  }
});

test("a substituted session keeps serving every goal the original served", () => {
  const shared = buildSession("run_easy", MONDAY, 60, DEFAULT_ATHLETE, ["race", "wedding"], ["Marathon", "Wedding"]);
  const week: PrescribedWeek = {
    weekStart: MONDAY,
    sessions: [shared],
    totalMinutes: 60,
    totalTss: shared.tss,
    loadMultiplier: 1,
    phaseName: "base",
    note: "",
  };
  const out = adjust(week, state({ conditions: [condition()] }));
  assert.deepEqual(out.sessions[0]!.servesGoalIds, ["race", "wedding"]);
  assert.equal(out.sessions[0]!.kind, "bike_endurance");
});

/*
 * ─── Composing conditions (defect 3) ──────────────────────────────────────
 */

test("adding an illness to an injury makes the week smaller, and the cards say so (defect 3)", () => {
  const strain = condition({ severity: 2 }); // Can't run
  const infection = illness({ label: "Chest infection", severity: 2, restrictions: [] });

  const injuryOnly = adjust(BASE_WEEK, state({ conditions: [strain] }));
  const illnessOnly = adjust(BASE_WEEK, state({ conditions: [infection] }));
  const both = adjust(BASE_WEEK, state({ conditions: [strain, infection] }));

  // The bug: `continue` after a substitution skipped easeForIllness entirely,
  // so "both" was byte-identical to the strain alone — more than twice the
  // training the infection alone prescribed, for the athlete who had both.
  assert.notDeepEqual(
    both.sessions.map((x) => x.durationMinutes),
    injuryOnly.sessions.map((x) => x.durationMinutes),
    "the infection changed nothing",
  );
  assert.ok(
    both.totalMinutes < Math.min(injuryOnly.totalMinutes, illnessOnly.totalMinutes),
    `both: ${both.totalMinutes} min, injury alone: ${injuryOnly.totalMinutes}, illness alone: ${illnessOnly.totalMinutes}`,
  );
  assert.ok(
    both.totalTss < Math.min(injuryOnly.totalTss, illnessOnly.totalTss),
    `both: ${both.totalTss} TSS, injury alone: ${injuryOnly.totalTss}, illness alone: ${illnessOnly.totalTss}`,
  );

  // And it is visible. `causesFor` only names conditions whose OWN
  // restrictions rule the kind out, so an illness with nothing ticked was
  // structurally invisible: five ride cards blaming the calf and not a word
  // about the infection.
  for (const session of both.sessions.filter((x) => x.kind !== "rest")) {
    assert.match(session.note, /Chest infection/, session.date);
    assert.match(session.note, /below the neck/, session.date);
    assert.match(session.note, /Left calf strain/, session.date);
  }
});

test("a return ramp also survives a substitution — the same skipped step (defect 3)", () => {
  // Open injury forbids running at severity 1 (so the swap itself is
  // minute-for-minute and changes nothing but the kind), while a separate,
  // healed injury has the athlete on day 1 of its return ramp. The ride must
  // still be cut to the ramp stage's load factor.
  const open = condition({ id: "achilles", label: "Achilles niggle", severity: 1, restrictions: ["no_running"] });
  const healed = condition({ id: "old", label: "Hamstring strain", severity: 2, openedAt: "2026-09-07", closedAt: "2026-09-13", updatedAt: "2026-09-13T00:00:00.000Z" });

  const swapOnly = adjust(BASE_WEEK, state({ conditions: [open] }));
  const both = adjust(BASE_WEEK, state({ conditions: [open, healed] }));

  assert.ok(both.sessions.every((x) => x.kind === "bike_endurance"), "running is still ruled out");
  assert.ok(
    both.totalMinutes < swapOnly.totalMinutes,
    `the ramp took nothing off: ${both.totalMinutes} vs ${swapOnly.totalMinutes}`,
  );
  const ride = both.sessions.find((x) => x.adjustedFrom?.kind === "run_easy")!;
  assert.equal(ride.durationMinutes, reducedMinutes(substituteMinutes("bike_endurance", ride.adjustedFrom!.durationMinutes, 1), 0.6));
  assert.match(ride.note, /back from Hamstring strain/);
});

/*
 * ─── The invariant this whole group is about ──────────────────────────────
 */

test("no condition ever buys the athlete MORE training, over every week, severity and kit", () => {
  const weeks: Array<[string, PrescribedWeek]> = [
    ["base", BASE_WEEK],
    ["build", BUILD_WEEK],
    ["taper", TAPER_WEEK],
    ["short sessions", synthetic([
      ["run_easy", MONDAY, 30],
      ["run_threshold", "2026-09-15", 40],
      ["run_intervals", "2026-09-16", 35],
      ["strength_lower", "2026-09-17", 35],
      ["run_long", "2026-09-19", 50],
    ])],
  ];
  const kit = [
    { bike: true, swim: true },
    { bike: true, swim: false },
    { bike: false, swim: true },
    { bike: false, swim: false },
  ];
  const restrictionSets: Restriction[][] = [
    ["no_running"],
    ["no_impact"],
    ["no_lower"],
    ["no_upper"],
    ["no_running", "no_lower"],
    [],
  ];

  const scenarios: Array<[string, Condition[]]> = [];
  for (const severity of [1, 2, 3] as const) {
    for (const restrictions of restrictionSets) {
      const label = restrictions.length ? restrictions.length.toString() : "nothing";
      scenarios.push([`injury sev ${severity} ruling out ${label}`, [condition({ severity, restrictions })]]);
      scenarios.push([
        `injury sev ${severity} ruling out ${label} + illness`,
        [condition({ severity, restrictions }), illness({ severity: 2, restrictions: [] })],
      ]);
      scenarios.push([
        `injury sev ${severity} ruling out ${label} + a return ramp`,
        [condition({ severity, restrictions }), condition({ id: "old", label: "Old strain", closedAt: "2026-09-13" })],
      ]);
    }
    scenarios.push([`illness sev ${severity}`, [illness({ severity, restrictions: [] })]]);
    scenarios.push([`ramp from sev ${severity}`, [condition({ severity, closedAt: "2026-09-13" })]]);
  }

  for (const [weekName, week] of weeks) {
    for (const available of kit) {
      for (const [name, conditions] of scenarios) {
        const out = adjust(week, state({ conditions, available }));
        const where = `${weekName} / ${name} / bike=${available.bike} pool=${available.swim}`;
        assert.ok(out.totalMinutes <= week.totalMinutes, `${where}: ${out.totalMinutes} min against ${week.totalMinutes}`);
        assert.ok(out.totalTss <= week.totalTss, `${where}: ${out.totalTss} TSS against ${week.totalTss}`);

        for (const session of out.sessions) {
          if (session.kind === "rest") continue;
          const originalKind = session.adjustedFrom?.kind ?? session.kind;
          const before = week.sessions.find((x) => x.date === session.date && x.kind === originalKind);
          if (!before) continue;
          assert.ok(
            session.durationMinutes <= before.durationMinutes,
            `${where}: ${before.kind} ${before.durationMinutes} min → ${session.kind} ${session.durationMinutes} min`,
          );
          assert.ok(
            session.tss <= before.tss,
            `${where}: ${before.kind} ${before.tss} TSS → ${session.kind} ${session.tss} TSS`,
          );
        }
      }
    }
  }
});

/*
 * ─── The card's arithmetic is the arithmetic that happened (defect 1) ─────
 */

/** Every "N min" and every "N%" a sentence claims, in the order it claims them. */
function claimsIn(note: string): { minutes: number[]; percents: number[] } {
  return {
    minutes: [...note.matchAll(/(\d+) min/g)].map((m) => Number(m[1])),
    percents: [...note.matchAll(/(\d+)%/g)].map((m) => Number(m[1])),
  };
}

test("a substitution card never states a calculation the app did not do (defect 1)", () => {
  // The old string read: "30 min becomes 45, then 70% of that while this is
  // open — 45 min". 70% of 45 is 31.5. The athlete was told a reduction that
  // never happened, on a session that had in fact got LONGER.
  for (const week of [BASE_WEEK, BUILD_WEEK, TAPER_WEEK]) {
    for (const severity of [1, 2, 3] as const) {
      for (const available of [{ bike: true, swim: true }, { bike: false, swim: true }]) {
        // Injury only: no illness and no ramp, so the substitution sentence
        // is the whole note and its numbers stand alone.
        const out = adjust(week, state({ conditions: [condition({ severity })], available }));
        for (const session of out.sessions.filter((x) => x.adjustedFrom)) {
          const { minutes, percents } = claimsIn(session.note);
          assert.ok(minutes.length > 0, `no numbers at all: ${session.note}`);
          assert.equal(minutes[0], session.adjustedFrom!.durationMinutes, `wrong starting number: ${session.note}`);
          assert.equal(minutes.at(-1), session.durationMinutes, `the last number is not what it asks for: ${session.note}`);
          for (const percent of percents) {
            assert.equal(
              Math.round(minutes[0]! * (percent / 100)),
              session.durationMinutes,
              `the card claims ${percent}% of ${minutes[0]} but prescribes ${session.durationMinutes}: ${session.note}`,
            );
          }
        }
      }
    }
  }
});

/*
 * ─── Synthetic weeks, for the two day-shapes the prescriber cannot make ───
 */

function synthetic(rows: Array<[SessionKind, string, number]>): PrescribedWeek {
  const sessions = rows.map(([kind, date, minutes]) =>
    buildSession(kind, date, minutes, DEFAULT_ATHLETE, ["race"], ["Marathon"]),
  );
  return {
    weekStart: MONDAY,
    sessions,
    totalMinutes: sessions.reduce((sum, s) => sum + s.durationMinutes, 0),
    totalTss: sessions.reduce((sum, s) => sum + s.tss, 0),
    loadMultiplier: 1,
    phaseName: "base",
    note: "",
  };
}

test("the week's own dates are the only ones touched", () => {
  const out = adjust(BASE_WEEK, state({ conditions: [condition()] }));
  assert.deepEqual(
    [...new Set(out.sessions.map((s) => s.date))].sort(),
    [...new Set(BASE_WEEK.sessions.map((s) => s.date))].sort(),
  );
  assert.ok(out.sessions.every((s) => s.date >= MONDAY && s.date <= addDays(SUNDAY, 0)));
});
