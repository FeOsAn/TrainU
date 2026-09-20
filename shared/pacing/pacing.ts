/**
 * Race-day pacing plans — the first block off the gap queue, because two goal
 * types have been asking for it since `capabilityGaps` started recording what
 * the app could not do.
 *
 * Three rules hold this file together:
 *
 * 1. **The physics is never restated.** Every number here starts life in a
 *    predictor — `predictRunRace`, `predictTriathlon`, `predictHyrox` — and is
 *    only ever *redistributed* by a profile from `profiles.ts`, never resized.
 *    Race power comes from `BIKE_RACE_POWER_FRACTION` in the predictor that
 *    uses it; the open-water penalty and the brick penalty are read out of the
 *    predicted leg times rather than reapplied. A pacing plan that disagrees
 *    with the prediction it was built from is two models of one athlete.
 * 2. **Every plan says how much of itself is guessed.** A pacing plan is the
 *    most confident-looking screen this app can render: it has decimal places,
 *    a watt number and a finish time. Built off a seeded FTP it is a guess
 *    wearing a lab coat. So every plan carries the predictor's `Confidence`
 *    AND the plain-language provenance of each input still unmeasured, and
 *    says so in words the athlete reads before the splits.
 * 3. **Nothing here is adjusted by how training went.** An athlete who skipped
 *    three taper sessions does not get slower splits invented for them; the
 *    honest signal for that is the calibration multiplier, once real race
 *    outcomes are recorded against committed plans.
 *
 * Pure: no DB, no clock (`options.today`), no network.
 */

import type { AthleteParams } from "../athlete";
import { todayISO } from "../dates";
import type { Goal, GoalTargetMetrics } from "../goal";
import type { Confidence, Measured } from "../measured";
import { seeded, widenForConfidence } from "../measured";
import {
  BIKE_RACE_POWER_FRACTION,
  TRIATHLON_DISTANCES,
  type TriathlonDistances,
  calcBikeRacePower,
  predictRunRace,
  predictTriathlon,
} from "../predictors/enduranceRace";
import { predictHyrox, type Limiter } from "../predictors/hyrox";
import { DEFAULT_ROXZONE_SECONDS, DEFAULT_STATION_BENCHMARKS, RACE_SEQUENCE, STATION_BY_ID, type StationId } from "../predictors/hyroxStations";
import {
  BAIL_OUT_SLOWDOWN,
  BAIL_OUT_TRIGGER_FRACTION,
  BIKE_SURGE_CEILING_FRACTION,
  EVEN_PROFILE,
  FINISH_BAND_PER_MILLE,
  HYROX_ROXZONE_CROSSINGS,
  type LegProfile,
  type PacingDiscipline,
  STRETCH_TOLERANCE_BASE_PCT,
  type SplitZone,
  integrateFactor,
  profileFor,
  splitKmFor,
  zoneAt,
  zoneNote,
  zoneSlices,
} from "./profiles";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PacingBasis = "target" | "predicted";

export const PACING_BASIS_LABELS: Record<PacingBasis, string> = {
  target: "built to the time you asked for",
  predicted: "built to what your numbers say today",
};

export type PacingUnavailableReason = "missing_target_distance" | "missing_triathlon_format" | "unsupported_discipline" | "unsupported_goal_type";

export const PACING_UNAVAILABLE_REASON_LABELS: Record<PacingUnavailableReason, string> = {
  missing_target_distance: "the race distance is missing",
  missing_triathlon_format: "the race format is missing",
  unsupported_discipline: "there is no race-day plan for this sport yet",
  unsupported_goal_type: "this goal is not a race",
};

export interface SeedInput {
  /** The field as the predictor named it — for the UI to link to, never to print. */
  field: string;
  /** Athlete-facing words for that field. */
  label: string;
  /** The `Measured.source` string: "seed — relaxed road position assumed, not measured". */
  source: string;
}

export interface Split {
  label: string;
  fromKm: number;
  toKm: number;
  paceSecPerKm: number;
  paceFormatted: string;
  seconds: number;
  cumulativeSeconds: number;
  cumulativeFormatted: string;
  zone: SplitZone;
  note: string;
}

/**
 * Every clock here is elapsed from the RACE start; only `decisionAtKm` is
 * leg-relative, and it says so. The meaning is written down because the first
 * version of this file assumed it across a module boundary and got it wrong:
 * the triathlon handed the run leg's total to a sentence that says "brings you
 * home in", promising a 1:45 finish to a five-hour race. A number crossing a
 * boundary needs its meaning attached, not assumed — the same rule
 * `Measured<T>` and `FRESH_KM_TO_THRESHOLD` encode.
 */
export interface BailOut {
  /** Pace to hold for the REST OF THE LEG the decision is made in. */
  paceSecPerKm: number;
  paceFormatted: string;
  /** Distance into the leg named by the trigger — for a single-leg race, into the race. */
  decisionAtKm: number;
  /** Elapsed from the RACE start at the decision point: what the athlete's watch will read there. */
  elapsedAtDecisionSeconds: number;
  elapsedAtDecisionFormatted: string;
  /** How far behind that checkpoint triggers it — a share of the WHOLE race, in every discipline. */
  behindBySeconds: number;
  /** Elapsed from the RACE start at the finish line, if the bail-out is taken. */
  finishSeconds: number;
  finishFormatted: string;
  /** The whole rule in one sentence, with real numbers in it. */
  trigger: string;
}

export interface FinishEstimate {
  predictedSeconds: number;
  predictedFormatted: string;
  lowSeconds: number;
  highSeconds: number;
  lowFormatted: string;
  highFormatted: string;
  /** Per-mille of predicted time, after widening for unmeasured inputs and calibration. */
  bandPerMille: number;
  targetSeconds: number | null;
  targetFormatted: string | null;
  goalProbability: number | null;
  goalProbabilityLow: number | null;
  goalProbabilityHigh: number | null;
}

