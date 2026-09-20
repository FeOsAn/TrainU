import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { conditions, dailyCheckIns, goals, physiqueEntries, preferences, sessionCompletions, trainingSessions } from "@shared/schema";
import { addDays } from "@shared/dates";
import { DEFAULT_ATHLETE } from "@shared/athlete";
import { adjustWeek, chronicWeeklyLoad, sessionKey } from "@shared/prescription/adjust";
import { arbitrateWeek } from "@shared/arbitration/arbitrate";
import { prescribeWeek } from "@shared/prescription/prescribe";
import { buildAthleteState, getAthleteParams, plannableConditions, recentLoad, weekReadiness } from "./athleteStateService";
import { closeCondition, openCondition } from "./conditionsService";
import { recordCompletion } from "./completionsService";
import { updateBlockPreferences } from "./preferencesService";
import type { PlannedSession } from "@shared/prescription/sessionKinds";
import { upsertCheckIn } from "./checkInsService";
import { upsertPhysiqueEntry, deletePhysiqueEntry } from "./physiqueService";
import { createGoal } from "./goalsService";

/**
 * Every test works in its own island of dates, far from the others: these
 * are real rows in one database, and the loader's windows reach back 60 and
 * 120 days, so two tests a month apart would quietly become each other's
 * evidence.
 */
function week(monday: string): { weekStart: string; weekEnd: string } {
  return { weekStart: monday, weekEnd: addDays(monday, 6) };
}

/**
 * These tests assert what the loader does NOT return as much as what it
 * does, and "nothing is logged yet" is one of the states worth pinning. So
 * the file starts from a clean slate rather than from whatever the last run
 * left behind — otherwise the suite passes once and fails on the rerun,
 * which is the same as not having it.
 */
for (const table of [goals, conditions, dailyCheckIns, physiqueEntries, sessionCompletions, trainingSessions, preferences]) {
  db.delete(table).run();
}

function logSession(date: string, tss: number): void {
  db.insert(trainingSessions)
    .values({ id: randomUUID(), date, sport: "run", source: "manual", durationMinutes: 45, tss })
    .run();
}

test("an empty database still builds a usable state, and it changes nothing", () => {
  const { weekStart, weekEnd } = week("2031-03-03");
  const state = buildAthleteState(weekStart, weekEnd, weekStart);

  assert.deepEqual(state.answeredKeys, []);
  assert.equal(state.checkIn, null);
  assert.equal(state.readiness, null);
  assert.deepEqual(state.available, { bike: false, swim: false });
  assert.deepEqual(state.recentLoad, []);

  const planGoals = [
    {
      id: "g",
      type: "endurance_race" as const,
      discipline: "run" as const,
      label: "Marathon",
      targetDate: "2032-06-01",
      priority: 1,
      successCriteria: "",
      targetMetrics: {},
      constraints: [],
      createdAt: "2031-01-01T00:00:00.000Z",
      active: true,
    },
  ];
  const prescribed = prescribeWeek(arbitrateWeek(planGoals, weekStart, state.params), planGoals, state.params);
  const adjusted = adjustWeek(prescribed, state, weekStart, { strict: true });
  assert.deepEqual(adjusted.sessions, prescribed.sessions, "a state that knows nothing has nothing to change");
  assert.deepEqual(adjusted.adjustments, []);
});

test("answered sessions are scoped to the week being viewed, not to all of history", () => {
  const { weekStart, weekEnd } = week("2031-04-07");
  const thisWeek = addDays(weekStart, 2);
  const lastWeek = addDays(weekStart, -5);

  recordCompletion({ date: thisWeek, kind: "run_easy", status: "completed" });
  recordCompletion({ date: lastWeek, kind: "run_easy", status: "skipped" });

  const state = buildAthleteState(weekStart, weekEnd, weekStart);
  assert.ok(state.answeredKeys.includes(sessionKey({ date: thisWeek, kind: "run_easy" } as never)));
  assert.ok(
    !state.answeredKeys.includes(sessionKey({ date: lastWeek, kind: "run_easy" } as never)),
    "last week's tick must not make this week's session immune to adjustment",
  );
});

test("conditions load open, recently closed, and nothing older than the ramp can reach", () => {
  const today = "2031-05-20";
  const { weekStart, weekEnd } = week("2031-05-19");

  const open = openCondition(
    { kind: "injury", label: "Left calf", bodyPart: "calf", severity: 2, openedAt: addDays(today, -5) },
    { today },
  );
  const healedRecently = openCondition(
    { kind: "injury", label: "Sore heel", bodyPart: "foot", severity: 1, openedAt: addDays(today, -40) },
    { today },
  );
  closeCondition(healedRecently.id, addDays(today, -20), today);
  const ancient = openCondition(
    { kind: "illness", label: "Old flu", severity: 2, openedAt: addDays(today, -200) },
    { today },
  );
  closeCondition(ancient.id, addDays(today, -190), today);

  const ids = buildAthleteState(weekStart, weekEnd, today).conditions.map((c) => c.id);
  assert.ok(ids.includes(open.id));
  assert.ok(ids.includes(healedRecently.id), "a recent heal is still inside its return-to-training ramp");
  assert.ok(!ids.includes(ancient.id), "a condition that healed six months ago cannot affect any week");
});

