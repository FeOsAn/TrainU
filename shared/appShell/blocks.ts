/**
 * The building-block catalog.
 *
 * TrainU doesn't generate an app per athlete — it ASSEMBLES one from this
 * library. The difference matters: generated UI can't be reviewed, tested, or
 * held to the `Measured<T>` rule, because nobody wrote it. An assembled app is
 * the same promise from the athlete's side ("I told it my goals and now the
 * app is about my goals") off code that's been validated once and reused.
 *
 * Two declarations do the work:
 *   - every BLOCK says what capabilities it PROVIDES, and who it applies to;
 *   - every goal type says what capabilities it NEEDS.
 *
 * A capability an active goal needs that no built, applicable block provides
 * is a GAP — reported by `assemble()`, surfaced to the athlete, and logged.
 * That's the point: the backlog gets written by real athlete goals instead of
 * guessed at, which is the same loop Phase 6 runs for predictions, one level
 * up. A block can also be declared `planned` before it exists, so "we haven't
 * built this yet" is a row in the catalog rather than silence.
 */

import type { Discipline, GoalType } from "../goal";
import type { ConnectorPreferences, FeaturePreferences } from "../preferences";

/**
 * A thing the app can do for an athlete. Deliberately coarser than a feature
 * and coarser than a component — it's the unit a goal can ask for and a block
 * can satisfy, so both sides of the match talk about the same nouns.
 */
export type Capability =
  | "goal_arbitration"
  | "session_prescription"
  | "adherence_tracking"
  | "training_load"
  | "calibration"
  | "race_time_prediction"
  | "run_prescription"
  | "swim_bike_prescription"
  | "station_benchmarks"
  | "compromised_running"
  | "body_comp_projection"
  | "nutrition_targets"
  | "physique_tracking"
  | "strength_progression"
  | "lift_1rm_tracking"
  | "race_day_pacing";

/** Where an assembled block renders. Routes are themselves assembled — see `assemble()`. */
export type SurfaceId = "plan" | "athlete" | "goals" | "coach" | "data";

/**
 * Engine blocks provide a capability without rendering anything — the
 * prescriber training compromised running for a HYROX athlete is a capability
 * that athlete has, whether or not a panel anywhere mentions it.
 *
 * They're modelled as blocks rather than as a separate list so that ONE
 * matching rule (goal type, discipline, preferences) decides both what
 * renders and what the app can do. Two rules would drift, which is the same
 * mistake `SESSION_KINDS` exists to prevent one layer down.
 */
export type BlockSurface = SurfaceId | "engine";

export interface Block {
  id: string;
  title: string;
  surface: BlockSurface;
  provides: Capability[];
  /**
   * Which goal types this block serves. "*" means every athlete gets it —
   * the arbitration engine and the seed/measured discipline are not optional
   * features, they're the product.
   */
  goalTypes: GoalType[] | "*";
  /** Narrows further within a goal type: a marathoner and an Ironman athlete are both `endurance_race`. */
  disciplines?: Discipline[];
  requiresFeature?: keyof FeaturePreferences;
  requiresConnector?: keyof ConnectorPreferences;
  /** Lower sorts higher on its surface. */
  rank: number;
  /**
   * `planned` blocks are declared but not implemented. They never assemble
   * into the app; they exist so the catalog can say "known gap, named, not
   * built" rather than the capability simply being absent.
   */
  status: "built" | "planned";
  /** Shown to the athlete under the block title, in their terms, not ours. */
  note?: string;
}

