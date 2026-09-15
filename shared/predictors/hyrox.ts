/**
 * HYROX race predictor. Ported from HyroxNga's racePredictor.ts, made to
 * read Measured<AthleteParams> instead of plain AthleteParams — the fix for
 * the gap that motivated this whole rewrite: strengthEnduranceIndex (this
 * file's own upstream comment calls it "the single most valuable thing a
 * race simulation measures") used to default to 1.0 and feed goalProbability
 * with full apparent confidence. Here it's a Measured<number> like every
 * other input, and goalProbability carries a band that widens when it, the
 * station benchmarks, or the roxzone time are still guesses.
 */

import type { AthleteParams } from "../athlete";
import { type Confidence, type Measured, assessConfidence, seeded, widenForConfidence } from "../measured";
import { DEFAULT_ROXZONE_SECONDS, DEFAULT_STATION_BENCHMARKS, RACE_SEQUENCE, STATIONS, STATION_BY_ID, type StationId, type StationSpec, stationBeforeRun } from "./hyroxStations";

export const GLOBAL_DRIFT_TOTAL = 0.055;
/** HYROX run pace relative to the fresh kilometre — roughly 5 km pace; no one runs run 1 of 8 at an all-out kilometre. */
const FRESH_KM_TO_RACE = 1.08;

export interface RunSplit {
  runIndex: number;
  seconds: number;
  precededBy: StationId | null;
  localPenalty: number;
  driftPenalty: number;
}

export interface StationSplit {
  stationId: StationId;
  seconds: number;
  benchmarkSeconds: number;
}

export interface Limiter {
  label: string;
  secondsAboveReference: number;
  kind: "station" | "run" | "roxzone";
  stationId?: StationId;
  note: string;
}

export interface HyroxPrediction {
  totalSeconds: number;
  runSeconds: number;
  stationSeconds: number;
  roxzoneSeconds: number;
  avgRunSecPerKm: number;
  runSplits: RunSplit[];
  stationSplits: StationSplit[];
  limiters: Limiter[];
  goalSeconds: number;
  goalProbability: number;
  goalProbabilityLow: number;
  goalProbabilityHigh: number;
  confidence: Confidence;
}

function benchmarkFor(a: AthleteParams, id: StationId): Measured<number> {
  return a.benchmarks[id] ?? seeded(DEFAULT_STATION_BENCHMARKS[id]);
}

function compromisedRunPenalty(station: StationSpec, seiValue: number): number {
  return station.runPenalty * seiValue;
}

