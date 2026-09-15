import { test } from "node:test";
import assert from "node:assert/strict";
import { assessConfidence, measured, seeded, valueOf, widenForConfidence } from "./measured";

test("measured() marks a value verified, seeded() does not", () => {
  const m = measured(285, "FTP test, 12 Oct", "2026-10-12");
  assert.equal(m.verified, true);
  assert.equal(valueOf(m), 285);

  const s = seeded(285);
  assert.equal(s.verified, false);
  assert.match(s.source, /seed/);
});

test("assessConfidence counts verified vs unverified fields", () => {
  const c = assessConfidence({
    ftpWatts: measured(285, "test"),
    bikeCdA: seeded(0.32),
    weightKg: measured(75, "scale"),
  });
  assert.equal(c.totalCount, 3);
  assert.equal(c.verifiedCount, 2);
  assert.deepEqual(c.unverifiedFields, ["bikeCdA"]);
});

test("widenForConfidence returns the base band when everything is verified", () => {
  const c = assessConfidence({ a: measured(1, "x"), b: measured(2, "y") });
  assert.equal(widenForConfidence(5, c), 5);
});

test("widenForConfidence widens the band as more inputs are guessed", () => {
  const allGuessed = assessConfidence({ a: seeded(1), b: seeded(2) });
  const halfGuessed = assessConfidence({ a: measured(1, "x"), b: seeded(2) });
  const noneGuessed = assessConfidence({ a: measured(1, "x"), b: measured(2, "y") });

  const bandAll = widenForConfidence(5, allGuessed);
  const bandHalf = widenForConfidence(5, halfGuessed);
  const bandNone = widenForConfidence(5, noneGuessed);

  assert.ok(bandAll > bandHalf, "fully-guessed band should be wider than half-guessed");
  assert.ok(bandHalf > bandNone, "half-guessed band should be wider than fully-verified");
  assert.equal(bandNone, 5);
});

test("widenForConfidence with no inputs at all returns the base unchanged", () => {
  const c = assessConfidence({});
  assert.equal(widenForConfidence(5, c), 5);
});
