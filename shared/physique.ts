/**
 * Physique tracking — the weigh-in, the trend, and the honest verdict.
 *
 * Onboarding has asked every athlete since Phase 4 whether they want to
 * track how they look, stored the answer in
 * `preferences.features.physiqueTracking`, and nothing has ever read it.
 * Phase 8 turned that into a declared gap rather than a silent one; this is
 * the block that closes it.
 *
 * Two decisions shape this whole file.
 *
 * ONE MECHANISM FOR WEIGHT (DECISIONS C4). A logged weigh-in does not write
 * an athlete row. `applyPhysiqueEvidence` folds the newest entry into
 * `AthleteParams.weightKg` / `bodyFatPercent` at READ time, exactly the way
 * `benchmarks` already works. Deleting the newest weigh-in therefore hands
 * the field back to the next-newest — and deleting all of them back to the
 * seed — with no second code path to keep in step. An incremental "also
 * update the athlete" write is the Phase 3 archetype waiting to happen: a
 * deleted row still steering next week's calorie target.
 *
 * THE VERDICT IS A FINISHING WEIGHT, NOT A RATE. `predictBodyComposition`
 * recomputes `requiredWeeklyChangeKg` from TODAY's weight every time it is
 * called, so comparing the observed rate against the required rate compares
 * a number with itself-adjusted: an athlete who has lost nothing in six
 * weeks gets a steeper requirement each week and keeps reading "on track"
 * until the requirement finally crosses the safe ceiling. `progressVsGoal`
 * therefore projects the OBSERVED rate forward to the target DATE and
 * compares finishing weights.
 */

import { ATHLETE_NUMERIC_BOUNDS, type AthleteParams } from "./athlete";
import { addDays, daysBetween, isValidISODate } from "./dates";
import { measured } from "./measured";
import type { Goal } from "./goal";
import {
  type BodyCompositionPrediction,
  predictBodyComposition,
} from "./predictors/bodyComposition";

/* ─── What a weigh-in is ──────────────────────────────────────────────── */

/** The three numbers an athlete can log about their body. Photos are deliberately not here — see the report. */
export type PhysiqueMetric = "weightKg" | "bodyFatPercent" | "waistCm";

export const PHYSIQUE_METRICS: readonly PhysiqueMetric[] = ["weightKg", "bodyFatPercent", "waistCm"];

/** Athlete-facing names. Typed so a fourth metric cannot compile until it has words (DECISIONS C7). */
export const PHYSIQUE_METRIC_LABELS: Record<PhysiqueMetric, string> = {
  weightKg: "Weight",
  bodyFatPercent: "Body fat",
  waistCm: "Waist",
};

export const PHYSIQUE_METRIC_UNITS: Record<PhysiqueMetric, string> = {
  weightKg: "kg",
  bodyFatPercent: "%",
  waistCm: "cm",
};

/**
 * Bounds. Weight and body fat come STRAIGHT from `ATHLETE_NUMERIC_BOUNDS` —
 * the same number reaches `AthleteParams` through the fold below, so two
 * bounds tables would mean a value this file accepted and `athleteParamsFromRow`
 * then silently dropped. Waist has no athlete field, so it is declared here,
 * once.
 */
export const PHYSIQUE_BOUNDS: Record<PhysiqueMetric, [number, number]> = {
  weightKg: ATHLETE_NUMERIC_BOUNDS.weightKg,
  bodyFatPercent: ATHLETE_NUMERIC_BOUNDS.bodyFatPercent,
  waistCm: [40, 200],
};

export interface PhysiqueEntry {
  id: string;
  /** YYYY-MM-DD. One entry per date — weighing twice on Tuesday corrects Tuesday. */
  date: string;
  weightKg: number | null;
  bodyFatPercent: number | null;
  waistCm: number | null;
  note: string | null;
  recordedAt: string;
}

/**
 * `undefined` keeps what is stored, `null` clears it, a number sets it —
 * the same patch convention `recordCompletion` and `upsertCheckIn` use, so
 * "add a waist measurement to this morning" does not erase this morning's
 * weight.
 */
export interface PhysiqueEntryInput {
  date: string;
  weightKg?: number | null;
  bodyFatPercent?: number | null;
  waistCm?: number | null;
  note?: string | null;
}