export interface GoalComparison {
  targetSeconds: number;
  targetFormatted: string;
  predictedSeconds: number;
  predictedFormatted: string;
  /** predicted − target. Positive means the target is faster than the prediction. */
  deltaSeconds: number;
  deltaFormatted: string;
  /** True when the target is faster than the prediction. */
  targetIsAhead: boolean;
  gapPercent: number;
  tolerancePercent: number;
  withinTolerance: boolean;
  /** What closing the gap would actually take, in numbers the athlete can act on. */
  requirement: string;
}

export interface PacingCommon {
  available: true;
  goalId: string;
  goalLabel: string;
  discipline: PacingDiscipline;
  /** The YYYY-MM-DD this plan was derived for. Plans re-derive; they are not stored. */
  derivedFor: string;
  basis: PacingBasis;
  basisReason: string;
  stretchTolerancePct: number;
  planSeconds: number;
  planFormatted: string;
  finish: FinishEstimate;
  bailOut: BailOut;
  confidence: Confidence;
  /** Every input still a guess, with its provenance. Empty only when everything is measured. */
  seeds: SeedInput[];
  /** One sentence about how much of this plan is measured — shown above the splits. */
  seedWarning: string | null;
  calibrationMultiplier: number;
  goalComparison: GoalComparison | null;
  /** Every rule that fired, in order, in the athlete's words. */
  reasons: string[];
}

export interface RunPacingPlan extends PacingCommon {
  discipline: "run";
  distanceKm: number;
  splitKm: number;
  profile: LegProfile;
  splits: Split[];
  anchor: "marathon_pb" | "threshold_pace";
}

export interface SwimZoneTarget {
  zone: SplitZone;
  fromKm: number;
  toKm: number;
  secPer100m: number;
  paceFormatted: string;
  note: string;
}

export interface BikeZoneTarget {
  zone: SplitZone;
  fromKm: number;
  toKm: number;
  targetWatts: number;
  note: string;
}

export type TriathlonFormat = keyof typeof TRIATHLON_DISTANCES;

export interface TriathlonPacingPlan extends PacingCommon {
  discipline: "triathlon";
  format: TriathlonFormat;
  distances: TriathlonDistances;
  swim: { seconds: number; formatted: string; secPer100m: number; paceFormatted: string; profile: LegProfile; zones: SwimZoneTarget[]; note: string };
  t1: { seconds: number; formatted: string; note: string };
  bike: {
    seconds: number;
    formatted: string;
    targetWatts: number;
    ceilingWatts: number;
    ftpFraction: number;
    speedKmh: number;
    profile: LegProfile;
    zones: BikeZoneTarget[];
    note: string;
  };
  t2: { seconds: number; formatted: string; note: string };
  run: { seconds: number; formatted: string; splitKm: number; profile: LegProfile; splits: Split[]; brickNote: string };
  /** 1 when the plan is built to the prediction; otherwise how much each leg was scaled to hit the target. */
  legScale: number;
}

export interface HyroxSegmentRow {
  index: number;
  kind: "run" | "station";
  label: string;
  stationId?: StationId;
  seconds: number;
  formatted: string;
  transitionSeconds: number;
  cumulativeSeconds: number;
  cumulativeFormatted: string;
  benchmarkSeconds?: number;
  degradationPct?: number;
  precededBy?: StationId | null;
  note: string;
}

export interface HyroxPacingPlan extends PacingCommon {
  discipline: "hyrox";
  segments: HyroxSegmentRow[];
  roxzone: { totalSeconds: number; perTransitionSeconds: number; crossings: number; note: string };
  avgRunSecPerKm: number;
  avgRunPaceFormatted: string;
  limiters: Limiter[];
}

export type PacingPlan = RunPacingPlan | TriathlonPacingPlan | HyroxPacingPlan;

export interface PacingUnavailable {
  available: false;
  goalId: string;
  goalLabel: string;
  reason: PacingUnavailableReason;
  /** Athlete-facing, and never contains a field name, a goal type or any other id. */
  message: string;
  fix?: { field: keyof GoalTargetMetrics | "discipline" };
}

export type PacingResult = PacingPlan | PacingUnavailable;

export interface PacingOptions {
  /** The day the plan is derived for. Defaults to today — this module reads no clock of its own. */
  today?: string;
  /**
   * Force the basis instead of letting the stretch-tolerance rule decide.
   *
   * A caller's option, NOT something the reason strings may advertise: the
   * predicted-basis sentence used to end "You can override this and plan to
   * the target anyway" while no screen could request it, sending the athlete
   * hunting for a button nobody had wired up. Anything here becomes a promise
   * only once something the athlete can press sends it.
   */
  basis?: PacingBasis;
  /** An ephemeral "what if I went for X" — never persisted, never written to the goal. */
  targetSecondsOverride?: number | null;
}

/**
 * `triathlonFormat` is not yet a field on `GoalTargetMetrics` (that edit lives
 * with whoever owns `shared/goal.ts`). Reading it through this widened type
 * means the moment it exists the plan picks it up, and until then the format
 * is inferred from the stated distance — never guessed at silently: an
 * unrecognised distance returns "the race format is missing" instead.
 */
type PacingTargetMetrics = GoalTargetMetrics & { triathlonFormat?: TriathlonFormat };

// ─── Formatting ──────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "3:31:10" for an hour or more, "48:12" below it. Always the same shape for the same duration. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatPace(secPerKm: number): string {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${pad(s % 60)}/km`;
}

