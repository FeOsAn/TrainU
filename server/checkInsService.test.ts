import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InvalidCheckInError,
  getCheckIn,
  listCheckIns,
  readinessFor,
  recordCheckIn,
  recordCheckInAdjustments,
  upsertCheckIn,
  type UpsertCheckInInput,
} from "./checkInsService";
import { SELF_BASELINE, selfScoreOf, type CheckIn } from "@shared/readiness";
import { addDays } from "@shared/dates";

/**
 * Every test works in its own island of dates, months clear of any other
 * test's, because these rows are real history: the baselines reach back 28
 * and 60 days, so two tests a fortnight apart would silently become each
 * other's evidence.
 */
function morning(date: string, over: Partial<UpsertCheckInInput> = {}): UpsertCheckInInput {
  return { date, sleepQuality: 3, soreness: 3, energy: 3, ...over };
}

function seedRun(endDate: string, days: number, over: Partial<UpsertCheckInInput> = {}): void {
  for (let i = 1; i <= days; i++) upsertCheckIn(morning(addDays(endDate, -i), over));
}

test("one row per date — checking in again corrects the morning rather than adding another", () => {
  upsertCheckIn(morning("2020-01-05", { sleepQuality: 2 }));
  upsertCheckIn(morning("2020-01-05", { sleepQuality: 5 }));
  const rows = listCheckIns("2020-01-05", "2020-01-05");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sleepQuality, 5);
});

test("the optional fields patch: undefined keeps, null clears, a value sets", () => {
  upsertCheckIn(morning("2020-04-06", { restingHrBpm: 52, note: "slept badly" }));

  // A second tap that only changes the taps must not wipe the resting HR — the
  // regression that makes an athlete stop bothering to enter it.
  const kept = upsertCheckIn(morning("2020-04-06", { energy: 5 }));
  assert.equal(kept.restingHrBpm, 52);
  assert.equal(kept.note, "slept badly");
  assert.equal(kept.energy, 5);

  const cleared = upsertCheckIn(morning("2020-04-06", { restingHrBpm: null, note: null }));
  assert.equal(cleared.restingHrBpm, null);
  assert.equal(cleared.note, null);
});

test("the train-anyway override round-trips, patches like the rest, and can be taken back off", () => {
  upsertCheckIn(morning("2020-07-07", { trainAnywayOverride: true }));
  assert.equal(getCheckIn("2020-07-07")!.trainAnywayOverride, true);

  const untouched = upsertCheckIn(morning("2020-07-07", { soreness: 4 }));
  assert.equal(untouched.trainAnywayOverride, true, "correcting the taps must not silently cancel the override");

  const off = upsertCheckIn(morning("2020-07-07", { trainAnywayOverride: false }));
  assert.equal(off.trainAnywayOverride, false);
  assert.equal(getCheckIn("2020-07-07")!.trainAnywayOverride, false);
});

test("the override reaches the readiness, which is the one gate the week-adjusting layer reads", () => {
  seedRun("2021-02-10", SELF_BASELINE.minSamples);
  const rough = { sleepQuality: 1, soreness: 5, energy: 1 };

  // Explicit rather than defaulted: the override patches like every other
  // optional field, so a re-run against a database this test already wrote
  // would otherwise inherit the override set at the bottom of it.
  const acting = recordCheckIn(morning("2021-02-10", { ...rough, trainAnywayOverride: false }));
  assert.equal(acting.readiness.band, "very_low");
  assert.equal(acting.readiness.acting, true);

  const overridden = recordCheckIn(morning("2021-02-10", { ...rough, trainAnywayOverride: true }));
  assert.equal(overridden.readiness.acting, false);
  assert.equal(overridden.readiness.trainAnywayOverride, true);
  assert.equal(overridden.readiness.band, "very_low", "the health record is unchanged — only what the app does with it");
});

test("a day nobody answered has no readiness at all, rather than an average one", () => {
  assert.equal(readinessFor("2021-06-02"), null);
  upsertCheckIn(morning("2021-06-03"));
  assert.equal(readinessFor("2021-06-02"), null, "yesterday's silence is not today's score");
  assert.ok(readinessFor("2021-06-03"));
});

test("below five mornings the score is reported but the layer is stood down", () => {
  seedRun("2021-10-10", SELF_BASELINE.minSamples - 1);
  const { readiness } = recordCheckIn(morning("2021-10-10", { sleepQuality: 1, soreness: 5, energy: 1 }));
  assert.equal(readiness.score.value, 0);
  assert.equal(readiness.band, "very_low");
  assert.equal(readiness.acting, false);
  assert.equal(readiness.baseline.selfScore, null);
  assert.match(readiness.actingReason, /mornings/);
});

test("the athlete's own normal comes from the stored history — a pessimist's ordinary morning reads as ready", () => {
  const pessimist = { sleepQuality: 2, soreness: 3, energy: 3 };
  seedRun("2022-02-20", 10, pessimist);
  const { readiness } = recordCheckIn(morning("2022-02-20", pessimist));
  assert.equal(selfScoreOf({ date: "2022-02-20", ...pessimist } as CheckIn), 42);
  assert.equal(readiness.baseline.selfScore!.median, 42);
  assert.equal(readiness.band, "ready", "42 is this athlete's normal, and normal is not a reason to downgrade anything");
  assert.equal(readiness.acting, true);
});

