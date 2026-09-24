import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ATHLETE,
  FRESH_KM_TO_5K,
  FRESH_KM_TO_EASY,
  athleteParamsFromRow,
} from "./athlete";
import { measured } from "./measured";

/*
 * ─── Derived running paces ────────────────────────────────────────────────
 *
 * Found by finishing the onboarding survey and reading the Athlete page: an
 * athlete who handed over a 19:30 5 km got a measured 3:32/km fresh kilometre
 * next to a 4:40/km "5 km pace" and a 5:54/km easy pace — both still seeds
 * derived from a threshold they no longer have. `prescribe.ts` prints easy
 * pace off `runEasySecPerKm`, so that seed was on every easy-run card.
 */

test("a measured kilometre re-derives the paces that are functions of it", () => {
  const km = 212; // 3:32/km, a 19:30 5 km projected back to a kilometre
  const params = athleteParamsFromRow({ runThresholdSecPerKm: measured(km, "5 km in 19:30, projected to 1 km", "2026-09-24") });

  assert.equal(params.runEasySecPerKm.value, Math.round(km * FRESH_KM_TO_EASY));
  assert.equal(params.run5kSecPerKm.value, Math.round(km * FRESH_KM_TO_5K));
  assert.ok(params.runEasySecPerKm.value < DEFAULT_ATHLETE.runEasySecPerKm.value, "a faster athlete gets a faster easy pace, not the seed");
  assert.equal(params.run5kSecPerKm.value, 233, "3:53/km — the pace a 19:30 5 km actually is, against a 4:40 seed");
});

test("derived is not measured — the confidence band has to keep saying so", () => {
  const params = athleteParamsFromRow({ runThresholdSecPerKm: measured(212, "1 km time trial", "2026-09-24") });
  assert.equal(params.runEasySecPerKm.verified, false);
  assert.match(params.runEasySecPerKm.source, /derived from your measured kilometre/);
  assert.equal(params.runEasySecPerKm.asOf, "2026-09-24");
});

test("a real measured easy pace always beats a derived one", () => {
  // Logged easy runs are evidence about easy pace itself; the kilometre is not.
  const params = athleteParamsFromRow({
    runThresholdSecPerKm: measured(212, "1 km time trial"),
    runEasySecPerKm: measured(300, "median of 6 easy runs in the last six weeks"),
  });
  assert.equal(params.runEasySecPerKm.value, 300);
  assert.equal(params.runEasySecPerKm.verified, true);
});

test("a seeded kilometre derives nothing — seeds stay exactly as they were", () => {
  const params = athleteParamsFromRow(null);
  assert.deepEqual(params.runEasySecPerKm, DEFAULT_ATHLETE.runEasySecPerKm);
  assert.deepEqual(params.run5kSecPerKm, DEFAULT_ATHLETE.run5kSecPerKm);
});

test("a derivation that lands outside plausible bounds is refused, not stored", () => {
  // 700 s/km is inside runThresholdSecPerKm's bounds [120, 720]; × 1.36 is
  // 952, outside runEasySecPerKm's [150, 900]. Better the old seed than a
  // number the athlete model itself says is impossible.
  const params = athleteParamsFromRow({ runThresholdSecPerKm: measured(700, "a very slow kilometre") });
  assert.deepEqual(params.runEasySecPerKm, DEFAULT_ATHLETE.runEasySecPerKm);
});