function formatPer100m(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${pad(s % 60)}/100 m`;
}

function formatKm(km: number): string {
  const rounded = Math.round(km * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ─── Seeds: which of this plan's inputs are still guesses ────────────────────

/**
 * Athlete-facing words for every athlete input a predictor can name. Typed as
 * a total record on purpose: a new field on `AthleteParams` fails `tsc` here
 * until someone writes what it is called in English, which is the same rule
 * every enum in this codebase follows.
 */
export const SEED_FIELD_LABELS: Record<Exclude<keyof AthleteParams, "benchmarks">, string> = {
  ftpWatts: "your cycling threshold power",
  bikeCdA: "how aerodynamic you are on the bike",
  cssSecPer100m: "your swim threshold pace",
  runThresholdSecPerKm: "your all-out kilometre",
  runEasySecPerKm: "your easy running pace",
  run5kSecPerKm: "your 5 km pace",
  lthrBpm: "your threshold heart rate",
  maxHrBpm: "your maximum heart rate",
  weightKg: "your body weight",
  heightCm: "your height",
  ageYears: "your age",
  marathonPbMinutes: "your marathon personal best",
  strengthEnduranceIndex: "how well your running survives a heavy station",
  squat1RmKg: "your best squat",
  deadlift1RmKg: "your best deadlift",
  bench1RmKg: "your best bench press",
  ohp1RmKg: "your best overhead press",
  bodyFatPercent: "your body-fat percentage",
};

const ROXZONE_LABEL = "how long your transitions take";

function measuredForField(a: AthleteParams, field: string): { label: string; m: Measured<number> } | null {
  if (field === "roxzoneSeconds") {
    return { label: ROXZONE_LABEL, m: a.benchmarks.roxzone ?? seeded(DEFAULT_ROXZONE_SECONDS) };
  }
  if (field.startsWith("benchmark_")) {
    const id = field.slice("benchmark_".length) as StationId;
    const spec = STATION_BY_ID[id];
    if (!spec) return null;
    return { label: `your ${spec.name} time`, m: a.benchmarks[id] ?? seeded(DEFAULT_STATION_BENCHMARKS[id]) };
  }
  const label = SEED_FIELD_LABELS[field as Exclude<keyof AthleteParams, "benchmarks">];
  if (!label) return null;
  const m = a[field as Exclude<keyof AthleteParams, "benchmarks">];
  return { label, m };
}

/**
 * Turn the predictor's `Confidence` into rows an athlete can read. The source
 * string is taken from the athlete's own `Measured` only when that value is
 * itself unverified — if the stored value is measured but the predictor still
 * reported the field as a guess, the predictor used its own default, and
 * saying otherwise would credit a measurement the plan did not use.
 */
export function seedsFrom(confidence: Confidence, a: AthleteParams): SeedInput[] {
  const out: SeedInput[] = [];
  for (const field of confidence.unverifiedFields) {
    const found = measuredForField(a, field);
    if (!found) continue;
    out.push({
      field,
      label: found.label,
      source: found.m.verified ? "not measured for this plan" : found.m.source,
    });
  }
  return out;
}

function seedWarningFor(seeds: SeedInput[], confidence: Confidence): string | null {
  if (seeds.length === 0) return null;
  const names = seeds.map((s) => s.label);
  const listed = names.length <= 3 ? joinList(names) : `${joinList(names.slice(0, 3))} and ${names.length - 3} more`;
  const total = confidence.totalCount;
  return `${seeds.length} of the ${total} numbers this plan is built on ${seeds.length === 1 ? "is" : "are"} still an estimate — ${listed}. The splits below are as precise as the inputs, no more. Measure what you can before race day and the plan sharpens with it.`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ─── The one basis rule ──────────────────────────────────────────────────────

export interface BasisDecision {
  basis: PacingBasis;
  reason: string;
  tolerancePct: number;
  gapPct: number;
  planSeconds: number;
}

/**
 * Plan to the athlete's stated target unless it sits further ahead of the
 * prediction than the tolerance allows — 3% when every input is measured,
 * about 8% when they are all seeds. The widening is the point: a prediction
 * built on guesses has less standing to overrule a target the athlete chose.
 */
export function chooseBasis(
  targetSeconds: number | null,
  predictedSeconds: number,
  confidence: Confidence,
  calibrationMultiplier: number,
  forced?: PacingBasis,
): BasisDecision {
  const tolerancePct = widenForConfidence(STRETCH_TOLERANCE_BASE_PCT, confidence, calibrationMultiplier);
  if (targetSeconds == null) {
    return {
      basis: "predicted",
      reason: "You haven't set a time for this race, so the plan is built to what your numbers say today.",
      tolerancePct,
      gapPct: 0,
      planSeconds: predictedSeconds,
    };
  }
  const gapPct = Math.round(((predictedSeconds - targetSeconds) / predictedSeconds) * 1000) / 10;

  if (forced === "target" || (forced == null && gapPct <= tolerancePct)) {
    // Three genuinely different situations, and telling the athlete the wrong
    // one reads as a bug: the target can sit behind the prediction, on it, or
    // ahead of it but within reach.
    const reason =
      Math.abs(predictedSeconds - targetSeconds) < 1
        ? `Your target of ${formatClock(targetSeconds)} is exactly what your numbers say today, so the plan is built to it.`
        : gapPct < 0
          ? `Your target of ${formatClock(targetSeconds)} is ${formatClock(targetSeconds - predictedSeconds)} inside what your numbers already say (${formatClock(
              predictedSeconds,
            )}), so the plan is built to your target.`
          : `Your target of ${formatClock(targetSeconds)} is ${gapPct}% ahead of the predicted ${formatClock(
              predictedSeconds,
            )}, which is inside the ${tolerancePct}% that your measurements support stretching. The plan is built to your target.`;
    return { basis: "target", reason, tolerancePct, gapPct, planSeconds: targetSeconds };
  }

  const measuredNote = confidence.totalCount > 0 ? ` (${confidence.unverifiedFields.length} of ${confidence.totalCount} inputs are still estimates)` : "";
  return {
    basis: "predicted",
    reason: `Your target of ${formatClock(targetSeconds)} is ${gapPct}% ahead of the predicted ${formatClock(
      predictedSeconds,
    )}, and the most your numbers support stretching is ${tolerancePct}%${measuredNote} — so the plan is built to the prediction. Going out at target pace is the most common way to lose ten minutes in the last quarter.`,
    tolerancePct,
    gapPct,
    planSeconds: predictedSeconds,
  };
}

function finishEstimateFor(
  discipline: PacingDiscipline,
  predictedSeconds: number,
  targetSeconds: number | null,
  confidence: Confidence,
  calibrationMultiplier: number,
  probability: { point: number; low: number; high: number } | null,
): FinishEstimate {
  const bandPerMille = widenForConfidence(FINISH_BAND_PER_MILLE[discipline], confidence, calibrationMultiplier);
  const low = Math.round(predictedSeconds * (1 - bandPerMille / 1000));
  const high = Math.round(predictedSeconds * (1 + bandPerMille / 1000));
  return {
    predictedSeconds: Math.round(predictedSeconds),
    predictedFormatted: formatClock(predictedSeconds),
    lowSeconds: low,
    highSeconds: high,
    lowFormatted: formatClock(low),
    highFormatted: formatClock(high),
    bandPerMille,
    targetSeconds,
    targetFormatted: targetSeconds == null ? null : formatClock(targetSeconds),
    goalProbability: probability?.point ?? null,
    goalProbabilityLow: probability?.low ?? null,
    goalProbabilityHigh: probability?.high ?? null,
  };
}

// ─── Splits ──────────────────────────────────────────────────────────────────

/**
 * Turn a leg total into splits under a profile. The cumulative column is what
 * is rounded, so the last row's cumulative equals the plan time EXACTLY (the
 * profile's weighted factor is 1 by construction, checked in the tests) and
 * no rounding error accumulates down the card. A split straddling a zone
 * boundary — 4.22 km on a marathon's first 10% — is priced across both zones,
 * not at whichever zone its midpoint fell in.
 */
export function buildSplits(totalSeconds: number, distanceKm: number, splitKm: number, profile: LegProfile): Split[] {
  const planSeconds = Math.round(totalSeconds);
  const splits: Split[] = [];
  let prevCum = 0;
  let from = 0;
  let guard = 0;
  while (from < distanceKm - 1e-9 && guard++ < 1000) {
    const to = Math.min(from + splitKm, distanceKm);
    const cumulativeSeconds = Math.round(planSeconds * integrateFactor(profile, 0, to / distanceKm));
    const seconds = cumulativeSeconds - prevCum;
    const zone = zoneAt(profile, (from + to) / 2 / distanceKm);
    splits.push({
      label: `${formatKm(from)}–${formatKm(to)} km`,
      fromKm: Math.round(from * 1000) / 1000,
      toKm: Math.round(to * 1000) / 1000,
      paceSecPerKm: Math.round(seconds / (to - from)),
      paceFormatted: formatPace(seconds / (to - from)),
      seconds,
      cumulativeSeconds,
      cumulativeFormatted: formatClock(cumulativeSeconds),
      zone,
      note: zoneNote(profile, zone),
    });
    prevCum = cumulativeSeconds;
    from = to;
  }
  return splits;
}

/**
 * What to hold if it goes wrong: one pace, one decision point, one number to
 * be behind by. A race plan with no bail-out is a plan that silently assumes
 * the day goes well, and the athlete improvises the worst decision of the
 * race under the most fatigue.
 */
function bailOutFor(
  splits: Split[],
  distanceKm: number,
  legSeconds: number,
  legLabel: string,
  /**
   * Everything already on the clock when this leg starts — 0 for a race that
   * IS the leg, swim + T1 + bike + T2 for a triathlon's run. Without it the
   * checkpoint and the finish are leg-relative numbers in a race-relative
   * sentence, which is what shipped.
   */
  elapsedBeforeLegSeconds = 0,
): BailOut {
  const meanPace = legSeconds / distanceKm;
  const paceSecPerKm = Math.round(meanPace * (1 + BAIL_OUT_SLOWDOWN));
  const boundaries = splits.slice(0, -1).map((s) => s.toKm);
  const half = distanceKm / 2;
  const decisionAtKm = boundaries.length > 0 ? boundaries.reduce((best, km) => (Math.abs(km - half) < Math.abs(best - half) ? km : best), boundaries[0]) : half;
  const atDecision = splits.find((s) => Math.abs(s.toKm - decisionAtKm) < 1e-9);
  const legCumulativeAtDecision = atDecision ? atDecision.cumulativeSeconds : Math.round(legSeconds / 2);
  const elapsedAtDecisionSeconds = Math.round(elapsedBeforeLegSeconds + legCumulativeAtDecision);
  // "Behind" is the same share of the same race in every discipline. Taking
  // it off the LEG instead made a triathlon's band a third of a marathon's,
  // firing the bail-out on a minute of drift across five hours.
  const behindBySeconds = Math.round((elapsedBeforeLegSeconds + legSeconds) * BAIL_OUT_TRIGGER_FRACTION);
  const finishSeconds = Math.round(elapsedAtDecisionSeconds + behindBySeconds + (distanceKm - decisionAtKm) * paceSecPerKm);
  return {
    paceSecPerKm,
    paceFormatted: formatPace(paceSecPerKm),
    decisionAtKm: Math.round(decisionAtKm * 1000) / 1000,
    elapsedAtDecisionSeconds,
    elapsedAtDecisionFormatted: formatClock(elapsedAtDecisionSeconds),
    behindBySeconds,
    finishSeconds,
    finishFormatted: formatClock(finishSeconds),
    trigger: `At ${formatKm(decisionAtKm)} km${legLabel}: if you are more than ${formatClock(behindBySeconds)} behind ${formatClock(
      elapsedAtDecisionSeconds,
    )} on the clock, stop chasing it and settle into ${formatPace(paceSecPerKm)} for the rest. That still brings you home in ${formatClock(
      finishSeconds,
    )}, which is a race you finish rather than a race you walk.`,
  };
}

// ─── Goal comparison ─────────────────────────────────────────────────────────

function goalComparisonFor(
  targetSeconds: number | null,
  predictedSeconds: number,
  decision: BasisDecision,
  requirement: (deltaSeconds: number) => string,
): GoalComparison | null {
  if (targetSeconds == null) return null;
  const deltaSeconds = Math.round(predictedSeconds - targetSeconds);
  const targetIsAhead = deltaSeconds > 0;
  return {
    targetSeconds: Math.round(targetSeconds),
    targetFormatted: formatClock(targetSeconds),
    predictedSeconds: Math.round(predictedSeconds),
    predictedFormatted: formatClock(predictedSeconds),
    deltaSeconds,
    deltaFormatted: formatClock(Math.abs(deltaSeconds)),
    targetIsAhead,
    gapPercent: decision.gapPct,
    tolerancePercent: decision.tolerancePct,
    withinTolerance: decision.gapPct <= decision.tolerancePct,
    requirement: targetIsAhead
      ? requirement(deltaSeconds)
      : deltaSeconds === 0
        ? `Your target and what your numbers say are the same time today — ${formatClock(
            targetSeconds,
          )}. Nothing has to change for this to happen; it just has to be executed, which is what the splits below are for.`
        : `Your numbers already have you ${formatClock(Math.abs(deltaSeconds))} inside ${formatClock(
            targetSeconds,
          )} today. The plan is built to your time rather than to the faster prediction — bank the margin instead of spending it in the first hour.`,
  };
}

/** The predictor only fills these when it was given a goal time. */
function probabilityOf(p: { goalProbability?: number; goalProbabilityLow?: number; goalProbabilityHigh?: number }): { point: number; low: number; high: number } | null {
  if (p.goalProbability == null || p.goalProbabilityLow == null || p.goalProbabilityHigh == null) return null;
  return { point: p.goalProbability, low: p.goalProbabilityLow, high: p.goalProbabilityHigh };
}

// ─── Running race ────────────────────────────────────────────────────────────

function targetSecondsFor(goal: Goal, options: PacingOptions): number | null {
  if (options.targetSecondsOverride !== undefined && options.targetSecondsOverride !== null) return options.targetSecondsOverride;
  if (options.targetSecondsOverride === null) return null;
  const t = goal.targetMetrics.targetTimeSeconds;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
}

function planRunRace(goal: Goal, a: AthleteParams, calibrationMultiplier: number, options: PacingOptions): PacingResult {
  const distanceKm = goal.targetMetrics.targetDistanceKm;
  if (typeof distanceKm !== "number" || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return {
      available: false,
      goalId: goal.id,
      goalLabel: goal.label,
      reason: "missing_target_distance",
      message: `Add the race distance to ${goal.label} and you'll get a full pacing plan. A plan built on a guessed distance is worse than no plan, so this one waits for the real number.`,
      fix: { field: "targetDistanceKm" },
    };
  }

  const targetSeconds = targetSecondsFor(goal, options);
  const prediction = predictRunRace(a, distanceKm, targetSeconds == null ? undefined : targetSeconds / 60, calibrationMultiplier);
  const predictedSeconds = prediction.predictedTimeMinutes * 60;
  const decision = chooseBasis(targetSeconds, predictedSeconds, prediction.confidence, calibrationMultiplier, options.basis);

  // A stretch target already asks for everything the athlete has; laying a
  // slow first tenth on top of it asks them to make the gap up later, which
  // is the opposite of what the profile is for.
  const stretching = decision.basis === "target" && targetSeconds != null && targetSeconds < predictedSeconds;
  const profile = stretching ? EVEN_PROFILE : profileFor("run", "run");

  const splitKm = splitKmFor(distanceKm);
  const splits = buildSplits(decision.planSeconds, distanceKm, splitKm, profile);
  const bailOut = bailOutFor(splits, distanceKm, decision.planSeconds, "");
  const seeds = seedsFrom(prediction.confidence, a);

  const reasons = [decision.reason, profile.rationale];
  if (stretching) reasons.push("Because you're already reaching for this time, the plan is flat rather than a negative split — there is no spare tenth to give away at the start.");
  const seedWarning = seedWarningFor(seeds, prediction.confidence);
  if (seedWarning) reasons.push(seedWarning);

  const comparison = goalComparisonFor(targetSeconds, predictedSeconds, decision, (delta) => {
    const perKm = delta / distanceKm;
    return `Your target is ${formatClock(delta)} faster than today's prediction — ${Math.round(perKm)} seconds per kilometre, held for the whole ${formatKm(
      distanceKm,
    )} km. That is ${formatPace(targetSeconds! / distanceKm)} instead of ${formatPace(predictedSeconds / distanceKm)}.`;
  });

  return {
    available: true,
    goalId: goal.id,
    goalLabel: goal.label,
    discipline: "run",
    derivedFor: options.today ?? todayISO(),
    basis: decision.basis,
    basisReason: decision.reason,
    stretchTolerancePct: decision.tolerancePct,
    planSeconds: Math.round(decision.planSeconds),
    planFormatted: formatClock(decision.planSeconds),
    finish: finishEstimateFor("run", predictedSeconds, targetSeconds, prediction.confidence, calibrationMultiplier, probabilityOf(prediction)),
    bailOut,
    confidence: prediction.confidence,
    seeds,
    seedWarning,
    calibrationMultiplier,
    goalComparison: comparison,
    reasons,
    distanceKm,
    splitKm,
    profile,
    splits,
    anchor: prediction.anchor,
  } satisfies RunPacingPlan;
}

