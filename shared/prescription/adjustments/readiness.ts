/**
 * The readiness slice of the modulation layer — what this morning does to
 * today.
 *
 * Third in the pipeline (`conditions` → `readiness` → `acwr` →
 * `conditions_guard`), so it acts on the week a torn calf has already
 * reshaped, and its own cut is then still subject to the weekly load
 * ceiling. It is pure, it touches sessions dated `today` and nothing else
 * (the one exception is moving today's hard session ONTO an empty tomorrow),
 * and it can only ever take load away.
 *
 * ─── The four gates, and why each one exists ─────────────────────────────
 *
 * 1. **`readiness.date === today`.** Yesterday's morning is not today's.
 *    A stale readiness quietly restructuring a week is the archetype this
 *    codebase keeps finding: state that should have stopped influencing
 *    output and didn't (the past-goal arbitration bug, Phase 3).
 *
 * 2. **`readiness.acting`.** DECISIONS C2: below five check-ins there is no
 *    baseline, so the band is a guess about a scale nobody has calibrated.
 *    A habitually pessimistic athlete reporting 2/3/3 on a perfectly good
 *    Tuesday would otherwise have every hard session downgraded forever.
 *    The score is still SHOWN from day one — a flag is useful immediately —
 *    but it does not restructure a week until it has earned the right to.
 *
 * 3. **`trainAnywayOverride`.** DECISIONS B7: the athlete is allowed to
 *    disagree with the app without falsifying their health record. Without
 *    this switch, an athlete who feels rough but intends to train has
 *    exactly one route to keeping their session — go back and lie about how
 *    they slept — which poisons the only dataset this feature produces.
 *
 * 4. **The phase gate (DECISIONS B3).** Every intensity-REMOVING action is
 *    gated on `week.phaseName`, which step 0 put on `PrescribedWeek` for
 *    precisely this. It cannot be inferred from `loadMultiplier`: an
 *    Ironman taper at 0.5 and priority 1 blended with a cut at 0.9 and
 *    priority 2 gives 0.633, so a multiplier guard never fires on the one
 *    week it most needs to. And race week is exactly when self-reported
 *    readiness is systematically worst — taper tension, nerves, bad sleep —
 *    so a naive rule would strip the sharpness out of every athlete's race
 *    week, every time, on a signal that means something different there.
 *    In taper and peak a low morning SHORTENS the hard session and leaves
 *    its kind alone: fewer reps, same pace. That is what a coach does.
 *
 * The slice NEVER adds load. `ready` and `high` are no-ops — a good morning
 * is not permission to make the week bigger, because the week was already
 * sized by goals that know things one morning does not.
 */

import { CHECK_IN_CAPTIONS, READINESS_BAND_LABELS, type CheckIn, type Readiness } from "../../readiness";
import { WEEKDAY_LABELS, addDays, weekdayOf } from "../../dates";
import {
  type AthleteState,
  type SessionChange,
  type WorkingWeek,
  adjustSessionAt,
  isAnswered,
  registerModulator,
  restDay,
} from "../adjust";
import type { PlannedSession, SessionKind } from "../sessionKinds";
import { HARD_KINDS, TITLE_OF, clampKind, downgradeToEasy } from "../templates";

/* ─── Constants ──────────────────────────────────────────────────────────── */

/**
 * Phases where race-specific sharpness is the point and must survive a bad
 * morning. Plain strings because `PrescribedWeek.phaseName` is a plain
 * string keyed into `PHASE_SHAPES`, not an enum — so there is nothing here
 * that could reach an athlete as an id.
 */
export const SHARPNESS_PROTECTED_PHASES: ReadonlySet<string> = new Set(["taper", "peak"]);

/**
 * How much of a hard session survives when a low morning lands in taper or
 * peak week.
 *
 * 70% is a real coaching number rather than a round one: enough volume off
 * that the session stops being a stressor, enough left that the athlete
 * still touches race pace. The alternative — cutting the kind — is what
 * arrives at a start line flat.
 */
export const SHARPNESS_SHORTEN_FACTOR = 0.7;

/** Every source this slice stamps. One constant so a reason and its source can never be written apart. */
const SOURCE = "checkin" as const;

/* ─── Words ──────────────────────────────────────────────────────────────── */

function captionOf(field: keyof typeof CHECK_IN_CAPTIONS, value: number): string {
  const scale = CHECK_IN_CAPTIONS[field].scale;
  const index = Math.min(scale.length, Math.max(1, Math.round(value))) - 1;
  return scale[index]!;
}

/**
 * The opening half of every reason: what the athlete actually told the app
 * this morning, in the words the check-in screen used when they told it.
 *
 * Reading their own answers back is what makes the change feel like a
 * consequence of something they said rather than something the app decided
 * about them. No score without its reasons, no band id, no enum value
 * (DECISIONS C7).
 */
