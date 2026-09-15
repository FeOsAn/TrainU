/**
 * Every physiological input, generalized across goal types, as a
 * Measured<T> — see shared/measured.ts for why. This single struct replaces
 * sub5-dashboard's triathlon-only AthleteParams and HyroxNga's HYROX-only
 * one; a marathon goal and a HYROX goal for the same athlete read the same
 * object instead of maintaining two disagreeing copies (the exact bug both
 * sibling apps' own athleteConstants/athlete.ts headers say they were built
 * to prevent — see those files' comments).
 */

import { type Measured, seeded, valueOf } from "./measured";

export interface AthleteParams {
  ftpWatts: Measured<number>;
  /** Bike aero drag area (m²). 0.32 = relaxed road position; a real TT setup is ~0.24-0.28. */
  bikeCdA: Measured<number>;
  cssSecPer100m: Measured<number>;
  runThresholdSecPerKm: Measured<number>;
  runEasySecPerKm: Measured<number>;
  run5kSecPerKm: Measured<number>;
  lthrBpm: Measured<number>;
  /** Only used for %maxHR zone fallbacks — see calibration.ts for how little that matters once LTHR is real. */
  maxHrBpm: Measured<number>;
  weightKg: Measured<number>;
  heightCm: Measured<number>;
  ageYears: Measured<number>;
  marathonPbMinutes: Measured<number>;
  /** 0.5-1.5, 1.0 = average carryover from a strength/station effort into the following run. HYROX's highest-leverage parameter. */
  strengthEnduranceIndex: Measured<number>;
  squat1RmKg: Measured<number>;
  deadlift1RmKg: Measured<number>;
  bench1RmKg: Measured<number>;
  ohp1RmKg: Measured<number>;
  bodyFatPercent: Measured<number>;
  /** Arbitrary named timed benchmarks in seconds (HYROX stations, a 1RM test, anything else), keyed by id — one generic bucket instead of one bespoke field per test. */
  benchmarks: Record<string, Measured<number>>;
}

export const DEFAULT_ATHLETE: AthleteParams = {
  ftpWatts: seeded(285),
  bikeCdA: seeded(0.32, "seed — relaxed road position assumed, not measured"),
  cssSecPer100m: seeded(112),
  runThresholdSecPerKm: seeded(260),
  runEasySecPerKm: seeded(354, "seed — derived from threshold"),
  run5kSecPerKm: seeded(280, "seed — derived from threshold"),
  lthrBpm: seeded(175),
  maxHrBpm: seeded(185, "seed — assumed, only used for %maxHR fallbacks"),
  weightKg: seeded(75),
  heightCm: seeded(178),
  ageYears: seeded(35),
  marathonPbMinutes: seeded(203),
  strengthEnduranceIndex: seeded(1.0, "seed — learned from race-simulation data"),
  squat1RmKg: seeded(100),
  deadlift1RmKg: seeded(120),
  bench1RmKg: seeded(80),
  ohp1RmKg: seeded(50),
  bodyFatPercent: seeded(18),
  benchmarks: {},
};

/** Plausible ranges — a settings PATCH, a chat tool call and a sim handler all write these and must agree on the bounds. */
export const ATHLETE_NUMERIC_BOUNDS: Record<string, [number, number]> = {
  ftpWatts: [80, 500],
  bikeCdA: [0.18, 0.45],
  cssSecPer100m: [60, 240],
  runThresholdSecPerKm: [120, 720],
  runEasySecPerKm: [150, 900],
  run5kSecPerKm: [120, 720],
  lthrBpm: [100, 220],
  maxHrBpm: [120, 230],
  weightKg: [35, 200],
  heightCm: [120, 230],
  ageYears: [14, 90],
  marathonPbMinutes: [120, 420],
  strengthEnduranceIndex: [0.5, 1.5],
  squat1RmKg: [20, 400],
  deadlift1RmKg: [20, 450],
  bench1RmKg: [20, 300],
  ohp1RmKg: [15, 200],
  bodyFatPercent: [3, 50],
};

export function withinBounds(field: string, n: number): boolean {
  const bounds = ATHLETE_NUMERIC_BOUNDS[field];
  return Number.isFinite(n) && (!bounds || (n >= bounds[0] && n <= bounds[1]));
}

/** Row shape as stored in athleteMeasurements.fieldsJson — see shared/schema.ts. */
export type AthleteRow = Partial<Record<Exclude<keyof AthleteParams, "benchmarks">, Measured<number>>> & {
  benchmarks?: Record<string, Measured<number>>;
};

/** Merge a (possibly partial) stored row over the defaults. Never trusts an out-of-bounds stored value. */
export function athleteParamsFromRow(row?: AthleteRow | null): AthleteParams {
  const merged = { ...DEFAULT_ATHLETE } as AthleteParams;
  if (!row) return merged;
  for (const key of Object.keys(DEFAULT_ATHLETE) as (keyof AthleteParams)[]) {
    if (key === "benchmarks") continue;
    const stored = row[key];
    if (stored && withinBounds(key, stored.value)) {
      (merged as any)[key] = stored;
    }
  }
  merged.benchmarks = { ...(row.benchmarks ?? {}) };
  return merged;
}

/** Flatten to plain numbers for math that doesn't care about provenance (TSS, physics). */
export function numericParams(a: AthleteParams): Record<Exclude<keyof AthleteParams, "benchmarks">, number> {
  const out: any = {};
  for (const key of Object.keys(DEFAULT_ATHLETE) as (keyof AthleteParams)[]) {
    if (key === "benchmarks") continue;
    out[key] = valueOf(a[key] as Measured<number>);
  }
  return out;
}