test("this morning's check-in is read for TODAY, never yesterday's standing in for it", () => {
  const today = "2031-06-18";
  const { weekStart, weekEnd } = week("2031-06-16");

  upsertCheckIn({ date: addDays(today, -1), sleepQuality: 1, soreness: 5, energy: 1 });
  const before = buildAthleteState(weekStart, weekEnd, today);
  assert.equal(before.checkIn, null, "a check-in dated yesterday is not a statement about today");
  assert.equal(before.readiness, null);

  upsertCheckIn({ date: today, sleepQuality: 4, soreness: 2, energy: 4 });
  const after = buildAthleteState(weekStart, weekEnd, today);
  assert.equal(after.checkIn?.date, today);
  assert.equal(after.readiness?.date, today);
});

test("the load history is the recent past only — nothing ancient, nothing in the future", () => {
  const today = "2031-08-12";
  logSession(addDays(today, -3), 60);
  logSession(addDays(today, -200), 60);
  logSession(addDays(today, 3), 60);

  const rows = recentLoad(today);
  assert.deepEqual(
    rows.map((r) => r.date),
    [addDays(today, -3)],
    "a session logged 200 days ago cannot be evidence about this week, and tomorrow's has not happened",
  );
});

test("the load history is what the weekly ceiling actually reads", () => {
  const today = "2032-06-14";
  // One session every two days for twelve weeks: 14 in any 28-day window.
  for (let back = 0; back <= 84; back += 2) logSession(addDays(today, -back), 40);

  const { weekStart, weekEnd } = week("2032-06-14");
  const state = buildAthleteState(weekStart, weekEnd, today);
  assert.equal(state.recentLoad.length, 43);
  assert.equal(chronicWeeklyLoad(state, today), 140, "14 sessions at 40 over four weeks is 140 a week");
});

test("the athlete's numbers fold in the newest weigh-in at read time, and let go of it when it is deleted", () => {
  const seeded = getAthleteParams().weightKg;
  assert.equal(seeded.value, DEFAULT_ATHLETE.weightKg.value);
  assert.equal(seeded.verified, false, "nothing has been measured yet, and the app says so");

  upsertPhysiqueEntry({ date: "2031-11-04", weightKg: 71.4 }, { today: "2031-11-04" });
  const folded = getAthleteParams().weightKg;
  assert.equal(folded.value, 71.4);
  assert.equal(folded.verified, true);
  assert.ok(folded.source.length > 0, "a measured number says where it came from");

  deletePhysiqueEntry("2031-11-04");
  assert.equal(getAthleteParams().weightKg.value, DEFAULT_ATHLETE.weightKg.value, "deleting the weigh-in undoes it — no row was ever rewritten");
});

test("cross-training availability comes off the athlete's own goals", () => {
  const { weekStart, weekEnd } = week("2032-01-05");
  const before = buildAthleteState(weekStart, weekEnd, weekStart);
  assert.deepEqual(before.available, { bike: false, swim: false });

  createGoal({
    type: "endurance_race",
    discipline: "triathlon",
    label: "Ironman 70.3",
    targetDate: "2032-09-01",
    successCriteria: "Finish under 5:30",
  });

  const after = buildAthleteState(weekStart, weekEnd, weekStart);
  assert.deepEqual(after.available, { bike: true, swim: true }, "someone training for a triathlon has a bike and a pool");
});

/*
 * ─── Regressions ──────────────────────────────────────────────────────────
 */

/** A prescription snapshot, the way `recordCompletion` stores one off a real card. */
function snapshot(date: string, minutes: number, tss: number): PlannedSession {
  return {
    date,
    kind: "run_easy",
    sport: "run",
    title: "Easy run",
    focus: "Aerobic base",
    durationMinutes: minutes,
    tss,
    intensity: "easy",
    targets: ["5:30/km"],
    servesGoalIds: [],
    note: "",
  };
}

test("DEFECT: the weekly load ceiling is unreachable for an athlete who only ticks sessions off", () => {
  const today = "2033-03-28";
  const { weekStart, weekEnd } = week("2033-03-28");

  // Twelve weeks of app-only training: no connector, no FIT upload, nothing in
  // `training_sessions` — the exact athlete CLAUDE.md says the app is for.
  for (let back = 84; back >= 0; back -= 2) {
    const date = addDays(today, -back);
    recordCompletion({ date, kind: "run_easy", status: "completed", prescribed: snapshot(date, 45, 55) });
  }

  const state = buildAthleteState(weekStart, weekEnd, today);
  assert.ok(state.recentLoad.length > 0, "ticked-off sessions ARE the athlete's recent training");
  const chronic = chronicWeeklyLoad(state, today);
  assert.ok(chronic != null, "with no chronic load the ceiling returns every week untouched, however big");
  // 14 sessions at 55 TSS in any 28-day window.
  assert.equal(Math.round(chronic!), 193);
});

