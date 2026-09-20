import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_PARTS,
  CONDITION_KIND_LABELS,
  CONDITION_CEILING_LABELS,
  CONDITION_SUSPEND_DAYS,
  DEMANDS,
  DEMAND_LABELS,
  ILLNESS_RULES,
  InvalidConditionError,
  KIND_DEMANDS,
  RAMP_BY_SEVERITY,
  RESTRICTIONS,
  RESTRICTION_FORBIDS,
  RESTRICTION_LABELS,
  RISK_BAND_MULTIPLIER,
  RISK_LEVEL_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  SUBSTITUTES,
  SUBSTITUTE_LOAD_FACTOR,
  SUGGESTED_RESTRICTIONS,
  applyConditionCeiling,
  assessGoalRisk,
  type Condition,
  conditionsOn,
  crossTrainingAvailability,
  daysOff,
  daysOpen,
  forbiddenKinds,
  isForbidden,
  isOpenOn,
  isSuspended,
  maxSeverity,
  openRestrictions,
  pickSubstitute,
  rampStageOn,
  rampStagesFor,
  steersTraining,
  validateConditionInput,
  validateConditionPatch,
} from "./conditions";
import { SESSION_KINDS, type SessionKind } from "./prescription/sessionKinds";
import { qualitiesFor } from "./prescription/templates";
import { type Goal } from "./goal";
import { DEFAULT_FEATURE_PREFERENCES, type FeaturePreferences } from "./preferences";

function condition(over: Partial<Condition> = {}): Condition {
  return {
    id: "c1",
    kind: "injury",
    label: "Left calf strain",
    bodyPart: "calf",
    severity: 2,
    restrictions: ["no_running"],
    openedAt: "2026-09-01",
    closedAt: null,
    note: null,
    createdAt: "2026-09-01T07:00:00.000Z",
    updatedAt: "2026-09-01T07:00:00.000Z",
    ...over,
  };
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    type: "endurance_race",
    discipline: "run",
    label: "Berlin Marathon",
    targetDate: "2026-10-30",
    priority: 1,
    successCriteria: "Sub 3:30",
    targetMetrics: {},
    constraints: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    active: true,
    ...over,
  };
}

function features(over: Partial<FeaturePreferences> = {}): FeaturePreferences {
  return { ...DEFAULT_FEATURE_PREFERENCES, ...over };
}

/* ── Catalog integrity: the Phase 8 archetype, one layer down ─────────────── */

test("every session kind is classified and routable — a kind the tables can't see is a kind the engine can't protect", () => {
  for (const kind of SESSION_KINDS) {
    assert.ok(Array.isArray(KIND_DEMANDS[kind]), `${kind} has no demands`);
    assert.ok(Array.isArray(SUBSTITUTES[kind]), `${kind} has no substitute list`);
    for (const demand of KIND_DEMANDS[kind]) {
      assert.ok((DEMANDS as readonly string[]).includes(demand), `${kind} demands something that isn't a demand`);
    }
    for (const candidate of SUBSTITUTES[kind]) {
      assert.ok((SESSION_KINDS as readonly string[]).includes(candidate), `${kind} substitutes an unknown kind`);
      assert.notEqual(candidate, kind, `${kind} substitutes itself`);
    }
  }
});

test("no restriction and no demand is dead data", () => {
  for (const restriction of RESTRICTIONS) {
    const banned = forbiddenKinds([restriction]);
    assert.ok(banned.size > 0, `${restriction} forbids nothing at all`);
  }
  for (const demand of DEMANDS) {
    assert.ok(
      SESSION_KINDS.some((k) => KIND_DEMANDS[k].includes(demand)),
      `no session kind demands ${demand}`,
    );
    assert.ok(
      Object.values(RESTRICTION_FORBIDS).includes(demand),
      `no restriction bans ${demand}`,
    );
  }
});

test("every body part suggests only real restrictions", () => {
  for (const part of BODY_PARTS) {
    const suggested = SUGGESTED_RESTRICTIONS[part];
    assert.ok(Array.isArray(suggested), `${part} has no suggestion list`);
    for (const r of suggested) assert.ok((RESTRICTIONS as readonly string[]).includes(r), `${part} suggests an unknown restriction`);
  }
});

