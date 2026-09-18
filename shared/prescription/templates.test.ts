import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_KINDS, type SessionKind } from "./sessionKinds";
import {
  DOWNGRADE,
  HARD_KINDS,
  INTENSITY_OF,
  KIND_MINUTES,
  SPORT_EQUIVALENCE,
  SPORT_OF,
  applyCeiling,
  clampKind,
  downgradeToEasy,
  equivalentMinutes,
  rpeFor,
} from "./templates";

test("downgradeToEasy reaches a fixed point for every session kind", () => {
  for (const kind of SESSION_KINDS) {
    const eased = downgradeToEasy(kind);
    assert.equal(downgradeToEasy(eased), eased, `${kind} → ${eased} is not a fixed point`);
    assert.equal(DOWNGRADE[eased] ?? eased, eased, `${eased} still has somewhere to fall`);
  }
});

test("nothing downgrades to a hard session — the bug this function exists for", () => {
  // applyCeiling walked DOWNGRADE exactly one step, so run_intervals under an
  // "easy" ceiling came out as run_threshold: a threshold session prescribed
  // to an athlete who was told to take it easy.
  assert.equal(downgradeToEasy("run_intervals"), "run_easy");
  assert.equal(downgradeToEasy("run_threshold"), "run_easy");
  assert.equal(downgradeToEasy("compromised"), "run_easy");
  for (const kind of SESSION_KINDS) {
    assert.ok(!HARD_KINDS.has(downgradeToEasy(kind)), `${kind} still ends up hard`);
    assert.notEqual(INTENSITY_OF[downgradeToEasy(kind)], "hard");
  }
});

test("a kind with nowhere to fall is returned unchanged", () => {
  assert.equal(downgradeToEasy("run_easy"), "run_easy");
  assert.equal(downgradeToEasy("strength_lower"), "strength_lower");
  assert.equal(downgradeToEasy("rest"), "rest");
});

test("applyCeiling('easy') IS downgradeToEasy — two mechanisms would drift", () => {
  for (const kind of SESSION_KINDS) {
    assert.equal(applyCeiling(kind, "easy"), downgradeToEasy(kind), kind);
  }
});

test("the other ceilings are unchanged", () => {
  for (const kind of SESSION_KINDS) {
    assert.equal(applyCeiling(kind, "full"), kind, "a full ceiling permits everything");
  }
  assert.equal(applyCeiling("run_intervals", "threshold"), "run_threshold");
  assert.equal(applyCeiling("compromised", "threshold"), "run_easy");
  assert.equal(applyCeiling("run_threshold", "threshold"), "run_threshold", "threshold is the ceiling, not above it");
});

test("HARD_KINDS is exactly the kinds priced as hard", () => {
  for (const kind of SESSION_KINDS) {
    assert.equal(HARD_KINDS.has(kind), INTENSITY_OF[kind] === "hard", kind);
  }
  assert.equal(rpeFor("run_intervals"), 8);
  assert.equal(rpeFor("run_easy"), 4);
  assert.equal(rpeFor("rest"), 1);
});

test("clampKind keeps every kind inside its own plausible range", () => {
  for (const kind of SESSION_KINDS) {
    const { min, max } = KIND_MINUTES[kind];
    assert.equal(clampKind(kind, 0), min, kind);
    assert.equal(clampKind(kind, 10_000), max, kind);
    assert.ok(clampKind(kind, 55) >= min && clampKind(kind, 55) <= max, kind);
  }
});

test("substituting across sports preserves LOAD, not minutes", () => {
  // SPORT_FALLBACK_PER_MIN: run 0.85, bike 0.70, swim 0.50. An hour of
  // running is ~73 minutes of riding, not 60 — swapping minute-for-minute
  // would quietly delete 18% of the week's stress and call it a substitution.
  assert.ok(Math.abs(SPORT_EQUIVALENCE.run.bike - 0.85 / 0.7) < 0.01);
  assert.ok(SPORT_EQUIVALENCE.run.bike > 1, "a ride must be LONGER than the run it replaces");
  assert.ok(SPORT_EQUIVALENCE.run.swim > SPORT_EQUIVALENCE.run.bike, "and a swim longer still");
  for (const sport of Object.keys(SPORT_EQUIVALENCE) as Array<keyof typeof SPORT_EQUIVALENCE>) {
    assert.equal(SPORT_EQUIVALENCE[sport][sport], 1, `${sport} → ${sport} must be a no-op`);
  }
});

test("an equivalent session is still a plausible session of its own kind", () => {
  const ride = equivalentMinutes("run_long", "bike_endurance", 120);
  assert.ok(ride > 120, "a ride replacing a two-hour long run is longer than two hours");
  assert.ok(ride <= KIND_MINUTES.bike_endurance.max);

  for (const from of SESSION_KINDS) {
    for (const to of SESSION_KINDS) {
      if (to === "rest") continue;
      for (const minutes of [0, 30, 90, 300]) {
        const out = equivalentMinutes(from, to, minutes);
        assert.ok(
          out >= KIND_MINUTES[to].min && out <= KIND_MINUTES[to].max,
          `${from} ${minutes}min → ${to} came out at ${out}`,
        );
      }
    }
  }
});

test("every session kind has a sport, and every sport has an exchange rate", () => {
  for (const kind of SESSION_KINDS) {
    const sport = SPORT_OF[kind as SessionKind];
    assert.ok(SPORT_EQUIVALENCE[sport], `${kind} maps to ${sport}, which has no exchange rate`);
  }
});
