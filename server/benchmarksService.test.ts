import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { athleteMeasurements } from "@shared/schema";
import { type AthleteParams, type AthleteRow, DEFAULT_ATHLETE, athleteParamsFromRow } from "@shared/athlete";
import { predictHyrox } from "@shared/predictors/hyrox";
import {
  BENCHMARK_BOUNDS,
  BENCHMARK_FORMAT,
  BENCHMARK_HINTS,
  BENCHMARK_LABELS,
  BENCHMARK_SEEDS,
  HYROX_BENCHMARK_IDS,
  ROXZONE_BENCHMARK_ID,
  STATIONS,
  STATION_BOUNDS,
  benchmarkWithinBounds,
  formatBenchmarkSeconds,
  parseBenchmarkInput,
} from "@shared/predictors/hyroxStations";
import { addDays } from "@shared/dates";
import { InvalidBenchmarkError, getBenchmarks, patchBenchmarks } from "./benchmarksService";

const TODAY = "2026-09-18";
const GOAL_SECONDS = 75 * 60;

/**
 * Every test starts from an athlete who has timed nothing, because the whole
 * point of this feature is the difference between that state and any other.
 */
function resetAthlete(): void {
  db.delete(athleteMeasurements).where(eq(athleteMeasurements.id, "self")).run();
}

/**
 * Read the athlete the way `routes.ts` does — straight off the row through
 * `athleteParamsFromRow` — rather than reassembling params from the service's
 * own return value. A benchmark that only exists in the response and never
 * reaches the predictor is exactly the failure this feature exists to end.
 */
function athleteFromDb(): AthleteParams {
  const row = db.select().from(athleteMeasurements).where(eq(athleteMeasurements.id, "self")).get();
  return athleteParamsFromRow(row ? (JSON.parse(row.fieldsJson) as AthleteRow) : null);
}

function bandWidth(a: AthleteParams): number {
  const p = predictHyrox(a, GOAL_SECONDS);
  return p.goalProbabilityHigh - p.goalProbabilityLow;
}

test("the bounds table is exhaustive over the catalog, and every seed is a believable time", () => {
  assert.equal(HYROX_BENCHMARK_IDS.length, STATIONS.length + 1, "eight stations and the roxzone");
  assert.deepEqual(HYROX_BENCHMARK_IDS.slice(0, STATIONS.length), STATIONS.map((s) => s.id), "stations are offered in race order");
  assert.equal(HYROX_BENCHMARK_IDS.at(-1), ROXZONE_BENCHMARK_ID);

  for (const st of STATIONS) {
    assert.ok(STATION_BOUNDS[st.id], `${st.id} has bounds`);
  }
  for (const id of HYROX_BENCHMARK_IDS) {
    const [min, max] = BENCHMARK_BOUNDS[id];
    assert.ok(min > 0 && max > min, `${id} bounds are a real range`);
    const seed = BENCHMARK_SEEDS[id];
    assert.ok(seed >= min && seed <= max, `${id}'s seed (${seed}s) sits inside its own bounds — otherwise the app ships a default it would refuse to accept`);
    assert.ok(BENCHMARK_LABELS[id].length > 0 && BENCHMARK_HINTS[id].length > 0, `${id} has athlete-facing words`);
    assert.ok(BENCHMARK_FORMAT[id], `${id} declares how it is written down`);
    assert.ok(!BENCHMARK_HINTS[id].includes("_"), `${id}'s hint is words, not an id`);
  }
});

test("getBenchmarks describes all nine as honest seeds before anything is timed", () => {
  resetAthlete();
  const views = getBenchmarks();
  assert.equal(views.length, 9);
  for (const v of views) {
    assert.equal(v.value.verified, false);
    assert.equal(v.value.value, BENCHMARK_SEEDS[v.id]);
    assert.match(v.value.source, /not yet measured/);
    assert.equal(v.display, formatBenchmarkSeconds(BENCHMARK_SEEDS[v.id]));
    assert.ok(v.formatHint.length > 0);
  }
});

