/**
 * The survey: what the app asks before it builds itself.
 *
 * Phase 4's chat is a conversation — good for someone who wants to talk, bad
 * as the only front door, because it can't tell you how far through you are
 * and it can't run at all without an API key. The survey is the front door:
 * deterministic, finishable offline, and the one thing standing between a
 * fresh install and an assembled app.
 *
 * This module is PURE — no DB, no network, no React. It declares what gets
 * asked, checks the answers, and translates them into the writes the rest of
 * the app already understands. That split matters: `surveyToWrites` is the
 * only place that knows "the survey's weight field is a weigh-in, not an
 * athlete row", so the survey cannot invent a second write path for anything
 * that already has one.
 *
 * Nothing here is stored raw and read by nothing. Every field below ends up
 * in a goal, an athlete measurement, a weigh-in, or a preference that some
 * existing module already reads — checked by `survey.test.ts`. A question
 * whose answer changes nothing is a question that shouldn't be asked.
 */

import { type Discipline, type GoalTargetMetrics, type GoalType, DISCIPLINES, defaultDiscipline } from "../goal";
import { ATHLETE_NUMERIC_BOUNDS, withinBounds } from "../athlete";
import { freshKmPaceFrom } from "../calibration";
import { type ConnectorPreferences, type FeaturePreferences } from "../preferences";
import { isValidISODate } from "../dates";

/**
 * The prescriber clamps a week to [3, 7] days (shared/prescription/prescribe.ts).
 * Asking for 2 and quietly building 3 is the archetype this codebase keeps
 * catching, so the survey asks inside the range the engine can actually honour
 * and says so on screen.
 */
export const MIN_TRAINING_DAYS = 3;
export const MAX_TRAINING_DAYS = 7;

export const GOAL_TYPES: GoalType[] = ["endurance_race", "hyrox", "body_composition", "strength", "general_fitness"];

/** Athlete-facing words for every enum this file declares — DECISIONS C7. */
export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  endurance_race: "A race",
  hyrox: "HYROX",
  body_composition: "How I look / weigh",
  strength: "A lift",
  general_fitness: "General fitness",
};

export const GOAL_TYPE_HINTS: Record<GoalType, string> = {
  endurance_race: "Marathon, half, 10k, Ironman, a sportive — anything with a start line.",
  hyrox: "Eight stations and eight kilometres, in whatever order they put them.",
  body_composition: "A weight, a body-fat number, or a wedding.",
  strength: "A squat, deadlift, bench or overhead press number.",
  general_fitness: "No date in mind — just don't lose it.",
};

export const DISCIPLINE_LABELS: Record<Discipline, string> = {
  run: "Running",
  triathlon: "Triathlon",
  cycling: "Cycling",
  swimming: "Swimming",
  other: "Something else",
};

export interface SurveyGoalAnswer {
  type: GoalType;
  discipline: Discipline;
  label: string;
  targetDate: string;
  successCriteria: string;
  targetMetrics: GoalTargetMetrics;
}

/**
 * A recent hard run, which is the single most useful number an endurance
 * athlete can hand over on day one: it turns `runThresholdSecPerKm` from a
 * seed into a measurement, and every pace on every session card is derived
 * from it.
 */
export interface RecentEffort {
  distanceKm: number;
  timeSeconds: number;
  /** When it happened — the provenance string says so, so it has to be real. */
  date: string;
}

export interface SurveyAnswers {
  version: 1;
  /** What to call them. Shown on the Plan header; not an account, there is only one athlete. */
  name: string;
  /** What they said out loud. Kept verbatim: it's the thing the app was built from, and "Your app" shows it back. */
  narrative: string;
  ageYears?: number;
  heightCm?: number;
  weightKg?: number;
  bodyFatPercent?: number;
  trainingDaysPerWeek: number;
  hasBike: boolean;
  hasPool: boolean;
  recentEffort?: RecentEffort;
  maxHrBpm?: number;
  lifts: { squat1RmKg?: number; deadlift1RmKg?: number; bench1RmKg?: number; ohp1RmKg?: number };
  ftpWatts?: number;
  goals: SurveyGoalAnswer[];
  connectors: ConnectorPreferences;
  physiqueTracking: boolean;
}

