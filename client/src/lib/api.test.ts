import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { ENGINE_ANSWER_KEYS, invalidateEngineAnswer } from "./api";

/*
 * Defect: logging an injury invalidated ["conditions"] and ["week"] but not
 * ["plan"], so the DECISIONS B5 explanation — "your cut is paused while the
 * calf strain is open" — never reached the screen. The stance flipped
 * Deficit → Maintenance in the accent panel and the "Tradeoffs being made"
 * panel directly below it, which is fed ONLY by ["plan"], went on showing
 * the pre-injury list until a reload.
 *
 * Nothing caught it because the three mutations each carried their own
 * hand-written key list, and there are no client tests. This pins the list
 * itself: week and plan travel together, out of one place.
 */

function seeded(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of [["week"], ["plan"], ["conditions"], ["preferences"], ["physique"], ["athlete"], ["goals"]]) {
    qc.setQueryData(key, { seeded: true });
  }
  return qc;
}

const stale = (qc: QueryClient, key: string[]) => qc.getQueryState(key)?.isInvalidated === true;

test("defect: the explanation is refetched with the plan it explains — ['plan'] is never left behind", () => {
  const qc = seeded();
  // Exactly what ConditionsPanel's create / close / still-true now call.
  invalidateEngineAnswer(qc, ["conditions"]);

  assert.equal(stale(qc, ["week"]), true, "the sessions and the stance");
  assert.equal(stale(qc, ["plan"]), true, "the GoalConflict that explains them (B5)");
  assert.equal(stale(qc, ["conditions"]), true, "the panel's own list");
});

test("the pair is one list, so a caller cannot ask for half of it", () => {
  assert.deepEqual(
    ENGINE_ANSWER_KEYS.map((k) => [...k]),
    [["week"], ["plan"]],
  );
});

test("boundary: nothing else is invalidated — this is not a blanket refetch", () => {
  const qc = seeded();
  invalidateEngineAnswer(qc, ["conditions"]);

  assert.equal(stale(qc, ["goals"]), false);
  assert.equal(stale(qc, ["athlete"]), false);
  assert.equal(stale(qc, ["preferences"]), false);
});

test("a weigh-in moves the plan too, and ['physique'] is a PREFIX so each goal's progress goes with it", () => {
  const qc = seeded();
  qc.setQueryData(["physique", "progress", "goal_1"], { seeded: true });
  // PhysiquePanel's invalidate(), on both save and delete.
  invalidateEngineAnswer(qc, ["physique"], ["athlete"]);

  assert.equal(stale(qc, ["plan"]), true);
  assert.equal(stale(qc, ["physique"]), true);
  assert.equal(stale(qc, ["physique", "progress", "goal_1"]), true);
  assert.equal(stale(qc, ["athlete"]), true);
});
