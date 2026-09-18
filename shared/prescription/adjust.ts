/**
 * The modulation layer: a prescribed week in, an adjusted week out.
 *
 *   arbitrateWeek(goals, weekStart, athlete, conditions, today) → ArbitratedWeek
 *   prescribeWeek(arbitrated, goals, athlete, options)          → PrescribedWeek
 *   adjustWeek(prescribed, state, today)                        → AdjustedWeek   ← here
 *
 * The prescription answers "what does this athlete's week want to be". This
 * layer answers "what can this athlete actually do THIS week, given a torn
 * calf, a bad night's sleep, and four weeks of training that were smaller
 * than the one being handed to them".
 *
 * It is pure. It deep-copies the prescription, runs a fixed list of
 * modulators over the copy, and finalises. It never mutates `prescribed` or
 * `state`, never writes a `Measured<T>`, and never reads a clock — `today`
 * is a parameter, so a week can be tested against any date.
 *
 * ─── Why the layer owns these four rules rather than each slice ───────────
 *
 * 1. **An answered session is untouchable.** Once the athlete has ticked
 *    Done, Partial or Skipped, the card is history. Rewriting it would
 *    change what they said they did. Enforced here, after every modulator,
 *    so a slice cannot forget.
 * 2. **Provenance lives on the session.** Every change is expressed as
 *    `PlannedSession.adjustedFrom` — the original kind/title/minutes/TSS
 *    plus every reason and every layer that has touched it, in order.
 *    `AdjustedWeek.adjustments` is DERIVED from that, never written
 *    alongside it, so a second slice touching an already-adjusted session
 *    APPENDS a reason instead of overwriting who changed it first. Two
 *    records that are written separately drift; one record read two ways
 *    cannot.
 * 3. **`(date, kind)` is unique.** That pair is the completion key. Two
 *    sessions sharing one key means one of the two cards can never be
 *    ticked — so the layer checks, and in production keeps the first and
 *    reports the rest rather than serving an untickable card.
 * 4. **An empty state changes nothing.** With no conditions, no check-in and
 *    no logged history, the output sessions are deep-equal to the input and
 *    `adjustments` is empty. That is what makes every slice optional.
 *
 * ─── Step order (DECISIONS B2, binding) ──────────────────────────────────
 *
 *   1. conditions        the FULL injury/illness rules — runs ONCE
 *   2. readiness         this morning's check-in — today only
 *   3. acwr              the weekly load ceiling (this file)
 *   4. conditions_guard  ONLY the two idempotent predicates
 *
 * `applyConditions` must not run twice: its branches SCALE (0.85 × 0.85 =
 * 0.72), so a second pass would quietly shrink an ill athlete's week by
 * another 15–50% with no reason attached to the second cut. The final guard
 * is a DIFFERENT function implementing only rest-only and forbidden-kind
 * substitution — predicates on the session's CURRENT kind, therefore
 * genuinely idempotent, therefore safe to run after everything else.
 *
 * The conditions and readiness slices are separate files that register
 * themselves into `MODULATORS`. A stage with nothing registered is skipped,
 * so this layer works — and is tested — with any subset of them present.
 */

import type { AthleteParams } from "../athlete";
import type { CrossTraining, Condition } from "../conditions";
import type { CheckIn, Readiness } from "../readiness";
import type { Sport } from "../session";
import { computeTrainingLoad, estimateSessionTss, type SessionForTss } from "../trainingLoad";
import {
  type AdjustedFrom,
  type AdjustmentSource,
  type PlannedSession,
  type PrescribedWeek,
  type SessionKind,
  sessionCompletionKey,
} from "./sessionKinds";
import { KIND_MINUTES, SPORT_OF, rpeFor } from "./templates";
import { buildSession } from "./prescribe";

/*
 * ─── What the layer knows about the athlete ───────────────────────────────
 */

/** A logged session, priced by the same `estimateSessionTss` the ledger uses. */
export interface LoggedLoad extends SessionForTss {
  date: string;
}

/**
 * Everything the modulators are allowed to look at.
 *
 * Exactly the fields the BUILT features provide, and no slots for the two
 * that were deferred — an empty field for an unbuilt feature is a promise
 * the app cannot keep, and every reader would have to guess whether "no
 * tendencies" meant "none found" or "never computed".
 */