export const EMPTY_SURVEY: SurveyAnswers = {
  version: 1,
  name: "",
  narrative: "",
  trainingDaysPerWeek: 5,
  hasBike: false,
  hasPool: false,
  lifts: {},
  goals: [],
  connectors: { garmin: false, whoop: false, appleHealth: false },
  physiqueTracking: false,
};

export function emptyGoal(today: string): SurveyGoalAnswer {
  return {
    type: "endurance_race",
    discipline: defaultDiscipline("endurance_race"),
    label: "",
    targetDate: today,
    successCriteria: "",
    targetMetrics: {},
  };
}

export class InvalidSurveyError extends Error {}

/** Optional numeric fields, and which athlete bound each is checked against. */
const OPTIONAL_NUMBERS: Array<[keyof SurveyAnswers | string, string]> = [
  ["ageYears", "ageYears"],
  ["heightCm", "heightCm"],
  ["weightKg", "weightKg"],
  ["bodyFatPercent", "bodyFatPercent"],
  ["maxHrBpm", "maxHrBpm"],
  ["ftpWatts", "ftpWatts"],
];

/**
 * Throws on anything that would make a bad app. Deliberately the same shape
 * as `validateGoalInput` — the survey is a form submission and gets a form
 * submission's scepticism, whether it was typed, dictated, or filled in by a
 * model reading the athlete's narrative.
 */
export function validateSurvey(answers: unknown, today: string): asserts answers is SurveyAnswers {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new InvalidSurveyError("answers must be an object");
  }
  const a = answers as Record<string, unknown>;

  if (typeof a.trainingDaysPerWeek !== "number" || !Number.isInteger(a.trainingDaysPerWeek)) {
    throw new InvalidSurveyError("trainingDaysPerWeek must be a whole number");
  }
  if (a.trainingDaysPerWeek < MIN_TRAINING_DAYS || a.trainingDaysPerWeek > MAX_TRAINING_DAYS) {
    throw new InvalidSurveyError(`trainingDaysPerWeek must be between ${MIN_TRAINING_DAYS} and ${MAX_TRAINING_DAYS}`);
  }
  for (const [field, bound] of OPTIONAL_NUMBERS) {
    const value = a[field as string];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !withinBounds(bound, value)) {
      const [lo, hi] = ATHLETE_NUMERIC_BOUNDS[bound]!;
      throw new InvalidSurveyError(`${field} must be a number between ${lo} and ${hi}`);
    }
  }
  const lifts = (a.lifts ?? {}) as Record<string, unknown>;
  for (const key of ["squat1RmKg", "deadlift1RmKg", "bench1RmKg", "ohp1RmKg"]) {
    const value = lifts[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !withinBounds(key, value)) {
      const [lo, hi] = ATHLETE_NUMERIC_BOUNDS[key]!;
      throw new InvalidSurveyError(`${key} must be a number between ${lo} and ${hi}`);
    }
  }

  if (a.recentEffort !== undefined && a.recentEffort !== null) {
    const e = a.recentEffort as Record<string, unknown>;
    if (typeof e.distanceKm !== "number" || e.distanceKm < 1 || e.distanceKm > 100) {
      throw new InvalidSurveyError("recentEffort.distanceKm must be between 1 and 100");
    }
    if (typeof e.timeSeconds !== "number" || e.timeSeconds < 120 || e.timeSeconds > 24 * 3600) {
      throw new InvalidSurveyError("recentEffort.timeSeconds must be a plausible finishing time");
    }
    if (typeof e.date !== "string" || !isValidISODate(e.date) || e.date > today) {
      throw new InvalidSurveyError("recentEffort.date must be a past date (YYYY-MM-DD)");
    }
    // A pace nobody has ever run means a typo — almost always minutes entered
    // where seconds were meant. Better refused than fed into every session
    // card as a measured number with a provenance string vouching for it.
    const pace = e.timeSeconds / e.distanceKm;
    if (!withinBounds("run5kSecPerKm", pace)) {
      throw new InvalidSurveyError("that distance and time work out to a pace this app doesn't believe — check them");
    }
  }

  if (!Array.isArray(a.goals) || a.goals.length === 0) {
    throw new InvalidSurveyError("tell it at least one goal — the whole app is assembled off them");
  }
  if (a.goals.length > 6) throw new InvalidSurveyError("six goals is already more than anything can be arbitrated between");

  for (const raw of a.goals as unknown[]) {
    if (!raw || typeof raw !== "object") throw new InvalidSurveyError("each goal must be an object");
    const goal = raw as Record<string, unknown>;
    if (!GOAL_TYPES.includes(goal.type as GoalType)) throw new InvalidSurveyError(`goal type must be one of ${GOAL_TYPES.join(", ")}`);
    if (goal.discipline !== undefined && !DISCIPLINES.includes(goal.discipline as Discipline)) {
      throw new InvalidSurveyError(`goal discipline must be one of ${DISCIPLINES.join(", ")}`);
    }
    if (typeof goal.label !== "string" || !goal.label.trim()) throw new InvalidSurveyError("every goal needs a name");
    if (typeof goal.targetDate !== "string" || !isValidISODate(goal.targetDate)) {
      throw new InvalidSurveyError("every goal needs a valid target date");
    }
    // Phase 3's own bug in reverse: a goal already in the past contributes
    // nothing to arbitration and would land the athlete in an app assembled
    // around a race that has been and gone. Caught here, where it can still
    // be fixed, rather than shown as an empty plan later.
    if (goal.targetDate < today) throw new InvalidSurveyError(`"${goal.label}" has a target date in the past`);
  }
}

