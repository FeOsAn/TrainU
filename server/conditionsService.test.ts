import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConditionNotFoundError,
  InvalidConditionError,
  closeCondition,
  getCondition,
  listConditions,
  openCondition,
  patchCondition,
  reopenCondition,
} from "./conditionsService";
import { isOpenOn, isSuspended, rampStageOn } from "@shared/conditions";

const TODAY = "2026-09-18";

/**
 * Labels are tagged per run so the file is safe to run twice against the same
 * database file — a test that only passes on a freshly deleted DB is a test
 * that will one day fail for a reason that has nothing to do with the code.
 */
const RUN = Math.random().toString(36).slice(2, 8);
const tag = (name: string) => `${RUN} ${name}`;

function open(over: Record<string, unknown> = {}, opts: { today?: string } = {}) {
  return openCondition({ kind: "injury", label: "Left calf strain", bodyPart: "calf", severity: 2, restrictions: ["no_running"], ...over }, { today: TODAY, ...opts });
}

test("opening a condition stores exactly what was confirmed, and reads back the same", () => {
  const c = open({ label: "Right hamstring", note: "Felt it on the last rep." });
  assert.equal(c.closedAt, null, "a new condition is open — the app never pre-closes one");
  assert.equal(c.openedAt, TODAY);
  assert.deepEqual(c.restrictions, ["no_running"]);

  const read = getCondition(c.id)!;
  assert.deepEqual(read, c, "what comes out of the database is what went in");
});

test("the write path validates: a hallucinated severity never reaches a row", () => {
  assert.throws(() => open({ severity: 9 }), InvalidConditionError);
  assert.throws(() => open({ kind: "curse" }), InvalidConditionError);
  assert.throws(() => open({ restrictions: ["no_sprinting"] }), InvalidConditionError);
  assert.throws(() => openCondition("my calf hurts", { today: TODAY }), InvalidConditionError);
});

test("a tick-off can open a condition, and says which session it came from", () => {
  // The link itself is not stored yet (no column) — what matters here is that
  // the call is accepted and validated rather than silently mangling the row.
  const c = open({ label: "Achilles twinge" }, {});
  const fromTickOff = openCondition(
    { kind: "injury", label: "Sore knee", severity: 1, restrictions: [] },
    { today: TODAY, sourceCompletionKey: "2026-09-17#run_long" },
  );
  assert.equal(fromTickOff.label, "Sore knee");
  assert.notEqual(fromTickOff.id, c.id);
  assert.throws(
    () => openCondition({ kind: "injury", label: "Sore knee", severity: 1 }, { today: TODAY, sourceCompletionKey: 17 as never }),
    InvalidConditionError,
  );
});

test("marking it healed closes it on the date the athlete gives, and the ramp starts the day after", () => {
  const c = open({ label: "Calf — healed test", openedAt: "2026-09-08" });
  const closed = closeCondition(c.id, "2026-09-14", TODAY);
  assert.equal(closed.closedAt, "2026-09-14");
  assert.equal(isOpenOn(closed, "2026-09-14"), true);
  assert.equal(isOpenOn(closed, "2026-09-15"), false);
  assert.ok(rampStageOn(closed, "2026-09-15"), "the return starts the day after it closed");
  assert.equal(getCondition(c.id)!.closedAt, "2026-09-14", "it persisted, not just returned");
});

test("closing an already-closed condition corrects the date instead of erroring", () => {
  const c = open({ label: tag("Cold — correction test"), kind: "illness", bodyPart: null, restrictions: [], openedAt: "2026-09-05" });
  closeCondition(c.id, "2026-09-10", TODAY);
  const corrected = closeCondition(c.id, "2026-09-12", TODAY);
  assert.equal(corrected.closedAt, "2026-09-12", "the athlete is telling the app something truer than what it had");
  assert.equal(listConditions().filter((x) => x.label === tag("Cold — correction test")).length, 1, "correcting must not create a duplicate");
});