export interface AthleteState {
  /** Read-only. `buildSession` re-targets and re-prices off these, so a shortened session's numbers stay true. */
  params: AthleteParams;
  /** Open, ramping or recently closed. The conditions slice decides per DATE which of those a given day is. */
  conditions: Condition[];
  /** Whether a substitute ride or swim is actually possible for this athlete. */
  available: CrossTraining;
  /** `sessionCompletionKey(date, kind)` for every session the athlete has already answered, in any status. */
  answeredKeys: string[];
  /** Today's morning check-in, or null if it was never answered. */
  checkIn: CheckIn | null;
  /** What that check-in means. Null when there was no check-in — never a fabricated neutral score. */
  readiness: Readiness | null;
  /**
   * The athlete's own recent logged training, for the load ceiling.
   *
   * The sessions rather than a precomputed ratio, so the ceiling runs
   * through the same `computeTrainingLoad` the Data page reads — one engine,
   * not a second opinion about the same four weeks.
   */
  recentLoad: LoggedLoad[];
}

/** A state that knows nothing. `adjustWeek` with this returns the prescription unchanged — the pinned no-op. */
export function emptyAthleteState(params: AthleteParams): AthleteState {
  return {
    params,
    conditions: [],
    available: { bike: false, swim: false },
    answeredKeys: [],
    checkIn: null,
    readiness: null,
    recentLoad: [],
  };
}

/*
 * ─── What a change IS ─────────────────────────────────────────────────────
 */

export const ADJUSTMENT_ACTIONS = ["substituted", "capped", "shortened", "rested", "moved"] as const;
export type AdjustmentAction = (typeof ADJUSTMENT_ACTIONS)[number];

/**
 * Athlete-facing words for each action. Typed `Record<AdjustmentAction, …>`
 * so a new action fails `tsc` until somebody has written what to call it —
 * the enum value itself must never reach a screen (DECISIONS C7).
 */
export const ADJUSTMENT_ACTION_LABELS: Record<AdjustmentAction, string> = {
  substituted: "Swapped for a different session",
  capped: "Intensity taken down",
  shortened: "Made shorter",
  rested: "Turned into rest",
  moved: "Moved to another day",
};

/**
 * Words for `AdjustmentSource`, which is declared in `sessionKinds.ts` with
 * the rest of the shared vocabulary. The label table lives here because this
 * is the file that turns a source into something an athlete reads; adding a
 * source without words for it fails `tsc` on this table.
 */
export const ADJUSTMENT_SOURCE_LABELS: Record<AdjustmentSource, string> = {
  condition: "Injury or illness",
  ramp: "Getting back into it",
  checkin: "This morning's check-in",
  acwr: "Weekly load ceiling",
};

/**
 * One change, as the "Changes this week" panel shows it.
 *
 * DERIVED from the sessions' own `adjustedFrom`, never accumulated in
 * parallel with it — see rule 2 at the top. One row per changed session: the
 * endpoints are the session's endpoints, and when two layers touched it the
 * reasons are joined in the order they happened, because that is the order
 * they happened TO the athlete.
 */
export interface Adjustment {
  date: string;
  /** What the prescription asked for, before anything touched it. */
  originalKind: SessionKind;
  /** What the athlete is actually being asked to do. `rest` for a session the layer removed. */
  kind: SessionKind;
  action: AdjustmentAction;
  /** The layer that most recently changed this session; the full chain is on the session's `adjustedFrom.sources`. */
  source: AdjustmentSource;
  /** Complete sentences with the real numbers in them. Never an id, a kind or an enum value. */
  reason: string;
  minutesBefore: number;
  /** 0 for a session the layer removed. */
  minutesAfter: number;
  /** The condition that caused it, when one did — so the UI can link the change to the injury card. */
  conditionId?: string;
}

/**
 * `AdjustedFrom` plus the two things the layer needs that the shared shape
 * does not carry. Both are additive and both survive into
 * `sessionCompletions.prescribedJson` harmlessly: a reader that knows
 * nothing about them sees exactly the `AdjustedFrom` it expects.
 */
export interface AdjustProvenance extends AdjustedFrom {
  /** The ORIGINAL date, set only when the session has been moved off it. */
  date?: string;
  /** Conditions that caused any part of this change, in the order they applied. */
  conditionIds?: string[];
}

