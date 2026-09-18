import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InvalidPhysiqueEntryError,
  PhysiqueEntryNotFoundError,
  athleteParamsWithPhysique,
  deletePhysiqueEntry,
  getPhysiqueEntry,
  listPhysiqueEntries,
  physiqueProgress,
  physiqueSaveWarning,
  physiqueTrend,
  upsertPhysiqueEntry,
} from "./physiqueService";
import { DEFAULT_ATHLETE, type AthleteParams } from "@shared/athlete";
import { measured } from "@shared/measured";
import type { Goal } from "@shared/goal";

const TODAY = "2026-09-18";

/**
 * Dates are tagged per run so this file is safe to run twice against the same
 * database file — `physique_entries.date` is unique, and a test that only
 * passes against a freshly deleted DB is a test that will one day fail for a
 * reason that has nothing to do with the code.
 *
 * The tag shifts the whole history into a distinct year, so two runs never
 * share a row and "the newest entry" always means this run's newest.
 */
const YEAR = 2000 + Math.floor(Math.random() * 90);
const d = (monthDay: string) => `${YEAR}-${monthDay}`;

function clear(): void {
  for (const entry of listPhysiqueEntries(d("01-01"), d("12-31"))) deletePhysiqueEntry(entry.date);
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    type: "body_composition",
    discipline: "other",
    label: "Wedding",
    targetDate: d("12-11"),
    priority: 1,
    successCriteria: "Fit the suit",
    targetMetrics: { targetWeightKg: 78 },
    constraints: [],
    createdAt: d("09-01"),
    active: true,
    ...over,
  };
}

const LATER_TODAY = d("09-18");

test("a weigh-in round-trips, and logging the same day again corrects it rather than duplicating it", () => {
  clear();
  const first = upsertPhysiqueEntry({ date: d("09-15"), weightKg: 80.4, note: "Morning, fasted" }, { today: LATER_TODAY });
  assert.equal(first.weightKg, 80.4);
  assert.equal(first.bodyFatPercent, null);
  assert.deepEqual(getPhysiqueEntry(d("09-15")), first);

  const corrected = upsertPhysiqueEntry({ date: d("09-15"), weightKg: 80.9 }, { today: LATER_TODAY });
  assert.equal(corrected.id, first.id, "one row per date");
  assert.equal(corrected.weightKg, 80.9);
  assert.equal(corrected.note, "Morning, fasted", "an untouched field is kept, not wiped");
  assert.equal(listPhysiqueEntries(d("01-01"), d("12-31")).length, 1);
});

test("a patch clears with null and keeps with undefined — and cannot empty the entry entirely", () => {
  clear();
  upsertPhysiqueEntry({ date: d("09-15"), weightKg: 80.4, waistCm: 84 }, { today: LATER_TODAY });
  const cleared = upsertPhysiqueEntry({ date: d("09-15"), waistCm: null }, { today: LATER_TODAY });
  assert.equal(cleared.waistCm, null);
  assert.equal(cleared.weightKg, 80.4);

  assert.throws(
    () => upsertPhysiqueEntry({ date: d("09-15"), weightKg: null }, { today: LATER_TODAY }),
    InvalidPhysiqueEntryError,
    "an entry that measures nothing is not an entry",
  );
  assert.equal(getPhysiqueEntry(d("09-15"))!.weightKg, 80.4, "the rejected write changed nothing");
});

test("the write path validates: an impossible weight never reaches a row", () => {
  clear();
  assert.throws(() => upsertPhysiqueEntry({ date: d("09-15"), weightKg: 900 }, { today: LATER_TODAY }), InvalidPhysiqueEntryError);
  assert.throws(() => upsertPhysiqueEntry({ date: "not-a-date", weightKg: 80 }, { today: LATER_TODAY }), InvalidPhysiqueEntryError);
  assert.throws(() => upsertPhysiqueEntry({ date: d("09-19"), weightKg: 80 }, { today: LATER_TODAY }), InvalidPhysiqueEntryError);
  assert.equal(listPhysiqueEntries(d("01-01"), d("12-31")).length, 0);
});

test("deleting a date that was never logged says so rather than succeeding silently", () => {
  clear();
  assert.throws(() => deletePhysiqueEntry(d("09-15")), PhysiqueEntryNotFoundError);
});