test("DEFECT: a completion with no prescription snapshot is no evidence, NOT a zero-load day", () => {
  // Its own island of dates, well clear of the other load tests: the loader
  // reaches back 120 days and two tests a month apart become each other's
  // evidence (see this file's header).
  const today = "2036-07-25";
  const { weekStart, weekEnd } = week("2036-07-21");

  // Ninety days of rows nothing can price (ticked off before snapshots
  // existed, or from a client that sent no prescription), and five days of
  // real evidence. Counting the unpriceable ones as 0 TSS would hand
  // `computeTrainingLoad` three months of "history" and manufacture a
  // baseline out of five days of training — and a fabricated baseline is a
  // ceiling that clamps a legitimate week. Null must mean "no evidence".
  for (let back = 90; back >= 6; back--) {
    recordCompletion({ date: addDays(today, -back), kind: "run_threshold", status: "completed" });
  }
  for (let back = 4; back >= 0; back--) {
    const date = addDays(today, -back);
    recordCompletion({ date, kind: "run_easy", status: "completed", prescribed: snapshot(date, 60, 80) });
  }

  assert.equal(
    chronicWeeklyLoad(buildAthleteState(weekStart, weekEnd, today), today),
    null,
    "five days of evidence is not four weeks of it, whatever else is on record",
  );
});

test("DEFECT: a synced file and the tick-off of the same session are ONE session, not two", () => {
  const today = "2033-10-24";
  const { weekStart, weekEnd } = week("2033-10-24");

  // Dedupe on (date, sport) rather than on `sessionId`, which is null for an
  // ordinary tick-off: keying on it would double the chronic load of every
  // athlete who has a watch connected AND ticks their cards.
  for (let back = 27; back >= 0; back -= 3) logSession(addDays(today, -back), 70);
  const syncedOnly = chronicWeeklyLoad(buildAthleteState(weekStart, weekEnd, today), today);
  assert.ok(syncedOnly != null);

  for (let back = 27; back >= 0; back -= 3) {
    const date = addDays(today, -back);
    recordCompletion({ date, kind: "run_easy", status: "completed", prescribed: snapshot(date, 45, 70) });
  }
  assert.equal(
    chronicWeeklyLoad(buildAthleteState(weekStart, weekEnd, today), today),
    syncedOnly,
    "ticking off a session a watch already recorded must not count it twice",
  );
});

test("DEFECT: switching the conditions block off stops conditions steering EVERY engine, not just the week", () => {
  const today = "2034-02-14";
  const { weekStart, weekEnd } = week("2034-02-13");

  const injury = openCondition(
    { kind: "injury", label: "Right calf", bodyPart: "calf", severity: 3, openedAt: addDays(today, -2) },
    { today },
  );
  assert.ok(plannableConditions(today).some((c) => c.id === injury.id));

  updateBlockPreferences({ "plan.conditions": "off" });
  assert.deepEqual(
    plannableConditions(today),
    [],
    "arbitration, prediction and the week all read this one answer — a block that is off must not steer any of them",
  );
  assert.deepEqual(buildAthleteState(weekStart, weekEnd, today).conditions, []);

  updateBlockPreferences({ "plan.conditions": null });
  assert.ok(plannableConditions(today).some((c) => c.id === injury.id), "'let my goals decide' has to stay reachable");
  db.delete(conditions).run();
});

test("DEFECT: the week's mornings are all of them, not just today's", () => {
  const today = "2034-05-17"; // Wednesday
  const { weekStart, weekEnd } = week("2034-05-15");

  upsertCheckIn({ date: addDays(weekStart, 1), sleepQuality: 1, soreness: 5, energy: 1 });
  upsertCheckIn({ date: today, sleepQuality: 4, soreness: 2, energy: 4 });
  upsertCheckIn({ date: addDays(today, 1), sleepQuality: 3, soreness: 3, energy: 3 });

  const mornings = weekReadiness(weekStart, weekEnd, today);
  assert.deepEqual(
    mornings.map((m) => m.date),
    [addDays(weekStart, 1), today],
    "Tuesday's morning is what keeps Tuesday's rest day on the week; tomorrow's has not happened",
  );
  assert.ok(mornings.every((m) => m.readiness?.date === m.date), "each morning carries its OWN readiness");

  // Boundary either side: a week entirely behind the athlete keeps all its
  // mornings; a week entirely ahead of them gets none.
  assert.equal(weekReadiness(weekStart, weekEnd, addDays(weekEnd, 3)).length, 3);
  assert.equal(weekReadiness(weekStart, weekEnd, addDays(weekStart, -1)).length, 0);

  updateBlockPreferences({ "plan.checkIn": "off" });
  assert.deepEqual(weekReadiness(weekStart, weekEnd, today), [], "a check-in block switched off acts on no morning at all");
  updateBlockPreferences({ "plan.checkIn": null });
  db.delete(dailyCheckIns).run();
});