test("ramp and illness numbers stay inside what they claim to be", () => {
  for (const severity of SEVERITIES) {
    const profile = RAMP_BY_SEVERITY[severity];
    assert.ok(profile.lengthModifier > 0);
    for (const stage of [profile.easy, profile.threshold]) {
      assert.ok(stage.loadFactor > 0 && stage.loadFactor <= 1, "a ramp stage that removes all load is a rest day, not a ramp");
      assert.ok(stage.label.trim().length > 0);
    }
    const rule = ILLNESS_RULES[severity];
    assert.ok(rule.loadFactor >= 0 && rule.loadFactor <= 1);
    assert.equal(rule.restOnly, rule.loadFactor === 0, "rest-only and a zero load factor have to mean the same thing");
    assert.ok(SUBSTITUTE_LOAD_FACTOR[severity] > 0 && SUBSTITUTE_LOAD_FACTOR[severity] <= 1);
  }
  // Every stage lasts at least a day whatever the arithmetic says.
  for (const stage of rampStagesFor(condition({ openedAt: "2026-09-01", closedAt: "2026-09-01", severity: 1 }))) {
    assert.ok(stage.days >= 1);
  }
});

test("no enum value ever reaches the athlete", () => {
  const labelTables: Array<{ table: Record<string, string>; ownWordsAllowed?: boolean }> = [
    { table: CONDITION_KIND_LABELS },
    { table: RESTRICTION_LABELS },
    { table: RISK_LEVEL_LABELS },
    // "running" is genuinely the English word for the demand it names, so
    // this is the one table where a label may equal its key. The
    // identifier check below still applies.
    { table: DEMAND_LABELS, ownWordsAllowed: true },
    { table: CONDITION_CEILING_LABELS, ownWordsAllowed: true },
    { table: SEVERITY_LABELS.injury as unknown as Record<string, string> },
    { table: SEVERITY_LABELS.illness as unknown as Record<string, string> },
  ];
  for (const { table, ownWordsAllowed } of labelTables) {
    for (const [key, words] of Object.entries(table)) {
      assert.ok(words.trim().length > 0, `${key} has no words`);
      if (!ownWordsAllowed) assert.notEqual(words, key, `${key} is its own label`);
      assert.ok(!/_/.test(words), `"${words}" still reads like an identifier`);
    }
  }
});

/* ── Per-DATE, not per-today: the Phase 3 archetype ───────────────────────── */

test("a condition closed on Wednesday is not open on Thursday, and one opened on Wednesday was not open on Monday", () => {
  const c = condition({ openedAt: "2026-09-09", closedAt: "2026-09-09" }); // opened and closed Wednesday
  assert.equal(isOpenOn(c, "2026-09-07"), false, "Monday — it hadn't happened yet");
  assert.equal(isOpenOn(c, "2026-09-09"), true, "Wednesday — the day itself counts");
  assert.equal(isOpenOn(c, "2026-09-10"), false, "Thursday — it is over, and must stop steering the plan");
});

test("an open condition is open on every date from its start onwards", () => {
  const c = condition({ openedAt: "2026-09-09", closedAt: null });
  assert.equal(isOpenOn(c, "2026-09-08"), false);
  assert.equal(isOpenOn(c, "2026-12-25"), true);
});

test("daysOpen counts to today, and stops growing once it healed", () => {
  assert.equal(daysOpen(condition({ openedAt: "2026-09-01" }), "2026-09-05"), 5);
  assert.equal(daysOpen(condition({ openedAt: "2026-09-01" }), "2026-08-31"), 0);
  assert.equal(daysOpen(condition({ openedAt: "2026-09-01", closedAt: "2026-09-03" }), "2026-09-30"), 3);
  assert.equal(daysOff(condition({ openedAt: "2026-09-01", closedAt: "2026-09-03" })), 3);
});

/* ── Restriction semantics ────────────────────────────────────────────────── */