export const BLOCKS: Block[] = [
  // ─── Always ────────────────────────────────────────────────────────────────
  {
    id: "plan.week",
    title: "This week",
    surface: "plan",
    provides: [],
    goalTypes: "*",
    rank: 10,
    status: "built",
  },
  {
    id: "plan.arbitration",
    title: "Why this week looks like this",
    surface: "plan",
    provides: [],
    goalTypes: "*",
    rank: 20,
    status: "built",
  },
  {
    id: "athlete.body",
    title: "Body",
    surface: "athlete",
    provides: [],
    goalTypes: "*",
    rank: 40,
    status: "built",
  },
  {
    id: "data.load",
    title: "Training load",
    surface: "data",
    provides: [],
    goalTypes: "*",
    rank: 10,
    status: "built",
  },
  {
    id: "data.calibration",
    title: "Calibration",
    surface: "data",
    provides: [],
    goalTypes: "*",
    rank: 30,
    status: "built",
  },

  // ─── Running / endurance ───────────────────────────────────────────────────
  {
    id: "athlete.running",
    title: "Running",
    surface: "athlete",
    provides: [],
    goalTypes: ["endurance_race", "hyrox", "general_fitness"],
    rank: 10,
    status: "built",
  },
  {
    id: "plan.racePrediction",
    title: "Race prediction",
    surface: "plan",
    provides: [],
    goalTypes: ["endurance_race", "hyrox"],
    rank: 15,
    status: "built",
  },
  {
    id: "athlete.heartRate",
    title: "Heart rate",
    surface: "athlete",
    provides: [],
    goalTypes: ["endurance_race", "hyrox", "general_fitness"],
    rank: 30,
    status: "built",
  },

  // ─── Multisport ────────────────────────────────────────────────────────────
  {
    id: "athlete.bikeSwim",
    title: "Bike & swim",
    surface: "athlete",
    provides: [],
    goalTypes: ["endurance_race"],
    disciplines: ["triathlon", "cycling", "swimming"],
    rank: 20,
    status: "built",
    note: "CdA, FTP and critical swim speed only mean something once you're racing more than one discipline.",
  },

  // ─── HYROX ─────────────────────────────────────────────────────────────────
  {
    id: "athlete.stations",
    title: "Station benchmarks",
    surface: "athlete",
    provides: ["station_benchmarks"],
    goalTypes: ["hyrox"],
    rank: 25,
    // `AthleteParams.benchmarks` holds these and `calibrateBenchmark()` can
    // write them, but nothing renders or edits them — so a HYROX athlete has
    // no way to put a real sled-push time in. Declared rather than quietly
    // treated as present: the catalog is only worth anything if "built" means
    // built.
    status: "planned",
    note: "Your sled, ski-erg and burpee-broad-jump times. The engine can use them; there's no screen to enter them yet.",
  },

  // ─── Strength ──────────────────────────────────────────────────────────────
  {
    id: "athlete.strength",
    title: "Strength",
    surface: "athlete",
    provides: ["lift_1rm_tracking", "strength_progression"],
    goalTypes: ["strength", "hyrox", "body_composition", "general_fitness"],
    rank: 35,
    status: "built",
  },

  // ─── Body composition ──────────────────────────────────────────────────────
  {
    id: "plan.nutrition",
    title: "Nutrition targets",
    surface: "plan",
    provides: [],
    goalTypes: ["body_composition", "endurance_race", "hyrox", "strength", "general_fitness"],
    rank: 12,
    status: "built",
  },

  // ─── Connector-gated ───────────────────────────────────────────────────────
  {
    id: "data.sessions",
    title: "Sessions",
    surface: "data",
    provides: [],
    goalTypes: "*",
    rank: 20,
    status: "built",
  },

  // ─── Engine ────────────────────────────────────────────────────────────────
  /*
   * These render nothing. They exist so that "the engine can do X for this
   * athlete" is matched by the same goal-type/discipline rule as "this panel
   * shows for this athlete" — and so a goal type the engine genuinely can't
   * serve yet reports a gap instead of quietly producing a plausible-looking
   * plan for the wrong sport.
   */
  {
    id: "engine.arbitration",
    title: "Goal arbitration",
    surface: "engine",
    provides: ["goal_arbitration"],
    goalTypes: "*",
    rank: 0,
    status: "built",
  },
  {
    id: "engine.prescription",
    title: "Session prescription",
    surface: "engine",
    provides: ["session_prescription", "adherence_tracking"],
    goalTypes: "*",
    rank: 0,
    status: "built",
  },
  {
    id: "engine.trainingLoad",
    title: "Training load",
    surface: "engine",
    provides: ["training_load"],
    goalTypes: "*",
    rank: 0,
    status: "built",
  },
  {
    id: "engine.calibration",
    title: "Prediction calibration",
    surface: "engine",
    provides: ["calibration"],
    goalTypes: "*",
    rank: 0,
    status: "built",
  },
  {
    id: "engine.nutrition",
    title: "Nutrition targets",
    surface: "engine",
    provides: ["nutrition_targets", "body_comp_projection"],
    goalTypes: "*",
    rank: 0,
    status: "built",
  },
  {
    id: "engine.runPrescription",
    title: "Run sessions",
    surface: "engine",
    provides: ["run_prescription"],
    goalTypes: ["endurance_race", "hyrox", "body_composition", "strength", "general_fitness"],
    rank: 0,
    status: "built",
  },
  {
    id: "engine.swimBikePrescription",
    title: "Swim & bike sessions",
    surface: "engine",
    provides: ["swim_bike_prescription"],
    goalTypes: ["endurance_race"],
    disciplines: ["triathlon", "cycling", "swimming"],
    rank: 0,
    status: "built",
  },
  {
    id: "engine.compromisedRunning",
    title: "Compromised running",
    surface: "engine",
    provides: ["compromised_running"],
    goalTypes: ["hyrox"],
    rank: 0,
    status: "built",
  },
  {
    id: "engine.strength",
    title: "Strength progression",
    surface: "engine",
    provides: ["strength_progression"],
    goalTypes: ["strength", "hyrox", "body_composition", "general_fitness"],
    rank: 0,
    status: "built",
  },
  {
    id: "engine.racePrediction",
    title: "Race-time prediction",
    surface: "engine",
    provides: ["race_time_prediction"],
    goalTypes: ["endurance_race", "hyrox"],
    // predictRunRace and predictTriathlon cover these; a standalone cycling or
    // swimming race has no predictor, so such a goal reports the gap.
    disciplines: ["run", "triathlon", "other"],
    rank: 0,
    status: "built",
  },

  // ─── Declared, not built ───────────────────────────────────────────────────
  /*
   * Everything below is a real gap, named rather than silently absent.
   *
   * `athlete.physique` is the sharpest example of why this catalog exists at
   * all: onboarding asks every athlete whether they want physique tracking and
   * writes the answer to `preferences.features.physiqueTracking` — and then
   * nothing in the app ever reads it. The preference has been collected since
   * Phase 4 and dropped on the floor every time. Declaring the block is what
   * turns that from an invisible dead end into a queue entry.
   */
  {
    id: "athlete.physique",
    title: "Physique progress",
    surface: "athlete",
    provides: ["physique_tracking"],
    goalTypes: ["body_composition"],
    requiresFeature: "physiqueTracking",
    rank: 45,
    status: "planned",
    note: "Photo and measurement tracking over a cut. You asked for this during onboarding — it isn't built yet.",
  },
  {
    id: "plan.pacing",
    title: "Race-day pacing plan",
    surface: "plan",
    provides: ["race_day_pacing"],
    goalTypes: ["endurance_race", "hyrox"],
    rank: 18,
    status: "planned",
    note: "Split-by-split targets for the race itself. The predictors know your finishing time; nothing turns it into a plan for the day yet.",
  },
];

