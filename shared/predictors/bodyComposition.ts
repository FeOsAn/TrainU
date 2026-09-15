/**
 * "Will I look how I want by the wedding" — the goal type neither sibling
 * app has a predictor for at all. Modeled the same way as the others:
 * a required weekly rate of change against a safe physiological ceiling,
 * with confidence coming from whether the athlete's current weight/body-fat
 * are actually recent measurements or a stale seed.
 */

import type { AthleteParams } from "../athlete";
import { type Confidence, type Measured, assessConfidence } from "../measured";

/** ~0.5-1% of bodyweight/week is the commonly cited sustainable fat-loss range; 0.75% is the middle of it. */
const SAFE_LOSS_FRACTION_PER_WEEK = 0.0075;
/** Lean gain is far slower and doesn't scale with bodyweight the way loss does — a small absolute weekly cap instead. */
const SAFE_GAIN_KG_PER_WEEK = 0.25;

export interface BodyCompositionGoalInput {
  targetWeightKg?: number;
  targetBodyFatPercent?: number;
  targetDate: string;
  today?: string;
}

export interface BodyCompositionPrediction {
  weeksAvailable: number;
  currentWeightKg: number;
  currentBodyFatPercent: number;
  requiredWeeklyChangeKg: number | null;
  safeWeeklyRateKg: number;
  achievable: boolean;
  note: string;
  confidence: Confidence;
}

function weeksBetween(from: string, to: string): number {
  return Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 86_400_000));
}

export function predictBodyComposition(a: AthleteParams, goal: BodyCompositionGoalInput): BodyCompositionPrediction {
  const today = goal.today ?? new Date().toISOString().slice(0, 10);
  const weeksAvailable = weeksBetween(today, goal.targetDate);
  const currentWeightKg = a.weightKg.value;
  const currentBodyFatPercent = a.bodyFatPercent.value;

  let targetWeightKg = goal.targetWeightKg ?? null;
  if (targetWeightKg == null && goal.targetBodyFatPercent != null) {
    // Hold lean mass constant, solve for the weight at the target body-fat %.
    const leanMassKg = currentWeightKg * (1 - currentBodyFatPercent / 100);
    targetWeightKg = leanMassKg / (1 - goal.targetBodyFatPercent / 100);
  }

  const inputs: Record<string, Measured<unknown>> = { weightKg: a.weightKg, bodyFatPercent: a.bodyFatPercent };
  const confidence = assessConfidence(inputs);

  if (targetWeightKg == null || weeksAvailable <= 0) {
    return {
      weeksAvailable: Math.round(weeksAvailable * 10) / 10,
      currentWeightKg,
      currentBodyFatPercent,
      requiredWeeklyChangeKg: null,
      safeWeeklyRateKg: 0,
      achievable: false,
      note: weeksAvailable <= 0 ? "Target date has passed." : "Need a target weight or target body-fat % to project against.",
      confidence,
    };
  }

  const requiredWeeklyChangeKg = (targetWeightKg - currentWeightKg) / weeksAvailable;
  const isLoss = requiredWeeklyChangeKg < 0;
  const safeWeeklyRateKg = isLoss ? currentWeightKg * SAFE_LOSS_FRACTION_PER_WEEK : SAFE_GAIN_KG_PER_WEEK;
  const achievable = Math.abs(requiredWeeklyChangeKg) <= safeWeeklyRateKg;

  const note = achievable
    ? `${isLoss ? "Losing" : "Gaining"} ${Math.abs(Math.round(requiredWeeklyChangeKg * 100) / 100)} kg/week over ${Math.round(weeksAvailable)} weeks is within a sustainable rate.`
    : `Needs ${Math.abs(Math.round(requiredWeeklyChangeKg * 100) / 100)} kg/week — above the ${Math.round(safeWeeklyRateKg * 100) / 100} kg/week ceiling for ${isLoss ? "sustainable fat loss" : "lean gain"}. Either move the date or adjust the target.`;

  return {
    weeksAvailable: Math.round(weeksAvailable * 10) / 10,
    currentWeightKg,
    currentBodyFatPercent,
    requiredWeeklyChangeKg: Math.round(requiredWeeklyChangeKg * 100) / 100,
    safeWeeklyRateKg: Math.round(safeWeeklyRateKg * 100) / 100,
    achievable,
    note,
    confidence,
  };
}