test("a restriction rules out exactly the kinds that demand what it bans — and never rest", () => {
  assert.ok(isForbidden("run_long", ["no_running"]));
  assert.ok(isForbidden("run_intervals", ["no_running"]));
  assert.ok(!isForbidden("bike_endurance", ["no_running"]), "a calf strain does not rule out riding");
  assert.ok(!isForbidden("swim_technique", ["no_running"]));
  assert.ok(isForbidden("bike_endurance", ["no_lower"]), "a ride loads the legs even though it has no impact");
  assert.ok(!isForbidden("bike_endurance", ["no_impact"]), "no impact is exactly what a bike is for");
  assert.ok(isForbidden("strength_push", ["no_upper"]));
  assert.ok(!isForbidden("rest", ["no_running", "no_impact", "no_upper", "no_lower"]), "there must always be something left");
  assert.equal(forbiddenKinds([]).size, 0);
});

test("unreadable restrictions forbid nothing rather than everything", () => {
  assert.equal(isForbidden("run_long", ["shoulder_hurts" as never]), false);
});

test("the union of several conditions is what a session is judged against", () => {
  const open = [condition({ restrictions: ["no_running"] }), condition({ id: "c2", restrictions: ["no_upper", "no_running"] })];
  assert.deepEqual(openRestrictions(open), ["no_running", "no_upper"]);
  assert.equal(maxSeverity(open), 2);
  assert.equal(maxSeverity([]), null);
});

/* ── Substitution ─────────────────────────────────────────────────────────── */

test("a forbidden run becomes the best cross-training the athlete can actually reach", () => {
  const calf: Parameters<typeof pickSubstitute>[1] = ["no_running"];
  assert.equal(pickSubstitute("run_long", calf, { bike: true, swim: true }), "bike_endurance");
  assert.equal(pickSubstitute("run_long", calf, { bike: false, swim: true }), "swim_technique", "no bike falls through to the pool");
  assert.equal(pickSubstitute("run_long", calf, { bike: false, swim: false }), null, "no equipment is an honest rest day, not a session they can't do");
  assert.equal(
    pickSubstitute("run_long", calf, { bike: true, swim: true }, ["bike_endurance"]),
    "swim_technique",
    "a ride is already on that day — two sessions must not collapse into one",
  );
});

test("a restriction that also rules out the substitute keeps going down the list", () => {
  // A knee: no running AND no leg load, so the bike is out too.
  assert.equal(pickSubstitute("run_easy", ["no_running", "no_lower"], { bike: true, swim: true }), "swim_technique");
  assert.equal(pickSubstitute("strength_lower", ["no_lower"], { bike: true, swim: true }), "strength_pull");
  assert.equal(pickSubstitute("strength_lower", ["no_lower", "no_upper"], { bike: true, swim: true }), null);
});

/* ── Illness: the easy ceiling is a fixed point (DECISIONS B1) ─────────────── */

test("an easy ceiling means easy — intervals do not stop at threshold on the way down", () => {
  assert.equal(applyConditionCeiling("run_intervals", "easy"), "run_easy");
  assert.equal(applyConditionCeiling("compromised", "easy"), "run_easy");
  assert.equal(applyConditionCeiling("run_threshold", "easy"), "run_easy");
  assert.equal(applyConditionCeiling("run_intervals", "threshold"), "run_threshold");
  assert.equal(applyConditionCeiling("run_easy", "easy"), "run_easy");
});

test("a fever is rest, and nothing below one permits a hard session", () => {
  assert.equal(ILLNESS_RULES[3].restOnly, true);
  assert.equal(ILLNESS_RULES[1].restOnly, false);
  assert.equal(ILLNESS_RULES[2].restOnly, false);
  for (const severity of [1, 2] as const) {
    for (const kind of SESSION_KINDS) {
      const capped = applyConditionCeiling(kind, ILLNESS_RULES[severity].ceiling);
      assert.notEqual(capped, "run_threshold", `${kind} stayed hard while an illness was open`);
      assert.notEqual(capped, "run_intervals");
      assert.notEqual(capped, "compromised");
    }
  }
});

/* ── The ramp is driven by time off, not severity alone (DECISIONS B4) ─────── */

test("a niggle that kept someone out for eight weeks gets a longer ramp than one that cost three days", () => {
  const long = rampStagesFor(condition({ severity: 1, openedAt: "2026-07-01", closedAt: "2026-08-25" })); // 56 days
  const short = rampStagesFor(condition({ severity: 1, openedAt: "2026-09-01", closedAt: "2026-09-03" })); // 3 days
  assert.ok(long[0]!.days > short[0]!.days, "severity alone must not decide how detrained someone is");
  assert.ok(long[0]!.days >= 10);
  assert.equal(short[0]!.days, 1);
});