export class InvalidPhysiqueEntryError extends Error {}

const MAX_NOTE_LENGTH = 500;

/**
 * Validate the entry AS IT WILL BE STORED — the caller merges an existing
 * row in first, so a patch that clears the last remaining number is rejected
 * for the same reason an empty entry is: it records nothing.
 *
 * `today` is optional and, when given, rejects a future date. A fat-fingered
 * "2027-09-18" would otherwise become the newest entry forever and pin the
 * fold below to a measurement that has not happened.
 */
export function validatePhysiqueEntry(
  input: PhysiqueEntryInput,
  options: { today?: string } = {},
): string | null {
  if (!input || typeof input !== "object") return "A weigh-in has to be an object.";
  if (!isValidISODate(input.date)) return "A weigh-in needs a real date, as YYYY-MM-DD.";
  if (options.today && daysBetween(options.today, input.date) > 0) {
    return "That date is in the future — a weigh-in records what the scale already said.";
  }

  let present = 0;
  for (const metric of PHYSIQUE_METRICS) {
    const value = input[metric];
    if (value == null) continue;
    present += 1;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${PHYSIQUE_METRIC_LABELS[metric]} has to be a number.`;
    }
    const [min, max] = PHYSIQUE_BOUNDS[metric];
    if (value < min || value > max) {
      return `${PHYSIQUE_METRIC_LABELS[metric]} of ${value} ${PHYSIQUE_METRIC_UNITS[metric]} is outside ${min}–${max} ${PHYSIQUE_METRIC_UNITS[metric]} — check the entry.`;
    }
  }
  if (present === 0) return "A weigh-in needs at least one measurement — a weight, a body-fat % or a waist.";

  if (input.note != null && typeof input.note !== "string") return "A note has to be text.";
  if (typeof input.note === "string" && input.note.length > MAX_NOTE_LENGTH) {
    return `Keep the note under ${MAX_NOTE_LENGTH} characters.`;
  }
  return null;
}

/**
 * A weight this far from the last logged one is worth a second look before
 * it is saved. Not a rejection — people really do lose 4 kg on holiday — but
 * a typo here moves maintenance by roughly 250 kcal/day through
 * `dailyTargets`, so it should cost one tap to confirm.
 */
export const CONFIRM_WEIGHT_DELTA_KG = 3;

/** The confirmation question, or null when nothing looks odd. One rule, so the client cannot invent a second one. */
export function weightChangeWarning(weightKg: number | null | undefined, previous: PhysiqueEntry | null): string | null {
  if (weightKg == null || !previous || previous.weightKg == null) return null;
  const delta = weightKg - previous.weightKg;
  if (Math.abs(delta) < CONFIRM_WEIGHT_DELTA_KG) return null;
  const direction = delta > 0 ? "up" : "down";
  return `That is ${Math.abs(Math.round(delta * 10) / 10)} kg ${direction} from ${previous.weightKg} kg on ${previous.date}. Save it anyway?`;
}

/* ─── The trend ───────────────────────────────────────────────────────── */

export interface PhysiquePoint {
  date: string;
  value: number;
  /** Days since the first point in the series — the sparkline's x axis, so a fortnight of silence LOOKS like a fortnight. */
  dayOffset: number;
}

export interface MetricTrend {
  metric: PhysiqueMetric;
  first: PhysiquePoint;
  last: PhysiquePoint;
  /** last − first, in the metric's own unit. */
  change: number;
  /**
   * Least-squares slope × 7, or null when the series has not earned a rate
   * yet. First-to-last would be worse than nothing: bodyweight swings ±1 kg
   * across a day, so two points a week apart can be entirely noise.
   */
  changePerWeek: number | null;
  spanDays: number;
  samples: number;
  /** Every point in the window, oldest first. Plot this; no chart library needed. */
  series: PhysiquePoint[];
}

/** Below this span, a slope is measuring daily water weight rather than a trend. */
export const MIN_TREND_SPAN_DAYS = 14;

export interface TrendWindow {
  /** Only entries within this many days of `today` count. Omit for all of them. */
  days?: number;
  /** Defaults to the newest entry's date, so the trend is pure and needs no clock. */
  today?: string;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Newest last. Ties on date fall back to when the row was written. */
function sortByDate(entries: readonly PhysiqueEntry[]): PhysiqueEntry[] {
  return [...entries].sort((a, b) => (a.date === b.date ? a.recordedAt.localeCompare(b.recordedAt) : a.date < b.date ? -1 : 1));
}

function inBounds(metric: PhysiqueMetric, value: number | null | undefined): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const [min, max] = PHYSIQUE_BOUNDS[metric];
  return value >= min && value <= max;
}

function pointsFor(entries: readonly PhysiqueEntry[], metric: PhysiqueMetric): PhysiquePoint[] {
  const sorted = sortByDate(entries).filter((e) => inBounds(metric, e[metric]));
  if (sorted.length === 0) return [];
  const origin = sorted[0].date;
  return sorted.map((e) => ({ date: e.date, value: e[metric] as number, dayOffset: daysBetween(origin, e.date) }));
}

/**
 * Weekly rate by least squares over the real elapsed days, not first-to-last:
 * an athlete who weighs in five times and once after a heavy meal should not
 * have that one morning define their trend.
 *
 * Null below `MIN_TREND_SPAN_DAYS`, and null when every point lands on the
 * same day (no run, no slope).
 */
export function weeklyRate(points: readonly PhysiquePoint[]): number | null {
  if (points.length < 2) return null;
  const span = points[points.length - 1].dayOffset - points[0].dayOffset;
  if (span < MIN_TREND_SPAN_DAYS) return null;
  const meanX = points.reduce((s, p) => s + p.dayOffset, 0) / points.length;
  const meanY = points.reduce((s, p) => s + p.value, 0) / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.dayOffset - meanX) * (p.value - meanY);
    den += (p.dayOffset - meanX) ** 2;
  }
  if (den === 0) return null;
  return round((num / den) * 7, 3);
}

/**
 * Per-metric trend over `window`. A metric with no readings in the window is
 * `null` rather than a zeroed trend — "nothing logged" and "no change" are
 * different facts and only one of them is a measurement.
 */
export function trend(
  entries: readonly PhysiqueEntry[],
  window: TrendWindow = {},
): Record<PhysiqueMetric, MetricTrend | null> {
  const sorted = sortByDate(entries);
  const anchor = window.today ?? (sorted.length ? sorted[sorted.length - 1].date : null);
  const from = window.days != null && anchor ? addDays(anchor, -(window.days - 1)) : null;
  const scoped = sorted.filter((e) => {
    if (anchor && daysBetween(anchor, e.date) > 0) return false;
    return from ? e.date >= from : true;
  });

  const out = {} as Record<PhysiqueMetric, MetricTrend | null>;
  for (const metric of PHYSIQUE_METRICS) {
    const series = pointsFor(scoped, metric);
    if (series.length === 0) {
      out[metric] = null;
      continue;
    }
    const first = series[0];
    const last = series[series.length - 1];
    out[metric] = {
      metric,
      first,
      last,
      change: round(last.value - first.value, 2),
      changePerWeek: weeklyRate(series),
      spanDays: last.dayOffset - first.dayOffset,
      samples: series.length,
      series,
    };
  }
  return out;
}

/* ─── The fold into AthleteParams (DECISIONS C4) ──────────────────────── */

/** Only the two metrics that are also athlete parameters fold; waist has nowhere to go and stays a logged number. */
const FOLDED_METRICS: ReadonlyArray<Extract<PhysiqueMetric, "weightKg" | "bodyFatPercent">> = ["weightKg", "bodyFatPercent"];

const FOLD_SOURCE: Record<(typeof FOLDED_METRICS)[number], (date: string) => string> = {
  weightKg: (date) => `scale, ${date}`,
  bodyFatPercent: (date) => `body-fat measurement, ${date}`,
};

/**
 * The newest logged value wins, as a MEASURED value with its date on it;
 * failing that the stored athlete row; failing that the seed.
 *
 * Never mutates `params` — it returns a new object, so a caller holding the
 * unfolded params still has them. That is the `Measured<T>` rule applied to
 * the container as well as the value: this function does not quietly turn
 * somebody else's seed into a measurement in place.
 *
 * Idempotent: folding already-folded params yields the same answer, because
 * the newest entry is chosen from the entries, never from what the params
 * already say.
 */
export function applyPhysiqueEvidence(params: AthleteParams, entries: readonly PhysiqueEntry[]): AthleteParams {
  const sorted = sortByDate(entries);
  const folded: AthleteParams = { ...params };
  for (const metric of FOLDED_METRICS) {
    // Newest first; an out-of-bounds row (hand-edited, restored from a
    // backup) is skipped rather than carried into a prediction.
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const entry = sorted[i];
      const value = entry[metric];
      if (!inBounds(metric, value)) continue;
      folded[metric] = measured(value, FOLD_SOURCE[metric](entry.date), entry.date);
      break;
    }
  }
  return folded;
}

/* ─── The verdict ─────────────────────────────────────────────────────── */

export type ProgressStatus = "on_track" | "behind" | "ahead" | "unknown";

/** Athlete-facing words. No status id ever reaches a screen (DECISIONS C7). */
export const PROGRESS_STATUS_LABELS: Record<ProgressStatus, string> = {
  on_track: "On track",
  behind: "Behind where this needs to be",
  ahead: "Ahead of plan",
  unknown: "Not enough logged yet",
};

/**
 * A weigh-in older than this stops producing a confident verdict. State that
 * stopped being current has to stop being asserted — three weeks of silence
 * is not evidence of anything.
 */
export const STALE_ENTRY_DAYS = 21;

/** Floor on the tolerance band, in kg. A flat band would flip a 12 kg cut's verdict week to week. */
export const MIN_TOLERANCE_KG = 0.5;
/** …so the band also scales with the size of the goal: 10% of the total change still to come. */
export const TOLERANCE_FRACTION_OF_GOAL = 0.1;

export interface PhysiqueProgress {
  status: ProgressStatus;
  /** The words for `status`, already resolved — the caller never maps an id itself. */
  statusLabel: string;
  /** Least-squares kg/week from the logged entries, or null when they have not earned a rate. */
  observedWeeklyChangeKg: number | null;
  /** What `predictBodyComposition` says is needed from TODAY. Shown, never used as the verdict — see the file header. */
  requiredWeeklyChangeKg: number | null;
  safeWeeklyRateKg: number;
  targetWeightKg: number | null;
  /** The observed rate carried forward from the last weigh-in to the target date. */
  projectedWeightKg: number | null;
  latestWeightKg: number | null;
  latestEntryDate: string | null;
  daysSinceLatestEntry: number | null;
  weeksRemaining: number;
  toleranceKg: number;
  /** One sentence with the numbers in it, in the athlete's words. */
  summary: string;
  /** The predictor's own answer, passed through so a caller needs one call rather than two. */
  prediction: BodyCompositionPrediction;
}

function kg(n: number): string {
  return `${round(n, 1)} kg`;
}

/**
 * Where this goal actually stands, against the athlete's own logged weight.
 *
 * `entries` are folded into `athlete` here, so the predictor's "current
 * weight" is the newest weigh-in whether or not the caller folded already
 * (the fold is idempotent).
 */
export function progressVsGoal(
  entries: readonly PhysiqueEntry[],
  goal: Goal,
  athlete: AthleteParams,
  options: { today?: string } = {},
): PhysiqueProgress {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const folded = applyPhysiqueEvidence(athlete, entries);
  const prediction = predictBodyComposition(folded, {
    targetWeightKg: goal.targetMetrics.targetWeightKg,
    targetBodyFatPercent: goal.targetMetrics.targetBodyFatPercent,
    targetDate: goal.targetDate,
    today,
  });

  const points = pointsFor(entries, "weightKg").filter((p) => daysBetween(today, p.date) <= 0);
  const last = points.length ? points[points.length - 1] : null;
  const observed = weeklyRate(points);
  const daysSince = last ? daysBetween(last.date, today) : null;

  /*
   * The target weight comes from the predictor rather than a second copy of
   * the body-fat → weight solve: when the goal is stated as a body-fat %,
   * only `predictBodyComposition` knows how that becomes a weight (hold lean
   * mass, solve). Reconstructing it from the numbers it returns keeps that
   * knowledge in one place. See the report for the exact-value follow-up.
   */
  const targetWeightKg =
    goal.targetMetrics.targetWeightKg ??
    (prediction.requiredWeeklyChangeKg != null
      ? round(prediction.currentWeightKg + prediction.requiredWeeklyChangeKg * prediction.weeksAvailable, 2)
      : null);

  const weeksRemaining = prediction.weeksAvailable;
  const toleranceKg = Math.max(
    MIN_TOLERANCE_KG,
    Math.abs(prediction.requiredWeeklyChangeKg ?? 0) * weeksRemaining * TOLERANCE_FRACTION_OF_GOAL,
  );

  const base = {
    statusLabel: PROGRESS_STATUS_LABELS.unknown,
    observedWeeklyChangeKg: observed,
    requiredWeeklyChangeKg: prediction.requiredWeeklyChangeKg,
    safeWeeklyRateKg: prediction.safeWeeklyRateKg,
    targetWeightKg,
    projectedWeightKg: null as number | null,
    latestWeightKg: last?.value ?? null,
    latestEntryDate: last?.date ?? null,
    daysSinceLatestEntry: daysSince,
    weeksRemaining,
    toleranceKg: round(toleranceKg, 2),
    prediction,
  };

  const unknown = (summary: string): PhysiqueProgress => ({ ...base, status: "unknown", summary });

  if (targetWeightKg == null || weeksRemaining <= 0) {
    return unknown(
      weeksRemaining <= 0
        ? `${goal.label} is in the past, so there is nothing left to project.`
        : `Set a target weight or body-fat % on ${goal.label} and this will tell you whether you are on course.`,
    );
  }
  if (!last) return unknown(`Log a weigh-in and this will tell you whether ${goal.label} is on course.`);
  if (daysSince != null && daysSince > STALE_ENTRY_DAYS) {
    return unknown(
      `Your last weigh-in was ${daysSince} days ago, on ${last.date}. That is too long ago to say where ${goal.label} stands — step on the scale and this answers.`,
    );
  }
  if (observed == null) {
    const span = points.length >= 2 ? points[points.length - 1].dayOffset - points[0].dayOffset : 0;
    return unknown(
      points.length < 2
        ? `One weigh-in is a number, not a trend. Log another and this will tell you whether ${goal.label} is on course.`
        : `${span} days of weigh-ins is still inside the noise — bodyweight swings about a kilo across a day. At ${MIN_TREND_SPAN_DAYS} days this can call it.`,
    );
  }

  // Project what the athlete is ACTUALLY doing forward to the date, and
  // compare finishing weights. Anchored on the last real weigh-in, not on
  // today: that is the last thing anybody actually measured.
  const weeksFromLast = daysBetween(last.date, goal.targetDate) / 7;
  const projectedWeightKg = round(last.value + observed * weeksFromLast, 2);
  const missBy = projectedWeightKg - targetWeightKg;
  const direction = Math.sign(prediction.requiredWeeklyChangeKg ?? 0);

  let status: ProgressStatus;
  if (Math.abs(missBy) <= toleranceKg) status = "on_track";
  else if (direction < 0) status = missBy < 0 ? "ahead" : "behind";
  else if (direction > 0) status = missBy > 0 ? "ahead" : "behind";
  else status = "behind"; // holding a weight: drifting either way is off target

  const rateWords = `${observed === 0 ? "holding steady" : `${kg(Math.abs(observed))} a week ${observed < 0 ? "down" : "up"}`}`;
  const summary =
    status === "on_track"
      ? `At ${rateWords} you land on about ${kg(projectedWeightKg)} by ${goal.targetDate} — within ${kg(toleranceKg)} of the ${kg(targetWeightKg)} ${goal.label} asks for.`
      : status === "ahead"
        ? `At ${rateWords} you land on about ${kg(projectedWeightKg)} by ${goal.targetDate}, past the ${kg(targetWeightKg)} ${goal.label} asks for. You could ease the deficit and still arrive.`
        : `At ${rateWords} you land on about ${kg(projectedWeightKg)} by ${goal.targetDate}, ${kg(Math.abs(missBy))} off the ${kg(targetWeightKg)} ${goal.label} asks for. Needs ${kg(Math.abs(prediction.requiredWeeklyChangeKg ?? 0))} a week from here${prediction.achievable ? "" : ", which is above a sustainable rate — moving the date or the target is the honest fix"}.`;

  return { ...base, status, statusLabel: PROGRESS_STATUS_LABELS[status], projectedWeightKg, summary };
}