export function reportedThisMorning(readiness: Readiness, checkIn: CheckIn | null): string {
  const score = readiness.score.value;
  const band = READINESS_BAND_LABELS[readiness.band].toLowerCase();
  if (!checkIn || checkIn.date !== readiness.date) {
    return `This morning's check-in put you at ${score} out of 100, which for you is ${band}.`;
  }
  return (
    `You reported sleep ${captionOf("sleepQuality", checkIn.sleepQuality)}, ` +
    `soreness ${captionOf("soreness", checkIn.soreness)} and ` +
    `energy ${captionOf("energy", checkIn.energy)} this morning — ` +
    `${score} out of 100, which for you is ${band}.`
  );
}

function dayName(date: string): string {
  return WEEKDAY_LABELS[weekdayOf(date)]!;
}

/* ─── Gates ──────────────────────────────────────────────────────────────── */

/**
 * Whether this morning is allowed to restructure today, and nothing about
 * what it would do.
 *
 * Exported because the same four gates decide whether the check-in card says
 * "here is what changed" or "this is on record and your week stands" — and
 * two copies of that answer would eventually disagree with each other in
 * front of the athlete.
 */
export function readinessActsOn(state: AthleteState, today: string): Readiness | null {
  const readiness = state.readiness;
  if (!readiness) return null;
  if (readiness.date !== today) return null;
  if (!readiness.acting) return null;
  // Checked on BOTH records rather than trusting `acting` alone: the override
  // is the athlete's explicit instruction, and an instruction that only one
  // of two fields has to carry is an instruction that can be lost.
  if (readiness.trainAnywayOverride) return null;
  if (state.checkIn?.date === today && state.checkIn.trainAnywayOverride) return null;
  if (readiness.band !== "low" && readiness.band !== "very_low") return null;
  return readiness;
}

/* ─── The slice ──────────────────────────────────────────────────────────── */

function isHard(session: PlannedSession): boolean {
  return HARD_KINDS.has(session.kind);
}

function todaysSessions(week: WorkingWeek, today: string, state: AthleteState): number[] {
  const indices: number[] = [];
  week.sessions.forEach((session, index) => {
    if (session.date !== today) return;
    if (session.kind === "rest") return;
    if (isAnswered(session, state)) return;
    indices.push(index);
  });
  return indices;
}

/**
 * Can this hard session move to tomorrow?
 *
 * Four conditions, and the last two are the no-back-to-back rule
 * `assignDates` already lays the week out to honour. Moving a hard session
 * next to another hard session does not make the week easier — it makes it
 * worse in a way the athlete will not see coming.
 */
function canMoveToTomorrow(week: WorkingWeek, index: number, today: string): boolean {
  const session = week.sessions[index];
  if (!session) return false;
  const tomorrow = addDays(today, 1);
  // Never outside the week being served: a session placed on the following
  // Monday belongs to a week this call is not allowed to touch.
  if (tomorrow > addDays(week.weekStart, 6)) return false;
  // Tomorrow has to be genuinely free — not "free of hard work". Dropping a
  // threshold run on top of an existing session both doubles the day and,
  // if the kinds happen to match, collides on the completion key.
  if (week.sessions.some((s) => s.date === tomorrow)) return false;
  // And the day after tomorrow must hold nothing hard.
  const dayAfter = addDays(today, 2);
  if (week.sessions.some((s) => s.date === dayAfter && isHard(s))) return false;
  // ...as must today, once this one has left. Two hard sessions today means
  // moving one of them simply relocates the stack.
  if (week.sessions.some((s, i) => i !== index && s.date === today && isHard(s))) return false;
  return true;
}

/** Whether a kind already sits on this date — the completion key is `(date, kind)`, so a second one would be untickable. */
function kindTakenOn(week: WorkingWeek, date: string, kind: SessionKind, exceptIndex: number): boolean {
  return week.sessions.some((s, i) => i !== exceptIndex && s.date === date && s.kind === kind);
}

/** Cut a session's length, never past the floor for its kind and never upward. */
function shortenedMinutes(session: PlannedSession): number {
  const target = clampKind(session.kind, Math.round(session.durationMinutes * SHARPNESS_SHORTEN_FACTOR));
  return Math.min(session.durationMinutes, target);
}

function change(reason: string): SessionChange {
  return { reason, source: SOURCE };
}

/**
 * In taper or peak: keep the session, take the volume off it.
 *
 * Returns false when there is nothing honest to do — a session already at
 * the floor for its kind gets left alone rather than "adjusted" by zero
 * minutes, which would put a change in the athlete's changelog that did not
 * happen.
 */
function shortenForSharpness(
  week: WorkingWeek,
  index: number,
  state: AthleteState,
  opener: string,
): boolean {
  const session = week.sessions[index]!;
  const minutes = shortenedMinutes(session);
  if (minutes >= session.durationMinutes) return false;
  return adjustSessionAt(
    week,
    index,
    { durationMinutes: minutes },
    change(
      `${opener} This is race week, so the ${TITLE_OF[session.kind].toLowerCase()} keeps its kind and its pace and ` +
        `just gets shorter: ${session.durationMinutes} minutes down to ${minutes}. Fewer reps, same speed — sharpness ` +
        `is the one thing you cannot get back before the start line, and feeling flat in a taper is normal rather than ` +
        `a reason to train easy.`,
    ),
    state,
  );
}

