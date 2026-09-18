import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { conditions, dailyCheckIns, goals, physiqueEntries, sessionCompletions, trainingSessions } from "@shared/schema";
import { addDays } from "@shared/dates";
import { DEFAULT_ATHLETE } from "@shared/athlete";
import { adjustWeek, chronicWeeklyLoad, sessionKey } from "@shared/prescription/adjust";
import { arbitrateWeek } from "@shared/arbitration/arbitrate";
import { prescribeWeek } from "@shared/prescription/prescribe";
import { buildAthleteState, getAthleteParams, recentLoad } from "./athleteStateService";
import { closeCondition, openCondition } from "./conditionsService";
import { recordCompletion } from "./completionsService";
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
for (const table of [goals, conditions, dailyCheckIns, physiqueEntries, sessionCompletions, trainingSessions]) {
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
