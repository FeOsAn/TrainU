/**
 * Turns N independent per-goal phases (goalPhase.ts) into ONE weekly
 * training instruction, surfacing every real tradeoff instead of silently
 * picking a winner or averaging it away invisibly. This is the actual
 * differentiator this whole app is built around — see CLAUDE.md.
 *
 * Two things can conflict between simultaneous goals:
 *  - Nutrition stance: surplus and deficit are a direct contradiction —
 *    you can't run both at once, so one goal's need must yield.
 *  - Training load: one goal wanting MORE stress while another wants LESS
 *    in the same week is blended by priority rather than either being
 *    fully honored, and that compromise is exactly what gets reported.
 */

import type { Goal, GoalConflict } from "../goal";
import type { AthleteParams } from "../athlete";
import { isOpenOn, type Condition } from "../conditions";
import { addDays } from "../dates";
import { phaseForGoal, type GoalPhase, type NutritionStance } from "./goalPhase";

export interface ArbitratedWeek {
  date: string;
  goalPhases: GoalPhase[];
  nutritionStance: NutritionStance;
  /** Blended relative to a 1.0 baseline week. */
  loadMultiplier: number;
  conflicts: GoalConflict[];
}

/** Load multipliers within this band of each other aren't worth calling a conflict — they're not really pulling against each other. */
const LOAD_CONFLICT_THRESHOLD = 0.15;

function resolutionFor(goalAId: string, goalBId: string, goals: Goal[]): GoalConflict["resolution"] {
  const a = goals.find((g) => g.id === goalAId)!;
  const b = goals.find((g) => g.id === goalBId)!;
  if (a.priority === b.priority) return "balanced";
  return a.priority < b.priority ? "goal_a_priority" : "goal_b_priority";
}

/**
 * Severity at which a condition stops being something you train around and
 * starts being something you have to eat for. A niggle does not pause a cut;
 * a real injury or a real illness does.
 */
const HEALING_SEVERITY = 2;

/**
 * @param conditions Open and recently-closed injuries/illnesses. Defaults to
 *   none, and with none the output is byte-identical to what this function
 *   returned before conditions existed — pinned by a test.
 * @param today The real current date. A future week can only be arbitrated
 *   against what is known NOW, so a condition's state is read at
 *   `min(date, today)`: past weeks see what was true then, future weeks see
 *   today's state rather than a guess about recovery.
 */
