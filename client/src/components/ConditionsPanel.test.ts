import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { equipmentChoices } from "./ConditionsPanel";
import type { Goal } from "@shared/goal";

const TODAY = "2026-09-20";
const NONE = { physiqueTracking: false, hasBike: false, hasPool: false };

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g1",
    type: "endurance_race",
    discipline: "run",
    label: "Berlin marathon",
    targetDate: "2026-11-01",
    priority: 1,
    successCriteria: "sub 3:30",
    targetMetrics: {},
    active: true,
    createdAt: `${TODAY}T00:00:00.000Z`,
    ...over,
  } as Goal;
}

/*
 * Defect: the "I have a bike" / "I can get to a pool" checkboxes READ a
 * derived value (`crossTrainingAvailability`, which ORs in a live triathlon
 * or cycling goal) and WROTE a raw preference. For a triathlete the read
 * side was pinned true, so the box sprang back on every tap and the engine
 * kept prescribing rides the athlete could not do.
 *
 * The tests that existed could not see it: `shared/conditions.test.ts`
 * exercises `crossTrainingAvailability` itself, where an OR is correct
 * behaviour. The bug is in the binding, and there were no client tests.
 */

test("defect: a triathlete's bike box is not an inert control that springs back", () => {
  const tri = goal({ id: "tri", discipline: "triathlon", label: "Ironman 70.3" });
  const choices = equipmentChoices([tri], NONE, TODAY);

  // Still ticked, because the engine really will substitute rides…
  assert.equal(choices.bike.checked, true);
  // …but the reason is a GOAL, and the panel now says so instead of offering
  // a tap that changes nothing. Named in the athlete's words, never by
  // discipline id (DECISIONS C7).
  assert.equal(choices.bike.impliedBy, "Ironman 70.3");
  assert.equal(choices.swim.impliedBy, "Ironman 70.3");
});

test("boundary: a runner's boxes are their own answer — read and write are the same value", () => {
  const run = goal({});
  assert.deepEqual(equipmentChoices([run], NONE, TODAY).bike, { checked: false, impliedBy: null });
  assert.deepEqual(equipmentChoices([run], { ...NONE, hasBike: true }, TODAY).bike, { checked: true, impliedBy: null });
  // …and it stays interactive, so unticking it actually unticks it.
  assert.deepEqual(equipmentChoices([run], { ...NONE, hasBike: true, hasPool: true }, TODAY).swim, {
    checked: true,
    impliedBy: null,
  });
});

test("boundary: a triathlon that has already happened proves nothing about today", () => {
  const past = goal({ id: "tri", discipline: "triathlon", label: "Ironman 70.3", targetDate: "2026-09-19" });
  const choices = equipmentChoices([past], NONE, TODAY);
  assert.equal(choices.bike.impliedBy, null, "yesterday's race does not hold the box");
  assert.equal(choices.bike.checked, false);

  const inactive = goal({ id: "tri", discipline: "triathlon", label: "Ironman 70.3", active: false });
  assert.equal(equipmentChoices([inactive], NONE, TODAY).bike.impliedBy, null);
});

test("defect: every invalidation in this panel goes through the one shared list", () => {
  // The three condition mutations each carried their own hand-written key
  // list, and one of them was missing ["plan"] (see lib/api.test.ts). One
  // list means they cannot drift apart again.
  const src = readFileSync(new URL("./ConditionsPanel.tsx", import.meta.url), "utf8");
  assert.equal(
    /invalidateQueries\(/.test(src),
    false,
    "use invalidateEngineAnswer() — a hand-written key list here is how the B5 explanation went missing",
  );
});