// ─── Triathlon ───────────────────────────────────────────────────────────────

const TRIATHLON_FORMAT_LABELS: Record<TriathlonFormat, string> = {
  sprint: "sprint",
  olympic: "Olympic",
  "70.3": "half (70.3)",
  full: "full (140.6)",
};

function formatFromDistance(totalKm: number | undefined): TriathlonFormat | null {
  if (typeof totalKm !== "number" || !Number.isFinite(totalKm) || totalKm <= 0) return null;
  for (const key of Object.keys(TRIATHLON_DISTANCES) as TriathlonFormat[]) {
    const d = TRIATHLON_DISTANCES[key];
    const sum = d.swimKm + d.bikeKm + d.runKm;
    if (Math.abs(totalKm - sum) / sum <= 0.05) return key;
  }
  return null;
}

/**
 * Solve for the race power that delivers a given bike time by bisecting the
 * PREDICTOR, not by re-deriving the power-balance equation here. The probe
 * athlete is a fresh object each iteration — the stored `Measured` is never
 * touched, and the solved number never gets written back as if it had been
 * measured.
 */
function solveRaceWatts(a: AthleteParams, distances: TriathlonDistances, targetBikeSeconds: number): number {
  let lo = a.ftpWatts.value * 0.4;
  let hi = a.ftpWatts.value * 2.5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const probe: AthleteParams = { ...a, ftpWatts: { ...a.ftpWatts, value: mid } };
    const seconds = predictTriathlon(probe, distances).bikeTimeMinutes * 60;
    if (seconds > targetBikeSeconds) lo = mid;
    else hi = mid;
  }
  return calcBikeRacePower((lo + hi) / 2);
}

