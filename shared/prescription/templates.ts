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

import { type Discipline, type GoalType, defaultDiscipline } from "../goal";
import { SESSION_KINDS, type Intensity, type PlannedSport, type SessionKind } from "./sessionKinds";
import { SPORT_FALLBACK_PER_MIN } from "../trainingLoad";

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

/**
 * Discipline overrides, for goal types where the sport isn't implied by the
 * type alone. `endurance_race` covers a marathon and an Ironman equally, and
 * before this existed every endurance goal took the run-only list above — so
 * an Ironman athlete was prescribed a marathon plan, with the swim and bike
 * sessions sitting fully implemented in prescribe.ts and unreachable because
 * nothing could ask for them.
 *
 * Same ordering rule as GOAL_QUALITIES: most important first, drops from the
 * right. For long-course triathlon the bike leads, because it's both the
 * largest time block in the race and the one where a weak engine costs the
 * most — you run the marathon on whatever the bike left you.
 */
export const DISCIPLINE_QUALITIES: Partial<Record<Discipline, SessionKind[]>> = {
  triathlon: [
    "bike_endurance",
    "run_long",
    "swim_technique",
    "run_easy",
    "bike_endurance",
    "run_threshold",
    "swim_technique",
    "strength_lower",
  ],
  cycling: ["bike_endurance", "bike_endurance", "run_easy", "bike_endurance", "strength_lower"],
  swimming: ["swim_technique", "swim_technique", "swim_technique", "strength_pull", "run_easy"],
};

/**
 * What this goal actually wants trained. The single lookup both the
 * prescriber and its tests go through, so a discipline can never be honoured
 * in one place and ignored in another.
 */
export function qualitiesFor(type: GoalType, discipline?: Discipline): SessionKind[] {
  const resolved = discipline ?? defaultDiscipline(type);
  return DISCIPLINE_QUALITIES[resolved] ?? GOAL_QUALITIES[type];
}


/**
 * The week's ANCHOR — the session that must come out biggest.
 *
 * For a runner that's the long run, and hardcoding it was right until the
 * app could tell a marathon from an Ironman. For a triathlete it's the long
 * ride: the bike is both the largest block of the race and the thing that
 * decides what's left for the run. Leaving the anchor as the long run gave a
 * 70.3 athlete a week that was 49% running by minutes against a race that's
 * roughly 55% bike.
 */
export const ANCHOR_KIND: Partial<Record<Discipline, SessionKind>> = {
  run: "run_long",
  triathlon: "bike_endurance",
  cycling: "bike_endurance",
  swimming: "swim_technique",
  other: "run_long",
};

/**
 * Per-discipline overrides on KIND_WEIGHT, applied over the global table.
 *
 * KIND_WEIGHT's global values are tuned for a runner, where a ride is
 * cross-training. In a triathlon the same `bike_endurance` session is the
 * main event, so it can't share one number with the recovery spin a
 * marathoner does. Overriding rather than replacing keeps every other goal
 * type on exactly the weights it already had.
 */
export const DISCIPLINE_KIND_WEIGHT: Partial<Record<Discipline, Partial<Record<SessionKind, number>>>> = {
  // Time split targeted at roughly 55% bike / 30% run / 15% swim, which is
  // about where a long-course race actually lands.
  triathlon: { bike_endurance: 3, swim_technique: 1.1, run_long: 1.5, run_easy: 0.8, run_threshold: 0.8 },
  cycling: { bike_endurance: 3, run_easy: 0.6 },
  swimming: { swim_technique: 2.2, run_easy: 0.6 },
};

/** The weight this kind carries for this discipline. One lookup, so an override can't be honoured in one place and missed in another. */
export function kindWeight(kind: SessionKind, discipline?: Discipline): number {
  const resolved = discipline ?? "other";
  return DISCIPLINE_KIND_WEIGHT[resolved]?.[kind] ?? KIND_WEIGHT[kind];
}

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

/**
 * Walk DOWNGRADE to a FIXED POINT — the first kind with no further downgrade.
 *
 * This exists because a single step is not what "easy" means. `DOWNGRADE`
 * takes `run_intervals` to `run_threshold`, which is still a hard session:
 * an ill athlete told to train easy was being handed a threshold run. Two
 * steps get to `run_easy`, which is what was meant. Anything that intends an
 * easy ceiling goes through here, never through one lookup.
 *
 * The loop guard is not paranoia — DOWNGRADE is hand-edited data, and a
 * cycle in it would otherwise hang the request rather than fail loudly.
 */
export function downgradeToEasy(kind: SessionKind): SessionKind {
  let current = kind;
  for (let steps = 0; steps < SESSION_KINDS.length; steps++) {
    const next = DOWNGRADE[current];
    if (!next || next === current) return current;
    current = next;
  }
  throw new Error(`DOWNGRADE has a cycle reachable from ${kind}`);
}

export function applyCeiling(kind: SessionKind, ceiling: IntensityCeiling): SessionKind {
  if (ceiling === "full") return kind;
  if (ceiling === "threshold") {
    return kind === "run_intervals" || kind === "compromised" ? (DOWNGRADE[kind] ?? kind) : kind;
  }
  // "easy" — strip everything hard back to aerobic work, all the way down.
  // Delegated rather than reimplemented so the ceiling and the explicit
  // easy-downgrade can never disagree about what "easy" means.
  return downgradeToEasy(kind);
}

