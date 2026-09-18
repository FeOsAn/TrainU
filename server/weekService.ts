/**
 * The week, assembled once.
 *
 * `GET /api/plan/week` is the screen an athlete opens every morning, and it
 * is now the output of a four-stage pipeline rather than a single call:
 *
 *   buildAthleteState → arbitrateWeek → prescribeWeek → adjustWeek
 *
 * arbitration says what the goals want, prescription turns that into
 * sessions, and the modulation layer turns those into the sessions THIS
 * athlete can actually do today given an open injury, a bad morning and how
 * much they have genuinely been training.
 *
 * It lives in its own file for one reason beyond routes.ts's length: the
 * check-in endpoint has to answer "what did that change?", and the only
 * honest answer is the one the week itself produces. Two code paths building
 * a week two ways is precisely the drift this codebase keeps refusing to
 * ship — so the check-in route calls `buildWeek` too and reads the answer
 * off it.
 */

import { addDays, startOfWeek, todayISO } from "@shared/dates";
import type { AthleteParams } from "@shared/athlete";
import type { Goal } from "@shared/goal";
import {
  type Condition,
  type RampPosition,
  assessGoalRisk,
  conditionsOn,
} from "@shared/conditions";
import { arbitrateWeek, type ArbitratedWeek } from "@shared/arbitration/arbitrate";
import { prescribeWeek } from "@shared/prescription/prescribe";
import {
  type AdjustedSession,
  type AdjustedWeek,
  type Adjustment,
  ADJUSTMENT_ACTION_LABELS,
  adjustWeek,
} from "@shared/prescription/adjust";
import { sessionCompletionKey } from "@shared/prescription/sessionKinds";
import { dailyTargets, type MacroTarget } from "@shared/nutrition";
import type { CheckIn, Readiness } from "@shared/readiness";

/*
 * Side-effect imports, and they are load-bearing.
 *
 * `MODULATORS` is a registry with four stages; the two slices below register
 * themselves at module load. Without these lines the conditions and
 * readiness stages stay `null` and `adjustWeek` silently runs the ACWR
 * ceiling alone — a week that looks completely plausible while ignoring a
 * broken foot. There is a test that asserts every stage is filled.
 */
import "@shared/prescription/adjustments/conditions";
import "@shared/prescription/adjustments/readiness";

import { buildAthleteState, getAthleteParams } from "./athleteStateService";
import { listGoals } from "./goalsService";
import { listCompletions, loggedSessionsFor, summariseAdherence, type AdherenceSummary, type CompletionRecord } from "./completionsService";
import { getCheckIn, recordCheckInAdjustments, type CheckInAdjustmentSummary } from "./checkInsService";
import { getAppShell } from "./appShellService";

/** A session as the client sees it: the adjusted card plus whether it has been answered. */
export type WeekSession = AdjustedSession & { completion: CompletionRecord | null };

export interface WeekDay {
  date: string;
  sessions: WeekSession[];
  dailyTss: number;
  nutrition: MacroTarget;
}

/** Conditions that bear on THIS week — open on at least one of its days, or ramping across one. */
export interface WeekConditions {
  open: Condition[];
  ramping: Array<{ condition: Condition; ramp: RampPosition; date: string }>;
  /** Open on paper but gone stale; the engine ignores them, the athlete is asked to confirm. */
  suspended: Condition[];
}

export interface WeekView {
  weekStart: string;
  arbitrated: ArbitratedWeek;
  days: WeekDay[];
  /** The ADJUSTED week's totals. `original` carries the prescription's. */
  totalMinutes: number;
  totalTss: number;
  note: string;
  phaseName: string;
  adherence: AdherenceSummary;
  /** What the modulation layer changed, in applied order. Each `reason` is a full sentence. */
  adjustments: Adjustment[];
  original: { totalMinutes: number; totalTss: number };
  /** Removed from the week but NOT from the record — still tickable (DECISIONS B7). */
  dropped: WeekSession[];
  conditions: WeekConditions;
  checkIn: CheckIn | null;
  readiness: Readiness | null;
}