export interface SurveyWrites {
  goals: Array<{
    type: GoalType;
    discipline: Discipline;
    label: string;
    targetDate: string;
    priority: number;
    successCriteria: string;
    targetMetrics: GoalTargetMetrics;
  }>;
  /** Straight onto the athlete row as `measured(...)`, with the provenance string to use. */
  athlete: Array<{ field: string; value: number; source: string }>;
  /** Weight and body fat are weigh-ins — they go through the physique path like every other weigh-in does. */
  weighIn: { weightKg?: number; bodyFatPercent?: number };
  connectors: ConnectorPreferences;
  features: Pick<FeaturePreferences, "physiqueTracking" | "hasBike" | "hasPool">;
}

function niceDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Answers → the writes that build the app. Pure, so it can be tested without
 * a database and read without following it into four services.
 *
 * Priority is list order (1 = most important). The survey shows that
 * explicitly and lets the athlete reorder, because it's the single answer
 * arbitration leans on hardest — it decides which goal gives way when two
 * pull apart.
 */
export function surveyToWrites(answers: SurveyAnswers, today: string): SurveyWrites {
  const athlete: SurveyWrites["athlete"] = [];
  const add = (field: string, value: number | undefined, source: string) => {
    if (value === undefined || value === null || !withinBounds(field, value)) return;
    athlete.push({ field, value, source });
  };

  add("ageYears", answers.ageYears, "told us during setup");
  add("heightCm", answers.heightCm, "told us during setup");
  add("maxHrBpm", answers.maxHrBpm, "told us during setup");
  add("ftpWatts", answers.ftpWatts, "told us during setup");
  for (const [field, value] of Object.entries(answers.lifts ?? {})) {
    add(field, value as number | undefined, "told us during setup");
  }

  /*
   * The recent effort becomes the FRESH KILOMETRE, not threshold pace —
   * `runThresholdSecPerKm` holds a 1 km all-out time (see its doc comment in
   * shared/athlete.ts, and the Phase 7 bug where reading it as threshold
   * predicted a 3:00 marathon off a 4:00/km kilometre). The Riegel projection
   * is calibration.ts's, imported rather than re-derived.
   */
  if (answers.recentEffort) {
    const { distanceKm, timeSeconds, date } = answers.recentEffort;
    const pace = timeSeconds / distanceKm;
    const freshKm = Math.round(freshKmPaceFrom(distanceKm, pace));
    const label = `${Math.round(distanceKm * 10) / 10} km in ${fmtTime(timeSeconds)} on ${niceDate(date)}, projected to 1 km`;
    add("runThresholdSecPerKm", freshKm, label);
    // A marathon is its own anchor in the predictor, and a real one beats
    // anything projected from a shorter distance.
    if (distanceKm >= 40) add("marathonPbMinutes", Math.round(timeSeconds / 60), `marathon on ${niceDate(date)}`);
  }

  const goals = answers.goals.map((goal, index) => ({
    type: goal.type,
    discipline: goal.discipline ?? defaultDiscipline(goal.type),
    label: goal.label.trim(),
    targetDate: goal.targetDate,
    priority: index + 1,
    successCriteria: goal.successCriteria.trim() || describeGoal(goal),
    targetMetrics: goal.targetMetrics ?? {},
  }));

  /*
   * A triathlon or cycling goal is proof of a bike; a triathlon or swimming
   * goal is proof of a pool. The athlete's own answer is never overwritten
   * downward — this only ever turns a flag ON, because `hasBike: false` for
   * someone training for an Ironman is a wrong answer that costs them every
   * cross-training substitute when they get injured.
   */
  const disciplines = new Set(goals.map((g) => g.discipline));
  const hasBike = answers.hasBike || disciplines.has("triathlon") || disciplines.has("cycling");
  const hasPool = answers.hasPool || disciplines.has("triathlon") || disciplines.has("swimming");

  return {
    goals,
    athlete,
    weighIn: {
      ...(answers.weightKg !== undefined ? { weightKg: answers.weightKg } : {}),
      ...(answers.bodyFatPercent !== undefined ? { bodyFatPercent: answers.bodyFatPercent } : {}),
    },
    connectors: { ...EMPTY_SURVEY.connectors, ...answers.connectors },
    features: { physiqueTracking: !!answers.physiqueTracking, hasBike, hasPool },
  };
}

