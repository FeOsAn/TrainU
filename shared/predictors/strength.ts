/**
 * Projected 1RM by a target date. Deliberately conservative: progression
 * rate is a rough population-level default, not measured per-athlete yet —
 * exactly the kind of number Phase 6's calibration loop should tighten once
 * there's real logged progression to check it against, rather than
 * something to over-engineer now on no data.
 */

import type { AthleteParams } from "../athlete";
import { type Confidence, type Measured, assessConfidence } from "../measured";

/** ~0.25%/week is a conservative, generic intermediate-lifter default — real progression varies enormously by training age and program. */
const DEFAULT_WEEKLY_GAIN_FRACTION = 0.0025;

export type LiftId = "squat1RmKg" | "deadlift1RmKg" | "bench1RmKg" | "ohp1RmKg";

export interface StrengthPrediction {
  lift: LiftId;
  currentOneRmKg: number;
  projectedOneRmKg: number;
  weeksAvailable: number;
  confidence: Confidence;
  note: string;
}

function weeksBetween(from: string, to: string): number {
  return Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 86_400_000));
}

export function predictStrength(a: AthleteParams, lift: LiftId, targetDate: string, today = new Date().toISOString().slice(0, 10)): StrengthPrediction {
  const current: Measured<number> = a[lift];
  const weeksAvailable = weeksBetween(today, targetDate);
  const projectedOneRmKg = Math.round(current.value * (1 + DEFAULT_WEEKLY_GAIN_FRACTION * weeksAvailable) * 10) / 10;
  const confidence = assessConfidence({ [lift]: current });

  return {
    lift,
    currentOneRmKg: current.value,
    projectedOneRmKg,
    weeksAvailable: Math.round(weeksAvailable * 10) / 10,
    confidence,
    note: current.verified
      ? `Projected from a measured ${current.value} kg at a conservative generic progression rate — not yet calibrated to this athlete's actual trend.`
      : `Current 1RM is still a seed (${current.source}) — log a real test before trusting this projection.`,
  };
}