test("a fat-fingered time is refused, and nothing in the same patch is written", () => {
  resetAthlete();
  assert.throws(() => patchBenchmarks({ sled_push: 20 }, { today: TODAY }), InvalidBenchmarkError, "a 20-second sled push is not a sled push");
  assert.throws(() => patchBenchmarks({ wall_balls: 60 * 60 }, { today: TODAY }), InvalidBenchmarkError);

  // The valid half of a bad patch must not survive it.
  assert.throws(() => patchBenchmarks({ wall_balls: 210, sled_push: 20 }, { today: TODAY }), InvalidBenchmarkError);
  const wallBalls = getBenchmarks().find((v) => v.id === "wall_balls")!;
  assert.equal(wallBalls.value.verified, false, "a 400 that had already written half the patch would be the app lying about what it stored");
});

test("an id nobody declared is refused rather than silently stored", () => {
  resetAthlete();
  assert.throws(() => patchBenchmarks({ ski_ergg: 200 }, { today: TODAY }), InvalidBenchmarkError);
  assert.throws(() => patchBenchmarks({ weightKg: 200 }, { today: TODAY }), InvalidBenchmarkError, "an athlete field is not a benchmark");
  assert.equal(benchmarkWithinBounds("ski_ergg", 200), false);
  assert.equal(benchmarkWithinBounds("ski_erg", 200), true);
});

test("a date in the future, or no date at all, is refused", () => {
  resetAthlete();
  assert.throws(() => patchBenchmarks({ row: { seconds: 190, date: "2026-12-01" } }, { today: TODAY }), InvalidBenchmarkError);
  assert.throws(() => patchBenchmarks({ row: { seconds: 190, date: "not-a-date" } }, { today: TODAY }), InvalidBenchmarkError);
});

test("a measured station time moves the prediction AND narrows its band — the block is not decorative", () => {
  resetAthlete();
  const seeded = athleteFromDb();
  const before = predictHyrox(seeded, GOAL_SECONDS);
  const bandBefore = bandWidth(seeded);

  patchBenchmarks({ wall_balls: 210 }, { today: TODAY });

  const after = athleteFromDb();
  const predicted = predictHyrox(after, GOAL_SECONDS);
  assert.ok(predicted.totalSeconds < before.totalSeconds, "30 seconds faster on wall balls has to show up in the finish time");
  assert.ok(bandWidth(after) < bandBefore, "one fewer guess behind the probability means a narrower band");
  assert.ok(
    !predicted.confidence.unverifiedFields.includes("benchmark_wall_balls"),
    "the station the athlete actually timed stops being listed as a guess",
  );
  assert.equal(predicted.confidence.verifiedCount, before.confidence.verifiedCount + 1);

  const split = predicted.stationSplits.find((s) => s.stationId === "wall_balls")!;
  assert.equal(split.benchmarkSeconds, 210, "the predictor reads the number the athlete entered, not the seed");
});

test("the roxzone reaches the predictor with no override passed, and clearing it puts the prediction back", () => {
  resetAthlete();
  const beforeTotal = predictHyrox(athleteFromDb(), GOAL_SECONDS).totalSeconds;

  patchBenchmarks({ roxzone: { seconds: 240, date: TODAY, note: "Race, Manchester" } }, { today: TODAY });
  const measured = athleteFromDb();
  const withRoxzone = predictHyrox(measured, GOAL_SECONDS);
  assert.equal(withRoxzone.roxzoneSeconds, 240, "roxzone is an entered benchmark now, not a parameter nothing passes");
  assert.equal(beforeTotal - withRoxzone.totalSeconds, 90, "90 seconds off the transitions is 90 seconds off the race");

  // The override parameter still wins, so existing call sites and a what-if
  // keep working exactly as they did.
  const overridden = predictHyrox(measured, GOAL_SECONDS, { value: 300, verified: true, source: "what if" });
  assert.equal(overridden.roxzoneSeconds, 300);

  patchBenchmarks({ roxzone: null }, { today: TODAY });
  const cleared = athleteFromDb();
  assert.equal(predictHyrox(cleared, GOAL_SECONDS).totalSeconds, beforeTotal, "clearing a typo has to actually undo it");
  assert.equal(getBenchmarks().find((v) => v.id === ROXZONE_BENCHMARK_ID)!.value.verified, false);
});