test("the baseline is built from mornings BEFORE the day being judged, never from later ones", () => {
  // Five good mornings AFTER the date in question. If the history query let
  // them in, this rough Tuesday would be judged against a future it hasn't
  // lived yet.
  for (let i = 1; i <= 6; i++) upsertCheckIn(morning(addDays("2022-07-10", i), { sleepQuality: 5, soreness: 1, energy: 5 }));
  upsertCheckIn(morning("2022-07-10", { sleepQuality: 2, soreness: 4, energy: 2 }));
  const readiness = readinessFor("2022-07-10")!;
  assert.equal(readiness.baseline.selfScore, null, "later mornings are not evidence about an earlier one");
  assert.equal(readiness.acting, false);
  assert.equal(readiness.score.value, 25);
});

test("a resting heart rate only bites once five of the athlete's own readings are stored", () => {
  seedRun("2022-12-15", 4, { restingHrBpm: 50 });
  const inert = recordCheckIn(morning("2022-12-15", { restingHrBpm: 70 })).readiness;
  assert.equal(inert.components.restingHrPenalty, 0);

  seedRun("2023-04-15", 5, { restingHrBpm: 50 });
  const biting = recordCheckIn(morning("2023-04-15", { restingHrBpm: 70 })).readiness;
  assert.equal(biting.baseline.restingHr!.bpm, 50);
  assert.equal(biting.components.restingHrPenalty, 20);
  // Three neutral taps are 50; this athlete's own normal is also 50, so it is
  // shifted +12 to sit in the middle of ready; then 20 comes off for a
  // resting heart rate 20 beats above their own.
  assert.equal(biting.components.normalisation, 12);
  assert.equal(biting.score.value, 42);
  assert.equal(biting.band, "low", "a raised resting heart rate on an ordinary morning is enough to pull the band down");
});

test("what a check-in changed is stored verbatim and read back", () => {
  upsertCheckIn(morning("2023-09-14", { sleepQuality: 1, soreness: 5, energy: 1 }));
  const summaries = [
    {
      date: "2023-09-14",
      kind: "run_intervals" as const,
      action: "Made easy",
      reason: "Your morning came in well below your own normal, so today's intervals became a 40-minute easy run.",
    },
  ];
  const stored = recordCheckInAdjustments("2023-09-14", summaries);
  assert.deepEqual(stored.adjustments, summaries);
  assert.deepEqual(getCheckIn("2023-09-14")!.adjustments, summaries);
});

test("editing the check-in clears what the old answer changed, rather than leaving a claim the app can't back", () => {
  upsertCheckIn(morning("2023-12-15", { sleepQuality: 1, soreness: 5, energy: 1 }));
  recordCheckInAdjustments("2023-12-15", [
    { date: "2023-12-15", kind: "run_long", action: "Rest day", reason: "You were a long way below your own normal, so today became a rest day." },
  ]);
  assert.equal(getCheckIn("2023-12-15")!.adjustments.length, 1);

  const corrected = upsertCheckIn(morning("2023-12-15", { sleepQuality: 5, soreness: 1, energy: 5 }));
  assert.deepEqual(corrected.adjustments, [], "state that stopped being true must stop being shown");
  assert.deepEqual(getCheckIn("2023-12-15")!.adjustments, []);
});

test("the override survives the layer reporting back, and vice versa", () => {
  upsertCheckIn(morning("2024-03-16", { trainAnywayOverride: true }));
  const stored = recordCheckInAdjustments("2024-03-16", []);
  assert.equal(stored.trainAnywayOverride, true);
  assert.equal(getCheckIn("2024-03-16")!.trainAnywayOverride, true);
});

test("adjustments for a morning that was never answered, or naming a session this app doesn't prescribe, are refused", () => {
  assert.throws(
    () => recordCheckInAdjustments("2024-07-01", []),
    (e: unknown) => e instanceof InvalidCheckInError && /no check-in/.test((e as Error).message),
  );
  upsertCheckIn(morning("2024-07-02"));
  assert.throws(
    () => recordCheckInAdjustments("2024-07-02", [{ date: "2024-07-02", kind: "moon_walk" as never, action: "Made easy", reason: "Because." }]),
    InvalidCheckInError,
  );
  assert.throws(
    () => recordCheckInAdjustments("2024-07-02", [{ date: "2024-07-02", kind: "run_easy", action: "", reason: "Because." }]),
    InvalidCheckInError,
  );
});

test("a malformed check-in is refused by the same rules a form is, and nothing is written", () => {
  assert.throws(() => upsertCheckIn(morning("2026-13-01")), InvalidCheckInError);
  assert.throws(() => upsertCheckIn(morning("2024-11-01", { sleepQuality: 9 })), InvalidCheckInError);
  assert.throws(() => upsertCheckIn(morning("2024-11-01", { restingHrBpm: 250 })), InvalidCheckInError);
  assert.equal(getCheckIn("2024-11-01"), null);
});

test("listing is inclusive at both ends and comes back in date order", () => {
  for (const d of ["2025-03-03", "2025-03-01", "2025-03-05"]) upsertCheckIn(morning(d));
  const rows = listCheckIns("2025-03-01", "2025-03-03");
  assert.deepEqual(rows.map((r) => r.date), ["2025-03-01", "2025-03-03"]);
});