test("a one-day fever does not earn a twelve-day ramp", () => {
  const stages = rampStagesFor(condition({ kind: "illness", severity: 3, openedAt: "2026-09-01", closedAt: "2026-09-01" }));
  assert.equal(stages[0]!.days, 1);
  assert.equal(stages[1]!.days, 1);
});

test("a long injury's ramp is capped rather than running for months", () => {
  const stages = rampStagesFor(condition({ severity: 3, openedAt: "2025-09-01", closedAt: "2026-09-01" }));
  assert.ok(stages[0]!.days <= 21);
});

/*
 * The ramp is a claim about DETRAINING, so a condition that never took a
 * session away has nothing to come back from.
 *
 * Every ramp fixture in this file carried `restrictions: ["no_running"]`,
 * which is why 568 green tests agreed with the bug. The form sends "nothing
 * ticked" whenever the athlete ticks no boxes, so a restriction-free record
 * is the DEFAULT shape of a logged niggle, not an edge case.
 */

test("a condition that ruled nothing out earns no return ramp (defect 4)", () => {
  // Logged 1 Jan, no boxes ticked, trained every session all year, tidied up
  // on 13 Sep. daysOff is 256, which used to buy two capped 21-day stages:
  // six weeks of easy-only training as a reward for closing the record.
  const niggle = condition({
    severity: 1,
    restrictions: [],
    openedAt: "2026-01-01",
    closedAt: "2026-09-13",
    updatedAt: "2026-01-01T07:00:00.000Z",
  });
  assert.equal(daysOff(niggle), 256, "the calendar span is unchanged — it is what we do with it that was wrong");
  assert.equal(steersTraining(niggle), false, "it removed nothing while it was open");
  assert.deepEqual(rampStagesFor(niggle), []);
  assert.equal(rampStageOn(niggle, "2026-09-14"), null, "day 1 after a condition that removed nothing");
  assert.equal(rampStageOn(niggle, "2026-10-20"), null, "and 37 days after, where the second stage used to still be running");
  assert.equal(conditionsOn([niggle], "2026-09-14", "2026-09-14").ramping.length, 0);

  // The other side of the boundary: the SAME record with one box ticked did
  // take sessions away, so it still ramps exactly as before.
  const real = condition({ ...niggle, restrictions: ["no_running"] });
  assert.equal(steersTraining(real), true);
  assert.equal(rampStagesFor(real).length, 2);
  assert.ok(rampStageOn(real, "2026-09-14") !== null);
  assert.equal(conditionsOn([real], "2026-09-14", "2026-09-14").ramping.length, 1);
});

test("an illness with nothing ticked still ramps — its rules act on severity, not on boxes", () => {
  const infection = condition({
    kind: "illness",
    label: "Chest infection",
    bodyPart: null,
    severity: 2,
    restrictions: [],
    openedAt: "2026-09-01",
    closedAt: "2026-09-07",
  });
  assert.equal(steersTraining(infection), true, "ILLNESS_RULES shortened and capped every session it was open for");
  assert.equal(rampStagesFor(infection).length, 2);
  assert.ok(rampStageOn(infection, "2026-09-08") !== null);
});

test("a restriction that rules out no session kind earns no ramp either", () => {
  // Read off `forbiddenKinds`, not off `restrictions.length`: what counts is
  // whether anything was actually removed, decided by the one table the week
  // adjuster acts on.
  const bogus = condition({ restrictions: ["shoulder_hurts" as never], openedAt: "2026-09-01", closedAt: "2026-09-07" });
  assert.equal(forbiddenKinds(bogus.restrictions).size, 0);
  assert.equal(steersTraining(bogus), false);
  assert.deepEqual(rampStagesFor(bogus), []);
  assert.equal(rampStageOn(bogus, "2026-09-08"), null);
});

