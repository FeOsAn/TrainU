import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { estimateSessionTss } from "../trainingLoad";
import {
  COMPLETION_REASONS,
  COMPLETION_STATUSES,
  HEALTH_REASONS,
  NOTE_MAX_CHARS,
  REASON_LABELS,
  REASON_META,
  REASON_SIGNALS,
  SIGNAL_LABELS,
  STATUS_ALLOWS,
  STATUS_LABELS,
  actualTssFor,
  followUpFor,
  parseReason,
  reasonSignal,
  summariseFeedback,
  validateFeedback,
  type CompletionFeedback,
} from "./completion";
import { sessionCompletionKey, type PlannedSession } from "./sessionKinds";

function prescribed(over: Partial<PlannedSession> = {}): PlannedSession {
  return {
    date: "2026-09-14",
    kind: "run_easy",
    sport: "run",
    title: "Easy run",
    focus: "Aerobic volume",
    durationMinutes: 60,
    tss: 51,
    intensity: "easy",
    targets: ["5:30/km"],
    servesGoalIds: ["race"],
    note: "For Marathon.",
    targetRpe: 4,
    ...over,
  };
}

function feedback(over: Partial<CompletionFeedback> = {}): CompletionFeedback {
  const date = over.date ?? "2026-09-14";
  const kind = over.kind ?? "run_easy";
  return {
    key: sessionCompletionKey(date, kind),
    date,
    kind,
    status: "completed",
    reason: null,
    rpe: null,
    note: null,
    sessionId: null,
    recordedAt: `${date}T18:00:00.000Z`,
    prescribed: prescribed({ date, kind }),
    ...over,
  };
}

// ---------------------------------------------------------------- vocabulary

test("every reason and signal has athlete-facing words, and no label leaks an enum value", () => {
  for (const reason of COMPLETION_REASONS) {
    const label = REASON_META[reason].label;
    assert.ok(label.length > 2, `${reason} needs words`);
    assert.equal(REASON_LABELS[reason], label, "one set of words, not two");
    assert.ok(!label.includes("_"), "a label must never read as an identifier");
    assert.notEqual(label, reason, `${reason} must reach the athlete as words, not as its own identifier`);
    assert.equal(label[0], label[0]!.toUpperCase(), "a label is written for a screen");
  }
  for (const signal of REASON_SIGNALS) assert.ok(SIGNAL_LABELS[signal].length > 2);
  for (const status of COMPLETION_STATUSES) assert.ok(STATUS_LABELS[status].length > 2);
});

test("health reasons are exactly the reasons whose signal is health", () => {
  const derived = COMPLETION_REASONS.filter((r) => REASON_META[r].signal === "health");
  assert.deepEqual([...derived].sort(), [...HEALTH_REASONS].sort());
});

test("a completed row carries no skip signal, whatever a stale reason says", () => {
  assert.equal(reasonSignal({ status: "completed", reason: "injury" }), null);
  assert.equal(reasonSignal({ status: "skipped", reason: "travel" }), "circumstance");
  assert.equal(reasonSignal({ status: "skipped", reason: "injury" }), "health");
  assert.equal(reasonSignal({ status: "partial", reason: "fatigue" }), "recovery");
  assert.equal(reasonSignal({ status: "skipped", reason: null }), "unknown", "not said is not the same as circumstance");
});

test("an unrecognised stored reason maps to null rather than leaking out", () => {
  assert.equal(parseReason("hangover"), null);
  assert.equal(parseReason(null), null);
  assert.equal(parseReason("injury"), "injury");
});

// ---------------------------------------------------------------- validation

test("validateFeedback rejects a bad date, kind, status, rpe, reason and over-long note", () => {
  assert.match(validateFeedback({ date: "nope", kind: "run_easy", status: "completed" })!, /date/);
  assert.match(validateFeedback({ date: "2026-09-14", kind: "telepathy", status: "completed" })!, /kind/);
  assert.match(validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "vibes" })!, /status/);
  assert.match(validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "completed", rpe: 47 })!, /whole number/);
  assert.match(validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "completed", rpe: 4.5 })!, /whole number/);
  assert.ok(validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "skipped", reason: "hungover" }));
  assert.ok(validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "completed", note: "x".repeat(NOTE_MAX_CHARS + 1) }));
  assert.equal(validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "completed", note: "x".repeat(NOTE_MAX_CHARS) }), null);
});

test("the two contradictions are rejected, in words with no enum value in them", () => {
  const rpeOnSkipped = validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "skipped", rpe: 6 })!;
  const reasonOnCompleted = validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "completed", reason: "travel" })!;
  assert.ok(rpeOnSkipped && reasonOnCompleted);
  for (const message of [rpeOnSkipped, reasonOnCompleted]) {
    assert.ok(!/skipped|completed|partial|run_easy/.test(message), `athlete-facing: ${message}`);
  }
  assert.equal(validateFeedback({ date: "2026-09-14", kind: "run_easy", status: "partial", rpe: 6, reason: "time" }), null);
});

