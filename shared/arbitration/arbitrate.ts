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

export function arbitrateWeek(goals: Goal[], date: string, athlete: AthleteParams): ArbitratedWeek {
  const active = goals.filter((g) => g.active);
  const phases = active.map((g) => phaseForGoal(g, date, athlete));
  const conflicts: GoalConflict[] = [];

  // ── Nutrition stance: surplus vs. deficit is a direct contradiction ────
  const surplusPhases = phases.filter((p) => p.nutritionStance === "surplus");
  const deficitPhases = phases.filter((p) => p.nutritionStance === "deficit");
  let nutritionStance: NutritionStance = "maintenance";

  if (surplusPhases.length > 0 && deficitPhases.length > 0) {
    const surplusGoal = active.find((g) => g.id === surplusPhases[0]!.goalId)!;
    const deficitGoal = active.find((g) => g.id === deficitPhases[0]!.goalId)!;
    const surplusWins = surplusGoal.priority <= deficitGoal.priority;
    nutritionStance = surplusWins ? "surplus" : "deficit";
    const winner = surplusWins ? surplusPhases[0]! : deficitPhases[0]!;
    const loser = surplusWins ? deficitPhases[0]! : surplusPhases[0]!;
    conflicts.push({
      betweenGoalIds: [surplusGoal.id, deficitGoal.id],
      window: { from: date, to: date },
      description: `${winner.goalLabel} needs a ${winner.nutritionStance} and outranks ${loser.goalLabel} by priority, so this week runs ${winner.nutritionStance} — ${loser.goalLabel} will progress slower than it would alone.`,
      resolution: resolutionFor(surplusGoal.id, deficitGoal.id, active),
    });
  } else if (deficitPhases.length > 0) {
    nutritionStance = "deficit";
  } else if (surplusPhases.length > 0) {
    nutritionStance = "surplus";
  }

  // ── Training load: priority-weighted blend, conflict flagged when the
  // raw asks actually pull apart rather than merely differing a little. ──
  let loadMultiplier = 1.0;
  if (active.length > 0) {
    const totalWeight = active.reduce((sum, g) => sum + 1 / g.priority, 0);
    loadMultiplier = phases.reduce((sum, p, i) => sum + p.loadMultiplier * (1 / active[i]!.priority), 0) / totalWeight;

    const maxPhase = phases.reduce((a, b) => (b.loadMultiplier > a.loadMultiplier ? b : a));
    const minPhase = phases.reduce((a, b) => (b.loadMultiplier < a.loadMultiplier ? b : a));
    if (maxPhase.goalId !== minPhase.goalId && maxPhase.loadMultiplier - minPhase.loadMultiplier > LOAD_CONFLICT_THRESHOLD) {
      const highGoal = active.find((g) => g.id === maxPhase.goalId)!;
      const lowGoal = active.find((g) => g.id === minPhase.goalId)!;
      conflicts.push({
        betweenGoalIds: [highGoal.id, lowGoal.id],
        window: { from: date, to: date },
        description: `${maxPhase.goalLabel} wants elevated load (${maxPhase.phaseName}, ${maxPhase.loadMultiplier}x) while ${minPhase.goalLabel} wants it reduced (${minPhase.phaseName}, ${minPhase.loadMultiplier}x). Blended to ${Math.round(loadMultiplier * 100) / 100}x — neither goal is fully honored this week.`,
        resolution: resolutionFor(highGoal.id, lowGoal.id, active),
      });
    }
  }

  return { date, goalPhases: phases, nutritionStance, loadMultiplier: Math.round(loadMultiplier * 100) / 100, conflicts };
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

export function arbitratePlan(goals: Goal[], fromDate: string, toDate: string, athlete: AthleteParams): ArbitratedPlan {
  const weeks: ArbitratedWeek[] = [];
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (cursor <= end) {
    weeks.push(arbitrateWeek(goals, cursor.toISOString().slice(0, 10), athlete));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return { fromDate, toDate, weeks, conflicts: mergeContiguousConflicts(weeks.flatMap((w) => w.conflicts)) };
}