/** A session that may carry layer provenance. Structurally a `PlannedSession` — nothing downstream needs to know. */
export interface AdjustedSession extends PlannedSession {
  adjustedFrom?: AdjustProvenance;
}

/**
 * The week a modulator works on: the prescription plus the sessions the
 * layer has taken out.
 *
 * `dropped` is part of the working week rather than a side effect because of
 * DECISIONS B7 — a session the layer turned into rest must stay visible and
 * tickable ("Actually, I did this"). A dropped session that only existed in
 * a local variable could not be rendered, and an athlete who trained anyway
 * would have to lie to the app to record it.
 */
export interface WorkingWeek extends PrescribedWeek {
  sessions: AdjustedSession[];
  dropped: AdjustedSession[];
}

/**
 * A slice. Takes the working week, returns it (usually the same object —
 * mutating the copy it was handed is fine and expected; it is private).
 *
 * A modulator never writes `adjustments` and never edits `adjustedFrom` by
 * hand. It calls `adjustSessionAt`, `dropSessionAt` or `restDay`, which
 * stamp provenance through `buildSession` so the session's targets, its
 * duration and its price can never disagree.
 */
export type Modulator = (week: WorkingWeek, state: AthleteState, today: string) => WorkingWeek;

export interface AdjustedWeek extends PrescribedWeek {
  sessions: AdjustedSession[];
  /** Applied order — the changelog the athlete reads. */
  adjustments: Adjustment[];
  /** The prescription's totals, so the UI can say "312 min, was 380". */
  original: { totalMinutes: number; totalTss: number };
  /** Removed by the layer, never rendered as a day card — but still tickable. */
  dropped: AdjustedSession[];
}

/*
 * ─── The pipeline ─────────────────────────────────────────────────────────
 */

export const MODULATOR_STAGES = ["conditions", "readiness", "acwr", "conditions_guard"] as const;
export type ModulatorStage = (typeof MODULATOR_STAGES)[number];

/** Never shown as-is; these are what the athlete (or a debug view) reads. */
export const MODULATOR_STAGE_LABELS: Record<ModulatorStage, string> = {
  conditions: "Injury and illness",
  readiness: "This morning's check-in",
  acwr: "Weekly load ceiling",
  conditions_guard: "Final safety check",
};

export interface ModulatorSlot {
  stage: ModulatorStage;
  /** Null until the slice that owns this stage registers itself. A null stage is skipped. */
  run: Modulator | null;
}

/**
 * The pipeline, in the one order DECISIONS B2 allows.
 *
 * Declared here as a fixed list of STAGES rather than assembled by whoever
 * imports what, because the order is the safety property: conditions once,
 * then the morning, then the ceiling, then the idempotent guard. A slice
 * registers into its stage; it cannot choose its position.
 */
export const MODULATORS: ModulatorSlot[] = [
  { stage: "conditions", run: null },
  { stage: "readiness", run: null },
  { stage: "acwr", run: enforceAcwrCeiling },
  { stage: "conditions_guard", run: null },
];

/** A slice registers itself at import time. Registering twice replaces — the last import wins, and tests can swap a stub in. */
export function registerModulator(stage: ModulatorStage, run: Modulator | null): void {
  const slot = MODULATORS.find((s) => s.stage === stage);
  if (!slot) throw new Error(`No modulator stage named ${stage}`);
  slot.run = run;
}

export function modulatorFor(stage: ModulatorStage): Modulator | null {
  return MODULATORS.find((s) => s.stage === stage)?.run ?? null;
}

export interface AdjustOptions {
  /**
   * Throw when the layer's own invariants are broken instead of repairing
   * them. Tests pass true; the server leaves it false, because a duplicate
   * key or a rewritten answered session is a bug to fix in the code, not a
   * reason to fail an athlete's Tuesday.
   */
  strict?: boolean;
  /** Overrides the registered pipeline. Tests use it; nothing else should. */
  modulators?: readonly ModulatorSlot[];
  /** Where a repaired invariant violation is reported. Defaults to `console.warn`. */
  onProblem?: (message: string) => void;
}

/** The completion key for a session — the same one the tick-off endpoint writes. */
export function sessionKey(session: PlannedSession): string {
  return sessionCompletionKey(session.date, session.kind);
}

