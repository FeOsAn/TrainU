/**
 * What happened to a prescribed session — the one vocabulary.
 *
 * The prescriber answers "what IS this session" (sessionKinds.ts); this file
 * answers "what did the athlete do about it". It is DB-free on purpose:
 * `server/completionsService.ts` persists these records, the routes serialise
 * them, the client renders them and the modulation layer reads them, and all
 * four import the same lists from here. The status list used to live in the
 * server and be hand-copied into the client's api.ts — exactly the drift
 * pattern SESSION_KINDS exists to prevent one layer down.
 *
 * The load-bearing idea is `signal`. "I was travelling" and "my knee hurt"
 * are both skips and mean opposite things: one says nothing at all about the
 * plan, the other is a health event. Rather than every consumer
 * re-implementing that judgement as a switch over reason strings — which is
 * how two consumers end up disagreeing about what a skip meant — the
 * judgement is DATA, attached to the reason once, read through `reasonSignal`.
 */

import type { AthleteParams } from "../athlete";
import type { Sport } from "../session";
import { estimateSessionTss, type SessionForTss } from "../trainingLoad";
import { SESSION_KINDS, type PlannedSession, type PlannedSport, type SessionKind } from "./sessionKinds";

export const COMPLETION_STATUSES = ["completed", "partial", "skipped"] as const;
export type CompletionStatus = (typeof COMPLETION_STATUSES)[number];

/** Athlete-facing words for a status. Typed so a new status fails tsc until it has some. */
export const STATUS_LABELS: Record<CompletionStatus, string> = {
  completed: "Done",
  partial: "Partly done",
  skipped: "Skipped",
};

export const COMPLETION_REASONS = [
  "travel",
  "illness",
  "injury",
  "fatigue",
  "time",
  "motivation",
  "weather",
  "other",
] as const;
export type CompletionReason = (typeof COMPLETION_REASONS)[number];

/**
 * What a skip is EVIDENCE of. This, not the reason string, is what every
 * consumer partitions on.
 *
 * - `circumstance` — the world got in the way. Says nothing about the plan or
 *   the athlete; a rescheduler may move the session, a learner must ignore it.
 * - `recovery` — the athlete was too tired. Evidence about the load.
 * - `health`  — something hurts or they are ill. A health event, not a load signal.
 * - `engagement` — they didn't want to. Evidence about the plan's appeal.
 * - `unknown` — they didn't say. Honest absence, never treated as any of the above.
 */
export const REASON_SIGNALS = ["circumstance", "recovery", "health", "engagement", "unknown"] as const;
export type ReasonSignal = (typeof REASON_SIGNALS)[number];

export const SIGNAL_LABELS: Record<ReasonSignal, string> = {
  circumstance: "Life got in the way",
  recovery: "Needed recovery",
  health: "Health",
  engagement: "Motivation",
  unknown: "Unsaid",
};

/**
 * The reason table: athlete-facing words and the signal each reason carries.
 * Typed `Record<CompletionReason, …>` so adding a reason fails `tsc` until it
 * has both — a reason with no words would otherwise reach a screen as its own
 * enum value, and a reason with no signal would silently read as "unknown".
 */
export const REASON_META: Record<CompletionReason, { label: string; signal: ReasonSignal }> = {
  travel: { label: "Travelling", signal: "circumstance" },
  time: { label: "Ran out of time", signal: "circumstance" },
  weather: { label: "Weather", signal: "circumstance" },
  fatigue: { label: "Too tired", signal: "recovery" },
  illness: { label: "Ill", signal: "health" },
  injury: { label: "Injured or in pain", signal: "health" },
  motivation: { label: "Didn't feel like it", signal: "engagement" },
  other: { label: "Something else", signal: "unknown" },
};

/** The plain label table, derived from REASON_META so there is one set of words, not two. */
export const REASON_LABELS: Record<CompletionReason, string> = Object.fromEntries(
  COMPLETION_REASONS.map((r) => [r, REASON_META[r].label]),
) as Record<CompletionReason, string>;

export const HEALTH_REASONS = ["injury", "illness"] as const satisfies readonly CompletionReason[];
export type HealthReason = (typeof HEALTH_REASONS)[number];

/** RPE is an integer 1-10: the column is an integer and the scale has no 7.5 on it. */
export const RPE_RANGE = { min: 1, max: 10 } as const;
export const NOTE_MAX_CHARS = 500;

/**
 * Which fields each status permits.
 *
 * ONE table, read by validation, by the merge rule in `recordCompletion` and
 * by the UI deciding which controls to show. An RPE on a session that never
 * happened is not a number that means something odd — it is a contradiction,
 * and a reason on a session that WAS done is a leftover from before the
 * athlete changed their mind.
 */
export const STATUS_ALLOWS: Record<CompletionStatus, { rpe: boolean; reason: boolean }> = {
  completed: { rpe: true, reason: false },
  partial: { rpe: true, reason: true },
  skipped: { rpe: false, reason: true },
};

