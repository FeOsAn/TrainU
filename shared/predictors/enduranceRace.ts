/**
 * Endurance-race predictors: a standalone running race (5K–marathon) via
 * Riegel, and a triathlon (swim/bike/run) via the same physics sub5-
 * dashboard used, generalized off a fixed 70.3-shaped race to arbitrary
 * distances (Olympic/70.3/full). Both report a Measured-based confidence
 * band instead of a bare point estimate — the fix for the bike-CdA gap that
 * started this whole exercise (see shared/measured.ts's header): CdA feeds
 * the band now, not just FTP.
 */

import type { AthleteParams } from "../athlete";
import { type Confidence, type Measured, assessConfidence, widenForConfidence } from "../measured";

function formatTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.floor(totalMinutes % 60);
  const s = Math.round((totalMinutes * 60) % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function goalProbabilityPoint(predictedMinutes: number, goalMinutes: number): number {
  // Margin in minutes, mapped through a logistic — same shape sub5-dashboard used.
  // Clamped to [1, 99]: an unclamped 100 or 0 would then sit outside a band
  // built by offsetting a clamped Low/High from it (sub5's own predictor
  // clamps for the same reason — see its calcSub5Probability).
  const margin = goalMinutes - predictedMinutes;
  const raw = Math.round((1 / (1 + Math.exp(-0.024 * (margin * 60 - 2)))) * 100);
  return Math.max(1, Math.min(99, raw));
}

// ─── Standalone running race ─────────────────────────────────────────────────

export interface RunRacePrediction {
  distanceKm: number;
  predictedTimeMinutes: number;
  predictedTimeFormatted: string;
  predictedPaceSecPerKm: number;
  anchor: "marathon_pb" | "threshold_pace";
  goalMinutes?: number;
  goalProbability?: number;
  goalProbabilityLow?: number;
  goalProbabilityHigh?: number;
  confidence: Confidence;
}

const RIEGEL_EXPONENT = 1.06;
const MARATHON_KM = 42.195;
/** A trained runner's threshold pace sits close to their 15 km race pace. */
const THRESHOLD_ANCHOR_KM = 15;

export function predictRunRace(a: AthleteParams, distanceKm: number, goalMinutes?: number): RunRacePrediction {
  const pb = a.marathonPbMinutes;
  const threshold = a.runThresholdSecPerKm;

  // Prefer whichever anchor is actually verified; a raced PB beats a
  // threshold estimate when both are real, since it's evidence at the exact
  // event type this predicts rather than an inferred fitness proxy.
  const useMarathonPb = pb.verified || !threshold.verified;
  const anchor: RunRacePrediction["anchor"] = useMarathonPb ? "marathon_pb" : "threshold_pace";
  const anchorDistanceKm = useMarathonPb ? MARATHON_KM : THRESHOLD_ANCHOR_KM;
  const anchorTimeMinutes = useMarathonPb ? pb.value : (threshold.value * THRESHOLD_ANCHOR_KM) / 60;

  const predictedTimeMinutes = anchorTimeMinutes * Math.pow(distanceKm / anchorDistanceKm, RIEGEL_EXPONENT);
  const predictedPaceSecPerKm = Math.round((predictedTimeMinutes * 60) / distanceKm);

  const inputs: Record<string, Measured<unknown>> = useMarathonPb ? { marathonPbMinutes: pb } : { runThresholdSecPerKm: threshold };
  const confidence = assessConfidence(inputs);

  const result: RunRacePrediction = {
    distanceKm,
    predictedTimeMinutes: Math.round(predictedTimeMinutes * 10) / 10,
    predictedTimeFormatted: formatTime(predictedTimeMinutes),
    predictedPaceSecPerKm,
    anchor,
    confidence,
  };

  if (goalMinutes != null) {
    const point = goalProbabilityPoint(predictedTimeMinutes, goalMinutes);
    const band = widenForConfidence(8, confidence);
    result.goalMinutes = goalMinutes;
    result.goalProbability = point;
    result.goalProbabilityLow = Math.max(1, point - band);
    result.goalProbabilityHigh = Math.min(99, point + band);
  }

  return result;
}

// ─── Triathlon ────────────────────────────────────────────────────────────────

export interface TriathlonDistances {
  swimKm: number;
  bikeKm: number;
  runKm: number;
}

export const TRIATHLON_DISTANCES: Record<"sprint" | "olympic" | "70.3" | "full", TriathlonDistances> = {
  sprint: { swimKm: 0.75, bikeKm: 20, runKm: 5 },
  olympic: { swimKm: 1.5, bikeKm: 40, runKm: 10 },
  "70.3": { swimKm: 1.9, bikeKm: 90, runKm: 21.1 },
  full: { swimKm: 3.8, bikeKm: 180, runKm: 42.2 },
};

export interface TriathlonPrediction {
  swimTimeMinutes: number;
  t1Minutes: number;
  bikeTimeMinutes: number;
  t2Minutes: number;
  runTimeMinutes: number;
  totalTimeMinutes: number;
  totalTimeFormatted: string;
  bikeSpeedKmh: number;
  bikeCdAUsed: number;
  goalMinutes?: number;
  goalProbability?: number;
  goalProbabilityLow?: number;
  goalProbabilityHigh?: number;
  confidence: Confidence;
}

function calcBikeRacePower(ftpWatts: number): number {
  return Math.round(ftpWatts * 0.75);
}

/** Newton's method against the cycling power-balance equation (rolling resistance + aero drag). */
function calcBikeTimeMinutes(racePowerWatts: number, weightKg: number, cda: number, bikeKm: number): number {
  const Crr = 0.004, g = 9.81, rho = 1.2, eta = 0.975;
  let v = 10;
  for (let i = 0; i < 50; i++) {
    const P_calc = ((Crr * weightKg * g + 0.5 * rho * cda * v * v) * v) / eta;
    const dP = (Crr * weightKg * g + 1.5 * rho * cda * v * v) / eta;
    v = v - (P_calc - racePowerWatts) / dP;
    if (v < 1) v = 1;
  }
  return (bikeKm / (v * 3.6)) * 60 * 1.025; // +2.5% for course/technical/pack-legal reality vs a lab number
}

/** Whole-race fatigue reaching the run scales with how much race precedes it — a rule of thumb, not a peer-reviewed model. */
function brickPenaltyFor(runKm: number): number {
  if (runKm <= 12) return 1.03;
  if (runKm <= 25) return 1.045;
  return 1.18;
}

function calcRunRacePaceSecPerKm(marathonPbMinutes: number, runKm: number): number {
  const anchorTimeMinutes = marathonPbMinutes * Math.pow(runKm / MARATHON_KM, RIEGEL_EXPONENT);
  return Math.round(((anchorTimeMinutes * 60) / runKm) * brickPenaltyFor(runKm));
}

function calcSwimTimeMinutes(poolPaceSecPer100m: number, swimKm: number): number {
  const lengths = (swimKm * 1000) / 100;
  return ((poolPaceSecPer100m + 8) * lengths) / 60; // +8s/100m for open-water/sighting vs pool pace
}

export function predictTriathlon(a: AthleteParams, distances: TriathlonDistances, goalMinutes?: number): TriathlonPrediction {
  const { swimKm, bikeKm, runKm } = distances;
  const swimTimeMinutes = calcSwimTimeMinutes(a.cssSecPer100m.value, swimKm);
  const t1Minutes = 4.5;
  const bikePower = calcBikeRacePower(a.ftpWatts.value);
  const bikeTimeMinutes = calcBikeTimeMinutes(bikePower, a.weightKg.value, a.bikeCdA.value, bikeKm);
  const bikeSpeedKmh = Math.round((bikeKm / (bikeTimeMinutes / 60)) * 10) / 10;
  const t2Minutes = 2.5;
  const runPace = calcRunRacePaceSecPerKm(a.marathonPbMinutes.value, runKm);
  const runTimeMinutes = (runPace * runKm) / 60;
  const totalTimeMinutes = swimTimeMinutes + t1Minutes + bikeTimeMinutes + t2Minutes + runTimeMinutes;

  const inputs: Record<string, Measured<unknown>> = {
    cssSecPer100m: a.cssSecPer100m,
    ftpWatts: a.ftpWatts,
    bikeCdA: a.bikeCdA,
    weightKg: a.weightKg,
    marathonPbMinutes: a.marathonPbMinutes,
  };
  const confidence = assessConfidence(inputs);

  const result: TriathlonPrediction = {
    swimTimeMinutes: Math.round(swimTimeMinutes * 10) / 10,
    t1Minutes,
    bikeTimeMinutes: Math.round(bikeTimeMinutes * 10) / 10,
    t2Minutes,
    runTimeMinutes: Math.round(runTimeMinutes * 10) / 10,
    totalTimeMinutes: Math.round(totalTimeMinutes * 10) / 10,
    totalTimeFormatted: formatTime(totalTimeMinutes),
    bikeSpeedKmh,
    bikeCdAUsed: a.bikeCdA.value,
    confidence,
  };

  if (goalMinutes != null) {
    const point = goalProbabilityPoint(totalTimeMinutes, goalMinutes);
    const band = widenForConfidence(8, confidence);
    result.goalMinutes = goalMinutes;
    result.goalProbability = point;
    result.goalProbabilityLow = Math.max(1, point - band);
    result.goalProbabilityHigh = Math.min(99, point + band);
  }

  return result;
}
