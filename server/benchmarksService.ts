/**
 * HYROX benchmark persistence — the write path that never existed.
 *
 * `predictHyrox` has read `AthleteParams.benchmarks[stationId]` since Phase 2
 * and `calibrateBenchmark()` has been able to turn a timed effort into a
 * `Measured<number>` with provenance for just as long. Nothing has ever
 * written either. That is the Phase 8 archetype exactly — a built capability
 * nothing can request — and it is why `athlete.stations` was re-declared as a
 * `planned` block rather than left claiming to work. This file is the missing
 * half: one place where a timed station effort or a roxzone becomes a
 * measured athlete number.
 *
 * Two rules it exists to hold:
 *
 *  1. **Every entry is validated before any entry is written.** A partially
 *     applied patch that answered 400 would be the app lying about what it
 *     stored — the same reason `createGoal` validates the whole goal first.
 *  2. **A benchmark is measured, or it is the seed. Never something in
 *     between.** Values come back through `calibrateBenchmark`, so the
 *     provenance string, the `asOf` date and the "older than 84 days —
 *     retest" wording are produced by the one function that already phrases
 *     benchmark provenance for the whole app, rather than a second copy here
 *     that would drift from it.
 *
 * Known limit, stated rather than hidden: one value per benchmark, no history
 * of past efforts. Re-entering replaces, and `null` clears back to the seed —
 * which is what makes a typo recoverable. A full evidence log (every effort
 * kept, best-recent chosen) needs a table this phase does not add.
 */

import { eq } from "drizzle-orm";
import { db } from "./db";
import { athleteMeasurements } from "@shared/schema";
import { type AthleteRow, athleteParamsFromRow } from "@shared/athlete";
import { getAthleteRow, saveAthleteRow } from "./athleteRowStore";
import { calibrateBenchmark } from "@shared/calibration";
import { isValidISODate, todayISO } from "@shared/dates";
import type { Measured } from "@shared/measured";
import {
  BENCHMARK_BOUNDS,
  BENCHMARK_FORMAT,
  BENCHMARK_FORMAT_LABELS,
  BENCHMARK_HINTS,
  BENCHMARK_LABELS,
  BENCHMARK_SEEDS,
  type BenchmarkFormat,
  type BenchmarkId,
  HYROX_BENCHMARK_IDS,
  benchmarkWithinBounds,
  formatBenchmarkSeconds,
  isBenchmarkId,
} from "@shared/predictors/hyroxStations";

/** Single-athlete app: the same row every other athlete read and write uses. */

/**
 * How long a timed effort stands before it is flagged for a retest. Matches
 * `calibrateBenchmark`'s own default: twelve weeks of training changes a
 * station time, and a number that old should say so rather than quietly
 * anchoring a race prediction.
 */
export const BENCHMARK_WINDOW_DAYS = 84;

export class InvalidBenchmarkError extends Error {}

/** One benchmark as the athlete sees it: what it is, how to time it, what is stored and where that came from. */
export interface BenchmarkView {
  id: BenchmarkId;
  label: string;
  hint: string;
  format: BenchmarkFormat;
  formatHint: string;
  /** [min, max] seconds this entry will accept — the form can say so before the athlete is rejected. */
  bounds: [number, number];
  seedSeconds: number;
  /** The stored measurement, or the seed with `verified: false` when nothing has been timed. */
  value: Measured<number>;
  /** m:ss rendering of `value.value`, so every surface shows the same string. */
  display: string;
}

/** One timed effort. `seconds` alone is the common case; the object form carries when it happened and what the test was. */
export interface BenchmarkEntry {
  seconds: number;
  /** ISO date the effort actually happened. Defaults to today; a future date is refused. */
  date?: string;
  /** Athlete's own description of the test — "race sled, 3 Oct gym session". Shown ahead of the derived provenance. */
  note?: string;
}

/** `null` clears a benchmark back to its seed — the only way to undo a typo that landed inside bounds. */
export type BenchmarkPatch = Record<string, number | BenchmarkEntry | null>;

/**
 * The stored effort, aged against TODAY rather than against the day it was
 * typed in.
 *
 * `patchBenchmarks` calls `calibrateBenchmark` with `today` = the day of
 * entry, so the effort is always inside the 84-day window at that moment and
 * the provenance string it freezes into the athlete row is always "measured,
 * 14 Jan". Reading it back verbatim meant the retest branch could only ever
 * fire for someone who back-dated an entry by twelve weeks AS THEY TYPED IT:
 * time could not reach it. A HYROX athlete who timed their stations in
 * January still read "measured, 14 Jan" in September, with no prompt to
 * retest, after a whole training block. `BENCHMARK_WINDOW_DAYS`' own doc
 * comment states the intent — "a number that old should say so" — and the
 * machinery to do it was present and never asked to run. The running
 * calibration one file over re-derives from session history on every read and
 * gets this right; this is the same rule, in the one place a station time is
 * read.
 *
 * What this deliberately does NOT do is change the prediction. A stale
 * measurement is still `verified: true` — an old measurement still beats a
 * guess, which is the policy `calibrateBenchmark` itself encodes — so
 * `assessConfidence` sees exactly what it saw before and no band moves. This
 * is about what the athlete is told, not about the numbers.
 */
