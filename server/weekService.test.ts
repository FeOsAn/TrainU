/**
 * What the wiring has to hold — the assertions that are about the pipeline
 * being CONNECTED, not about any one slice's coaching logic (each slice
 * already has its own suite).
 *
 * Three of these exist because the failure is silent. A missing side-effect
 * import leaves a modulator stage null and produces a week that looks
 * completely plausible while ignoring a broken foot; deriving nutrition from
 * completions produces a number that looks plausible and tells a cutting
 * athlete they overate on a day they did exactly as they were told.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db";
import { conditions, dailyCheckIns, goals, physiqueEntries, preferences, sessionCompletions, trainingSessions } from "@shared/schema";
import { addDays, startOfWeek, todayISO } from "@shared/dates";
import { MODULATOR_STAGES, modulatorFor } from "@shared/prescription/adjust";
import { createGoal } from "./goalsService";
import { openCondition } from "./conditionsService";
import { recordCompletion } from "./completionsService";
import { updateBlockPreferences } from "./preferencesService";
import { buildWeek } from "./weekService";

for (const table of [goals, conditions, dailyCheckIns, physiqueEntries, sessionCompletions, trainingSessions, preferences]) {
  db.delete(table).run();
}

/*
 * The real current week, not a fixed date in the future.
 *
 * A condition goes stale 28 days after its last edit (DECISIONS C10), and
 * staleness is measured against the wall clock the row was written with — so
 * a test that opens an injury and then asks about a week in 2027 gets a
 * condition the engine has correctly stopped trusting, and pins the opposite
 * of what it meant to.
 */
const TODAY = startOfWeek(todayISO());
const WEEK_END = addDays(TODAY, 6);

function marathon() {
  return createGoal({
    type: "endurance_race",
    discipline: "run",
    label: "Spring marathon",
    targetDate: addDays(TODAY, 90),
    priority: 1,
    successCriteria: "Finish under 3:30",
  });
}

test("every modulator stage is registered — a null stage is a slice that silently never runs", () => {
  for (const stage of MODULATOR_STAGES) {
    assert.ok(modulatorFor(stage), `the ${stage} stage has no modulator: weekService's side-effect import is missing`);
  }
});

test("the week carries the adjusted sessions plus what the layer changed", () => {
  marathon();
  const week = buildWeek({ date: TODAY, today: TODAY });

  assert.equal(week.weekStart, TODAY);
  assert.equal(week.days.length, 7);
  assert.ok(week.days.some((d) => d.sessions.length > 0), "a live goal should produce sessions");
  assert.ok(Array.isArray(week.adjustments));
  assert.ok(Array.isArray(week.dropped));
  assert.equal(typeof week.original.totalMinutes, "number");
  assert.equal(typeof week.original.totalTss, "number");
  assert.ok(week.phaseName.length > 0);
  assert.deepEqual(week.conditions, { open: [], ramping: [], suspended: [] });
  assert.equal(week.checkIn, null);
  assert.equal(week.readiness, null);
});

test("DECISIONS B6: skipping a session does NOT lower that day's calorie target", () => {
  const before = buildWeek({ date: TODAY, today: TODAY });
  const day = before.days.find((d) => d.sessions.length > 0)!;
  const session = day.sessions[0]!;

  recordCompletion({ date: session.date, kind: session.kind, status: "skipped", reason: "time" });

  const after = buildWeek({ date: TODAY, today: TODAY });
  const sameDay = after.days.find((d) => d.date === day.date)!;

  assert.equal(sameDay.dailyTss, day.dailyTss, "planned load must not follow performance");
  assert.deepEqual(sameDay.nutrition, day.nutrition, "the athlete already ate to this number");
  assert.equal(sameDay.sessions[0]!.completion?.status, "skipped", "the skip is still on record");
  assert.equal(after.adherence.skipped, 1);
});

test("DECISIONS B7: a session the layer drops stays tickable, and stays ticked", () => {
  // A fever rests the day outright; every session it removes lands in `dropped`.
  openCondition(
    { kind: "illness", label: "Flu", severity: 3, openedAt: TODAY },
    { today: TODAY },
  );

  const withFever = buildWeek({ date: TODAY, today: TODAY });
  assert.ok(withFever.dropped.length > 0, "a rest-only illness should drop the week's sessions");
  assert.ok(
    withFever.adjustments.some((a) => a.source === "condition"),
    "the changes panel must be able to say why",
  );

  const droppedSession = withFever.dropped.find((s) => s.completion === null)!;
  // The "actually, I did this" path: a date+kind that is NOT in the adjusted week.
  const recorded = recordCompletion({ date: droppedSession.date, kind: droppedSession.kind, status: "completed", rpe: 4 });
  assert.equal(recorded.status, "completed");

  const after = buildWeek({ date: TODAY, today: TODAY });
  const stillThere =
    after.days.flatMap((d) => d.sessions).find((s) => s.date === droppedSession.date && s.kind === droppedSession.kind) ??
    after.dropped.find((s) => s.date === droppedSession.date && s.kind === droppedSession.kind);
  assert.ok(stillThere, "the session the athlete answered must still be somewhere they can see it");
  assert.equal(stillThere!.completion?.status, "completed", "an answered session is immune to the layer");

  db.delete(conditions).run();
  db.delete(sessionCompletions).run();
});

test("an open injury reaches the week: conditions are reported and the goal carries its risk", () => {
  openCondition(
    { kind: "injury", label: "Left calf strain", bodyPart: "calf", severity: 2, openedAt: TODAY },
    { today: TODAY },
  );

  const week = buildWeek({ date: TODAY, today: TODAY });
  assert.equal(week.conditions.open.length, 1);
  assert.equal(week.conditions.open[0]!.label, "Left calf strain");

  const phase = week.arbitrated.goalPhases.find((p) => p.phaseName !== "past")!;
  assert.ok(phase.risk, "a live goal should carry its risk once there is health history");
  assert.ok(phase.risk!.note.includes("Spring marathon"));
});

test("switching the conditions block off switches the behaviour off, through the same rule that hides it", () => {
  const on = buildWeek({ date: TODAY, today: TODAY });
  assert.ok(on.conditions.open.length > 0);

  updateBlockPreferences({ "plan.conditions": "off" });
  const off = buildWeek({ date: TODAY, today: TODAY });
  assert.deepEqual(off.conditions, { open: [], ramping: [], suspended: [] });
  assert.equal(
    off.adjustments.filter((a) => a.source === "condition").length,
    0,
    "a block the athlete switched off must not still be steering the week",
  );

  updateBlockPreferences({ "plan.conditions": null });
  db.delete(conditions).run();
});

test("browsing next week does not apply this morning's state to it", () => {
  const next = buildWeek({ date: addDays(WEEK_END, 1), today: TODAY });
  assert.equal(next.weekStart, addDays(TODAY, 7));
  assert.equal(next.readiness, null);
});