/**
 * A readable `successCriteria` when the athlete left it blank.
 *
 * It has to be non-empty — `validateGoalInput` rejects a blank one, so an
 * optional field on the form becomes a required string here — and it is shown
 * back on the Goals page under the goal's own name, so one generic shape for
 * all five types reads as filler ("How I look / weigh — Christmas,
 * 2026-12-20" under a card already titled Christmas).
 */
export function describeGoal(goal: SurveyGoalAnswer): string {
  const m = goal.targetMetrics ?? {};
  const by = niceDate(goal.targetDate);
  if (m.targetTimeSeconds) return `${goal.label} in ${fmtTime(m.targetTimeSeconds)}`;
  if (goal.type === "strength" && m.targetWeightKg) return `Lift ${m.targetWeightKg} kg by ${by}`;
  if (m.targetWeightKg) return `Reach ${m.targetWeightKg} kg by ${by}`;
  if (m.targetBodyFatPercent) return `Reach ${m.targetBodyFatPercent}% body fat by ${by}`;

  switch (goal.type) {
    case "endurance_race":
    case "hyrox":
      return `Get to the start line of ${goal.label} on ${by} in the shape to race it`;
    case "body_composition":
      return `Be where you want to be by ${by}`;
    case "strength":
      return `Move the number by ${by}`;
    case "general_fitness":
      return `Hold the shape you're in through ${by}`;
  }
}