export function isAnswered(session: PlannedSession, state: AthleteState): boolean {
  return state.answeredKeys.includes(sessionKey(session));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Turn a prescribed week into the week this athlete can actually do.
 *
 * Pure. `prescribed` and `state` are not mutated — a test deep-freezes both
 * and pins it.
 */
export function adjustWeek(
  prescribed: PrescribedWeek,
  state: AthleteState,
  today: string,
  options: AdjustOptions = {},
): AdjustedWeek {
  const strict = options.strict ?? false;
  const report = options.onProblem ?? ((message: string) => console.warn(`[adjustWeek] ${message}`));
  const problem = (message: string): void => {
    if (strict) throw new Error(message);
    report(message);
  };

  // One deep copy up front: every modulator gets a private week it may
  // mutate freely, and `prescribed` is never touched.
  let working: WorkingWeek = { ...clone(prescribed), dropped: [] };

  for (const slot of options.modulators ?? MODULATORS) {
    if (!slot.run) continue;
    const before = clone(working);
    const next = slot.run(working, state, today);

    if (!next || !Array.isArray(next.sessions)) {
      problem(`the ${slot.stage} step returned no week; keeping the week it was given`);
      working = before;
      continue;
    }

    const violation = answeredViolation(before, next, state);
    if (violation) {
      // Rule 1 is the layer's, not the slice's: roll the whole step back
      // rather than serving a week where a session the athlete already
      // answered says something different from what they answered about.
      problem(`the ${slot.stage} step changed a session the athlete had already answered (${violation}); step rolled back`);
      working = before;
      continue;
    }
    working = next;
  }

  return finaliseWeek(working, prescribed, problem);
}

/** JSON with every object's keys in a fixed order, so "same session, rebuilt" does not read as "changed". */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** The key of the first answered session the step changed or removed, or null if it left them all alone. */
function answeredViolation(before: WorkingWeek, after: WorkingWeek, state: AthleteState): string | null {
  const answered = new Set(state.answeredKeys);
  const afterByKey = new Map(after.sessions.map((s) => [sessionKey(s), s]));
  for (const session of before.sessions) {
    const key = sessionKey(session);
    if (!answered.has(key)) continue;
    const now = afterByKey.get(key);
    if (!now) return key;
    if (stableJson(now) !== stableJson(session)) return key;
  }
  return null;
}

function finaliseWeek(week: WorkingWeek, prescribed: PrescribedWeek, problem: (m: string) => void): AdjustedWeek {
  const sessions: AdjustedSession[] = [];
  const dropped = [...week.dropped];
  const seen = new Set<string>();

  const sorted = [...week.sessions].sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  for (const session of sorted) {
    const key = sessionKey(session);
    if (seen.has(key)) {
      // Two cards, one completion key: ticking either would tick both, and
      // the second is unreachable. Keep the first, say so, move on.
      problem(`two sessions share one completion key (${key}); keeping the first`);
      dropped.push(session);
      continue;
    }
    seen.add(key);
    sessions.push(session);
  }

  return {
    weekStart: week.weekStart,
    sessions,
    totalMinutes: sessions.reduce((sum, s) => sum + s.durationMinutes, 0),
    totalTss: sessions.reduce((sum, s) => sum + s.tss, 0),
    loadMultiplier: week.loadMultiplier,
    phaseName: week.phaseName,
    note: week.note,
    adjustments: deriveAdjustments(sessions, dropped),
    original: { totalMinutes: prescribed.totalMinutes, totalTss: prescribed.totalTss },
    dropped,
  };
}

/*
 * ─── Provenance in, changelog out ────────────────────────────────────────
 */

function actionFor(from: AdjustProvenance, session: AdjustedSession, removed: boolean): AdjustmentAction {
  if (removed || session.kind === "rest") return "rested";
  if (SPORT_OF[session.kind] !== SPORT_OF[from.kind]) return "substituted";
  if (session.kind !== from.kind) return "capped";
  if (from.date && from.date !== session.date) return "moved";
  return "shortened";
}

/**
 * The week-level changelog, read off the sessions themselves.
 *
 * This is the whole of rule 2: there is nowhere else a change can be
 * recorded, so a slice cannot produce a changelog entry that the session
 * disagrees with, and a second slice touching the same session appends to
 * one chain rather than opening a second record of it.
 */
export function deriveAdjustments(sessions: readonly AdjustedSession[], dropped: readonly AdjustedSession[]): Adjustment[] {
  const rows: Adjustment[] = [];

  const push = (session: AdjustedSession, removed: boolean): void => {
    const from = session.adjustedFrom;
    if (!from) return;
    const source = from.sources[from.sources.length - 1];
    if (!source) return; // an unstamped change: nothing truthful to say about it
    rows.push({
      date: session.date,
      originalKind: from.kind,
      kind: removed ? "rest" : session.kind,
      action: actionFor(from, session, removed),
      source,
      reason: from.reasons.join(" "),
      minutesBefore: from.durationMinutes,
      minutesAfter: removed ? 0 : session.durationMinutes,
      ...(from.conditionIds?.[0] ? { conditionId: from.conditionIds[0] } : {}),
    });
  };

  for (const session of sessions) push(session, false);
  for (const session of dropped) push(session, true);

  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.originalKind.localeCompare(b.originalKind));
}