test("rampStageOn walks the stages and reports when steady work and full training come back", () => {
  const c = condition({ severity: 2, openedAt: "2026-09-01", closedAt: "2026-09-07" }); // 7 days off -> 3-day stages
  assert.equal(rampStageOn(c, "2026-09-07"), null, "the day it closed is not day one of the return");
  const first = rampStageOn(c, "2026-09-08")!;
  assert.equal(first.stageIndex, 0);
  assert.equal(first.dayIndex, 1);
  assert.equal(first.stage.ceiling, "easy");
  assert.equal(first.stageEndsOn, "2026-09-10");
  assert.equal(first.thresholdFrom, "2026-09-11");
  assert.equal(first.fullFrom, "2026-09-14");

  const second = rampStageOn(c, "2026-09-11")!;
  assert.equal(second.stageIndex, 1);
  assert.equal(second.dayIndex, 1);
  assert.equal(second.stage.ceiling, "threshold");
  assert.equal(rampStageOn(c, "2026-09-13")!.stageIndex, 1);
  assert.equal(rampStageOn(c, "2026-09-14"), null, "past the ramp, the plan goes back to normal on its own");
});

test("an open condition has no ramp — you do not return from something you are still in", () => {
  assert.equal(rampStageOn(condition({ closedAt: null }), "2026-09-20"), null);
});

/* ── Suspension: stale, never auto-closed (DECISIONS C10) ──────────────────── */

test("an open condition nobody has touched for four weeks stops steering the plan, and is never closed on the athlete's behalf", () => {
  const stale = condition({ openedAt: "2026-08-01", updatedAt: "2026-08-01T07:00:00.000Z" });
  assert.equal(isSuspended(stale, "2026-08-28"), false, "one day short — still trusted");
  assert.equal(isSuspended(stale, "2026-08-29"), true);
  assert.equal(stale.closedAt, null, "suspension must never write a healed date the app did not observe");

  const confirmed = condition({ openedAt: "2026-08-01", updatedAt: "2026-08-20T07:00:00.000Z" });
  assert.equal(isSuspended(confirmed, "2026-08-29"), false, "an edit is the athlete saying it is still true");

  assert.equal(isSuspended(condition({ closedAt: "2026-08-02" }), "2026-12-01"), false, "a closed condition is not stale, it is over");
  assert.equal(CONDITION_SUSPEND_DAYS, 28);
});

test("conditionsOn is the one per-date view: open, ramping and stale are told apart", () => {
  const open = condition({ id: "open", openedAt: "2026-09-01", closedAt: null, updatedAt: "2026-09-01T07:00:00.000Z" });
  const healed = condition({ id: "healed", openedAt: "2026-08-20", closedAt: "2026-09-01" });
  const stale = condition({ id: "stale", openedAt: "2026-07-01", closedAt: null, updatedAt: "2026-07-01T07:00:00.000Z" });

  const view = conditionsOn([open, healed, stale], "2026-09-03", "2026-09-03");
  assert.deepEqual(view.open.map((c) => c.id), ["open"]);
  assert.deepEqual(view.suspended.map((c) => c.id), ["stale"]);
  assert.deepEqual(view.ramping.map((r) => r.condition.id), ["healed"]);
  assert.equal(view.ramping[0]!.ramp.stageIndex, 0);
});

test("staleness is judged against today, not against the date being planned", () => {
  const stale = condition({ openedAt: "2026-07-01", closedAt: null, updatedAt: "2026-07-01T07:00:00.000Z" });
  // Planning Monday and Friday of the same week must not flip it mid-week.
  const monday = conditionsOn([stale], "2026-09-07", "2026-09-10");
  const friday = conditionsOn([stale], "2026-09-11", "2026-09-10");
  assert.equal(monday.open.length, 0);
  assert.equal(friday.open.length, 0);
});

/* ── Cross-training availability ──────────────────────────────────────────── */