/** DB-free view of one `session_completions` row. */
export interface CompletionFeedback {
  /** `sessionCompletionKey(date, kind)`. Opaque; don't parse it. */
  key: string;
  date: string;
  kind: SessionKind;
  status: CompletionStatus;
  reason: CompletionReason | null;
  /** Integer 1-10, as reported by the athlete. */
  rpe: number | null;
  note: string | null;
  /** The logged/synced `training_sessions` row this was satisfied by, when one matches. */
  sessionId: string | null;
  recordedAt: string;
  /** What was on the card when it was ticked. May predate `targetRpe` — read as unknown, never defaulted. */
  prescribed: PlannedSession | null;
}

/**
 * The handoff to the injury/illness feature. DERIVED on every read and never
 * stored: re-marking the session Done makes the offer disappear with it,
 * which a stored flag would not.
 */
export interface CompletionFollowUp {
  type: "health_event";
  reason: HealthReason;
  sourceCompletionKey: string;
  prefill: { date: string; sessionKind: SessionKind; sport: PlannedSport | null; note: string | null };
}

/**
 * This feature's contribution to the modulation layer's athlete state: a pure
 * derivation over a window. Nothing outside the window influences any field —
 * a skip from six weeks ago must not still be shaping this week.
 */
export interface CompletionSignals {
  window: { from: string; to: string };
  /** The windowed rows, date ascending. */
  feedback: CompletionFeedback[];
  /** How many prescribed sessions in the window got an answer of any kind. */
  answered: number;
  /** Partial + skipped rows bucketed by `reasonSignal`. All keys present, zero-filled. */
  skipsBySignal: Record<ReasonSignal, number>;
  /** Mean (reported − prescribed) RPE, 1 dp, over rows having both. Null when there are none. */
  rpeDrift: number | null;
  rpeSamples: number;
  /** Newest health-signal row in the window — what the conditions slice keys off. */
  latestHealthEvent: { key: string; date: string; kind: SessionKind; reason: HealthReason } | null;
  /** Sum of `actualTssFor` over priced rows; null when nothing in the window could be priced. */
  actualTss: number | null;
}

function isReason(value: unknown): value is CompletionReason {
  return typeof value === "string" && (COMPLETION_REASONS as readonly string[]).includes(value);
}

/** Reads a stored reason string. An unrecognised one maps to null rather than leaking out as a signal. */
export function parseReason(value: unknown): CompletionReason | null {
  return isReason(value) ? value : null;
}

/**
 * The ONLY path from a reason to a signal. Consumers must never switch on
 * reason strings themselves.
 *
 * Returns null when the status permits no reason at all: a completed session
 * carries no skip signal whatever a stale `reason` field says. State that
 * should have stopped influencing output, doesn't.
 */
export function reasonSignal(f: Pick<CompletionFeedback, "status" | "reason">): ReasonSignal | null {
  if (!STATUS_ALLOWS[f.status]?.reason) return null;
  return f.reason ? REASON_META[f.reason].signal : "unknown";
}

/** Non-null exactly when the athlete told us something hurts or they are ill. */
export function followUpFor(f: CompletionFeedback): CompletionFollowUp | null {
  if (reasonSignal(f) !== "health") return null;
  const reason = f.reason as HealthReason;
  return {
    type: "health_event",
    reason,
    sourceCompletionKey: f.key,
    prefill: {
      date: f.date,
      sessionKind: f.kind,
      sport: f.prescribed?.sport ?? null,
      note: f.note,
    },
  };
}

/**
 * What this session actually cost, on the same scale the plan was priced on.
 *
 * Three sources, in descending order of how much they know:
 *   1. a linked `training_sessions` row — the ledger's own number, off real
 *      duration and real HR/power. Nothing the athlete types beats a measured file.
 *   2. the prescribed duration re-priced at the REPORTED RPE — same
 *      `estimateSessionTss` the prescriber used, so "did 240 of 310 TSS" is a
 *      comparison rather than two scales side by side.
 *   3. the prescribed TSS as-planned, when no RPE was given.
 *
 * `skipped` is 0 and `partial` is half. Half is an estimate and deliberately a
 * crude one — no actual minutes are captured for a partial — but it is the
 * same half `summariseAdherence` counts in the rate, so the two numbers on the
 * screen at least agree with each other.
 *
 * Reads `athlete` only through `estimateSessionTss`/`numericParams`; no
 * `Measured<T>` is touched.
 */
export function actualTssFor(f: CompletionFeedback, athlete: AthleteParams, logged?: SessionForTss | null): number | null {
  const full = fullTssFor(f, athlete, logged);
  if (full == null) return null;
  // The athlete's own word governs: a row they marked skipped cost nothing,
  // whatever else is attached to it.
  if (f.status === "skipped") return 0;
  if (f.status === "partial") return Math.round(0.5 * full);
  return Math.round(full);
}