/*
 * ─── The mutators every slice goes through ───────────────────────────────
 */

export interface SessionChange {
  /** One complete athlete-facing sentence, carrying the real numbers. No ids, no enum values (DECISIONS C7). */
  reason: string;
  source: AdjustmentSource;
  conditionId?: string;
}

export interface SessionPatch {
  kind?: SessionKind;
  durationMinutes?: number;
  /** Only when the session genuinely is not its kind's usual effort — it is what prices the session. */
  targetRpe?: number;
  /** Overrides the card's note. By default the note becomes the accumulated reasons, so the card says why it looks like this. */
  note?: string;
  date?: string;
}

function extendProvenance(session: AdjustedSession, change: SessionChange, nextDate: string): AdjustProvenance {
  const prior = session.adjustedFrom;
  const originalDate = prior?.date ?? session.date;
  const conditionIds = change.conditionId
    ? [...(prior?.conditionIds ?? []), change.conditionId]
    : prior?.conditionIds;
  return {
    // The ORIGINAL, never the intermediate: "was a 90-minute long run" stays
    // true however many layers have been over it since.
    kind: prior?.kind ?? session.kind,
    title: prior?.title ?? session.title,
    durationMinutes: prior?.durationMinutes ?? session.durationMinutes,
    tss: prior?.tss ?? session.tss,
    reasons: [...(prior?.reasons ?? []), change.reason],
    sources: [...(prior?.sources ?? []), change.source],
    ...(originalDate !== nextDate ? { date: originalDate } : {}),
    ...(conditionIds ? { conditionIds } : {}),
  };
}

/**
 * Rebuild a session as something else, carrying its provenance forward.
 *
 * Pure — it returns a new session and leaves the old one alone. Everything
 * goes through `buildSession`, so a session shortened to 42 minutes has
 * targets that say 42 minutes and a price computed from 42 minutes. Patching
 * the number alone is how a card ends up contradicting itself.
 */
export function adjustSession(
  session: AdjustedSession,
  patch: SessionPatch,
  change: SessionChange,
  athlete: AthleteParams,
): AdjustedSession {
  const kind = patch.kind ?? session.kind;
  const date = patch.date ?? session.date;
  const durationMinutes = patch.durationMinutes ?? session.durationMinutes;
  const provenance = extendProvenance(session, change, date);
  // A session keeps the RPE it was priced at unless its KIND changed (a
  // downgraded run is a different effort) or the caller says otherwise.
  const targetRpe = patch.targetRpe ?? (kind === session.kind ? session.targetRpe : rpeFor(kind));
  return buildSession(kind, date, durationMinutes, athlete, session.servesGoalIds, [], {
    ...(session.occurrence ? { occurrence: session.occurrence } : {}),
    ...(targetRpe != null ? { targetRpe } : {}),
    note: patch.note ?? provenance.reasons.join(" "),
    adjustedFrom: provenance,
  });
}

/**
 * Change the session at `index` in place in the working week.
 *
 * Returns false and changes nothing when the athlete has already answered
 * it. Every slice calls this rather than assigning into `week.sessions`, so
 * the answered rule and the provenance stamp are applied once, here.
 */
export function adjustSessionAt(
  week: WorkingWeek,
  index: number,
  patch: SessionPatch,
  change: SessionChange,
  state: AthleteState,
): boolean {
  const session = week.sessions[index];
  if (!session || isAnswered(session, state)) return false;
  week.sessions[index] = adjustSession(session, patch, change, state.params);
  return true;
}