test("a close date before the start, or in the future, is refused", () => {
  const c = open({ label: "Shin — bad dates", openedAt: "2026-09-10" });
  assert.throws(() => closeCondition(c.id, "2026-09-01", TODAY), InvalidConditionError);
  assert.throws(() => closeCondition(c.id, "2026-12-01", TODAY), InvalidConditionError);
  assert.equal(getCondition(c.id)!.closedAt, null, "a refused close leaves the row untouched");
});

test("patching changes only what was asked for, and moves updatedAt so a stale condition becomes trusted again", () => {
  const c = open({ label: "Hip — patch test", openedAt: "2026-08-01" });
  // Pretend nobody has touched it for weeks.
  const stale = { ...c, updatedAt: "2026-08-01T07:00:00.000Z" };
  assert.equal(isSuspended(stale, TODAY), true);

  const patched = patchCondition(c.id, { severity: 1, restrictions: ["no_impact"] }, TODAY);
  assert.equal(patched.severity, 1);
  assert.deepEqual(patched.restrictions, ["no_impact"]);
  assert.equal(patched.label, "Hip — patch test", "an unmentioned field is left alone");
  assert.equal(patched.openedAt, "2026-08-01");
  assert.equal(isSuspended(patched, TODAY), false, "confirming it is still true is what un-suspends it");
});

test("patching an unknown field, or an unknown condition, fails loudly", () => {
  const c = open({ label: "Knee — reject test" });
  assert.throws(() => patchCondition(c.id, { kind: "illness" }, TODAY), InvalidConditionError);
  assert.throws(() => patchCondition(c.id, { severity: 4 }, TODAY), InvalidConditionError);
  assert.throws(() => patchCondition("no-such-id", { severity: 1 }, TODAY), ConditionNotFoundError);
  assert.throws(() => closeCondition("no-such-id", TODAY, TODAY), ConditionNotFoundError);
});

test("reopening undoes a close the athlete ticked too early", () => {
  const c = open({ label: "Foot — reopen test", openedAt: "2026-09-02" });
  closeCondition(c.id, "2026-09-09", TODAY);
  const reopened = reopenCondition(c.id, TODAY);
  assert.equal(reopened.closedAt, null);
  assert.equal(rampStageOn(reopened, "2026-09-11"), null, "no return-to-training ramp while it is open again");
});

test("listing filters by open, by date, and by how long ago it healed", () => {
  open({ label: tag("Filter — still open"), openedAt: "2026-09-12" });
  const recent = open({ label: tag("Filter — healed recently"), openedAt: "2026-09-01" });
  closeCondition(recent.id, "2026-09-05", TODAY);
  const ancient = open({ label: tag("Filter — healed long ago"), openedAt: "2026-01-02" });
  closeCondition(ancient.id, "2026-01-10", TODAY);

  const labels = (filter: Parameters<typeof listConditions>[0]) =>
    listConditions(filter).map((c) => c.label).filter((l) => l.startsWith(`${RUN} Filter`));

  assert.deepEqual(labels({ openOnly: true }), [tag("Filter — still open")]);
  assert.deepEqual(labels({ openOn: "2026-09-03" }), [tag("Filter — healed recently")], "per DATE, not per today");
  assert.deepEqual(labels({ openOn: "2026-09-06" }), [], "it was already healed by then");
  assert.deepEqual(
    labels({ closedOnOrAfter: "2026-07-20" }).sort(),
    [tag("Filter — healed recently"), tag("Filter — still open")].sort(),
    "something healed eight months ago cannot still be in a ramp, so it is never loaded",
  );
  assert.equal(labels({}).length, 3);
  assert.equal(labels({})[0], tag("Filter — still open"), "newest first — the athlete reads what just happened at the top");
});

test("a note and a null body part round-trip without becoming empty strings", () => {
  const c = open({ label: "Round trip", kind: "illness", bodyPart: null, restrictions: "none", note: "Started Tuesday night." });
  const read = getCondition(c.id)!;
  assert.equal(read.bodyPart, null);
  assert.deepEqual(read.restrictions, []);
  assert.equal(read.note, "Started Tuesday night.");
});
