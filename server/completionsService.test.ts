import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidCompletionError, listCompletions, recordCompletion, summariseAdherence } from "./completionsService";
import { sessionCompletionKey, type PlannedSession } from "@shared/prescription/sessionKinds";

function prescribed(over: Partial<PlannedSession> = {}): PlannedSession {
  return {
    date: "2026-09-14",
    kind: "run_easy",
    sport: "run",
    title: "Easy run",
    focus: "Aerobic volume",
    durationMinutes: 50,
    tss: 45,
    intensity: "easy",
    targets: ["5:30/km"],
    servesGoalIds: ["race"],
    note: "For Marathon.",
    ...over,
  };
}

test("records a completion under a stable date#kind key", () => {
  const r = recordCompletion({ date: "2026-09-14", kind: "run_easy", status: "completed", rpe: 4 });
  assert.equal(r.key, sessionCompletionKey("2026-09-14", "run_easy"));
  assert.equal(r.status, "completed");
  assert.equal(r.rpe, 4);
});

test("two sessions on the same day are tracked separately, not collapsed", () => {
  recordCompletion({ date: "2026-09-15", kind: "run_easy", status: "completed" });
  recordCompletion({ date: "2026-09-15", kind: "strength_lower", status: "skipped" });
  const onThatDay = listCompletions("2026-09-15", "2026-09-15");
  assert.equal(onThatDay.length, 2, "ticking the run must not tick the lift");
  assert.equal(onThatDay.find((c) => c.kind === "strength_lower")!.status, "skipped");
});

test("re-ticking corrects the record instead of duplicating it", () => {
  recordCompletion({ date: "2026-09-16", kind: "run_long", status: "skipped" });
  recordCompletion({ date: "2026-09-16", kind: "run_long", status: "completed", rpe: 6 });
  const records = listCompletions("2026-09-16", "2026-09-16").filter((c) => c.kind === "run_long");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "completed");
});

test("the prescription snapshot survives a later correction that doesn't carry one", () => {
  // The plan re-derives from current numbers, so the snapshot is the only
  // record of what was actually asked for at the time.
  recordCompletion({ date: "2026-09-17", kind: "run_threshold", status: "completed", prescribed: prescribed({ date: "2026-09-17", kind: "run_threshold", targets: ["4:41/km"] }) });
  const corrected = recordCompletion({ date: "2026-09-17", kind: "run_threshold", status: "partial" });
  assert.ok(corrected.prescribed, "the original prescription must not be lost by a status correction");
  assert.deepEqual(corrected.prescribed!.targets, ["4:41/km"]);
});

test("rejects a bad date, an unknown kind, an unknown status and an impossible RPE", () => {
  assert.throws(() => recordCompletion({ date: "not-a-date", kind: "run_easy", status: "completed" }), InvalidCompletionError);
  assert.throws(() => recordCompletion({ date: "2026-09-14", kind: "telepathy" as any, status: "completed" }), InvalidCompletionError);
  assert.throws(() => recordCompletion({ date: "2026-09-14", kind: "run_easy", status: "vibes" as any }), InvalidCompletionError);
  assert.throws(() => recordCompletion({ date: "2026-09-14", kind: "run_easy", status: "completed", rpe: 47 }), InvalidCompletionError);
});

test("adherence counts partials as half and measures against what was prescribed", () => {
  const records = [
    { key: "a", date: "2026-10-01", kind: "run_easy", status: "completed", rpe: null, note: null, sessionId: null, recordedAt: "", prescribed: null },
    { key: "b", date: "2026-10-02", kind: "run_long", status: "partial", rpe: null, note: null, sessionId: null, recordedAt: "", prescribed: null },
    { key: "c", date: "2026-10-03", kind: "strength_lower", status: "skipped", rpe: null, note: null, sessionId: null, recordedAt: "", prescribed: null },
  ];
  const summary = summariseAdherence(records, 5);
  assert.equal(summary.completed, 1);
  assert.equal(summary.partial, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.adherenceRate, 0.3, "(1 + 0.5) / 5 prescribed");
});

test("adherence is null rather than 0 when nothing has been prescribed", () => {
  assert.equal(summariseAdherence([], 0).adherenceRate, null);
});

test("listCompletions filters by window", () => {
  recordCompletion({ date: "2026-12-01", kind: "run_easy", status: "completed" });
  const inWindow = listCompletions("2026-12-01", "2026-12-07");
  const outOfWindow = listCompletions("2026-11-01", "2026-11-07");
  assert.ok(inWindow.some((c) => c.date === "2026-12-01"));
  assert.ok(!outOfWindow.some((c) => c.date === "2026-12-01"));
});
