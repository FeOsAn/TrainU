/**
 * What each goal type actually needs trained, and how a phase reshapes that.
 *
 * This is the coaching layer, and it is deliberately deterministic data
 * rather than anything a model generates: the same inputs always produce the
 * same week, so a coaching change is a code change with a diff you can argue
 * with, and it can be unit tested. HyroxNga's plan engine makes the same
 * call for the same reason — the model's job is to phrase and adapt
 * sessions, never to invent the periodization.
 */

import type { GoalType } from "../goal";
import type { SessionKind } from "./sessionKinds";

/**
 * A goal type's qualities, MOST IMPORTANT FIRST. When days are scarce the
 * engine drops from the right, so this ordering is the statement about what
 * actually matters for the goal — the long run survives, the second easy run
 * does not.
 */
export const GOAL_QUALITIES: Record<GoalType, SessionKind[]> = {
  // The long run is the single highest-return session for a distance race,
  // then aerobic volume, then race-specific intensity.
  endurance_race: ["run_long", "run_easy", "run_threshold", "run_easy", "run_intervals", "strength_lower"],

  // Compromised running is HYROX's defining quality and the thing a generic
  // running plan never trains: the race is 8 km run on legs a station just
  // wrecked. Stations and lower-body strength sit under it.
  hyrox: ["compromised", "run_intervals", "station_work", "strength_lower", "run_easy", "strength_push"],

  strength: ["strength_lower", "strength_push", "strength_pull", "run_easy"],

  /*
   * A body-composition goal asks for almost no cardio of its own. What it
   * actually needs is RESISTANCE TRAINING and enough easy aerobic work to
   * spend energy without costing recovery — lifting in a deficit is what
   * protects lean mass, which is the whole difference between losing weight
   * and looking like you trained. So it contributes strength slots and easy
   * volume, and never argues for intensity it can't recover from.
   */
  body_composition: ["strength_lower", "strength_push", "run_easy", "strength_pull", "run_easy"],

  general_fitness: ["run_easy", "strength_lower", "run_easy", "strength_push"],
};

export type IntensityCeiling = "easy" | "threshold" | "full";

export interface PhaseShape {
  /** How hard this phase permits going. Sessions above the ceiling get downgraded, not dropped. */
  intensityCeiling: IntensityCeiling;
  focus: string;
}

/**
 * Phases only reshape the week — they do NOT set its size. The arbitrated
 * load multiplier already encodes every live goal's phase, blended by
 * priority; applying a per-phase minute budget on top of it would count the
 * phase twice and, in a build block, prescribe a week nobody could absorb.
 */
export const PHASE_SHAPES: Record<string, PhaseShape> = {
  base: { intensityCeiling: "threshold", focus: "Aerobic base. Volume and tissue tolerance — the engine everything else gets spent from." },
  build: { intensityCeiling: "full", focus: "Build. Race-specific intensity on top of the base you've laid." },
  peak: { intensityCeiling: "full", focus: "Race specificity. Quality over accumulation." },
  taper: { intensityCeiling: "full", focus: "Volume down, intensity held. You can't add fitness now; you can subtract it." },
  // A deficit blunts recovery, so the ceiling drops — intensity you can't
  // recover from in a deficit is intensity that costs lean mass.
  cut: { intensityCeiling: "threshold", focus: "Training through a deficit. Intensity moderated, lifting protected." },
  "lean-gain": { intensityCeiling: "threshold", focus: "Lean gain. Lifting leads, aerobic work supports." },
  accumulation: { intensityCeiling: "threshold", focus: "Accumulation. Volume on the bar." },
  maintain: { intensityCeiling: "threshold", focus: "Maintaining. Enough to hold what you've built." },
  past: { intensityCeiling: "easy", focus: "Done." },
};

export const DEFAULT_PHASE_SHAPE: PhaseShape = PHASE_SHAPES.maintain!;

/** Minutes per training day in a neutral (1.0x) week, before the arbitrated multiplier. */
export const BASELINE_MINUTES_PER_DAY = 60;

/**
 * Share of the week's aerobic minutes each kind gets, relative to the others
 * actually scheduled. The long run's 1.8 is what makes it the week's biggest
 * session — there's no separate "long share" on top of this, because two
 * mechanisms sizing the same session is how you end up with a long run
 * shorter than the easy run.
 */
export const KIND_WEIGHT: Record<SessionKind, number> = {
  run_long: 1.8,
  run_easy: 1,
  run_threshold: 1,
  run_intervals: 0.9,
  bike_endurance: 1.6,
  swim_technique: 0.8,
  compromised: 1.1,
  station_work: 0.9,
  strength_lower: 0.9,
  strength_push: 0.8,
  strength_pull: 0.8,
  rest: 0,
};

/**
 * Plausible duration bounds per kind, in minutes.
 *
 * Without these, a week whose slots are mostly strength hands the entire
 * remaining aerobic budget to whichever one or two runs exist — which is how
 * a 5-day week produced a 225-minute "easy run". A session type has a sane
 * range regardless of how much budget happens to be left over.
 */
export const KIND_MINUTES: Record<SessionKind, { min: number; max: number }> = {
  run_easy: { min: 30, max: 80 },
  run_long: { min: 50, max: 210 },
  run_threshold: { min: 40, max: 80 },
  run_intervals: { min: 35, max: 70 },
  bike_endurance: { min: 45, max: 240 },
  swim_technique: { min: 30, max: 75 },
  compromised: { min: 35, max: 75 },
  station_work: { min: 30, max: 60 },
  strength_lower: { min: 35, max: 70 },
  strength_push: { min: 35, max: 70 },
  strength_pull: { min: 35, max: 70 },
  rest: { min: 0, max: 0 },
};

/** Kinds above a phase's ceiling get downgraded to this, rather than dropped — the slot still has training value. */
export const DOWNGRADE: Partial<Record<SessionKind, SessionKind>> = {
  run_intervals: "run_threshold",
  run_threshold: "run_easy",
  compromised: "run_easy",
};

export function applyCeiling(kind: SessionKind, ceiling: IntensityCeiling): SessionKind {
  if (ceiling === "full") return kind;
  if (ceiling === "threshold") {
    return kind === "run_intervals" || kind === "compromised" ? (DOWNGRADE[kind] ?? kind) : kind;
  }
  // "easy" — strip everything hard back to aerobic work.
  return DOWNGRADE[kind] ?? kind;
}
