import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicate, isSameActivity, mapExternalSportName, overlapRatio } from "./sessionDedupe";
import type { TrainingSession } from "./session";

function sess(over: Partial<TrainingSession>): TrainingSession {
  return {
    id: "id",
    date: "2026-08-07",
    sport: "run",
    source: "garmin",
    startTime: "2026-08-07 13:15:06",
    durationMinutes: 60,
    distanceKm: null,
    avgHeartRate: 140,
    maxHeartRate: null,
    avgPaceSecPerKm: null,
    avgPaceSecPer100m: null,
    avgPowerWatts: null,
    normalizedPower: null,
    tss: null,
    hrZonesJson: null,
    rpe: null,
    externalId: null,
    ...over,
  };
}

test("overlapping windows from two sources are the same activity", () => {
  const garmin = { date: "2026-08-07", startTime: "2026-08-07 13:15:06", durationMinutes: 89, avgHeartRate: 142 };
  const whoop = { date: "2026-08-07", startTime: "2026-08-07T13:21:00.180Z", durationMinutes: 68, avgHeartRate: 145 };
  const result = isSameActivity(whoop, garmin);
  assert.equal(result.match, true);
  assert.equal(result.basis, "overlap");
});

test("non-overlapping windows on the same day are not the same activity, even with similar HR", () => {
  const morning = { date: "2026-08-07", startTime: "2026-08-07 06:00:00", durationMinutes: 40, avgHeartRate: 140 };
  const evening = { date: "2026-08-07", startTime: "2026-08-07 18:00:00", durationMinutes: 40, avgHeartRate: 140 };
  assert.equal(isSameActivity(evening, morning).match, false);
});

test("a block that extends well beyond the ground truth is NOT called a duplicate (spanning-block guard)", () => {
  // Garmin recorded a 30-min swim; Whoop auto-detected the whole 90-min gym visit around it.
  const garminSwim = { date: "2026-08-07", startTime: "2026-08-07 13:15:06", durationMinutes: 30, avgHeartRate: 130 };
  const whoopBlock = { date: "2026-08-07", startTime: "2026-08-07 13:00:06", durationMinutes: 90, avgHeartRate: 128 };
  assert.equal(isSameActivity(whoopBlock, garminSwim).match, false);
});

test("fingerprint fallback matches on duration + HR when no start time is known", () => {
  const a = { date: "2026-08-07", durationMinutes: 60, avgHeartRate: 140 };
  const b = { date: "2026-08-07", durationMinutes: 58, avgHeartRate: 143 };
  const result = isSameActivity(a, b);
  assert.equal(result.match, true);
  assert.equal(result.basis, "fingerprint");
});

test("fingerprint fallback makes no claim when heart rate is missing on either side", () => {
  const a = { date: "2026-08-07", durationMinutes: 60, avgHeartRate: null };
  const b = { date: "2026-08-07", durationMinutes: 58, avgHeartRate: 143 };
  assert.equal(isSameActivity(a, b).match, false);
});

test("overlapRatio is 0 for disjoint windows and 1 for an identical window", () => {
  // a: 0-10min (0-600,000ms). b starting at 700,000ms starts after a already ended.
  assert.equal(overlapRatio(0, 10, 700_000, 10), 0);
  assert.equal(overlapRatio(0, 30, 0, 30), 1);
});

test("findDuplicate returns the matching existing session, or null", () => {
  const existing = [sess({ id: "a" })];
  const candidate = sess({ id: "b", source: "whoop", startTime: "2026-08-07T13:21:00.180Z", durationMinutes: 58 });
  assert.equal(findDuplicate(candidate, existing), existing[0]);
  assert.equal(findDuplicate(sess({ id: "c", date: "2026-01-01" }), existing), null);
});

test("mapExternalSportName is name-first and falls back to 'other'", () => {
  assert.equal(mapExternalSportName("Cycling"), "bike");
  assert.equal(mapExternalSportName("Functional Fitness"), "strength");
  assert.equal(mapExternalSportName("Weightlifting"), "strength");
  assert.equal(mapExternalSportName(null), "other");
  assert.equal(mapExternalSportName("Kayaking"), "other");
});