/**
 * What each goal type needs from the app to be served honestly. This is the
 * demand side of the match — kept separate from the blocks so that adding a
 * goal type immediately reports everything missing for it, rather than
 * quietly rendering whatever blocks happen to apply.
 */
export const CAPABILITY_NEEDS: Record<GoalType, Capability[]> = {
  endurance_race: ["goal_arbitration", "session_prescription", "run_prescription", "race_time_prediction", "training_load", "race_day_pacing"],
  hyrox: ["goal_arbitration", "session_prescription", "run_prescription", "station_benchmarks", "compromised_running", "strength_progression", "race_time_prediction", "race_day_pacing"],
  body_composition: ["goal_arbitration", "session_prescription", "body_comp_projection", "nutrition_targets", "strength_progression"],
  strength: ["goal_arbitration", "session_prescription", "lift_1rm_tracking", "strength_progression"],
  general_fitness: ["goal_arbitration", "session_prescription", "training_load"],
};

/** Extra needs a discipline adds on top of its goal type's. */
export const DISCIPLINE_NEEDS: Partial<Record<Discipline, Capability[]>> = {
  triathlon: ["swim_bike_prescription"],
  cycling: ["swim_bike_prescription"],
  swimming: ["swim_bike_prescription"],
};

/**
 * Needs that come from a stated preference rather than from a goal. A
 * preference IS a stated need: if onboarding asked whether you want physique
 * tracking and you said yes, the app owes you an answer — either the feature
 * or an honest "not built yet". Silently storing the answer, which is what
 * happened from Phase 4 until this catalog existed, is the one option that
 * isn't acceptable.
 */
export const FEATURE_NEEDS: Partial<Record<keyof FeaturePreferences, Capability[]>> = {
  physiqueTracking: ["physique_tracking"],
};

/** Plain-language names, for the gap surface — the athlete reads these, not the ids. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  goal_arbitration: "Reconciling your goals into one plan",
  session_prescription: "A prescribed week of sessions",
  adherence_tracking: "Ticking sessions off",
  training_load: "Training load tracking",
  calibration: "Prediction calibration",
  race_time_prediction: "Race-time prediction",
  run_prescription: "Run sessions",
  swim_bike_prescription: "Swim and bike sessions",
  station_benchmarks: "HYROX station benchmarks",
  compromised_running: "Compromised running",
  body_comp_projection: "Body-composition projection",
  nutrition_targets: "Daily calorie and macro targets",
  physique_tracking: "Physique progress tracking",
  strength_progression: "Strength progression",
  lift_1rm_tracking: "1RM tracking",
  race_day_pacing: "A race-day pacing plan",
};