export interface BuildWeekOptions {
  /** Any date inside the week to build. Defaults to today. */
  date?: string;
  daysPerWeek?: number;
  /** The real current date. NEVER the requested date — see below. */
  today?: string;
}

function weekConditions(conditions: Condition[], dates: string[], today: string): WeekConditions {
  const open = new Map<string, Condition>();
  const suspended = new Map<string, Condition>();
  const ramping = new Map<string, { condition: Condition; ramp: RampPosition; date: string }>();

  for (const date of dates) {
    const on = conditionsOn(conditions, date, today);
    for (const c of on.open) open.set(c.id, c);
    for (const c of on.suspended) suspended.set(c.id, c);
    // First day of the week a ramp covers is the one worth naming — the ramp
    // position itself carries the dates steady and full training come back.
    for (const r of on.ramping) if (!ramping.has(r.condition.id)) ramping.set(r.condition.id, { ...r, date });
  }

  return { open: [...open.values()], ramping: [...ramping.values()], suspended: [...suspended.values()] };
}

/**
 * Attach each live goal's health risk to its phase.
 *
 * `GoalPhase.risk` is declared for exactly this and is never set by
 * `phaseForGoal`: a condition changes nothing about what a goal WANTS this
 * week, only about what has actually been possible. Keeping it an annotation
 * is what keeps the arbitrated numbers provably independent of the athlete's
 * health state, with the honest consequence surfaced instead.
 *
 * Only attached when there is any health history at all, so a `risk` object
 * on a phase means "there is something here to read", not "we checked".
 */
function withGoalRisk(arbitrated: ArbitratedWeek, goals: Goal[], conditions: Condition[], weekEnd: string, today: string): ArbitratedWeek {
  if (conditions.length === 0) return arbitrated;

  /*
   * Risk is assessed at the point in THIS week closest to now.
   *
   * Not at the week's Monday, which was the obvious thing to pass and is
   * wrong for the week the athlete is actually in: `assessGoalRisk` counts
   * the 28 days up to `asOf`, so a calf strain opened on Thursday would not
   * appear on Thursday's own screen. Not at `today` either, because a future
   * week is genuinely closer to the race and a past week must not be
   * re-labelled with news that arrived after it.
   */
  const asOf = today < arbitrated.date ? arbitrated.date : today > weekEnd ? weekEnd : today;

  return {
    ...arbitrated,
    goalPhases: arbitrated.goalPhases.map((phase) => {
      if (phase.phaseName === "past") return phase;
      const goal = goals.find((g) => g.id === phase.goalId);
      if (!goal) return phase;
      return { ...phase, risk: assessGoalRisk(goal, conditions, asOf, today) };
    }),
  };
}

/** The layer's changes, in the words the athlete was shown — never an action id. */
export function checkInSummaries(adjustments: readonly Adjustment[]): CheckInAdjustmentSummary[] {
  return adjustments
    .filter((a) => a.source === "checkin")
    .map((a) => ({ date: a.date, kind: a.kind, action: ADJUSTMENT_ACTION_LABELS[a.action], reason: a.reason }));
}

/**
 * Build one week, end to end.
 *
 * `today` and the requested week are deliberately separate arguments and
 * mean different things: `today` decides which conditions have gone stale,
 * whose check-in is this morning's and what the trailing load is, while the
 * requested date only picks which seven days to render. Browsing next week
 * must not apply this morning's check-in to it.
 */