function planTriathlon(goal: Goal, a: AthleteParams, calibrationMultiplier: number, options: PacingOptions): PacingResult {
  const metrics = goal.targetMetrics as PacingTargetMetrics;
  const format = metrics.triathlonFormat ?? formatFromDistance(metrics.targetDistanceKm);
  if (!format || !TRIATHLON_DISTANCES[format]) {
    return {
      available: false,
      goalId: goal.id,
      goalLabel: goal.label,
      reason: "missing_triathlon_format",
      message: `Tell us which race ${goal.label} is — sprint, Olympic, half or full — and you'll get swim, bike and run targets for it. The three legs are too different to guess at.`,
      fix: { field: "targetDistanceKm" },
    };
  }

  const distances = TRIATHLON_DISTANCES[format];
  const targetSeconds = targetSecondsFor(goal, options);
  const prediction = predictTriathlon(a, distances, targetSeconds == null ? undefined : targetSeconds / 60, calibrationMultiplier);
  const predictedSeconds = prediction.totalTimeMinutes * 60;
  const decision = chooseBasis(targetSeconds, predictedSeconds, prediction.confidence, calibrationMultiplier, options.basis);

  // Transitions are not a fitness lever — scaling them to hit a target would
  // just be inventing seconds in the one place the athlete cannot train for.
  const t1 = Math.round(prediction.t1Minutes * 60);
  const t2 = Math.round(prediction.t2Minutes * 60);
  const predSwim = prediction.swimTimeMinutes * 60;
  const predBike = prediction.bikeTimeMinutes * 60;
  const predRun = prediction.runTimeMinutes * 60;
  const movingPredicted = predSwim + predBike + predRun;
  const movingPlanned = decision.planSeconds - t1 - t2;
  const legScale = decision.basis === "target" && movingPredicted > 0 ? movingPlanned / movingPredicted : 1;

  const swimSeconds = Math.round(predSwim * legScale);
  const bikeSeconds = Math.round(predBike * legScale);
  // The run absorbs rounding so the legs sum to the plan exactly.
  const runSeconds = Math.round(decision.planSeconds) - t1 - t2 - swimSeconds - bikeSeconds;

  const swimProfile = profileFor("triathlon", "swim");
  const bikeProfile = profileFor("triathlon", "bike");
  const runProfile = profileFor("triathlon", "run");

  const swimMeanPer100m = swimSeconds / (distances.swimKm * 10);
  const swimZones: SwimZoneTarget[] = zoneSlices(swimProfile).map((z) => ({
    zone: z.zone,
    fromKm: Math.round(z.from * distances.swimKm * 1000) / 1000,
    toKm: Math.round(z.to * distances.swimKm * 1000) / 1000,
    secPer100m: Math.round(swimMeanPer100m * z.factor),
    paceFormatted: formatPer100m(swimMeanPer100m * z.factor),
    note: zoneNote(swimProfile, z.zone),
  }));

  const targetWatts = legScale === 1 ? calcBikeRacePower(a.ftpWatts.value) : solveRaceWatts(a, distances, bikeSeconds);
  const ceilingWatts = Math.round(a.ftpWatts.value * BIKE_SURGE_CEILING_FRACTION);
  const bikeZones: BikeZoneTarget[] = zoneSlices(bikeProfile).map((z) => ({
    zone: z.zone,
    fromKm: Math.round(z.from * distances.bikeKm * 10) / 10,
    toKm: Math.round(z.to * distances.bikeKm * 10) / 10,
    targetWatts: Math.round(targetWatts * z.factor),
    note: zoneNote(bikeProfile, z.zone),
  }));

  const runSplitKm = splitKmFor(distances.runKm);
  const runSplits = buildSplits(runSeconds, distances.runKm, runSplitKm, runProfile);
  // The run leg does not start the clock again: the decision point and the
  // finish are both elapsed from the gun, so the checkpoint is the number the
  // athlete's watch will actually be showing when they have to make the call.
  const bailOut = bailOutFor(runSplits, distances.runKm, runSeconds, " into the run", swimSeconds + t1 + bikeSeconds + t2);
  const seeds = seedsFrom(prediction.confidence, a);
  const seedWarning = seedWarningFor(seeds, prediction.confidence);

  const reasons = [decision.reason, swimProfile.rationale, bikeProfile.rationale, runProfile.rationale];
  reasons.push(
    `${targetWatts} watts is ${Math.round((targetWatts / a.ftpWatts.value) * 100)}% of your threshold power. Long-course race power sits around ${Math.round(
      BIKE_RACE_POWER_FRACTION * 100,
    )}% of threshold — that is where this number comes from, and it is the same number the race prediction was built on.`,
  );
  if (targetWatts > ceilingWatts) {
    reasons.push(
      `Hitting this time needs ${targetWatts} watts on the bike, which is above the ${ceilingWatts} watts you should be treating as a hard ceiling. That is the clearest sign this target is being bought on the bike and paid for on the run.`,
    );
  }
  if (seedWarning) reasons.push(seedWarning);

  const comparison = goalComparisonFor(targetSeconds, predictedSeconds, decision, (delta) => {
    const swimShare = Math.round((delta * predSwim) / movingPredicted);
    const bikeShare = Math.round((delta * predBike) / movingPredicted);
    const runShare = delta - swimShare - bikeShare;
    return `Your target is ${formatClock(delta)} faster than today's prediction. Spread across the legs in proportion that is ${formatClock(
      swimShare,
    )} in the water, ${formatClock(bikeShare)} on the bike and ${formatClock(
      runShare,
    )} on the run. The bike is the only one of the three where that much time is genuinely available — and taking it there is also the fastest way to lose twice as much on the run.`;
  });

  return {
    available: true,
    goalId: goal.id,
    goalLabel: goal.label,
    discipline: "triathlon",
    derivedFor: options.today ?? todayISO(),
    basis: decision.basis,
    basisReason: decision.reason,
    stretchTolerancePct: decision.tolerancePct,
    planSeconds: Math.round(decision.planSeconds),
    planFormatted: formatClock(decision.planSeconds),
    finish: finishEstimateFor("triathlon", predictedSeconds, targetSeconds, prediction.confidence, calibrationMultiplier, probabilityOf(prediction)),
    bailOut,
    confidence: prediction.confidence,
    seeds,
    seedWarning,
    calibrationMultiplier,
    goalComparison: comparison,
    reasons,
    format,
    distances,
    swim: {
      seconds: swimSeconds,
      formatted: formatClock(swimSeconds),
      secPer100m: Math.round(swimMeanPer100m),
      paceFormatted: formatPer100m(swimMeanPer100m),
      profile: swimProfile,
      zones: swimZones,
      note: `${formatPer100m(swimMeanPer100m)} average for the ${formatKm(distances.swimKm)} km, which already includes sighting and open water — it is slower than the same effort in a pool lane, and that is expected, not a bad day.`,
    },
    t1: { seconds: t1, formatted: formatClock(t1), note: "Wetsuit off while you are still walking, helmet on before you touch the bike. Practise it twice and this is free time." },
    bike: {
      seconds: bikeSeconds,
      formatted: formatClock(bikeSeconds),
      targetWatts,
      ceilingWatts,
      ftpFraction: Math.round((targetWatts / a.ftpWatts.value) * 100) / 100,
      speedKmh: Math.round((distances.bikeKm / (bikeSeconds / 3600)) * 10) / 10,
      profile: bikeProfile,
      zones: bikeZones,
      note: `${targetWatts} watts average, ${ceilingWatts} watts as a hard ceiling on the climbs. Every minute you take off this leg by riding above the ceiling, you give back with interest in the ${TRIATHLON_FORMAT_LABELS[format]} run.`,
    },
    t2: { seconds: t2, formatted: formatClock(t2), note: "Shoes, number, go. The first kilometre will feel wrong whatever you do here." },
    run: {
      seconds: runSeconds,
      formatted: formatClock(runSeconds),
      splitKm: runSplitKm,
      profile: runProfile,
      splits: runSplits,
      brickNote: `These splits already carry the cost of everything in front of them — they are slower than the same distance run fresh, on purpose. If the first kilometre feels easy at this pace, that is the plan working.`,
    },
    legScale: Math.round(legScale * 1000) / 1000,
  } satisfies TriathlonPacingPlan;
}