test("validateFeedback reads STATUS_ALLOWS rather than restating it", () => {
  for (const status of COMPLETION_STATUSES) {
    const rpeError = validateFeedback({ date: "2026-09-14", kind: "run_easy", status, rpe: 5 });
    assert.equal(rpeError === null, STATUS_ALLOWS[status].rpe);
    const reasonError = validateFeedback({ date: "2026-09-14", kind: "run_easy", status, reason: "time" });
    assert.equal(reasonError === null, STATUS_ALLOWS[status].reason);
  }
});

// ------------------------------------------------------------------ handoff

test("an injury or illness yields a follow-up; anything else, and any Done row, does not", () => {
  const f = feedback({ status: "skipped", reason: "injury", note: "left calf" });
  const followUp = followUpFor(f)!;
  assert.ok(followUp);
  assert.equal(followUp.type, "health_event");
  assert.equal(followUp.reason, "injury");
  assert.equal(followUp.sourceCompletionKey, f.key);
  assert.deepEqual(followUp.prefill, { date: f.date, sessionKind: "run_easy", sport: "run", note: "left calf" });

  assert.equal(followUpFor(feedback({ status: "skipped", reason: "travel" })), null);
  // Derived on every read: re-marking it Done makes the offer disappear with it.
  assert.equal(followUpFor({ ...f, status: "completed" }), null);
});

// ------------------------------------------------------------------ pricing

test("a completed session with a reported RPE is priced through the same function the plan was", () => {
  const f = feedback({ status: "completed", rpe: 7 });
  assert.equal(
    actualTssFor(f, DEFAULT_ATHLETE),
    estimateSessionTss({ sport: "run", durationMinutes: 60, rpe: 7 }, DEFAULT_ATHLETE),
  );
});

test("without an RPE it falls back to what was planned; partial is half; skipped is zero; unpriceable is null", () => {
  const planned = feedback({ status: "completed" });
  assert.equal(actualTssFor(planned, DEFAULT_ATHLETE), 51);
  const half = actualTssFor(feedback({ status: "partial", rpe: 7 }), DEFAULT_ATHLETE)!;
  assert.equal(half, Math.round(0.5 * actualTssFor(feedback({ status: "completed", rpe: 7 }), DEFAULT_ATHLETE)!));
  assert.equal(actualTssFor(feedback({ status: "skipped", reason: "travel" }), DEFAULT_ATHLETE), 0);
  assert.equal(actualTssFor(feedback({ status: "completed", prescribed: null }), DEFAULT_ATHLETE), null, "nothing to price against");
});

test("a linked logged session beats the self-report — the ledger's own number off the real file", () => {
  const f = feedback({ status: "completed", rpe: 3, sessionId: "garmin-1" });
  const logged = { sport: "run" as const, durationMinutes: 95, avgHeartRate: 165 };
  const fromFile = actualTssFor(f, DEFAULT_ATHLETE, logged);
  assert.equal(fromFile, estimateSessionTss(logged, DEFAULT_ATHLETE));
  assert.notEqual(fromFile, actualTssFor(f, DEFAULT_ATHLETE), "a 95-minute file must not price as the 60 planned");
});

test("pricing never mutates the athlete's numbers", () => {
  const before = JSON.parse(JSON.stringify(DEFAULT_ATHLETE));
  actualTssFor(feedback({ status: "completed", rpe: 9 }), DEFAULT_ATHLETE);
  summariseFeedback([feedback({ status: "partial", rpe: 8, reason: "time" })], { from: "2026-09-01", to: "2026-09-30" }, DEFAULT_ATHLETE);
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_ATHLETE)), before);
});

// ------------------------------------------------------------------ signals

const WINDOW = { from: "2026-09-14", to: "2026-09-20" };

test("rows outside the window contribute to nothing at all", () => {
  const outside = feedback({ date: "2026-09-13", kind: "run_long", status: "skipped", reason: "injury" });
  const inside = feedback({ date: "2026-09-15", kind: "run_easy", status: "skipped", reason: "travel" });
  const s = summariseFeedback([outside, inside], WINDOW, DEFAULT_ATHLETE);
  assert.equal(s.feedback.length, 1);
  assert.equal(s.answered, 1);
  assert.equal(s.latestHealthEvent, null, "yesterday's injury is outside the window, so it is not this week's state");
  assert.equal(s.skipsBySignal.health, 0);
  assert.equal(s.skipsBySignal.circumstance, 1);
});