/** Move today's hard session onto an empty tomorrow, keeping its kind, its length and its targets. */
function moveToTomorrow(week: WorkingWeek, index: number, today: string, state: AthleteState, opener: string): boolean {
  const session = week.sessions[index]!;
  const tomorrow = addDays(today, 1);
  return adjustSessionAt(
    week,
    index,
    { date: tomorrow },
    change(
      `${opener} ${TITLE_OF[session.kind]} moved from ${dayName(today)} to ${dayName(tomorrow)}, unchanged — ` +
        `${dayName(tomorrow)} was free and nothing hard sits on ${dayName(addDays(today, 2))}, so the work is kept ` +
        `rather than lost and you get a day to come back to it.`,
    ),
    state,
  );
}

/** Nowhere to move it to: keep the slot, take the intensity out of it. */
function downgradeToday(week: WorkingWeek, index: number, state: AthleteState, opener: string, why: string): boolean {
  const session = week.sessions[index]!;
  const kind = downgradeToEasy(session.kind);
  // `downgradeToEasy` walks DOWNGRADE to a fixed point, so `run_intervals`
  // lands on `run_easy` rather than on the `run_threshold` a single step
  // would give — a hard session prescribed to an athlete who just said they
  // are under par (DECISIONS B1).
  if (kind === session.kind) return shortenForSharpness(week, index, state, opener);
  if (kindTakenOn(week, session.date, kind, index)) return shortenForSharpness(week, index, state, opener);
  const minutes = Math.min(session.durationMinutes, clampKind(kind, session.durationMinutes));
  return adjustSessionAt(
    week,
    index,
    { kind, durationMinutes: minutes },
    change(
      `${opener} ${TITLE_OF[session.kind]} becomes ${TITLE_OF[kind].toLowerCase()}, ${minutes} minutes at your own ` +
        `easy pace: ${why} Hard work done on a morning like this costs more to recover from than it builds.`,
    ),
    state,
  );
}

/**
 * A low morning: take the intensity out of today, or postpone it.
 *
 * Non-hard sessions are left exactly as they are. An easy run on a rough
 * morning is the session that most deserves to survive — it is how the day
 * gets its aerobic work without asking anything of a body that has said no.
 */
function applyLowBand(week: WorkingWeek, state: AthleteState, today: string, opener: string): void {
  const sharpness = SHARPNESS_PROTECTED_PHASES.has(week.phaseName);

  // Latest first: the indices of everything before an untouched session stay
  // valid, and `adjustSessionAt` replaces in place rather than reordering.
  for (const index of todaysSessions(week, today, state).reverse()) {
    const session = week.sessions[index]!;
    if (!isHard(session)) continue;

    if (sharpness) {
      shortenForSharpness(week, index, state, opener);
      continue;
    }

    if (canMoveToTomorrow(week, index, today)) {
      moveToTomorrow(week, index, today, state, opener);
      continue;
    }

    downgradeToday(
      week,
      index,
      state,
      opener,
      "there was no free day later this week to move it to without stacking two hard days together.",
    );
  }
}

/**
 * A very low morning: today becomes rest, and what was planned stays
 * recoverable.
 *
 * Not phase-gated, unlike the low band. The phase gate exists to protect
 * race-specific SHARPNESS from being downgraded away, and one rest day does
 * not blunt anyone — a taper is mostly rest already. A score this far below
 * the athlete's own normal is a different signal from "tired in taper
 * week", and the coaching answer to it is the same in every phase.
 *
 * DECISIONS B7: the displaced sessions go to `week.dropped`, where the Plan
 * page renders them with an "actually, I did this" control. An athlete who
 * trains anyway must not lose the record, and must not have to go back and
 * falsify this morning to keep it.
 */
function applyVeryLowBand(week: WorkingWeek, state: AthleteState, today: string, opener: string): void {
  restDay(
    week,
    today,
    change(
      `${opener} Today is rest. What was planned is still listed below, so if you go out and do it anyway you can ` +
        `still tick it off — this morning stays on record either way.`,
    ),
    state,
  );
}

/**
 * The modulator. Registered into the `readiness` stage at import time; the
 * layer decides where in the pipeline that sits.
 */
export function applyReadiness(week: WorkingWeek, state: AthleteState, today: string): WorkingWeek {
  const readiness = readinessActsOn(state, today);
  if (!readiness) return week;

  const opener = reportedThisMorning(readiness, state.checkIn);

  if (readiness.band === "very_low") applyVeryLowBand(week, state, today, opener);
  else applyLowBand(week, state, today, opener);

  return week;
}

registerModulator("readiness", applyReadiness);