// ─── HYROX ───────────────────────────────────────────────────────────────────

/**
 * `predictHyrox` still requires a goal time, and the splits do not depend on
 * it — only `goalProbability` does. When the athlete has not set one, we pass
 * this and drop the probability rather than showing a number derived from a
 * time nobody chose. (Whoever makes that parameter optional can delete this.)
 */
const HYROX_NO_TARGET_PLACEHOLDER_SECONDS = 3600;

function planHyrox(goal: Goal, a: AthleteParams, calibrationMultiplier: number, options: PacingOptions): PacingResult {
  const targetSeconds = targetSecondsFor(goal, options);
  const prediction = predictHyrox(a, targetSeconds ?? HYROX_NO_TARGET_PLACEHOLDER_SECONDS, undefined, calibrationMultiplier);
  const predictedSeconds = prediction.totalSeconds;

  // Basis is always the prediction here, and the reason is not a technicality.
  const decision: BasisDecision = {
    basis: "predicted",
    reason:
      "This plan is built to what your numbers say rather than to a target time. Stations do not pace — you either have the sled or you do not — and every run split below already carries the cost of the station in front of it. Chasing a target by running the early kilometres faster only moves time from the runs you can still control to the ones you cannot.",
    tolerancePct: widenForConfidence(STRETCH_TOLERANCE_BASE_PCT, prediction.confidence, calibrationMultiplier),
    gapPct: targetSeconds == null ? 0 : Math.round(((predictedSeconds - targetSeconds) / predictedSeconds) * 1000) / 10,
    planSeconds: predictedSeconds,
  };

  const perTransitionCumulative = (i: number) => Math.round((prediction.roxzoneSeconds * i) / HYROX_ROXZONE_CROSSINGS);
  const segments: HyroxSegmentRow[] = [];
  let runCursor = 0;
  let stationCursor = 0;
  let cumulative = 0;
  let transitionsTaken = 0;
  const totalSegments = RACE_SEQUENCE.length;

  RACE_SEQUENCE.forEach((seg, i) => {
    const isLast = i === totalSegments - 1;
    let row: HyroxSegmentRow;
    if (seg.kind === "run") {
      const split = prediction.runSplits[runCursor++];
      const before = split.precededBy ? STATION_BY_ID[split.precededBy].name : null;
      row = {
        index: i + 1,
        kind: "run",
        label: seg.label,
        seconds: split.seconds,
        formatted: formatClock(split.seconds),
        transitionSeconds: 0,
        cumulativeSeconds: 0,
        cumulativeFormatted: "",
        precededBy: split.precededBy,
        note: before
          ? `${formatPace(split.seconds)} — slower than your fresh kilometre because you are coming off ${before}, and that cost is already in this number. Run it, do not race it back.`
          : `${formatPace(split.seconds)} — the only kilometre you run fresh all day, which is exactly why it is the easiest one to ruin the race with.`,
      };
    } else {
      const split = prediction.stationSplits[stationCursor++];
      const spec = STATION_BY_ID[split.stationId];
      const degradationPct = Math.round((split.seconds / split.benchmarkSeconds - 1) * 100);
      row = {
        index: i + 1,
        kind: "station",
        label: spec.name,
        stationId: split.stationId,
        seconds: split.seconds,
        formatted: formatClock(split.seconds),
        transitionSeconds: 0,
        cumulativeSeconds: 0,
        cumulativeFormatted: "",
        benchmarkSeconds: split.benchmarkSeconds,
        degradationPct,
        note: `${formatClock(split.seconds)} — about ${degradationPct}% off your fresh time for it, which is what this far into the race costs. Break it before it breaks you, not after.`,
      };
    }
    cumulative += row.seconds;
    if (!isLast) {
      const prev = perTransitionCumulative(transitionsTaken);
      transitionsTaken += 1;
      row.transitionSeconds = perTransitionCumulative(transitionsTaken) - prev;
      cumulative += row.transitionSeconds;
    }
    row.cumulativeSeconds = cumulative;
    row.cumulativeFormatted = formatClock(cumulative);
    segments.push(row);
  });

  // Bail-out for HYROX is a run-pace ceiling, decided after Run 4 — halfway by
  // runs, and the last point where easing still changes the second half.
  const afterRun4 = segments.filter((s) => s.kind === "run")[3];
  const decisionCumulative = afterRun4 ? afterRun4.cumulativeSeconds : Math.round(predictedSeconds / 2);
  const behindBySeconds = Math.round(predictedSeconds * BAIL_OUT_TRIGGER_FRACTION);
  const remainingRunSeconds = prediction.runSplits.slice(4).reduce((s, r) => s + r.seconds, 0);
  const remainingOther = predictedSeconds - decisionCumulative - remainingRunSeconds;
  const bailPace = Math.round(prediction.avgRunSecPerKm * (1 + BAIL_OUT_SLOWDOWN));
  const bailFinish = Math.round(decisionCumulative + behindBySeconds + remainingRunSeconds * (1 + BAIL_OUT_SLOWDOWN) + remainingOther);
  const bailOut: BailOut = {
    paceSecPerKm: bailPace,
    paceFormatted: formatPace(bailPace),
    decisionAtKm: 4,
    elapsedAtDecisionSeconds: decisionCumulative,
    elapsedAtDecisionFormatted: formatClock(decisionCumulative),
    behindBySeconds,
    finishSeconds: bailFinish,
    finishFormatted: formatClock(bailFinish),
    trigger: `Leaving the fourth run: if you are more than ${formatClock(behindBySeconds)} behind ${formatClock(
      decisionCumulative,
    )}, put a ceiling of ${formatPace(bailPace)} on every remaining run and spend nothing on them. That finishes in ${formatClock(
      bailFinish,
    )} with the sled and the wall balls still doable, which is the trade worth making.`,
  };

  const seeds = seedsFrom(prediction.confidence, a);
  const seedWarning = seedWarningFor(seeds, prediction.confidence);
  const reasons = [decision.reason, profileFor("hyrox", "run").rationale];
  if (seedWarning) reasons.push(seedWarning);

  const comparison = goalComparisonFor(targetSeconds, predictedSeconds, decision, (delta) => {
    const perStation = Math.round(delta / 8);
    return `Your target is ${formatClock(delta)} faster than today's prediction. Spread evenly that is about ${formatClock(
      perStation,
    )} off every station — which is not how it comes: it comes from the two stations that degrade the most and from the transitions, both of which are listed above.`;
  });

  return {
    available: true,
    goalId: goal.id,
    goalLabel: goal.label,
    discipline: "hyrox",
    derivedFor: options.today ?? todayISO(),
    basis: "predicted",
    basisReason: decision.reason,
    stretchTolerancePct: decision.tolerancePct,
    planSeconds: predictedSeconds,
    planFormatted: formatClock(predictedSeconds),
    finish: finishEstimateFor(
      "hyrox",
      predictedSeconds,
      targetSeconds,
      prediction.confidence,
      calibrationMultiplier,
      targetSeconds == null ? null : { point: prediction.goalProbability, low: prediction.goalProbabilityLow, high: prediction.goalProbabilityHigh },
    ),
    bailOut,
    confidence: prediction.confidence,
    seeds,
    seedWarning,
    calibrationMultiplier,
    goalComparison: comparison,
    reasons,
    segments,
    roxzone: {
      totalSeconds: prediction.roxzoneSeconds,
      perTransitionSeconds: Math.round(prediction.roxzoneSeconds / HYROX_ROXZONE_CROSSINGS),
      crossings: HYROX_ROXZONE_CROSSINGS,
      note: `${formatClock(prediction.roxzoneSeconds)} of your day is spent between the runs and the stations, across ${HYROX_ROXZONE_CROSSINGS} crossings — about ${Math.round(
        prediction.roxzoneSeconds / HYROX_ROXZONE_CROSSINGS,
      )} seconds each. None of it is fitness, all of it is on the clock, and it is the cheapest time in the race to find.`,
    },
    avgRunSecPerKm: prediction.avgRunSecPerKm,
    avgRunPaceFormatted: formatPace(prediction.avgRunSecPerKm),
    limiters: prediction.limiters,
  } satisfies HyroxPacingPlan;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * The one way to get a pacing plan. Dispatches on the goal's type and
 * discipline; returns a `PacingUnavailable` — never a half-built plan, never a
 * guessed distance — when the goal does not yet say enough to plan from.
 */
export function pacingPlan(goal: Goal, athlete: AthleteParams, calibrationMultiplier = 1, options: PacingOptions = {}): PacingResult {
  const mult = Number.isFinite(calibrationMultiplier) && calibrationMultiplier > 0 ? calibrationMultiplier : 1;

  if (goal.type === "hyrox") return planHyrox(goal, athlete, mult, options);

  if (goal.type === "endurance_race") {
    if (goal.discipline === "run") return planRunRace(goal, athlete, mult, options);
    if (goal.discipline === "triathlon") return planTriathlon(goal, athlete, mult, options);
    return {
      available: false,
      goalId: goal.id,
      goalLabel: goal.label,
      reason: "unsupported_discipline",
      message: `There is no race-day plan for ${goal.label}'s sport yet — running races, triathlons and HYROX are built. We have logged that you wanted one, which is what decides what gets built next.`,
      fix: { field: "discipline" },
    };
  }

  return {
    available: false,
    goalId: goal.id,
    goalLabel: goal.label,
    reason: "unsupported_goal_type",
    message: `${goal.label} isn't a race, so there is no start line to pace. Race-day plans are for running races, triathlons and HYROX.`,
  };
}

/** Which pacing plan a goal would get, or null when it would get none. */
export function pacingDisciplineFor(goal: Goal): PacingDiscipline | null {
  if (goal.type === "hyrox") return "hyrox";
  if (goal.type !== "endurance_race") return null;
  if (goal.discipline === "run") return "run";
  if (goal.discipline === "triathlon") return "triathlon";
  return null;
}
