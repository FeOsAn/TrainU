import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured } from "../measured";
import { predictStrength } from "./strength";

test("projects a small increase over a multi-month window", () => {
  const a = { ...DEFAULT_ATHLETE, squat1RmKg: measured(100, "5RM test, 1 Sep") };
  const p = predictStrength(a, "squat1RmKg", "2027-01-01", "2026-09-15");
  assert.ok(p.projectedOneRmKg > p.currentOneRmKg);
  assert.ok(p.weeksAvailable > 10);
});

test("projecting a seeded (never-tested) 1RM warns rather than presenting false precision", () => {
  const p = predictStrength(DEFAULT_ATHLETE, "ohp1RmKg", "2027-01-01", "2026-09-15");
  assert.equal(p.confidence.verifiedCount, 0);
  assert.match(p.note, /seed/);
});

test("a verified 1RM produces a note that doesn't warn about being a seed", () => {
  const a = { ...DEFAULT_ATHLETE, bench1RmKg: measured(90, "5RM test") };
  const p = predictStrength(a, "bench1RmKg", "2027-01-01", "2026-09-15");
  assert.equal(p.confidence.verifiedCount, 1);
  assert.doesNotMatch(p.note, /still a seed/);
});

test("zero time available projects no change", () => {
  const a = { ...DEFAULT_ATHLETE, deadlift1RmKg: measured(140, "test") };
  const p = predictStrength(a, "deadlift1RmKg", "2026-09-15", "2026-09-15");
  assert.equal(p.projectedOneRmKg, 140);
});