/**
 * Take a session out of the week, keeping it (with its reason) in `dropped`
 * so it can still be rendered and still be ticked off by an athlete who did
 * it anyway.
 */
export function dropSessionAt(week: WorkingWeek, index: number, change: SessionChange, state: AthleteState): boolean {
  const session = week.sessions[index];
  if (!session || isAnswered(session, state)) return false;
  week.sessions.splice(index, 1);
  week.dropped.push({ ...session, adjustedFrom: extendProvenance(session, change, session.date) });
  return true;
}

/**
 * Make a whole day rest.
 *
 * One helper rather than one per slice, so a severity-3 illness and a
 * very-low check-in compose instead of each inventing their own rest day.
 * Answered sessions stay: the athlete already trained, and the app does not
 * get to decide retroactively that they rested.
 */
export function restDay(week: WorkingWeek, date: string, change: SessionChange, state: AthleteState): number {
  const goalIds = new Set<string>();
  let removed = 0;

  for (let i = week.sessions.length - 1; i >= 0; i--) {
    const session = week.sessions[i]!;
    if (session.date !== date || session.kind === "rest") continue;
    if (isAnswered(session, state)) continue;
    for (const id of session.servesGoalIds) goalIds.add(id);
    if (dropSessionAt(week, i, change, state)) removed++;
  }

  if (removed === 0) return 0;
  if (week.sessions.some((s) => s.date === date && s.kind === "rest")) return removed;

  week.sessions.push(
    buildSession("rest", date, 0, state.params, Array.from(goalIds), [], { note: change.reason }),
  );
  return removed;
}

/*
 * ─── The weekly load ceiling (DECISIONS B4) ──────────────────────────────
 *
 * The prescription sizes a week off the arbitrated multiplier, which knows
 * what the GOALS want. It does not know what the athlete has actually been
 * doing. Those two are the same number right up until they aren't: a week
 * off sick, a holiday, a first week back — and then a build week lands on a
 * body four weeks detrained, at exactly the ratio the sports-medicine
 * literature spends its time warning about.
 *
 * So: the adjusted week's load is clamped against the athlete's own trailing
 * four weeks. Not a return-from-injury special case — a general step, which
 * is why it also catches the missed week nobody logged as an injury.
 *
 * `computeTrainingLoad` already computes all of this and, until now, only
 * one route and the Data page read it: a built capability nothing requests,
 * the Phase 8 archetype exactly. This step is that capability finally being
 * asked for something.
 */

/** Acute:chronic ratio a planned week is not allowed to exceed. 1.3 is the conventional ceiling; above it injury rates climb sharply. */
export const ACWR_CEILING = 1.3;

/** Days of history before the ceiling will act at all. Under four weeks there is no four-week average to compare against. */
export const ACWR_MIN_HISTORY_DAYS = 28;

/**
 * Below this much logged training a week, the app does not claim to know
 * what the athlete has been doing.
 *
 * The history is LOGGED sessions, so an athlete who trains without a watch
 * looks detrained to this step. Clamping a real week against a phantom
 * baseline would be worse than not clamping: it would silently cut a
 * training week because a connector was not set up. Above the floor there is
 * enough evidence to speak; below it the step says nothing.
 */
export const ACWR_MIN_CHRONIC_WEEKLY_TSS = 100;

const ACWR_MAX_PASSES = 8;

/**
 * The athlete's own four-week average weekly load, or null when there is not
 * enough history to have an opinion.
 *
 * `monthlyTss / 4` rather than a second EWMA: the chronic side of an
 * acute:chronic ratio is the four-week rolling average, and it comes
 * straight out of the engine that already computes it.
 */
export function chronicWeeklyLoad(state: AthleteState, today: string): number | null {
  if (state.recentLoad.length === 0) return null;
  const load = computeTrainingLoad(state.recentLoad, state.params, today);
  if (load.history.length < ACWR_MIN_HISTORY_DAYS) return null;
  const weekly = load.monthlyTss / 4;
  return weekly < ACWR_MIN_CHRONIC_WEEKLY_TSS ? null : weekly;
}