export function buildWeek(options: BuildWeekOptions = {}): WeekView {
  const today = options.today ?? todayISO();
  const weekStart = startOfWeek(options.date ?? today);
  const weekEnd = addDays(weekStart, 6);
  const dates = Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset));

  const state = buildAthleteState(weekStart, weekEnd, today);
  const athlete: AthleteParams = state.params;
  const activeGoals = listGoals().filter((g) => g.active);

  /*
   * Block off = engine off.
   *
   * The two health blocks carry their own capabilities rather than having a
   * separate engine twin, so switching "Morning check-in" or "Something
   * hurts?" off in Your app switches the behaviour off through the ONE
   * matching rule that already decides what renders — not a second flag that
   * would eventually disagree with the first. One variable each, applied to
   * both the modulation layer and the arbitration input, so a condition
   * cannot steer nutrition while being invisible everywhere else.
   */
  const capabilities = getAppShell(today).capabilities;
  if (!capabilities.includes("readiness_modulation")) state.readiness = null;
  if (!capabilities.includes("condition_adjustment")) state.conditions = [];
  const conditions = state.conditions;

  const arbitrated = withGoalRisk(
    arbitrateWeek(activeGoals, weekStart, athlete, conditions, today),
    activeGoals,
    conditions,
    weekEnd,
    today,
  );

  const prescribed = prescribeWeek(arbitrated, activeGoals, athlete, { daysPerWeek: options.daysPerWeek });
  const adjusted: AdjustedWeek = adjustWeek(prescribed, state, today);

  const completions = listCompletions(weekStart, weekEnd);
  const completionByKey = new Map(completions.map((c) => [c.key, c]));
  const answer = (s: AdjustedSession): WeekSession => ({
    ...s,
    completion: completionByKey.get(sessionCompletionKey(s.date, s.kind)) ?? null,
  });

  // The deficit is sized off the rate the body-composition goal's deadline
  // actually demands — carried through on its phase rather than recomputed.
  const requiredWeeklyChangeKg = arbitrated.goalPhases.find((p) => p.requiredWeeklyChangeKg != null)?.requiredWeeklyChangeKg ?? null;

  const days: WeekDay[] = dates.map((date) => {
    const sessions = adjusted.sessions.filter((s) => s.date === date).map(answer);

    /*
     * ── DECISIONS B6: nutrition targets follow the PLAN, not the performance ──
     *
     * `dailyTss` is the ADJUSTED week's planned load for this day. It is
     * deliberately NOT derived from completions, and nobody should "fix"
     * that later:
     *
     * The adjusted week is the right basis because every change in it is
     * visible and explicable — an illness rest day correctly gets rest-day
     * macros, and the athlete can read the sentence saying why.
     *
     * Completions are the WRONG basis because they would rewrite the past.
     * Skip Thursday's long run and Thursday's calorie target would silently
     * drop by several hundred kcal — after the athlete had already eaten to
     * the number this app gave them that morning. The screen would then be
     * telling someone, most likely someone mid-cut, that they overate on a
     * day they did exactly what they were told. That is the most harmful
     * thing this app could display, and it would be a side effect nobody
     * chose. A missed session shows up as missed training, in the adherence
     * line, where it belongs.
     */
    const dailyTss = sessions.reduce((sum, s) => sum + s.tss, 0);

    return {
      date,
      sessions,
      dailyTss,
      nutrition: dailyTargets(athlete, { stance: arbitrated.nutritionStance, requiredWeeklyChangeKg, dailyTss }),
    };
  });

  /*
   * What this morning's check-in did, kept alongside the check-in itself.
   *
   * Only for the CURRENT week — an adjustment recorded against today cannot
   * have come from a week the athlete is merely browsing — and only when
   * there is a check-in to attach it to. An empty list is a meaningful
   * record: "you told us, and nothing needed to change".
   */
  if (weekStart === startOfWeek(today) && getCheckIn(today)) {
    recordCheckInAdjustments(today, checkInSummaries(adjusted.adjustments));
  }

  return {
    weekStart,
    arbitrated,
    days,
    totalMinutes: adjusted.totalMinutes,
    totalTss: adjusted.totalTss,
    note: adjusted.note,
    phaseName: adjusted.phaseName,
    adherence: summariseAdherence(completions, adjusted.sessions.length, athlete, loggedSessionsFor(completions)),
    adjustments: adjusted.adjustments,
    original: adjusted.original,
    dropped: adjusted.dropped.map(answer),
    conditions: weekConditions(conditions, dates, today),
    checkIn: state.checkIn,
    readiness: state.readiness,
  };
}

/** The athlete's numbers as every read path should see them — benchmarks and the newest weigh-in folded in. */
export { getAthleteParams };