export function arbitrateWeek(
  goals: Goal[],
  date: string,
  athlete: AthleteParams,
  conditions: Condition[] = [],
  today: string = date,
): ArbitratedWeek {
  const active = goals.filter((g) => g.active);
  // Keep each goal paired with its own phase rather than relying on two
  // arrays staying index-aligned — filtering below would silently mismatch
  // priorities to the wrong goal otherwise.
  const all = active.map((goal) => ({ goal, phase: phaseForGoal(goal, date, athlete) }));

  /*
   * A goal whose target date has passed is reported (the UI still shows
   * "past") but takes NO part in arbitration. It used to, and the result was
   * a real training bug: a body-composition goal that finished in October
   * still contributed its neutral 1.0x — at priority 1, so heavily weighted —
   * straight through the following June's race week, pulling a 0.5x taper up
   * to 0.83x. The athlete would have been told to train through the taper
   * into their A-race on behalf of a wedding seven months behind them.
   */
  const live = all.filter(({ phase }) => phase.phaseName !== "past");
  const conflicts: GoalConflict[] = [];
  const liveGoals = live.map(({ goal }) => goal);

  // ── Nutrition stance: surplus vs. deficit is a direct contradiction ────
  const surplus = live.filter(({ phase }) => phase.nutritionStance === "surplus");
  const deficit = live.filter(({ phase }) => phase.nutritionStance === "deficit");
  let nutritionStance: NutritionStance = "maintenance";

  if (surplus.length > 0 && deficit.length > 0) {
    const surplusEntry = surplus[0]!;
    const deficitEntry = deficit[0]!;
    const surplusWins = surplusEntry.goal.priority <= deficitEntry.goal.priority;
    nutritionStance = surplusWins ? "surplus" : "deficit";
    const winner = surplusWins ? surplusEntry.phase : deficitEntry.phase;
    const loser = surplusWins ? deficitEntry.phase : surplusEntry.phase;
    conflicts.push({
      betweenGoalIds: [surplusEntry.goal.id, deficitEntry.goal.id],
      window: { from: date, to: date },
      description: `${winner.goalLabel} needs a ${winner.nutritionStance} and outranks ${loser.goalLabel} by priority, so this week runs ${winner.nutritionStance} — ${loser.goalLabel} will progress slower than it would alone.`,
      resolution: resolutionFor(surplusEntry.goal.id, deficitEntry.goal.id, liveGoals),
    });
  } else if (deficit.length > 0) {
    nutritionStance = "deficit";
  } else if (surplus.length > 0) {
    nutritionStance = "surplus";
  }

  // ── Training load: priority-weighted blend, conflict flagged when the
  // raw asks actually pull apart rather than merely differing a little. ──
  let loadMultiplier = 1.0;
  if (live.length > 0) {
    const totalWeight = live.reduce((sum, { goal }) => sum + 1 / goal.priority, 0);
    loadMultiplier = live.reduce((sum, { goal, phase }) => sum + phase.loadMultiplier * (1 / goal.priority), 0) / totalWeight;

    const high = live.reduce((a, b) => (b.phase.loadMultiplier > a.phase.loadMultiplier ? b : a));
    const low = live.reduce((a, b) => (b.phase.loadMultiplier < a.phase.loadMultiplier ? b : a));
    if (high.goal.id !== low.goal.id && high.phase.loadMultiplier - low.phase.loadMultiplier > LOAD_CONFLICT_THRESHOLD) {
      conflicts.push({
        betweenGoalIds: [high.goal.id, low.goal.id],
        window: { from: date, to: date },
        description: `${high.phase.goalLabel} wants elevated load (${high.phase.phaseName}, ${high.phase.loadMultiplier}x) while ${low.phase.goalLabel} wants it reduced (${low.phase.phaseName}, ${low.phase.loadMultiplier}x). Blended to ${Math.round(loadMultiplier * 100) / 100}x — neither goal is fully honored this week.`,
        resolution: resolutionFor(high.goal.id, low.goal.id, liveGoals),
      });
    }
  }

  /*
   * ── A deficit does not run through a real injury ──────────────────────
   *
   * While a condition of severity 2 or worse is open, the stance is forced
   * to maintenance. This is not a softening of the goal, it is arithmetic:
   * the conditions layer strips training load out of the week, which lowers
   * maintenance energy, and applying a 25% deficit to that already-reduced
   * number is a double cut landing exactly when tissue repair needs protein
   * and energy the most. An athlete cutting through a calf strain heals
   * slower and loses more lean mass for it.
   *
   * Deterministic and stated, never silent: the athlete gets the same
   * explanation channel a goal-vs-goal tradeoff uses, so "why am I not in a
   * deficit this week" has an answer on the screen.
   */
  /*
   * The week is seven days long, so "is a condition open during this week"
   * cannot be answered from its Monday alone. Anchoring on `date` meant an
   * injury opened on Wednesday did not pause the cut on the very screen
   * showing that Wednesday — the stance read `deficit` while the same
   * response carried two sessions this injury had just turned into rest.
   *
   * Clamp now into the week instead: the current week asks about today, a
   * past week asks about its own last day (so news that arrived afterwards
   * never rewrites it), and a future week asks about its first (reporting
   * what is true as things stand, not a guess about recovery).
   */
  const weekEnd = addDays(date, 6);
  const asOf = today < date ? date : today > weekEnd ? weekEnd : today;
  const healing = conditions.filter((c) => c.severity >= HEALING_SEVERITY && isOpenOn(c, asOf));
  if (healing.length > 0 && nutritionStance !== "maintenance") {
    const pausedStance = nutritionStance;
    const paused = live.find(({ phase }) => phase.nutritionStance === pausedStance);
    nutritionStance = "maintenance";
    if (paused) {
      const labels = healing.map((c) => c.label);
      const named = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
      const what = pausedStance === "deficit" ? "cut" : "gaining phase";
      conflicts.push({
        // Both ids are the same goal on purpose: the other party here is a
        // condition, not a goal, and inventing a fake goal id to fill the
        // pair would put something in the UI that nothing can look up.
        betweenGoalIds: [paused.goal.id, paused.goal.id],
        window: { from: date, to: date },
        description: `${paused.phase.goalLabel}: your ${what} is paused while ${named} is open — healing costs protein and energy, and eating under maintenance while your body is repairing tissue slows both. It goes back to a ${pausedStance} the week after you mark it healed.`,
      });
    }
  }

  return {
    date,
    goalPhases: all.map(({ phase }) => phase),
    nutritionStance,
    loadMultiplier: Math.round(loadMultiplier * 100) / 100,
    conflicts,
  };
}

export interface ArbitratedPlan {
  fromDate: string;
  toDate: string;
  weeks: ArbitratedWeek[];
  /** Conflicts between the same goal pair across contiguous weeks are merged into one span, so a 12-week cut isn't 12 near-identical conflict entries. */
  conflicts: GoalConflict[];
}

function pairKey(ids: [string, string]): string {
  return [...ids].sort().join("|");
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

function mergeContiguousConflicts(raw: GoalConflict[]): GoalConflict[] {
  const byPair = new Map<string, GoalConflict[]>();
  for (const c of raw) {
    const key = pairKey(c.betweenGoalIds);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(c);
  }

  const merged: GoalConflict[] = [];
  for (const list of byPair.values()) {
    list.sort((a, b) => a.window.from.localeCompare(b.window.from));
    let current: GoalConflict | null = null;
    for (const c of list) {
      // Weekly steps mean the next window's start is ~7 days after the last;
      // an 8-day gap comfortably covers that without merging genuinely
      // separate conflict episodes that happen to recur later.
      if (current && daysBetween(current.window.to, c.window.from) <= 8) {
        current.window = { from: current.window.from, to: c.window.to };
        current.description = c.description; // the latest week's numbers are the most relevant
      } else {
        if (current) merged.push(current);
        current = { ...c, window: { ...c.window } };
      }
    }
    if (current) merged.push(current);
  }
  return merged;
}

export function arbitratePlan(
  goals: Goal[],
  fromDate: string,
  toDate: string,
  athlete: AthleteParams,
  conditions: Condition[] = [],
  today: string = fromDate,
): ArbitratedPlan {
  const weeks: ArbitratedWeek[] = [];
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (cursor <= end) {
    weeks.push(arbitrateWeek(goals, cursor.toISOString().slice(0, 10), athlete, conditions, today));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return { fromDate, toDate, weeks, conflicts: mergeContiguousConflicts(weeks.flatMap((w) => w.conflicts)) };
}
