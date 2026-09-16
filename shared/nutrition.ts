/**
 * Turning "deficit" into numbers you can actually eat to.
 *
 * The arbitration engine resolves a nutrition STANCE (deficit / maintenance /
 * surplus). On its own that's a word. What makes it actionable is that
 * predictBodyComposition already computes the required weekly rate of change
 * for the goal — so the deficit size isn't a guessed "20% cut", it's derived
 * from the rate this athlete's actual deadline demands, then capped at what's
 * safe.
 *
 * Formulas adapted from HyroxNga's nutrition.ts:
 *  - Katch-McArdle for resting energy, because it works from lean mass and
 *    doesn't systematically under-read someone carrying a lot of muscle the
 *    way height/weight equations do.
 *  - Training energy from TSS rather than a flat "activity multiplier" — a
 *    multiplier can't tell a rest day from a three-hour ride, and on a plan
 *    whose daily load swings fivefold that's hundreds of calories.
 *  - Protein off FAT-FREE mass, rising as body fat falls: the leaner you are,
 *    the more of a deficit your body will take out of muscle instead of fat.
 */

import type { AthleteParams } from "./athlete";
import type { NutritionStance } from "./arbitration/goalPhase";

/** Energy in a kilogram of body mass. The standard figure, and the bridge between "kg per week" and "kcal per day". */
export const KCAL_PER_KG_BODY_MASS = 7700;

/** No deficit deeper than this share of maintenance, however aggressive the deadline — past here you're burning lean mass and recovery, not fat. */
export const MAX_DEFICIT_FRACTION = 0.25;
/** A surplus beyond this just adds fat, not muscle. */
export const MAX_SURPLUS_FRACTION = 0.15;

export interface MacroTarget {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  maintenanceKcal: number;
  /** Signed: negative in a deficit. */
  dailyDeltaKcal: number;
  note: string;
  /** True when the deadline demanded a deeper cut than MAX_DEFICIT_FRACTION and it was capped. */
  capped: boolean;
}

export function fatFreeMassKg(weightKg: number, bodyFatPercent: number): number {
  return weightKg * (1 - bodyFatPercent / 100);
}

/** Katch-McArdle. */
export function restingEnergyKcal(weightKg: number, bodyFatPercent: number): number {
  return Math.round(370 + 21.6 * fatFreeMassKg(weightKg, bodyFatPercent));
}

/** ~7.5 kcal per TSS point for a 75 kg athlete — one TSS being roughly a hundredth of an hour at threshold. */
export function trainingEnergyKcal(tss: number, weightKg: number): number {
  return Math.round(tss * 7.5 * (weightKg / 75));
}

export function maintenanceKcal(weightKg: number, bodyFatPercent: number, dailyTss: number): number {
  // 1.35 covers everything that isn't deliberate training — standing,
  // walking, fidgeting, and the thermic effect of food.
  const baseline = restingEnergyKcal(weightKg, bodyFatPercent) * 1.35;
  return Math.round(baseline + trainingEnergyKcal(dailyTss, weightKg));
}

export interface DailyTargetInput {
  stance: NutritionStance;
  /** From predictBodyComposition — negative to lose. Undefined when no body-composition goal is driving this. */
  requiredWeeklyChangeKg?: number | null;
  /** The day's planned training load, so carbohydrate flexes with the session. */
  dailyTss: number;
}

/**
 * Protein and fat are set first — protein to protect lean mass, fat to a
 * floor below which hormonal function suffers — and carbohydrate takes
 * whatever energy is left. That ordering is deliberate: carbohydrate is the
 * fuel that should flex with training load, and on a hard day it's what
 * goes up.
 */
export function dailyTargets(athlete: AthleteParams, input: DailyTargetInput): MacroTarget {
  const weightKg = athlete.weightKg.value;
  const bodyFatPercent = athlete.bodyFatPercent.value;
  const maintenance = maintenanceKcal(weightKg, bodyFatPercent, input.dailyTss);

  // The deficit is the one the deadline actually requires, not a stock 20%.
  const rate = input.requiredWeeklyChangeKg ?? 0;
  let delta = 0;
  let capped = false;

  if (input.stance === "deficit") {
    const required = Math.abs(rate) > 0 ? (Math.abs(rate) * KCAL_PER_KG_BODY_MASS) / 7 : maintenance * 0.15;
    const ceiling = maintenance * MAX_DEFICIT_FRACTION;
    capped = required > ceiling;
    delta = -Math.round(Math.min(required, ceiling));
  } else if (input.stance === "surplus") {
    const required = Math.abs(rate) > 0 ? (Math.abs(rate) * KCAL_PER_KG_BODY_MASS) / 7 : maintenance * 0.1;
    const ceiling = maintenance * MAX_SURPLUS_FRACTION;
    capped = required > ceiling;
    delta = Math.round(Math.min(required, ceiling));
  }

  const kcal = Math.max(1200, Math.round(maintenance + delta));
  const ffm = fatFreeMassKg(weightKg, bodyFatPercent);

  // 2.4 g/kg FFM in a deficit, 1.8 otherwise; +0.3 again once genuinely lean.
  const baseProtein = input.stance === "deficit" ? 2.4 : 1.8;
  const leanBonus = bodyFatPercent < 12 ? 0.3 : 0;
  const proteinG = Math.round(ffm * (baseProtein + leanBonus));

  // Fat floor of 0.8 g/kg bodyweight, or 22% of energy, whichever is higher.
  const fatG = Math.max(Math.round(weightKg * 0.8), Math.round((kcal * 0.22) / 9));
  const carbG = Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4));

  return {
    kcal,
    proteinG,
    fatG,
    carbG,
    maintenanceKcal: maintenance,
    dailyDeltaKcal: delta,
    capped,
    note: noteFor(input, capped),
  };
}

function noteFor(input: DailyTargetInput, capped: boolean): string {
  if (input.stance === "deficit") {
    if (capped) {
      return "Capped at a 25% deficit — the deadline wants faster than that, and going deeper costs lean mass and recovery rather than fat. Move the date or the target.";
    }
    return "Protein is the number that matters here — it's what decides whether you lose fat or lose muscle.";
  }
  if (input.stance === "surplus") {
    return capped ? "Capped — a bigger surplus adds fat, not muscle." : "Small surplus. Lean gain is slow by nature; a bigger one is just fat.";
  }
  if (input.dailyTss > 90) return "Hard day — carbohydrate is the one to hit, most of it around the session.";
  if (input.dailyTss === 0) return "Rest day. Protein and fat hold; carbohydrate is lower because you're not spending it.";
  return "Maintenance. Eat to train, not to change the scale.";
}
