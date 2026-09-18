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

/**
 * Which layer changed a session. Only the sources that exist: a source is
 * declared when the code that emits it is built, so an unbuilt feature can
 * never be blamed for an adjustment nobody wrote.
 */
export type AdjustmentSource = "condition" | "ramp" | "checkin" | "acwr";

/**
 * What a session WAS before the modulation layer touched it.
 *
 * Carried on the session rather than only in a side list, because the card
 * the athlete reads and the record the adherence dataset keeps must agree:
 * "Endurance ride (was: Long run)" with the reason attached is an app
 * substitution, and telling that apart from an athlete's own skip is the
 * whole value of the dataset.
 */
export interface AdjustedFrom {
  kind: SessionKind;
  title: string;
  durationMinutes: number;
  tss: number;
  /** Full sentences, in the athlete's words. Chained changes append rather than overwrite. */
  reasons: string[];
  /** Every layer that has touched this session, in the order they did. */
  sources: AdjustmentSource[];
}

/** Which of N sessions of this kind this is, in allocation order. `{ n: 2, of: 3 }` is the second of three rides. */
export interface SessionOccurrence {
  n: number;
  of: number;
}

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

  /*
   * The three fields below are always set by `prescribeWeek`. They are
   * optional in the TYPE only because `sessionCompletions.prescribedJson`
   * holds snapshots written before they existed — a reader treats absence as
   * UNKNOWN, never as a default. Reading a missing `occurrence` as `n: 1`
   * would make February's second easy run look like the week's anchor.
   */

  /** The RPE this session's planned TSS was priced at — so a reported RPE can be compared with what was asked for. */
  targetRpe?: number;
  /** Which of N sessions of this kind this is. */
  occurrence?: SessionOccurrence;
  /** Set only when the modulation layer changed this session. Absent means "as prescribed". */
  adjustedFrom?: AdjustedFrom;
}

export interface PrescribedWeek {
  weekStart: string;
  sessions: PlannedSession[];
  totalMinutes: number;
  totalTss: number;
  /** The arbitrated multiplier this week's budget was scaled by. */
  loadMultiplier: number;
  /**
   * The dominant goal's phase (base/build/peak/taper/cut/...) — the shape
   * this week was built to.
   *
   * Carried explicitly because it CANNOT be inferred from `loadMultiplier`:
   * the multi-goal blend mixes several goals' phases into one number, so a
   * 0.83x week might be a taper pulled up by a second goal or a base week
   * pulled down by one. Anything that removes intensity has to gate on the
   * real phase — dropping a taper's hard session because a number looked
   * low is how an athlete arrives at an A-race undertrained.
   */
  phaseName: string;
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
