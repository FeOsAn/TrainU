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
  rpeFor,
} from "./templates";
import * as templates from "./templates";
import { DEFAULT_ATHLETE } from "../athlete";
import { estimateSessionTss } from "../trainingLoad";

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

/*
 * ─── The two exchange rates that disagreed ────────────────────────────────
 *
 * `SPORT_EQUIVALENCE` is derived from `SPORT_FALLBACK_PER_MIN`, which prices
 * a LOGGED session that arrived with nothing but a duration. A PLANNED
 * session is priced by `rpeTss`, which is sport-blind. Those are two
 * different answers to "what does a minute of this cost", and sizing a
 * substitute with the first one multiplied a week denominated in the second.
 * These tests exist so the next person reads the disagreement rather than
 * re-deriving the bug from the doc comment.
 */

test("a PLANNED session is priced sport-blind, which is why SPORT_EQUIVALENCE must not size one", () => {
  const minutes = 60;
  const asRun = estimateSessionTss({ sport: "run", durationMinutes: minutes, rpe: 4 }, DEFAULT_ATHLETE);
  const asBike = estimateSessionTss({ sport: "bike", durationMinutes: minutes, rpe: 4 }, DEFAULT_ATHLETE);
  const asSwim = estimateSessionTss({ sport: "swim", durationMinutes: minutes, rpe: 4 }, DEFAULT_ATHLETE);
  assert.equal(asBike, asRun, "the prescriber's pricer does not know a ride from a run");
  assert.equal(asSwim, asRun);

  // And the energy table says they differ by 21% and 70%. Both statements are
  // true of their own domain; only one of them is the currency a prescribed
  // week is counted in.
  assert.ok(SPORT_EQUIVALENCE.run.bike > 1.2, "the energy table says a ride must be LONGER");
  assert.ok(SPORT_EQUIVALENCE.run.swim > SPORT_EQUIVALENCE.run.bike, "and a swim longer still");

  // So converting minutes up by the energy rate and then pricing the result
  // with the planned pricer INFLATES the session — which is exactly what an
  // injured athlete's week did.
  const inflated = Math.round(minutes * SPORT_EQUIVALENCE.run.bike);
  assert.ok(
    estimateSessionTss({ sport: "bike", durationMinutes: inflated, rpe: 4 }, DEFAULT_ATHLETE) > asRun,
    "a substitute sized by the energy table costs MORE than the session it replaces",
  );
});

test("the table is still internally honest about what it does say", () => {
  for (const sport of Object.keys(SPORT_EQUIVALENCE) as Array<keyof typeof SPORT_EQUIVALENCE>) {
    assert.equal(SPORT_EQUIVALENCE[sport][sport], 1, `${sport} → ${sport} must be a no-op`);
  }
});

test("equivalentMinutes is gone — no one gets to size a substitute across sports again", () => {
  // It had exactly two callers, both in the conditions slice, and both were
  // the defect. Leaving it exported is leaving the trap baited.
  assert.ok(!("equivalentMinutes" in templates), "equivalentMinutes is back");
});

test("every session kind has a sport, and every sport has an exchange rate", () => {
  for (const kind of SESSION_KINDS) {
    const sport = SPORT_OF[kind as SessionKind];
    assert.ok(SPORT_EQUIVALENCE[sport], `${kind} maps to ${sport}, which has no exchange rate`);
  }
});