test("the newest entry wins in the fold, and a deleted entry reverts it — no athlete row is ever written", () => {
  clear();
  upsertPhysiqueEntry({ date: d("09-01"), weightKg: 82, bodyFatPercent: 19 }, { today: LATER_TODAY });
  upsertPhysiqueEntry({ date: d("09-15"), weightKg: 80.4 }, { today: LATER_TODAY });

  const folded = athleteParamsWithPhysique(DEFAULT_ATHLETE);
  assert.equal(folded.weightKg.value, 80.4);
  assert.equal(folded.weightKg.verified, true);
  assert.equal(folded.weightKg.source, `scale, ${d("09-15")}`);
  assert.equal(folded.bodyFatPercent.value, 19, "body fat falls back to the newest entry that carries one");

  deletePhysiqueEntry(d("09-15"));
  assert.equal(athleteParamsWithPhysique(DEFAULT_ATHLETE).weightKg.value, 82, "the next-newest takes over by itself");

  deletePhysiqueEntry(d("09-01"));
  const bare = athleteParamsWithPhysique(DEFAULT_ATHLETE);
  assert.equal(bare.weightKg.value, DEFAULT_ATHLETE.weightKg.value);
  assert.equal(bare.weightKg.verified, false, "with nothing logged the field is a seed again, not a stale measurement");
});

test("back-dating a weigh-in does not overwrite a newer one", () => {
  clear();
  upsertPhysiqueEntry({ date: d("09-15"), weightKg: 80.4 }, { today: LATER_TODAY });
  upsertPhysiqueEntry({ date: d("07-04"), weightKg: 88 }, { today: LATER_TODAY });
  const folded = athleteParamsWithPhysique(DEFAULT_ATHLETE);
  assert.equal(folded.weightKg.value, 80.4, "written last, but it describes July");
  assert.equal(folded.weightKg.asOf, d("09-15"));
});

test("a stored athlete measurement survives until a weigh-in actually supersedes it", () => {
  clear();
  const stored: AthleteParams = { ...DEFAULT_ATHLETE, weightKg: measured(79, "manually entered", d("08-20")) };
  assert.deepEqual(athleteParamsWithPhysique(stored).weightKg, stored.weightKg);

  upsertPhysiqueEntry({ date: d("09-15"), weightKg: 80.4 }, { today: LATER_TODAY });
  assert.equal(athleteParamsWithPhysique(stored).weightKg.value, 80.4);
  assert.equal(stored.weightKg.value, 79, "the caller's params were not mutated");
});

test("the trend and the verdict read the stored history", () => {
  clear();
  for (const [date, weightKg] of [
    [d("08-18"), 84],
    [d("08-28"), 83.2],
    [d("09-08"), 82.3],
    [d("09-17"), 81.6],
  ] as const) {
    upsertPhysiqueEntry({ date, weightKg }, { today: LATER_TODAY });
  }

  const t = physiqueTrend({ today: LATER_TODAY });
  assert.equal(t.weightKg!.samples, 4);
  assert.equal(t.weightKg!.first.value, 84);
  assert.ok(t.weightKg!.changePerWeek! < -0.5);
  assert.equal(t.waistCm, null);

  const windowed = physiqueTrend({ days: 21, today: LATER_TODAY });
  assert.equal(windowed.weightKg!.samples, 2, "only the last three weeks");

  const progress = physiqueProgress(goal(), DEFAULT_ATHLETE, { today: LATER_TODAY });
  assert.equal(progress.latestWeightKg, 81.6);
  assert.equal(progress.status, "ahead");
  assert.notEqual(progress.summary, "");
});

test("the save warning compares against the last weigh-in BEFORE the date being logged", () => {
  clear();
  upsertPhysiqueEntry({ date: d("09-10"), weightKg: 80 }, { today: LATER_TODAY });
  assert.equal(physiqueSaveWarning({ date: d("09-15"), weightKg: 79.4 }), null);
  assert.match(physiqueSaveWarning({ date: d("09-15"), weightKg: 87 })!, /up from 80 kg/);

  upsertPhysiqueEntry({ date: d("09-15"), weightKg: 87 }, { today: LATER_TODAY });
  assert.match(
    physiqueSaveWarning({ date: d("09-15"), weightKg: 87 })!,
    /up from 80 kg/,
    "correcting a day is judged against the day before it, not against itself",
  );
  clear();
});
