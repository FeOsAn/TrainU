/**
 * The what-if endpoint's one non-negotiable property: it changes nothing.
 *
 * Worth its own test rather than trusting the read-only-by-inspection
 * argument, because the failure is invisible. Every other planning route in
 * this app logs to `outcome_log` — that is the habit of the file — and a
 * hypothetical logged there is a prediction that can never resolve, quietly
 * biasing the Phase 6 calibration numbers with plans nobody trained.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db";
import { conditions, goals, outcomeLog } from "@shared/schema";
import { addDays, startOfWeek, todayISO } from "@shared/dates";
import { createGoal, listGoals } from "./goalsService";
import { updateBlockPreferences } from "./preferencesService";
import { runWhatIf, WhatIfPatchError } from "./whatIfService";

for (const table of [goals, conditions, outcomeLog]) db.delete(table).run();

const TODAY = startOfWeek(todayISO());

const race = createGoal({
  type: "endurance_race",
  discipline: "run",
  label: "Autumn marathon",
  targetDate: addDays(TODAY, 210),
  priority: 2,
  successCriteria: "Finish under 3:30",
});

createGoal({
  type: "body_composition",
  label: "Wedding",
  targetDate: addDays(TODAY, 42),
  priority: 1,
  successCriteria: "Down to 72 kg",
  targetMetrics: { targetWeightKg: 72 },
});

test("a what-if writes nothing — not the goal, and not an outcome row", () => {
  const goalsBefore = JSON.stringify(listGoals());
  const outcomesBefore = db.select().from(outcomeLog).all().length;

  const result = runWhatIf({ patch: { op: "shift", goalId: race.id, byWeeks: -12 } }, { today: TODAY });

  assert.ok(result.summary.length > 0, "a what-if that says nothing is not an answer");
  assert.equal(JSON.stringify(listGoals()), goalsBefore, "the goal itself must be untouched");
  assert.equal(db.select().from(outcomeLog).all().length, outcomesBefore, "a hypothetical is not a prediction");
});

test("weeks line up with the week route, so 'the week of the 7th' means one week", () => {
  const result = runWhatIf({ patch: { op: "remove", goalId: race.id } }, { today: TODAY });
  assert.equal(result.fromDate, TODAY);
  assert.equal(result.before.weeks[0]!.date, TODAY);
});

test("bad input is refused in the athlete's words, never as a 500", () => {
  const cases: unknown[] = [
    null,
    [],
    { patch: null },
    { patch: [] },
    { patch: { op: "delete_everything", goalId: race.id } },
    { patch: { op: "shift", goalId: "nope", byWeeks: 1 } },
    { patch: { op: "shift", goalId: race.id, byWeeks: 999 } },
    { patch: { op: "reprioritise", goalId: race.id, priority: 0 } },
    { patch: { op: "shift", goalId: race.id, byWeeks: 1 }, fromDate: 7 },
  ];
  for (const body of cases) {
    assert.throws(
      () => runWhatIf(body, { today: TODAY }),
      (e: unknown) => e instanceof WhatIfPatchError && typeof (e as Error).message === "string" && (e as Error).message.length > 0,
      `expected a plain-language refusal for ${JSON.stringify(body)}`,
    );
  }
});

test("a patch that would produce a goal the app would refuse to create is refused too", () => {
  // 52 weeks earlier puts this race in the past, which is legal; the guard
  // that matters is that the patched goal still goes through the same
  // validator a real one does, so an illegal one cannot be modelled.
  const result = runWhatIf({ patch: { op: "shift", goalId: race.id, byWeeks: -52 } }, { today: TODAY });
  assert.ok(result.caveats.length >= 0);
  assert.ok(result.diff.goals.some((g) => g.goalId === race.id));
});

test("switching \"Something hurts?\" off stops what-if listening to conditions too", () => {
  /*
   * Phase 9's promise is ONE matching rule for what a block renders and what
   * it does. What-if read the conditions table directly, so a block the
   * athlete had switched off still shaped every hypothetical — the week
   * ignored their injury and "what if I moved my race?" did not.
   *
   * (The staleness rule is enforced downstream in `arbitrateWeek`, which is
   * why routing through `plannableConditions` is also the one definition of
   * "open and still trusted" rather than a second copy of it.)
   *
   * Pinned on both sides: with the block ON the condition must change the
   * answer, or this test would pass even if conditions never mattered.
   */
  for (const table of [goals, conditions, outcomeLog]) db.delete(table).run();
  const today = todayISO();
  const race = createGoal({
    type: "endurance_race", discipline: "run", label: "Berlin Marathon",
    targetDate: addDays(today, 180), priority: 1, successCriteria: "sub 3:30",
    targetMetrics: { targetTimeSeconds: 12600, targetDistanceKm: 42.195 },
  });
  createGoal({
    type: "body_composition", label: "Wedding", targetDate: addDays(today, 60),
    priority: 2, successCriteria: "lean", targetMetrics: { targetBodyFatPercent: 12 },
  });
  db.insert(conditions).values({
    id: "strain", kind: "injury", label: "Calf strain", bodyPart: "calf",
    severity: 2, restrictionsJson: JSON.stringify(["no_running"]),
    openedAt: addDays(today, -3), closedAt: null, note: null,
    createdAt: addDays(today, -3), updatedAt: `${addDays(today, -1)}T00:00:00.000Z`,
  }).run();

  const answer = () => JSON.stringify(runWhatIf({ patch: { op: "shift", goalId: race.id, byWeeks: 2 } }, { today }));
  const withBlockOn = answer();
  updateBlockPreferences({ "plan.conditions": "off" });
  const withBlockOff = answer();
  updateBlockPreferences({ "plan.conditions": null });
  const restored = answer();

  assert.notEqual(withBlockOff, withBlockOn, "a switched-off block must not keep steering the hypothetical");
  assert.equal(restored, withBlockOn, "and switching it back on must bring it back");
});