function stationDegradation(station: StationSpec, seiValue: number): number {
  const positionFraction = (station.order - 1) / (STATIONS.length - 1);
  return 1 + positionFraction * 0.14 * station.demand.anaerobic * seiValue;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 1;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** A logistic on the gap to goal — HYROX race-day variance (floor traffic, sled friction, no-reps) is real but not enormous. */
function goalProbabilityPoint(predictedSeconds: number, goalSeconds: number): number {
  const SPREAD = 150;
  // Clamped to [1, 99] — see enduranceRace.ts's goalProbabilityPoint for why:
  // an unclamped 100/0 could sit outside a band built by offsetting from it.
  const raw = Math.round((1 / (1 + Math.exp((predictedSeconds - goalSeconds) / SPREAD))) * 100);
  return Math.max(1, Math.min(99, raw));
}

export function predictHyrox(a: AthleteParams, goalSeconds: number, roxzoneOverride?: Measured<number>, calibrationMultiplier = 1): HyroxPrediction {
  const runThreshold = a.runThresholdSecPerKm;
  const sei = a.strengthEnduranceIndex;
  const roxzone = roxzoneOverride ?? seeded(DEFAULT_ROXZONE_SECONDS);
  const freshPace = runThreshold.value * FRESH_KM_TO_RACE;

  const runSplits: RunSplit[] = [];
  const stationSplits: StationSplit[] = [];

  for (const seg of RACE_SEQUENCE) {
    if (seg.kind === "run") {
      const prev = stationBeforeRun(seg.index);
      const localPenalty = prev ? compromisedRunPenalty(prev, sei.value) : 0;
      const driftPenalty = (GLOBAL_DRIFT_TOTAL * (seg.index - 1)) / 7;
      const secPerKm = freshPace * (1 + localPenalty + driftPenalty);
      runSplits.push({
        runIndex: seg.index,
        seconds: Math.round(secPerKm),
        precededBy: prev?.id ?? null,
        localPenalty: Math.round(localPenalty * 1000) / 1000,
        driftPenalty: Math.round(driftPenalty * 1000) / 1000,
      });
    } else {
      const st = STATION_BY_ID[seg.stationId!];
      const benchmark = benchmarkFor(a, st.id);
      stationSplits.push({
        stationId: st.id,
        seconds: Math.round(benchmark.value * stationDegradation(st, sei.value)),
        benchmarkSeconds: benchmark.value,
      });
    }
  }

  const runSeconds = runSplits.reduce((s, r) => s + r.seconds, 0);
  const stationSeconds = stationSplits.reduce((s, r) => s + r.seconds, 0);
  const totalSeconds = runSeconds + stationSeconds + roxzone.value;

  const limiters = findLimiters(runSplits, stationSplits, roxzone.value, sei.value);

  const inputs: Record<string, Measured<unknown>> = {
    runThresholdSecPerKm: runThreshold,
    strengthEnduranceIndex: sei,
    roxzoneSeconds: roxzone,
    ...Object.fromEntries(STATIONS.map((s) => [`benchmark_${s.id}`, benchmarkFor(a, s.id)])),
  };
  const confidence = assessConfidence(inputs);
  const point = goalProbabilityPoint(totalSeconds, goalSeconds);
  const band = widenForConfidence(5, confidence, calibrationMultiplier);

  return {
    totalSeconds,
    runSeconds,
    stationSeconds,
    roxzoneSeconds: roxzone.value,
    avgRunSecPerKm: Math.round(runSeconds / 8),
    runSplits,
    stationSplits,
    limiters,
    goalSeconds,
    goalProbability: point,
    goalProbabilityLow: Math.max(1, point - band),
    goalProbabilityHigh: Math.min(99, point + band),
    confidence,
  };
}

function findLimiters(runSplits: RunSplit[], stationSplits: StationSplit[], roxzoneSeconds: number, seiValue: number): Limiter[] {
  const out: Limiter[] = [];

  const degradations = stationSplits.map((s) => s.seconds / s.benchmarkSeconds);
  const medianDegradation = median(degradations);
  for (const s of stationSplits) {
    const excess = s.seconds - s.benchmarkSeconds * medianDegradation;
    if (excess > 4) {
      out.push({
        kind: "station",
        stationId: s.stationId,
        label: STATION_BY_ID[s.stationId].name,
        secondsAboveReference: Math.round(excess),
        note: `Degrades ${Math.round((s.seconds / s.benchmarkSeconds - 1) * 100)}% off its fresh benchmark — more than your average station.`,
      });
    }
  }

  const actualPenaltySec = runSplits.reduce((sum, r) => sum + r.seconds * (r.localPenalty / (1 + r.localPenalty + r.driftPenalty)), 0);
  const referencePenaltySec = seiValue > 0 ? actualPenaltySec * (0.8 / seiValue) : actualPenaltySec;
  if (actualPenaltySec - referencePenaltySec > 8) {
    out.push({
      kind: "run",
      label: "Compromised running",
      secondsAboveReference: Math.round(actualPenaltySec - referencePenaltySec),
      note: `You lose ${Math.round(actualPenaltySec)}s across the 8 km purely to leaving stations with wrecked legs.`,
    });
  }

  const ROXZONE_REFERENCE = 300;
  if (roxzoneSeconds - ROXZONE_REFERENCE > 15) {
    out.push({
      kind: "roxzone",
      label: "Roxzone",
      secondsAboveReference: Math.round(roxzoneSeconds - ROXZONE_REFERENCE),
      note: "Transitions, not fitness — free time.",
    });
  }

  return out.sort((x, y) => y.secondsAboveReference - x.secondsAboveReference);
}