/*
 * ─── The session vocabulary ────────────────────────────────────────────────
 *
 * These five tables were private to prescribe.ts. They are here because they
 * answer "what IS this kind of session" — a question the prescriber, the
 * modulation layer and every future slice that substitutes or downgrades a
 * session all have to answer identically. A second copy anywhere is the
 * SESSION_KINDS mistake one level up: a substituted ride titled by one table
 * and priced by another is two sessions wearing one name.
 */

export const SPORT_OF: Record<SessionKind, PlannedSport> = {
  run_easy: "run",
  run_long: "run",
  run_threshold: "run",
  run_intervals: "run",
  bike_endurance: "bike",
  swim_technique: "swim",
  compromised: "hybrid",
  station_work: "station",
  strength_lower: "strength",
  strength_push: "strength",
  strength_pull: "strength",
  rest: "other",
};

export const INTENSITY_OF: Record<SessionKind, Intensity> = {
  run_easy: "easy",
  run_long: "moderate",
  run_threshold: "hard",
  run_intervals: "hard",
  bike_endurance: "easy",
  swim_technique: "easy",
  compromised: "hard",
  station_work: "moderate",
  strength_lower: "moderate",
  strength_push: "moderate",
  strength_pull: "moderate",
  rest: "rest",
};

export const HARD_KINDS: ReadonlySet<SessionKind> = new Set<SessionKind>(
  SESSION_KINDS.filter((kind) => INTENSITY_OF[kind] === "hard"),
);

export const TITLE_OF: Record<SessionKind, string> = {
  run_easy: "Easy run",
  run_long: "Long run",
  run_threshold: "Threshold run",
  run_intervals: "Intervals",
  bike_endurance: "Endurance ride",
  swim_technique: "Swim — technique",
  compromised: "Compromised running",
  station_work: "Station work",
  strength_lower: "Strength — lower",
  strength_push: "Strength — push",
  strength_pull: "Strength — pull",
  rest: "Rest",
};

export const FOCUS_OF: Record<SessionKind, string> = {
  run_easy: "Aerobic volume that costs almost nothing to recover from.",
  run_long: "The single highest-return session for any distance goal.",
  run_threshold: "Raises the pace you can hold before it falls apart.",
  run_intervals: "Top-end. Small doses, fully recovered.",
  bike_endurance: "Aerobic volume with no impact cost.",
  swim_technique: "Swimming is technique-limited long before it's fitness-limited.",
  compromised: "Running well on legs that have just been wrecked — the race, not a run.",
  station_work: "Time under the exact loads race day will ask for.",
  strength_lower: "Raises the ceiling every endurance quality sits under.",
  strength_push: "Upper-body pressing strength and shoulder durability.",
  strength_pull: "Posterior chain and grip — the two things that quietly cap everything.",
  rest: "Adaptation happens here, not in the sessions.",
};

/** Keep a session's minutes inside what that kind plausibly is. The ONE clamp — a slice that sizes a session without it re-creates the 225-minute "easy run". */
export function clampKind(kind: SessionKind, minutes: number): number {
  const bounds = KIND_MINUTES[kind];
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(minutes)));
}

/** RPE the session is prescribed AT, which is what prices its planned TSS. */
export function rpeFor(kind: SessionKind): number {
  switch (INTENSITY_OF[kind]) {
    case "hard":
      return 8;
    case "moderate":
      return 6;
    case "easy":
      return 4;
    default:
      return 1;
  }
}

/**
 * Converting a session's DURATION when it is substituted across sports, so
 * the substitute carries the same training LOAD rather than the same clock
 * time.
 *
 * Minutes are not load. `SPORT_FALLBACK_PER_MIN` (shared/trainingLoad.ts,
 * the same table that prices a logged session when nothing better exists)
 * says a minute of running is 0.85, a minute of riding 0.70 and a minute of
 * swimming 0.50. So swapping a 60-minute run for a 60-minute ride quietly
 * removes 18% of the week's stress, and swapping it for a swim removes 41% —
 * a "substitution" that is really an unannounced rest day.
 *
 * Derived from that table rather than restated, because two tables of the
 * same exchange rates is exactly the drift this file exists to prevent.
 * Read it as: minutes_to = minutes_from × SPORT_EQUIVALENCE[from][to].
 *
 * A word of honesty about the numbers: they equate ENERGY COST, not
 * specificity. An hour of riding is not an hour of running for a marathoner
 * no matter how the arithmetic comes out — which is why substitution is a
 * fallback for an injured athlete, never an optimisation.
 */
export const SPORT_EQUIVALENCE: Record<PlannedSport, Record<PlannedSport, number>> = (() => {
  const sports: PlannedSport[] = ["run", "bike", "swim", "strength", "hybrid", "station", "other"];
  const table = {} as Record<PlannedSport, Record<PlannedSport, number>>;
  for (const from of sports) {
    table[from] = {} as Record<PlannedSport, number>;
    for (const to of sports) {
      table[from][to] = Math.round((SPORT_FALLBACK_PER_MIN[from] / SPORT_FALLBACK_PER_MIN[to]) * 100) / 100;
    }
  }
  return table;
})();

/**
 * The minutes of `toKind` that carry the same load as `minutes` of
 * `fromKind`, clamped to what that kind plausibly is. Clamped here rather
 * than by the caller so a substitute can never come back as a 12-minute
 * swim or a four-hour ride.
 */
export function equivalentMinutes(fromKind: SessionKind, toKind: SessionKind, minutes: number): number {
  const factor = SPORT_EQUIVALENCE[SPORT_OF[fromKind]][SPORT_OF[toKind]];
  return clampKind(toKind, minutes * factor);
}