test("what the athlete said, plus what their goals prove, and nothing else", () => {
  const today = "2026-09-18";
  assert.deepEqual(crossTrainingAvailability([goal()], features(), today), { bike: false, swim: false });
  assert.deepEqual(crossTrainingAvailability([goal()], features({ hasBike: true }), today), { bike: true, swim: false });
  assert.deepEqual(crossTrainingAvailability([goal()], features({ hasPool: true }), today), { bike: false, swim: true });
  assert.deepEqual(
    crossTrainingAvailability([goal({ discipline: "triathlon" })], features(), today),
    { bike: true, swim: true },
    "a triathlete plainly has both without being asked",
  );
  assert.deepEqual(crossTrainingAvailability([goal({ discipline: "cycling" })], features(), today), { bike: true, swim: false });
  assert.deepEqual(
    crossTrainingAvailability([goal({ discipline: "triathlon", targetDate: "2026-06-01" })], features(), today),
    { bike: false, swim: false },
    "a race that already happened proves nothing about what they can reach today",
  );
  assert.deepEqual(
    crossTrainingAvailability([goal({ discipline: "triathlon", active: false })], features(), today),
    { bike: false, swim: false },
  );
});

/* ── Goal risk ────────────────────────────────────────────────────────────── */

const TODAY = "2026-09-18";
/** Nine days ending today, healed today. */
function nineDayInjury(over: Partial<Condition> = {}): Condition {
  return condition({ openedAt: "2026-09-10", closedAt: "2026-09-18", ...over });
}

test("a marathon six weeks out that lost nine long-run days is at risk, in the athlete's words", () => {
  const race = goal({ targetDate: "2026-10-30" });
  const risk = assessGoalRisk(race, [nineDayInjury()], TODAY, TODAY);
  assert.equal(risk.level, "at_risk");
  assert.equal(risk.daysLost, 9);
  assert.equal(risk.anchorKind, "run_long");
  assert.equal(risk.windowDays, 28);
  assert.deepEqual(risk.conditionLabels, ["Left calf strain"]);
  assert.match(risk.note, /Berlin Marathon/);
  assert.match(risk.note, /Left calf strain/);
  assert.match(risk.note, /6 weeks out/);
  for (const leak of ["run_long", "no_running", "at_risk", "severity", "injury"]) {
    assert.ok(!risk.note.includes(leak), `the note leaked "${leak}" at the athlete`);
  }
});

test("the same nine days with the race half a year away is only worth watching", () => {
  const risk = assessGoalRisk(goal({ targetDate: "2027-04-17" }), [nineDayInjury()], TODAY, TODAY);
  assert.equal(risk.level, "watch");
  assert.equal(risk.daysLost, 9);
});

test("an injury that touches nothing the goal needs is no risk at all", () => {
  const risk = assessGoalRisk(goal(), [nineDayInjury({ label: "Sprained wrist", bodyPart: "wrist", restrictions: ["no_upper"] })], TODAY, TODAY);
  assert.equal(risk.level, "none");
  assert.equal(risk.daysLost, 0);
  assert.equal(risk.daysCapped, 0);
  assert.match(risk.note, /nothing in the last four weeks/);
});

test("a triathlete's anchor is the ride, so the same injury costs capped days rather than lost ones", () => {
  const tri = goal({ discipline: "triathlon", label: "Ironman 70.3" });
  assert.equal(qualitiesFor(tri.type, tri.discipline)[0], "bike_endurance");
  const risk = assessGoalRisk(tri, [nineDayInjury()], TODAY, TODAY);
  assert.equal(risk.anchorKind, "bike_endurance");
  assert.equal(risk.daysLost, 0, "they could still ride");
  assert.equal(risk.daysCapped, 9);
  assert.equal(risk.level, "watch");
});

test("a fever open right now with a race in two weeks is at risk on its own", () => {
  const ill = condition({ id: "flu", kind: "illness", label: "Flu", bodyPart: null, severity: 3, restrictions: [], openedAt: "2026-09-17", closedAt: null, updatedAt: "2026-09-17T07:00:00.000Z" });
  const risk = assessGoalRisk(goal({ targetDate: "2026-10-02" }), [ill], TODAY, TODAY);
  assert.equal(risk.level, "at_risk");
  assert.ok(risk.daysLost >= 2);
});

test("days that have not happened yet are never counted as lost", () => {
  const race = goal({ targetDate: "2026-12-05" });
  const now = assessGoalRisk(race, [nineDayInjury()], TODAY, TODAY);
  const nextMonth = assessGoalRisk(race, [nineDayInjury()], "2026-10-18", TODAY);
  assert.equal(nextMonth.daysLost, now.daysLost, "a future week must report today's risk, not a projection of it");
});