function fullTssFor(f: CompletionFeedback, athlete: AthleteParams, logged?: SessionForTss | null): number | null {
  if (logged) return estimateSessionTss(logged, athlete);
  if (!f.prescribed) return null;
  if (f.rpe == null) return f.prescribed.tss;
  return estimateSessionTss(
    { sport: f.prescribed.sport as Sport, durationMinutes: f.prescribed.durationMinutes, rpe: f.rpe },
    athlete,
  );
}

export interface ValidateFeedbackInput {
  date: unknown;
  kind: unknown;
  status: unknown;
  rpe?: unknown;
  reason?: unknown;
  note?: unknown;
}

/**
 * Pure validation of what a caller ASSERTED — not of the merged row.
 * Inherited fields are the merge rule's problem (see `recordCompletion`).
 * Returns the first human-readable error, or null.
 */
export function validateFeedback(input: ValidateFeedbackInput): string | null {
  const date = input.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return "date must be a valid YYYY-MM-DD date";
  }
  if (typeof input.kind !== "string" || !(SESSION_KINDS as readonly string[]).includes(input.kind)) {
    return `kind must be one of ${SESSION_KINDS.join(", ")}`;
  }
  if (typeof input.status !== "string" || !(COMPLETION_STATUSES as readonly string[]).includes(input.status)) {
    return `status must be one of ${COMPLETION_STATUSES.join(", ")}`;
  }
  const status = input.status as CompletionStatus;

  if (input.rpe != null) {
    if (typeof input.rpe !== "number" || !Number.isInteger(input.rpe) || input.rpe < RPE_RANGE.min || input.rpe > RPE_RANGE.max) {
      return `rpe must be a whole number between ${RPE_RANGE.min} and ${RPE_RANGE.max}`;
    }
    if (!STATUS_ALLOWS[status].rpe) {
      return "an effort rating only applies to a session that happened";
    }
  }
  if (input.reason != null) {
    if (!isReason(input.reason)) {
      return `reason must be one of ${COMPLETION_REASONS.map((r) => REASON_LABELS[r].toLowerCase()).join(", ")}`;
    }
    if (!STATUS_ALLOWS[status].reason) {
      return "a reason only applies to a session that was cut short or missed";
    }
  }
  if (input.note != null) {
    if (typeof input.note !== "string") return "note must be text";
    if (input.note.length > NOTE_MAX_CHARS) return `note must be ${NOTE_MAX_CHARS} characters or fewer`;
  }
  return null;
}

function emptySkipCounts(): Record<ReasonSignal, number> {
  return Object.fromEntries(REASON_SIGNALS.map((s) => [s, 0])) as Record<ReasonSignal, number>;
}

/**
 * The state this feature contributes to the modulation layer.
 *
 * Windowed FIRST — a row outside [from, to] contributes to nothing, not to the
 * counts, not to the drift, not to `latestHealthEvent`. Pure; does not mutate
 * its inputs.
 */
export function summariseFeedback(
  records: readonly CompletionFeedback[],
  window: { from: string; to: string },
  athlete: AthleteParams,
): CompletionSignals {
  const feedback = records
    .filter((r) => r.date >= window.from && r.date <= window.to)
    .slice()
    .sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date)));

  const skipsBySignal = emptySkipCounts();
  let rpeDriftTotal = 0;
  let rpeSamples = 0;
  let latestHealthEvent: CompletionSignals["latestHealthEvent"] = null;
  let latestHealthAt = "";
  let actualTss: number | null = null;

  for (const r of feedback) {
    const signal = reasonSignal(r);
    if (signal && r.status !== "completed") skipsBySignal[signal] += 1;

    const target = r.prescribed?.targetRpe;
    // Rows whose snapshot predates targetRpe are EXCLUDED, never defaulted:
    // a made-up expectation would manufacture drift that nobody reported.
    if (r.rpe != null && target != null && STATUS_ALLOWS[r.status].rpe) {
      rpeDriftTotal += r.rpe - target;
      rpeSamples += 1;
    }

    if (signal === "health" && r.reason) {
      const at = `${r.date}#${r.recordedAt}`;
      if (at >= latestHealthAt) {
        latestHealthAt = at;
        latestHealthEvent = { key: r.key, date: r.date, kind: r.kind, reason: r.reason as HealthReason };
      }
    }

    const tss = actualTssFor(r, athlete);
    if (tss != null) actualTss = (actualTss ?? 0) + tss;
  }

  return {
    window: { from: window.from, to: window.to },
    feedback,
    answered: feedback.length,
    skipsBySignal,
    rpeDrift: rpeSamples > 0 ? Math.round((rpeDriftTotal / rpeSamples) * 10) / 10 : null,
    rpeSamples,
    latestHealthEvent,
    actualTss,
  };
}