/** What this week would be as a multiple of the athlete's recent normal. Null when there is no baseline to divide by. */
export function projectedAcwr(weekTss: number, chronicWeeklyTss: number | null): number | null {
  if (chronicWeeklyTss == null || chronicWeeklyTss <= 0) return null;
  return weekTss / chronicWeeklyTss;
}

/** Price a session at a different duration exactly as `buildSession` would, so the plan and the projection agree. */
function priceAt(session: AdjustedSession, minutes: number, athlete: AthleteParams): number {
  return estimateSessionTss(
    { sport: SPORT_OF[session.kind] as Sport, durationMinutes: minutes, rpe: session.targetRpe ?? rpeFor(session.kind) },
    athlete,
  );
}

/**
 * Clamp the week so it is at most `ACWR_CEILING` times the athlete's own
 * recent weekly load.
 *
 * Shortens proportionally and drops nothing — the week keeps its shape, the
 * long session stays the long session, and every shortened session is
 * rebuilt through `buildSession` so its targets and its price match its new
 * length. Sessions the athlete has already answered, and days that are
 * already behind them, are left exactly alone: this step can only change
 * what is still ahead.
 */
export function enforceAcwrCeiling(week: WorkingWeek, state: AthleteState, today: string): WorkingWeek {
  const chronic = chronicWeeklyLoad(state, today);
  if (chronic == null) return week;

  const allowed = chronic * ACWR_CEILING;
  const plannedTss = week.sessions.reduce((sum, s) => sum + s.tss, 0);
  const ratio = projectedAcwr(plannedTss, chronic);
  if (ratio == null || ratio <= ACWR_CEILING) return week;

  const flexible = week.sessions
    .map((session, index) => ({ session, index }))
    .filter(
      ({ session }) =>
        session.kind !== "rest" &&
        session.durationMinutes > 0 &&
        session.date >= today &&
        !isAnswered(session, state),
    );
  if (flexible.length === 0) return week;

  // Everything the step cannot touch is load the week is committed to; only
  // the remainder can absorb the cut.
  const fixedTss = plannedTss - flexible.reduce((sum, f) => sum + f.session.tss, 0);
  const targetPool = Math.max(0, allowed - fixedTss);

  const minutes = flexible.map((f) => f.session.durationMinutes);
  const floors = flexible.map((f) => KIND_MINUTES[f.session.kind].min);

  // Iterate to a fixed point rather than scaling once: a session that hits
  // its floor stops absorbing, and the rest have to take the remainder.
  for (let pass = 0; pass < ACWR_MAX_PASSES; pass++) {
    const prices = flexible.map((f, i) => priceAt(f.session, minutes[i]!, state.params));
    const pool = prices.reduce((sum, p) => sum + p, 0);
    const excess = pool - targetPool;
    if (excess <= 0) break;

    const room = flexible.map((_, i) => minutes[i]! > floors[i]!);
    const roomPool = prices.reduce((sum, p, i) => sum + (room[i] ? p : 0), 0);
    if (roomPool <= 0) break;

    const factor = Math.max(0, (roomPool - excess) / roomPool);
    let changed = false;
    for (let i = 0; i < minutes.length; i++) {
      if (!room[i]) continue;
      const next = Math.max(floors[i]!, Math.min(minutes[i]!, Math.round(minutes[i]! * factor)));
      if (next !== minutes[i]) {
        minutes[i] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const achieved =
    fixedTss + flexible.reduce((sum, f, i) => sum + priceAt(f.session, minutes[i]!, state.params), 0);
  if (achieved >= plannedTss) return week; // nothing could move: say nothing rather than something untrue

  const plannedRounded = Math.round(plannedTss);
  const achievedRounded = Math.round(achieved);
  const chronicRounded = Math.round(chronic);

  for (let i = 0; i < flexible.length; i++) {
    const { index, session } = flexible[i]!;
    const next = minutes[i]!;
    if (next >= session.durationMinutes) continue;
    adjustSessionAt(
      week,
      index,
      { durationMinutes: next },
      {
        source: "acwr",
        reason:
          `Trimmed from ${session.durationMinutes} to ${next} minutes: this week was planned at ${plannedRounded} of ` +
          `training load against the ${chronicRounded} a week you have actually been doing, and jumping more than a ` +
          `third in one week is where injuries come from. The week now sits at ${achievedRounded}.`,
      },
      state,
    );
  }

  return week;
}