test("a suspended condition stops counting against a goal too", () => {
  const forgotten = condition({ openedAt: "2026-07-01", closedAt: null, updatedAt: "2026-07-01T07:00:00.000Z" });
  const risk = assessGoalRisk(goal(), [forgotten], TODAY, TODAY);
  assert.equal(risk.daysLost, 0);
  assert.equal(risk.level, "none");
});

test("risk widens a band and never moves a point estimate", () => {
  assert.equal(RISK_BAND_MULTIPLIER.none, 1);
  assert.ok(RISK_BAND_MULTIPLIER.watch > 1);
  assert.ok(RISK_BAND_MULTIPLIER.at_risk > RISK_BAND_MULTIPLIER.watch);
});

/* ── Validation ───────────────────────────────────────────────────────────── */

test("a good condition comes back normalised, with the defaults resolved once", () => {
  const valid = validateConditionInput(
    { kind: "injury", label: "  Left calf strain  ", bodyPart: "calf", severity: 2, restrictions: ["no_impact", "no_running", "no_running"] },
    TODAY,
  );
  assert.equal(valid.label, "Left calf strain");
  assert.equal(valid.openedAt, TODAY, "no start date means it started today");
  assert.deepEqual(valid.restrictions, ["no_running", "no_impact"], "deduped, in declaration order, so two clients store one row shape");
  assert.equal(valid.note, null);
});

test('"none" is an explicit nothing-ruled-out, not a missing answer', () => {
  assert.deepEqual(validateConditionInput({ kind: "illness", label: "Head cold", severity: 1, restrictions: "none" }, TODAY).restrictions, []);
});

test("a hallucinated or mangled condition is rejected exactly as a bad form post is", () => {
  const ok = { kind: "injury", label: "Calf", severity: 2 };
  assert.throws(() => validateConditionInput({ ...ok, kind: "vibes" }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, label: "   " }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, label: "x".repeat(200) }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, severity: 7 }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, severity: "2" }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, bodyPart: "soul" }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, restrictions: ["no_sprinting"] }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, restrictions: "some" }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, openedAt: "2026-02-30" }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput({ ...ok, openedAt: "2026-09-19" }, TODAY), InvalidConditionError, "a condition cannot start tomorrow");
  assert.throws(() => validateConditionInput({ ...ok, note: 12 }, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput("injured", TODAY), InvalidConditionError);
  assert.throws(() => validateConditionInput([{ ...ok }], TODAY), InvalidConditionError);
});

test("a patch is judged against the row it is changing", () => {
  const existing = condition({ openedAt: "2026-09-10", closedAt: null });
  assert.deepEqual(validateConditionPatch({ closedAt: "2026-09-15" }, existing, TODAY), { closedAt: "2026-09-15" });
  assert.deepEqual(validateConditionPatch({ severity: 1 }, existing, TODAY), { severity: 1 });
  assert.deepEqual(validateConditionPatch({ closedAt: null }, existing, TODAY), { closedAt: null }, "ticking healed too early has to be undoable");
  assert.deepEqual(validateConditionPatch({}, existing, TODAY), {});

  assert.throws(() => validateConditionPatch({ closedAt: "2026-09-01" }, existing, TODAY), InvalidConditionError, "healed before it started");
  assert.throws(() => validateConditionPatch({ closedAt: "2026-10-01" }, existing, TODAY), InvalidConditionError, "healed in the future");
  assert.throws(() => validateConditionPatch({ openedAt: "2026-09-20" }, existing, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionPatch({ kind: "illness" }, existing, TODAY), InvalidConditionError, "a condition does not become an illness by patch");
  assert.throws(() => validateConditionPatch({ id: "other" }, existing, TODAY), InvalidConditionError);
  assert.throws(() => validateConditionPatch(null, existing, TODAY), InvalidConditionError);
});

test("moving the start date is checked against the close date it will sit next to", () => {
  const closed = condition({ openedAt: "2026-09-01", closedAt: "2026-09-05" });
  assert.throws(() => validateConditionPatch({ openedAt: "2026-09-08" }, closed, TODAY), InvalidConditionError);
  assert.deepEqual(validateConditionPatch({ openedAt: "2026-09-03" }, closed, TODAY), { openedAt: "2026-09-03" });
});
