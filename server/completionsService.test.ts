import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidCompletionError, listCompletions, loggedSessionsFor, recordCompletion, summariseAdherence } from "./completionsService";
import { sessionCompletionKey, type PlannedSession } from "@shared/prescription/sessionKinds";
import { followUpFor, type CompletionRecord } from "@shared/prescription/completion";
import { DEFAULT_ATHLETE } from "@shared/athlete";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { trainingSessions } from "@shared/schema";

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
    { key: "a", date: "2026-10-01", kind: "run_easy", status: "completed", reason: null, rpe: null, note: null, sessionId: null, recordedAt: "", prescribed: null },
    { key: "b", date: "2026-10-02", kind: "run_long", status: "partial", reason: null, rpe: null, note: null, sessionId: null, recordedAt: "", prescribed: null },
    { key: "c", date: "2026-10-03", kind: "strength_lower", status: "skipped", reason: null, rpe: null, note: null, sessionId: null, recordedAt: "", prescribed: null },
  ];
  const summary = summariseAdherence(records as CompletionRecord[], 5);
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

// ------------------------------------------------- patch semantics (F1)

test("a second tap adds a reason without erasing the effort rating from the first", () => {
  // The whole point of patch semantics: Done is one tap, RPE and reason are
  // optional second taps that must not clear each other.
  recordCompletion({ date: "2027-01-04", kind: "run_threshold", status: "partial", rpe: 8 });
  const withReason = recordCompletion({ date: "2027-01-04", kind: "run_threshold", status: "partial", reason: "time" });
  assert.equal(withReason.rpe, 8, "an absent rpe must KEEP the stored one, not clear it");
  assert.equal(withReason.reason, "time");

  const withNote = recordCompletion({ date: "2027-01-04", kind: "run_threshold", status: "partial", note: "cut the last two reps" });
  assert.equal(withNote.rpe, 8);
  assert.equal(withNote.reason, "time");
  assert.equal(withNote.note, "cut the last two reps");
});

test("an explicit null clears a field, which absence deliberately does not", () => {
  recordCompletion({ date: "2027-01-05", kind: "run_easy", status: "completed", rpe: 5, note: "legs ok" });
  const cleared = recordCompletion({ date: "2027-01-05", kind: "run_easy", status: "completed", rpe: null });
  assert.equal(cleared.rpe, null);
  assert.equal(cleared.note, "legs ok", "clearing one field must not clear the others");
});

test("flipping the status clears what the new status forbids", () => {
  recordCompletion({ date: "2027-01-06", kind: "run_long", status: "skipped", reason: "injury" });
  const done = recordCompletion({ date: "2027-01-06", kind: "run_long", status: "completed" });
  assert.equal(done.reason, null, "a session that happened carries no skip reason");
  assert.equal(followUpFor(done), null, "and the injury handoff disappears with it");

  recordCompletion({ date: "2027-01-07", kind: "run_easy", status: "completed", rpe: 7 });
  const skipped = recordCompletion({ date: "2027-01-07", kind: "run_easy", status: "skipped", reason: "travel" });
  assert.equal(skipped.rpe, null, "a session that never happened has no effort rating");
  assert.equal(skipped.reason, "travel");
});

test("an explicit contradiction is rejected rather than quietly dropped", () => {
  assert.throws(() => recordCompletion({ date: "2027-01-08", kind: "run_easy", status: "skipped", rpe: 6 }), InvalidCompletionError);
  assert.throws(() => recordCompletion({ date: "2027-01-08", kind: "run_easy", status: "completed", reason: "travel" }), InvalidCompletionError);
  assert.throws(() => recordCompletion({ date: "2027-01-08", kind: "run_easy", status: "skipped", reason: "hungover" as any }), InvalidCompletionError);
  assert.throws(() => recordCompletion({ date: "2027-01-08", kind: "run_easy", status: "completed", rpe: 4.5 }), InvalidCompletionError);
  assert.equal(listCompletions("2027-01-08", "2027-01-08").length, 0, "a rejected tap writes nothing");
});

test("the reason round-trips, and an unrecognised stored one reads as null", () => {
  const r = recordCompletion({ date: "2027-01-09", kind: "run_easy", status: "skipped", reason: "illness" });
  assert.equal(r.reason, "illness");
  assert.equal(listCompletions("2027-01-09", "2027-01-09")[0]!.reason, "illness");
  assert.equal(followUpFor(r)!.reason, "illness");

  db.run(sql`UPDATE session_completions SET reason = 'hangover' WHERE key = ${sessionCompletionKey("2027-01-09", "run_easy")}`);
  assert.equal(listCompletions("2027-01-09", "2027-01-09")[0]!.reason, null, "an unknown string must not leak out as a signal");
});

test("the prescription snapshot still survives a reason-only second tap", () => {
  recordCompletion({
    date: "2027-01-10",
    kind: "run_intervals",
    status: "partial",
    prescribed: prescribed({ date: "2027-01-10", kind: "run_intervals", targets: ["6 x 800m @ 4:05/km"] }),
  });
  const patched = recordCompletion({ date: "2027-01-10", kind: "run_intervals", status: "partial", reason: "fatigue" });
  assert.deepEqual(patched.prescribed!.targets, ["6 x 800m @ 4:05/km"]);
});

// ------------------------------------------------------ actual load (F1)

test("adherence reports actual TSS only when it has the athlete's numbers to price with", () => {
  const records = listCompletions("2027-02-01", "2027-02-07");
  assert.equal(summariseAdherence(records, 5).actualTss, null, "no athlete, no number — and null, not 0");

  recordCompletion({
    date: "2027-02-02",
    kind: "run_easy",
    status: "completed",
    rpe: 7,
    prescribed: prescribed({ date: "2027-02-02", durationMinutes: 60, tss: 51 }),
  });
  const withRow = listCompletions("2027-02-01", "2027-02-07");
  const summary = summariseAdherence(withRow, 5, DEFAULT_ATHLETE);
  assert.ok(summary.actualTss! > 0, "the reported RPE must be READ by something, not merely stored");
  assert.equal(summary.completed, 1);
  assert.equal(summary.adherenceRate, 0.2);
});

test("a completion linked to a logged session is priced off the real row, not the plan", () => {
  db.insert(trainingSessions)
    .values({ id: "logged-1", date: "2027-03-01", sport: "run", source: "manual", durationMinutes: 110, avgHeartRate: 168 })
    .run();
  recordCompletion({
    date: "2027-03-01",
    kind: "run_long",
    status: "completed",
    sessionId: "logged-1",
    prescribed: prescribed({ date: "2027-03-01", kind: "run_long", durationMinutes: 60, tss: 51 }),
  });
  const records = listCompletions("2027-03-01", "2027-03-01");
  const logged = loggedSessionsFor(records);
  assert.equal(logged.size, 1);
  const fromPlan = summariseAdherence(records, 1, DEFAULT_ATHLETE).actualTss!;
  const fromFile = summariseAdherence(records, 1, DEFAULT_ATHLETE, logged).actualTss!;
  assert.ok(fromFile > fromPlan, "110 real minutes must cost more than the 60 that were planned");
});
