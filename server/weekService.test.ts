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
import { upsertCheckIn } from "./checkInsService";
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

/*
 * ─── Regressions ──────────────────────────────────────────────────────────
 */

test("DEFECT: adherence never counts the app's OWN rest days as sessions the athlete failed to do", () => {
  // A fever on the week's first day turns every day into a rest card. The
  // denominator used to be `adjusted.sessions.length`, which counts those
  // synthetic rest sessions — so an athlete resting exactly as instructed
  // read "Adherence 0% — 0 done, 0 skipped of 5 prescribed". A rest card
  // cannot be ticked; nothing was asked of them, and the honest answer is
  // "no rate yet", not zero. This is the number the deferred learners are
  // meant to be built on.
  openCondition({ kind: "illness", label: "Flu", severity: 3, openedAt: TODAY }, { today: TODAY });

  const ill = buildWeek({ date: TODAY, today: TODAY });
  assert.ok(
    ill.days.flatMap((d) => d.sessions).every((s) => s.kind === "rest"),
    "a severity-3 illness rests the whole week",
  );
  assert.equal(ill.adherence.prescribed, 0, "a rest day is not something asked of the athlete");
  assert.equal(ill.adherence.adherenceRate, null, "nothing asked is not the same as nothing done");

  // DECISIONS B7: a dropped session the athlete did anyway counts on BOTH
  // sides. It is not in `adjusted.sessions` at all, so a denominator built
  // from that alone with a numerator built from completions gives 1/0.
  const dropped = ill.dropped[0]!;
  recordCompletion({ date: dropped.date, kind: dropped.kind, status: "completed" });

  const after = buildWeek({ date: TODAY, today: TODAY });
  assert.equal(after.adherence.prescribed, 1);
  assert.equal(after.adherence.completed, 1);
  assert.equal(after.adherence.adherenceRate, 1, "one session asked of them, one done — never 133%, never a divide by zero");

  db.delete(conditions).run();
  db.delete(sessionCompletions).run();
});

test("DEFECT: yesterday's check-in adjustment does not evaporate at midnight", () => {
  const tuesday = addDays(TODAY, 1);
  const wednesday = addDays(TODAY, 2);

  // Six ordinary mornings first: below five check-ins readiness reports but
  // does not act (DECISIONS C2), so without these the slice is inert and the
  // test would pin nothing. The fixtures that missed this defect had exactly
  // one check-in, dated today.
  for (let back = 8; back >= 3; back--) {
    upsertCheckIn({ date: addDays(TODAY, -back), sleepQuality: 3, soreness: 3, energy: 3 });
  }
  upsertCheckIn({ date: tuesday, sleepQuality: 1, soreness: 5, energy: 1 });

  const onTuesday = buildWeek({ date: TODAY, today: tuesday });
  const tuesdayAsLived = onTuesday.days.find((d) => d.date === tuesday)!;
  assert.ok(
    tuesdayAsLived.sessions.length > 0 && tuesdayAsLived.sessions.every((s) => s.kind === "rest"),
    "a very low morning rests the day",
  );
  const droppedOnTuesday = onTuesday.dropped.filter((s) => s.date === tuesday).map((s) => s.kind);
  assert.ok(droppedOnTuesday.length > 0, "what was planned stays recoverable (B7)");

  // Wednesday. The week re-derives from scratch, and Tuesday used to come
  // back as a full threshold run the athlete never did: no reason text, no
  // "actually, I did this" control, rest-day macros replaced by training-day
  // ones, and the adherence line counting the session the app itself removed
  // as one they failed to do.
  const onWednesday = buildWeek({ date: TODAY, today: wednesday });
  const tuesdayLater = onWednesday.days.find((d) => d.date === tuesday)!;
  assert.ok(tuesdayLater.sessions.every((s) => s.kind === "rest"), "Tuesday's rest day is still Tuesday's rest day");
  assert.deepEqual(
    onWednesday.dropped.filter((s) => s.date === tuesday).map((s) => s.kind),
    droppedOnTuesday,
    "the session the layer removed stays tickable after midnight",
  );
  assert.deepEqual(tuesdayLater.nutrition, tuesdayAsLived.nutrition, "the athlete ate to the number the app gave them");
  assert.equal(tuesdayLater.dailyTss, tuesdayAsLived.dailyTss);
  assert.equal(onWednesday.totalMinutes, onTuesday.totalMinutes);
  assert.equal(onWednesday.adherence.prescribed, onTuesday.adherence.prescribed, "no phantom missed session");
  assert.ok(
    onWednesday.adjustments.some((a) => a.date === tuesday && a.source === "checkin"),
    "and the changes panel can still say why",
  );

  // A past morning may only take load away where it stood: nothing it does
  // may put a session on a day the athlete has also already lived through.
  for (const date of [tuesday, wednesday]) {
    const then = onTuesday.days.find((d) => d.date === date)!.sessions.length;
    const now = onWednesday.days.find((d) => d.date === date)!.sessions.length;
    assert.ok(now <= then, `replaying a past morning invented a session on ${date}`);
  }

  // The far side of the boundary: a morning that has not happened cannot act
  // on the week, however bad it says it was.
  upsertCheckIn({ date: addDays(TODAY, 4), sleepQuality: 1, soreness: 5, energy: 1 });
  const stillMonday = buildWeek({ date: TODAY, today: TODAY });
  assert.equal(
    stillMonday.adjustments.filter((a) => a.source === "checkin").length,
    0,
    "Friday's check-in cannot rest Friday while it is still Monday",
  );

  db.delete(dailyCheckIns).run();
});
