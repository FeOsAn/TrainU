import { test } from "node:test";
import assert from "node:assert/strict";
import { appleWorkoutToSession, importAppleHealthExport, parseAppleHealthExport } from "./appleHealth";
import type { TrainingSession } from "@shared/session";

const SAMPLE_EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" value="72"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="32.5" durationUnit="min" totalDistance="5.2" totalDistanceUnit="km" totalEnergyBurned="320" totalEnergyBurnedUnit="kcal" sourceName="Apple Watch" startDate="2026-09-01 07:00:00 -0700" endDate="2026-09-01 07:32:30 -0700">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
  </Workout>
  <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" sourceName="Apple Watch" startDate="2026-09-02 18:00:00 -0700" endDate="2026-09-02 18:45:00 -0700"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="60" durationUnit="min" totalDistance="20" totalDistanceUnit="mi" startDate="2026-09-03 08:00:00 -0700" endDate="2026-09-03 09:00:00 -0700"/>
</HealthData>`;

test("parses every Workout element in the export, ignoring non-Workout Records", () => {
  const workouts = parseAppleHealthExport(SAMPLE_EXPORT);
  assert.equal(workouts.length, 3);
});

test("extracts duration, distance, and dates correctly for a run", () => {
  const [run] = parseAppleHealthExport(SAMPLE_EXPORT);
  assert.equal(run!.activityType, "HKWorkoutActivityTypeRunning");
  assert.equal(run!.durationMinutes, 33); // 32.5 rounds to 33
  assert.equal(run!.distanceKm, 5.2);
  assert.equal(run!.startDate, new Date("2026-09-01T07:00:00-07:00").toISOString());
});

test("a workout with no distance (strength training) parses fine with distanceKm undefined", () => {
  const workouts = parseAppleHealthExport(SAMPLE_EXPORT);
  const strength = workouts.find((w) => w.activityType.includes("Strength"))!;
  assert.equal(strength.distanceKm, undefined);
  assert.equal(strength.durationMinutes, 45);
});

test("converts miles to km when totalDistanceUnit is mi", () => {
  const workouts = parseAppleHealthExport(SAMPLE_EXPORT);
  const ride = workouts.find((w) => w.activityType.includes("Cycling"))!;
  assert.ok(Math.abs(ride.distanceKm! - 32.19) < 0.1, `expected ~32.19 km for 20 miles, got ${ride.distanceKm}`);
});

test("a malformed or incomplete Workout tag is skipped, not thrown", () => {
  const xml = `<Workout workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2026-09-01 07:00:00 -0700"/>`; // missing endDate
  assert.doesNotThrow(() => parseAppleHealthExport(xml));
  assert.equal(parseAppleHealthExport(xml).length, 0);
});

test("appleWorkoutToSession maps the HK activity type prefix to our Sport union and sets source apple_health", () => {
  const [run] = parseAppleHealthExport(SAMPLE_EXPORT);
  const session = appleWorkoutToSession(run!, "test-id");
  assert.equal(session.sport, "run");
  assert.equal(session.source, "apple_health");
  assert.equal(session.distanceKm, 5.2);
});

test("importAppleHealthExport inserts new workouts and skips ones that already exist as duplicates", () => {
  const inserted: TrainingSession[] = [];
  const existing: TrainingSession[] = [];
  const result = importAppleHealthExport(SAMPLE_EXPORT, existing, (s) => inserted.push(s));
  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 3);
  assert.equal(inserted.length, 3);

  // Importing the exact same export again must not double-insert (same externalId).
  const secondInserted: TrainingSession[] = [];
  const secondResult = importAppleHealthExport(SAMPLE_EXPORT, existing, (s) => secondInserted.push(s));
  assert.equal(secondResult.inserted, 0);
  assert.equal(secondInserted.length, 0);
});
