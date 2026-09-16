/**
 * The core object the rest of the app is arbitrated around. An athlete has
 * one or more of these active at once (marathon in 9 months + wedding in 6
 * weeks is the canonical example), and Phase 3's scheduler is what turns
 * several of them into one coherent plan instead of either ignoring the
 * conflict or silently picking one.
 */

export type GoalType = "endurance_race" | "hyrox" | "body_composition" | "strength" | "general_fitness";

/**
 * Which sports a goal actually involves. `endurance_race` covers both a
 * marathon and an Ironman, and until this existed the app could not tell them
 * apart — so every endurance goal got a run-only week, and an Ironman athlete
 * was prescribed a marathon plan. The swim and bike sessions were fully built
 * in the prescriber the whole time; nothing could ask for them.
 *
 * Only meaningful for `endurance_race`; every other goal type is "other".
 */
export type Discipline = "run" | "triathlon" | "cycling" | "swimming" | "other";

export const DISCIPLINES: Discipline[] = ["run", "triathlon", "cycling", "swimming", "other"];

/** What a goal of this type defaults to when the athlete hasn't said. */
export function defaultDiscipline(type: GoalType): Discipline {
  return type === "endurance_race" ? "run" : "other";
}

export interface GoalConstraint {
  /** Plain language, shown back to the athlete as-is. "No running the last 10 days before the wedding." */
  label: string;
  fromDate?: string;
  toDate?: string;
}

/**
 * The structured numbers Phase 3's arbitration engine and Phase 2's
 * predictors actually need to compute against — kept separate from
 * successCriteria (which stays free text for the athlete to read back)
 * because "sub-3:30" and "3:30:00" are the same target but neither parses
 * reliably out of prose.
 */
export interface GoalTargetMetrics {
  targetTimeSeconds?: number;
  targetDistanceKm?: number;
  targetWeightKg?: number;
  targetBodyFatPercent?: number;
  liftId?: "squat1RmKg" | "deadlift1RmKg" | "bench1RmKg" | "ohp1RmKg";
}

export interface Goal {
  id: string;
  type: GoalType;
  /** Which sports this goal involves — see Discipline. Defaults per type. */
  discipline: Discipline;
  /** "Berlin Marathon", "Cousin's wedding" — whatever the athlete calls it. */
  label: string;
  targetDate: string;
  /** 1 = most important. Equal priorities are weighted equally, not tie-broken by list order. */
  priority: number;
  /** What "success" means here — free text, since a race time, a look, and a lift number don't share a unit. */
  successCriteria: string;
  /** The subset of successCriteria that's actually a number to compute against. */
  targetMetrics: GoalTargetMetrics;
  constraints: GoalConstraint[];
  createdAt: string;
  active: boolean;
}

/**
 * A window where two goals' training demands conflict (e.g. a marathon's
 * long-run volume vs. a pre-wedding calorie deficit). Phase 3 populates and
 * resolves these; this type exists now so the schema and UI have somewhere
 * to point before the resolution logic itself is built.
 */
export interface GoalConflict {
  betweenGoalIds: [string, string];
  window: { from: string; to: string };
  description: string;
  resolution?: "goal_a_priority" | "goal_b_priority" | "balanced";
}