test("what is stored carries where it came from, including when it is too old to trust", () => {
  resetAthlete();
  patchBenchmarks({ ski_erg: { seconds: 208, date: "2026-09-12", note: "Gym test, race pace" } }, { today: TODAY });
  const fresh = getBenchmarks().find((v) => v.id === "ski_erg")!;
  assert.equal(fresh.value.verified, true);
  assert.equal(fresh.value.value, 208);
  assert.equal(fresh.value.asOf, "2026-09-12");
  assert.match(fresh.value.source, /^Gym test, race pace/, "the athlete's own description of the test leads");
  assert.match(fresh.value.source, /12 Sep/, "and the date it happened is in there");
  assert.equal(fresh.display, "3:28");

  patchBenchmarks({ sled_pull: { seconds: 130, date: "2026-01-04" } }, { today: TODAY });
  const stale = getBenchmarks().find((v) => v.id === "sled_pull")!;
  assert.equal(stale.value.verified, true, "an old measurement still beats a guess");
  assert.match(stale.value.source, /retest/, "but it says out loud that it is old");
});

test("re-entering replaces, and a plain number is the same as an entry dated today", () => {
  resetAthlete();
  patchBenchmarks({ row: 205 }, { today: TODAY });
  assert.equal(getBenchmarks().find((v) => v.id === "row")!.value.asOf, TODAY);
  patchBenchmarks({ row: 196 }, { today: TODAY });
  const row = getBenchmarks().find((v) => v.id === "row")!;
  assert.equal(row.value.value, 196);
  assert.equal(row.display, "3:16");
});

test("the athlete can type 1:45 or 105 and mean the same thing", () => {
  assert.equal(parseBenchmarkInput("1:45"), 105);
  assert.equal(parseBenchmarkInput("105"), 105);
  assert.equal(parseBenchmarkInput(" 3:28 "), 208);
  assert.equal(parseBenchmarkInput("3:28.4"), 208);
  assert.equal(parseBenchmarkInput("abc"), null);
  assert.equal(parseBenchmarkInput(""), null);
  assert.equal(parseBenchmarkInput("1:75"), null, "a minute has sixty seconds in it");
  assert.equal(formatBenchmarkSeconds(105), "1:45");
  assert.equal(formatBenchmarkSeconds(DEFAULT_ATHLETE.benchmarks.row?.value ?? 200), "3:20");
});

/*
 * ─── Regressions ──────────────────────────────────────────────────────────
 */

test("DEFECT: a station time ages — the retest window is read on every READ, not frozen at entry", () => {
  resetAthlete();
  const entered = "2026-01-14";
  patchBenchmarks({ sled_push: { seconds: 208, note: "Race sled" } }, { today: entered });

  /*
   * The existing coverage reaches the stale branch only by back-dating an
   * entry AS IT IS TYPED, which is the one case the write-time call can
   * still catch. Elapsed time was untested and unreachable: the provenance
   * string was computed with `today` = the day of entry and stored, so a
   * January effort read "measured, 14 Jan" in September with no prompt to
   * retest, after a whole training block. Both sides of the 84-day line.
   */
  const day84 = getBenchmarks({ today: addDays(entered, 84) }).find((v) => v.id === "sled_push")!;
  assert.doesNotMatch(day84.value.source, /retest/, "84 days is still inside the window");
  assert.match(day84.value.source, /^Race sled — measured, 14 Jan/);

  const day85 = getBenchmarks({ today: addDays(entered, 85) }).find((v) => v.id === "sled_push")!;
  assert.match(day85.value.source, /older than 84 days — retest/, "the day after, it says so");
  assert.match(day85.value.source, /^Race sled — /, "and the athlete's own note survives the re-derive");

  // Deliberately NOT a confidence change: an old measurement still beats a
  // guess, so `verified` and the value itself are untouched and no
  // prediction band moves. This is about what the athlete is told.
  assert.equal(day85.value.verified, true);
  assert.equal(day85.value.value, 208);
  assert.equal(day85.value.asOf, entered);
  assert.equal(day85.display, day84.display);
});
