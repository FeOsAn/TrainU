/**
 * What a single goal wants THIS week, in isolation — before any arbitration
 * against other simultaneous goals happens. That's arbitrate.ts's job; this
 * file only answers "if this were the athlete's only goal, what phase would
 * they be in right now."
 */

import type { Goal } from "../goal";
import type { AthleteParams } from "../athlete";
import { predictBodyComposition } from "../predictors/bodyComposition";

export type NutritionStance = "surplus" | "maintenance" | "deficit";

export interface GoalPhase {
  goalId: string;
  goalLabel: string;
  goalType: Goal["type"];
  phaseName: string;
  /** Relative to a 1.0 baseline week for this goal alone — NOT yet blended with any other goal. */
  loadMultiplier: number;
  nutritionStance: NutritionStance;
  notes: string;
}

function weeksUntil(fromDate: string, targetDate: string): number {
  return (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / (7 * 86_400_000);
}

function base(goal: Goal): Pick<GoalPhase, "goalId" | "goalLabel" | "goalType"> {
  return { goalId: goal.id, goalLabel: goal.label, goalType: goal.type };
}

function phaseForEnduranceLike(goal: Goal, weeksOut: number): GoalPhase {
  if (weeksOut <= 1.5) {
    return { ...base(goal), phaseName: "taper", loadMultiplier: 0.5, nutritionStance: "maintenance", notes: "Final taper — volume down, intensity held, arrive fresh." };
  }
  if (weeksOut <= 3) {
    return { ...base(goal), phaseName: "peak", loadMultiplier: 0.85, nutritionStance: "maintenance", notes: "Peak block — race-specific work, volume trimmed to absorb it." };
  }
  if (weeksOut <= 12) {
    return { ...base(goal), phaseName: "build", loadMultiplier: 1.15, nutritionStance: "maintenance", notes: "Build phase — volume and race-specific intensity both rising." };
  }
  return { ...base(goal), phaseName: "base", loadMultiplier: 1.0, nutritionStance: "maintenance", notes: "Base phase — steady aerobic volume." };
}

function phaseForBodyComposition(goal: Goal, date: string, athlete: AthleteParams): GoalPhase {
  const prediction = predictBodyComposition(athlete, {
    targetWeightKg: goal.targetMetrics.targetWeightKg,
    targetBodyFatPercent: goal.targetMetrics.targetBodyFatPercent,
    targetDate: goal.targetDate,
    today: date,
  });

  const needsChange = prediction.requiredWeeklyChangeKg != null && Math.abs(prediction.requiredWeeklyChangeKg) > 0.01;
  // requiredWeeklyChangeKg (computed "if starting today") only grows in
  // magnitude as the deadline approaches a fixed target — so the moment it
  // reaches the safe ceiling IS the latest week it's still safe to start.
  // No separate "cut window" simulation needed; Phase 2's own predictor
  // already carries this.
  const mustStartNow = needsChange && Math.abs(prediction.requiredWeeklyChangeKg!) >= prediction.safeWeeklyRateKg;

  if (!mustStartNow) {
    return { ...base(goal), phaseName: "maintain", loadMultiplier: 1.0, nutritionStance: "maintenance", notes: "Outside the required window yet — maintaining until the safe rate demands starting." };
  }

  const isLoss = prediction.requiredWeeklyChangeKg! < 0;
  return {
    ...base(goal),
    phaseName: isLoss ? "cut" : "lean-gain",
    // A deficit costs recovery capacity, not fitness itself — trim volume
    // slightly rather than intensity, which is what actually earns the result.
    loadMultiplier: isLoss ? 0.9 : 1.05,
    nutritionStance: isLoss ? "deficit" : "surplus",
    notes: prediction.note,
  };
}

function phaseForStrength(goal: Goal, weeksOut: number): GoalPhase {
  if (weeksOut <= 4) {
    return { ...base(goal), phaseName: "peak", loadMultiplier: 1.0, nutritionStance: "maintenance", notes: "Peaking — intensity up, volume trimmed." };
  }
  return { ...base(goal), phaseName: "accumulation", loadMultiplier: 1.1, nutritionStance: "surplus", notes: "Accumulation — building volume; a slight surplus supports the adaptation." };
}

export function phaseForGoal(goal: Goal, date: string, athlete: AthleteParams): GoalPhase {
  const weeksOut = weeksUntil(date, goal.targetDate);
  if (weeksOut < 0) {
    return { ...base(goal), phaseName: "past", loadMultiplier: 1.0, nutritionStance: "maintenance", notes: `${goal.label}'s target date has passed.` };
  }

  switch (goal.type) {
    case "endurance_race":
    case "hyrox":
      return phaseForEnduranceLike(goal, weeksOut);
    case "body_composition":
      return phaseForBodyComposition(goal, date, athlete);
    case "strength":
      return phaseForStrength(goal, weeksOut);
    default:
      return { ...base(goal), phaseName: "maintain", loadMultiplier: 1.0, nutritionStance: "maintenance", notes: "Steady state." };
  }
}
