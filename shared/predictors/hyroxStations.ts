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

// ───────────────────────────────────────────────────────────────────────────
// Entering a benchmark (Phase 10 · F9)
//
// The catalog above already described the race; nothing above described how
// an athlete PUTS a real time into it. `predictHyrox` has read
// `a.benchmarks[stationId]` since Phase 2 and no screen has ever written one,
// so every HYROX prediction has been eight guesses wearing a confidence
// band. What was missing is the entry side: plausible bounds so a
// fat-fingered 20-second sled push is refused the way ATHLETE_NUMERIC_BOUNDS
// refuses a 900 W FTP, and athlete-facing words for each thing being timed.
//
// Roxzone is a benchmark here too, not a parameter. It is the one number in
// a HYROX race that is pure transition time and the easiest to improve, and
// until now it could only arrive through a function argument nothing passed.
// ───────────────────────────────────────────────────────────────────────────

/** The roxzone is not a station, but it is an enterable, timed benchmark keyed in the same bucket. */
export const ROXZONE_BENCHMARK_ID = "roxzone";

export type BenchmarkId = StationId | typeof ROXZONE_BENCHMARK_ID;

/** Race order, then the roxzone — the order these are shown and entered. */
export const HYROX_BENCHMARK_IDS: BenchmarkId[] = [...STATIONS.map((s) => s.id), ROXZONE_BENCHMARK_ID];

/**
 * Plausible [min, max] seconds for a FRESH single effort at race standard.
 * Written out per station rather than derived, so adding a station fails
 * `tsc` here until someone decides what a believable time for it is.
 *
 * Wide on purpose: these reject typos and unit mistakes (a time entered in
 * minutes, a missing digit), not slow athletes. Rejecting a real time an
 * athlete actually ran would teach them the app is wrong about them, which
 * costs far more than letting an unusual number through.
 */
export const STATION_BOUNDS: Record<StationId, [number, number]> = {
  ski_erg: [180, 480],
  sled_push: [30, 420],
  sled_pull: [45, 480],
  burpee_broad_jump: [100, 600],
  row: [165, 480],
  farmers_carry: [45, 300],
  sandbag_lunges: [90, 480],
  wall_balls: [150, 720],
};

/** Total transition time across a whole race, not one transition: three minutes is exceptional, fifteen means walking. */
export const ROXZONE_BOUNDS: [number, number] = [120, 900];

export const BENCHMARK_BOUNDS: Record<BenchmarkId, [number, number]> = {
  ...STATION_BOUNDS,
  [ROXZONE_BENCHMARK_ID]: ROXZONE_BOUNDS,
};

/** The seed each benchmark falls back to while it has never been timed — the same numbers the predictor already assumed. */
export const BENCHMARK_SEEDS: Record<BenchmarkId, number> = {
  ...DEFAULT_STATION_BENCHMARKS,
  [ROXZONE_BENCHMARK_ID]: DEFAULT_ROXZONE_SECONDS,
};

/** Athlete-facing name. Stations reuse the catalog's own name so the two can never disagree. */
export const BENCHMARK_LABELS: Record<BenchmarkId, string> = {
  ...(Object.fromEntries(STATIONS.map((s) => [s.id, s.name])) as Record<StationId, string>),
  [ROXZONE_BENCHMARK_ID]: "Roxzone",
};

/**
 * What to time, in the athlete's words. Required per benchmark, so a new one
 * cannot ship as a bare id on a form nobody knows how to fill in.
 *
 * Every station description says "fresh" deliberately: the predictor applies
 * its own in-race degradation on top of these, so entering a time from the
 * middle of a race would be counted as tired twice.
 */
export const BENCHMARK_HINTS: Record<BenchmarkId, string> = {
  ski_erg: "1000 m on the SkiErg from a standing start, fresh, as hard as you would open a race.",
  sled_push: "50 m of sled push at your race weight — four lengths of 12.5 m — fresh, timed end to end.",
  sled_pull: "50 m of sled pull at race weight, fresh, from the first pull to the sled crossing the line.",
  burpee_broad_jump: "80 m of burpee broad jumps, fresh, held together as long as you can.",
  row: "1000 m on the rower from a standing start, fresh.",
  farmers_carry: "200 m carrying race-weight kettlebells, fresh, clock running through any set-down.",
  sandbag_lunges: "100 m of sandbag lunges at race weight, fresh, timed end to end.",
  wall_balls: "100 wall balls at race height and weight, fresh, no-reps included.",
  roxzone: "All eight transitions from a race or a full simulation, added up — the time you spend moving between the rig and the stations.",
};

/** How a benchmark is written down. One member today; the table exists so a kilogram or a wattage benchmark has to declare itself rather than inherit seconds. */
export type BenchmarkFormat = "mmss";

export const BENCHMARK_FORMAT_LABELS: Record<BenchmarkFormat, string> = {
  mmss: "Minutes and seconds — type 1:45, or 105 for plain seconds.",
};

export const BENCHMARK_FORMAT: Record<BenchmarkId, BenchmarkFormat> = {
  ski_erg: "mmss",
  sled_push: "mmss",
  sled_pull: "mmss",
  burpee_broad_jump: "mmss",
  row: "mmss",
  farmers_carry: "mmss",
  sandbag_lunges: "mmss",
  wall_balls: "mmss",
  roxzone: "mmss",
};

export function isBenchmarkId(id: string): id is BenchmarkId {
  return Object.prototype.hasOwnProperty.call(BENCHMARK_BOUNDS, id);
}

/**
 * Deliberately the opposite default from `shared/athlete.ts`'s
 * `withinBounds`, which waves an unknown field through: an id nobody
 * declared is rejected, not stored. That default is exactly how
 * `PATCH /api/athlete { ski_erg: 200 }` currently returns 200 while writing
 * a key no reader will ever look at.
 */
export function benchmarkWithinBounds(id: string, seconds: number): boolean {
  if (!isBenchmarkId(id) || !Number.isFinite(seconds)) return false;
  const [min, max] = BENCHMARK_BOUNDS[id];
  return seconds >= min && seconds <= max;
}

/** 215 → "3:35". One formatter, so a benchmark reads the same wherever it is shown. */
export function formatBenchmarkSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * "3:35", "3:35.4" or "215" → 215. Null when it is not a time at all, so the
 * caller can say so rather than storing a zero. Lives here beside the format
 * hint that promises the athlete both spellings work — a parser in the form
 * and a hint in the catalog is two mechanisms waiting to disagree.
 */
export function parseBenchmarkInput(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw) : null;
  const text = raw.trim();
  if (text === "") return null;
  const colon = text.match(/^(\d{1,3}):([0-5]?\d)(?:[.,](\d+))?$/);
  if (colon) {
    const seconds = parseInt(colon[1]!, 10) * 60 + parseInt(colon[2]!, 10) + (colon[3] ? parseFloat(`0.${colon[3]}`) : 0);
    return Math.round(seconds);
  }
  if (/^\d+(?:[.,]\d+)?$/.test(text)) return Math.round(parseFloat(text.replace(",", ".")));
  return null;
}
