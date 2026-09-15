/**
 * The HYROX race format, as data. Trimmed from HyroxNga's shared/hyrox.ts:
 * singles only for now (doubles needs a Team/partner concept that doesn't
 * exist in TrainU's Goal model yet — add it there first if doubles becomes
 * a real ask, don't bolt division weights onto this file speculatively).
 */

export type StationId = "ski_erg" | "sled_push" | "sled_pull" | "burpee_broad_jump" | "row" | "farmers_carry" | "sandbag_lunges" | "wall_balls";

export interface StationSpec {
  id: StationId;
  order: number;
  name: string;
  demand: { legs: number; upper: number; anaerobic: number };
  /** Fraction of fresh 1 km pace added to the following run, for an athlete of average strength endurance. Wall balls carry 0 — no run follows. */
  runPenalty: number;
}

export const STATIONS: StationSpec[] = [
  { id: "ski_erg", order: 1, name: "SkiErg", demand: { legs: 0.25, upper: 0.8, anaerobic: 0.5 }, runPenalty: 0.04 },
  { id: "sled_push", order: 2, name: "Sled Push", demand: { legs: 0.95, upper: 0.35, anaerobic: 0.9 }, runPenalty: 0.2 },
  { id: "sled_pull", order: 3, name: "Sled Pull", demand: { legs: 0.6, upper: 0.85, anaerobic: 0.8 }, runPenalty: 0.16 },
  { id: "burpee_broad_jump", order: 4, name: "Burpee Broad Jumps", demand: { legs: 0.75, upper: 0.6, anaerobic: 0.85 }, runPenalty: 0.15 },
  { id: "row", order: 5, name: "Rowing", demand: { legs: 0.55, upper: 0.6, anaerobic: 0.55 }, runPenalty: 0.09 },
  { id: "farmers_carry", order: 6, name: "Farmers Carry", demand: { legs: 0.45, upper: 0.7, anaerobic: 0.4 }, runPenalty: 0.07 },
  { id: "sandbag_lunges", order: 7, name: "Sandbag Lunges", demand: { legs: 1.0, upper: 0.4, anaerobic: 0.7 }, runPenalty: 0.24 },
  { id: "wall_balls", order: 8, name: "Wall Balls", demand: { legs: 0.85, upper: 0.65, anaerobic: 0.95 }, runPenalty: 0 },
];

export const STATION_BY_ID: Record<StationId, StationSpec> = Object.fromEntries(STATIONS.map((s) => [s.id, s])) as Record<StationId, StationSpec>;

export interface RaceSegment {
  kind: "run" | "station";
  index: number;
  label: string;
  stationId?: StationId;
}

export const RACE_SEQUENCE: RaceSegment[] = STATIONS.flatMap((st) => [
  { kind: "run" as const, index: st.order, label: `Run ${st.order}` },
  { kind: "station" as const, index: st.order, label: st.name, stationId: st.id },
]);

/** The station before run N, or null for run 1 (fresh) and any index past the race. */
export function stationBeforeRun(runIndex: number): StationSpec | null {
  if (runIndex <= 1 || runIndex > STATIONS.length) return null;
  return STATIONS[runIndex - 2] ?? null;
}

export const DEFAULT_STATION_BENCHMARKS: Record<StationId, number> = {
  ski_erg: 215,
  sled_push: 90,
  sled_pull: 118,
  burpee_broad_jump: 180,
  row: 200,
  farmers_carry: 88,
  sandbag_lunges: 172,
  wall_balls: 240,
};

export const DEFAULT_ROXZONE_SECONDS = 330;