function agedValue(id: BenchmarkId, stored: Measured<number>, today: string): Measured<number> {
  // A `Measured` with no date cannot be aged, and one that isn't a measurement
  // has nothing to age. Either way: exactly what is stored, untouched.
  if (!stored.asOf || !stored.verified) return stored;
  const evidence = [{ testId: id, date: stored.asOf, value: stored.value }];
  const asEntered = calibrateBenchmark(id, BENCHMARK_SEEDS[id], evidence, stored.asOf, BENCHMARK_WINDOW_DAYS);
  const asOfToday = calibrateBenchmark(id, BENCHMARK_SEEDS[id], evidence, today, BENCHMARK_WINDOW_DAYS);
  if (asOfToday.source === asEntered.source) return stored;
  // The athlete's own note leads the stored string ("race sled, 3 Oct gym
  // session — measured, 3 Oct"); re-deriving without putting it back would
  // silently delete what they wrote about their own effort.
  const note = stored.source.endsWith(asEntered.source)
    ? stored.source.slice(0, stored.source.length - asEntered.source.length)
    : "";
  return { ...stored, source: `${note}${asOfToday.source}` };
}

function viewOf(id: BenchmarkId, stored: Measured<number> | undefined, today: string = todayISO()): BenchmarkView {
  // No stored value means the seed, produced by the same `calibrateBenchmark`
  // call with no evidence — so "not yet measured" is phrased once, not twice.
  const value = stored
    ? agedValue(id, stored, today)
    : calibrateBenchmark(id, BENCHMARK_SEEDS[id], [], today, BENCHMARK_WINDOW_DAYS);
  return {
    id,
    label: BENCHMARK_LABELS[id],
    hint: BENCHMARK_HINTS[id],
    format: BENCHMARK_FORMAT[id],
    formatHint: BENCHMARK_FORMAT_LABELS[BENCHMARK_FORMAT[id]],
    bounds: BENCHMARK_BOUNDS[id],
    seedSeconds: BENCHMARK_SEEDS[id],
    value,
    display: formatBenchmarkSeconds(value.value),
  };
}

/**
 * Every HYROX benchmark in race order, roxzone last — measured ones as
 * stored, aged against `today`, the rest as honest seeds.
 */
export function getBenchmarks(opts: { today?: string } = {}): BenchmarkView[] {
  const today = opts.today ?? todayISO();
  const stored = athleteParamsFromRow(getAthleteRow()).benchmarks;
  return HYROX_BENCHMARK_IDS.map((id) => viewOf(id, stored[id], today));
}

interface ValidEntry {
  id: BenchmarkId;
  seconds: number;
  date: string;
  note?: string;
}

function validate(rawId: string, raw: number | BenchmarkEntry | null, today: string): ValidEntry | { id: BenchmarkId; clear: true } {
  if (!isBenchmarkId(rawId)) {
    throw new InvalidBenchmarkError(`"${rawId}" is not something this app knows how to time. Enter one of: ${HYROX_BENCHMARK_IDS.map((id) => BENCHMARK_LABELS[id]).join(", ")}.`);
  }
  const id = rawId;
  if (raw === null) return { id, clear: true };

  const entry: BenchmarkEntry = typeof raw === "number" ? { seconds: raw } : raw;
  if (typeof entry !== "object" || entry === null || typeof entry.seconds !== "number" || !Number.isFinite(entry.seconds)) {
    throw new InvalidBenchmarkError(`${BENCHMARK_LABELS[id]} needs a time in seconds.`);
  }
  const seconds = Math.round(entry.seconds);
  if (!benchmarkWithinBounds(id, seconds)) {
    const [min, max] = BENCHMARK_BOUNDS[id];
    throw new InvalidBenchmarkError(
      `${formatBenchmarkSeconds(seconds)} is not a believable ${BENCHMARK_LABELS[id]} time — it should be between ${formatBenchmarkSeconds(min)} and ${formatBenchmarkSeconds(max)}. Check the units before saving.`,
    );
  }

  const date = entry.date ?? today;
  if (!isValidISODate(date)) {
    throw new InvalidBenchmarkError(`${BENCHMARK_LABELS[id]} needs a real date for when you did it.`);
  }
  if (date > today) {
    throw new InvalidBenchmarkError(`${BENCHMARK_LABELS[id]} is dated in the future — the app can only record efforts you have actually done.`);
  }

  const note = typeof entry.note === "string" && entry.note.trim() !== "" ? entry.note.trim() : undefined;
  return { id, seconds, date, note };
}

/**
 * Record timed efforts. Throws `InvalidBenchmarkError` — having written
 * nothing — if any single entry is bad.
 *
 * Provenance comes from `calibrateBenchmark` rather than a string built here:
 * it dates the effort, and it is the thing that adds "older than 84 days —
 * retest" to a back-dated entry, which a hand-written "entered on ..." would
 * have quietly dropped. The athlete's own note, when they give one, leads.
 */
export function patchBenchmarks(patch: BenchmarkPatch, opts: { today?: string } = {}): BenchmarkView[] {
  const today = opts.today ?? todayISO();
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new InvalidBenchmarkError("Send benchmarks as a set of named times.");
  }

  // Validate the whole patch first: a half-applied write behind a 400 would
  // leave the athlete's numbers in a state the response denies.
  const validated = Object.entries(patch).map(([id, raw]) => validate(id, raw, today));

  const row = getAthleteRow() ?? {};
  const benchmarks = { ...(row.benchmarks ?? {}) };
  for (const v of validated) {
    if ("clear" in v) {
      delete benchmarks[v.id];
      continue;
    }
    const derived = calibrateBenchmark(v.id, BENCHMARK_SEEDS[v.id], [{ testId: v.id, date: v.date, value: v.seconds }], today, BENCHMARK_WINDOW_DAYS);
    benchmarks[v.id] = v.note ? { ...derived, source: `${v.note} — ${derived.source}` } : derived;
  }
  row.benchmarks = benchmarks;
  saveAthleteRow(row);

  return getBenchmarks({ today });
}
