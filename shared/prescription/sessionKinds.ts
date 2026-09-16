/**
 * The vocabulary of sessions the engine can prescribe, and the shape of a
 * prescribed week.
 *
 * SESSION_KINDS is declared as a value, not only a type, because several
 * modules check a string against it at runtime (the completion endpoint, the
 * UI, and eventually the coach's adaptation tool). HyroxNga learned this the
 * hard way: three modules each kept their own hand-written copy, they
 * drifted, and an unrecognised kind was read as "replace the whole day" — so
 * "skip Friday's lift" silently deleted Friday's easy run too. One list,
 * derived in both directions.
 */

export const SESSION_KINDS = [
  "run_easy",
  "run_long",
  "run_threshold",
  "run_intervals",
  "bike_endurance",
  "swim_technique",
  "compromised",
  "station_work",
  "strength_lower",
  "strength_push",
  "strength_pull",
  "rest",
] as const;

export type SessionKind = (typeof SESSION_KINDS)[number];

export type Intensity = "rest" | "easy" | "moderate" | "hard";

/** Coarse bucket, matching shared/session.ts's Sport so planned and logged load price identically. */
export type PlannedSport = "run" | "bike" | "swim" | "strength" | "hybrid" | "station" | "other";

export interface PlannedSession {
  /** YYYY-MM-DD. */
  date: string;
  kind: SessionKind;
  sport: PlannedSport;
  title: string;
  /** One line: what this session is for. */
  focus: string;
  durationMinutes: number;
  /** Priced with the SAME estimateSessionTss the ledger uses on logged sessions, so planned and actual load are on one scale. */
  tss: number;
  intensity: Intensity;
  /** Concrete numbers — paces off threshold, loads off 1RM. Never vague. */
  targets: string[];
  /** Which goal(s) this session is serving. A session can serve more than one. */
  servesGoalIds: string[];
  /** Why this session is in this week, given everything else going on. */
  note: string;
}

export interface PrescribedWeek {
  weekStart: string;
  sessions: PlannedSession[];
  totalMinutes: number;
  totalTss: number;
  /** The arbitrated multiplier this week's budget was scaled by. */
  loadMultiplier: number;
  note: string;
}

/**
 * Stable per-session completion key.
 *
 * The plan is derived deterministically and never stored, so a completion
 * can't reference a row id — it references the (date, kind) pair instead.
 * Keyed on kind rather than date alone because a day can hold two sessions,
 * and a date-only key would mean ticking the lift also ticked the run.
 * Opaque string; don't parse it.
 */
export function sessionCompletionKey(date: string, kind: SessionKind): string {
  return `${date}#${kind}`;
}