test("skips bucket by signal, with every key present and zero-filled", () => {
  const rows = [
    feedback({ date: "2026-09-14", kind: "run_easy", status: "skipped", reason: "travel" }),
    feedback({ date: "2026-09-15", kind: "run_long", status: "skipped", reason: "time" }),
    feedback({ date: "2026-09-16", kind: "run_threshold", status: "skipped", reason: "weather" }),
    feedback({ date: "2026-09-17", kind: "strength_lower", status: "partial", reason: "fatigue" }),
    feedback({ date: "2026-09-18", kind: "run_intervals", status: "completed", rpe: 8 }),
  ];
  const s = summariseFeedback(rows, WINDOW, DEFAULT_ATHLETE);
  assert.deepEqual(s.skipsBySignal, { circumstance: 3, recovery: 1, health: 0, engagement: 0, unknown: 0 });
  assert.equal(s.answered, 5);
  assert.deepEqual(s.feedback.map((f) => f.date), ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]);
});

test("a reason-less skip is unknown, never folded into any other bucket", () => {
  const s = summariseFeedback([feedback({ date: "2026-09-15", status: "skipped" })], WINDOW, DEFAULT_ATHLETE);
  assert.equal(s.skipsBySignal.unknown, 1);
});

test("rpeDrift averages reported minus prescribed, and excludes rows with no expectation", () => {
  const noTarget = feedback({ date: "2026-09-14", kind: "run_long", status: "completed", rpe: 9, prescribed: prescribed({ targetRpe: undefined }) });
  assert.equal(summariseFeedback([noTarget], WINDOW, DEFAULT_ATHLETE).rpeDrift, null, "never defaulted");
  assert.equal(summariseFeedback([noTarget], WINDOW, DEFAULT_ATHLETE).rpeSamples, 0);

  const drifted = summariseFeedback(
    [
      feedback({ date: "2026-09-15", kind: "run_easy", status: "completed", rpe: 6 }),
      noTarget,
    ],
    WINDOW,
    DEFAULT_ATHLETE,
  );
  assert.equal(drifted.rpeSamples, 1);
  assert.equal(drifted.rpeDrift, 2, "easy prescribed at 4, reported at 6");

  const two = summariseFeedback(
    [
      feedback({ date: "2026-09-15", kind: "run_easy", status: "completed", rpe: 6 }),
      feedback({ date: "2026-09-16", kind: "run_long", status: "partial", rpe: 5, reason: "time" }),
    ],
    WINDOW,
    DEFAULT_ATHLETE,
  );
  assert.equal(two.rpeSamples, 2);
  assert.equal(two.rpeDrift, 1.5, "(+2 and +1) / 2");
});

test("latestHealthEvent is the newest health row in the window", () => {
  const older = feedback({ date: "2026-09-15", kind: "run_easy", status: "skipped", reason: "illness" });
  const newer = feedback({ date: "2026-09-18", kind: "run_long", status: "skipped", reason: "injury" });
  const s = summariseFeedback([newer, older], WINDOW, DEFAULT_ATHLETE);
  assert.equal(s.latestHealthEvent!.date, "2026-09-18");
  assert.equal(s.latestHealthEvent!.reason, "injury");
  assert.equal(s.latestHealthEvent!.kind, "run_long");
});

test("actualTss sums the priced rows, and is null rather than zero when nothing can be priced", () => {
  const s = summariseFeedback(
    [
      feedback({ date: "2026-09-15", kind: "run_easy", status: "completed", rpe: 4 }),
      feedback({ date: "2026-09-16", kind: "run_long", status: "skipped", reason: "travel" }),
    ],
    WINDOW,
    DEFAULT_ATHLETE,
  );
  assert.ok(s.actualTss! > 0);
  const empty = summariseFeedback([], WINDOW, DEFAULT_ATHLETE);
  assert.equal(empty.actualTss, null);
  assert.equal(empty.rpeDrift, null);
  assert.deepEqual(empty.skipsBySignal, { circumstance: 0, recovery: 0, health: 0, engagement: 0, unknown: 0 });
});

test("summariseFeedback does not mutate or reorder its input array", () => {
  const rows = [
    feedback({ date: "2026-09-18", kind: "run_long", status: "completed", rpe: 6 }),
    feedback({ date: "2026-09-15", kind: "run_easy", status: "completed", rpe: 5 }),
  ];
  const before = JSON.parse(JSON.stringify(rows));
  const s = summariseFeedback(rows, WINDOW, DEFAULT_ATHLETE);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), before);
  assert.deepEqual(s.feedback.map((f) => f.date), ["2026-09-15", "2026-09-18"]);
  assert.deepEqual(s.window, WINDOW);
});
