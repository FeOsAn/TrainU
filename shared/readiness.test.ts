import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_IN_MAX,
  CHECK_IN_MIN,
  READINESS_BAND_LABELS,
  READINESS_BAND_MEANINGS,
  READINESS_BAND_VALUES,
  READY_CENTRE,
  RESTING_HR_BASELINE,
  SELF_BASELINE,
  bandFor,
  computeReadiness,
  restingHrBaselineOn,
  selfScoreBaselineOn,
  selfScoreOf,
  validateCheckIn,
  type CheckIn,
} from "./readiness";
import { addDays } from "./dates";

const TODAY = "2026-09-18";

function checkIn(over: Partial<CheckIn> = {}): CheckIn {
  return { date: TODAY, sleepQuality: 3, soreness: 3, energy: 3, ...over };
}

/** `n` mornings ending the day before `TODAY`, all reporting the same thing. */
function historyOf(n: number, over: Partial<CheckIn> = {}): CheckIn[] {
  return Array.from({ length: n }, (_, i) => checkIn({ date: addDays(TODAY, -(i + 1)), ...over }));
}

/* ─── The formula ────────────────────────────────────────────────────────── */

test("the three taps span 0-100, with the neutral answer landing at 50", () => {
  assert.equal(selfScoreOf(checkIn({ sleepQuality: 1, soreness: 5, energy: 1 })), 0);
  assert.equal(selfScoreOf(checkIn({ sleepQuality: 5, soreness: 1, energy: 5 })), 100);
  assert.equal(selfScoreOf(checkIn({ sleepQuality: 3, soreness: 3, energy: 3 })), 50);
});

test("soreness is inverted — more soreness is fewer points", () => {
  const easy = selfScoreOf(checkIn({ soreness: 1 }));
  const wrecked = selfScoreOf(checkIn({ soreness: 5 }));
  assert.ok(easy > wrecked, "1 = no soreness must score better than 5 = wrecked");
  assert.equal(easy, 67);
  assert.equal(wrecked, 33);
});

test("the worked examples from the design hold exactly", () => {
  assert.equal(selfScoreOf(checkIn({ sleepQuality: 2, soreness: 4, energy: 2 })), 25);
  assert.equal(selfScoreOf(checkIn({ sleepQuality: 2, soreness: 3, energy: 3 })), 42);
});

test("bands split at 30 / 45 / 80, with the edges on the right side", () => {
  assert.equal(bandFor(0), "very_low");
  assert.equal(bandFor(29), "very_low");
  assert.equal(bandFor(30), "low");
  assert.equal(bandFor(44), "low");
  assert.equal(bandFor(45), "ready");
  assert.equal(bandFor(79), "ready");
  assert.equal(bandFor(80), "high");
  assert.equal(bandFor(100), "high");
});

test("every component adds up to the score, for every possible morning", () => {
  for (let sleep = CHECK_IN_MIN; sleep <= CHECK_IN_MAX; sleep++) {
    for (let soreness = CHECK_IN_MIN; soreness <= CHECK_IN_MAX; soreness++) {
      for (let energy = CHECK_IN_MIN; energy <= CHECK_IN_MAX; energy++) {
        const r = computeReadiness(checkIn({ sleepQuality: sleep, soreness, energy }));
        const c = r.components;
        const sum = c.sleep + c.soreness + c.energy + c.normalisation + (c.wearable ?? 0) - c.restingHrPenalty + c.clamp;
        assert.equal(sum, r.score.value, `${sleep}/${soreness}/${energy} does not add up`);
        assert.equal(c.sleep + c.soreness + c.energy, selfScoreOf(checkIn({ sleepQuality: sleep, soreness, energy })));
      }
    }
  }
});

test("the sum still holds once a baseline, a heart rate and a wearable are all in play", () => {
  const history = historyOf(6, { sleepQuality: 2, soreness: 4, energy: 2, restingHrBpm: 50 });
  const r = computeReadiness(
    checkIn({ sleepQuality: 5, soreness: 1, energy: 5, restingHrBpm: 62 }),
    history,
    { wearable: { score: 90, source: "Whoop recovery", asOf: TODAY } },
  );
  const c = r.components;
  const sum = c.sleep + c.soreness + c.energy + c.normalisation + (c.wearable ?? 0) - c.restingHrPenalty + c.clamp;
  assert.equal(sum, r.score.value);
  assert.ok(c.normalisation > 0 && c.restingHrPenalty > 0 && c.wearable !== null, "this fixture exercises all three");
});

test("the score is held inside 0-100, and says so rather than hiding the correction", () => {
  // A pessimist's best morning ever: their own normal is 25, so the shift is
  // +37 and the raw 100 would come out at 137.
  const r = computeReadiness(checkIn({ sleepQuality: 5, soreness: 1, energy: 5 }), historyOf(6, { sleepQuality: 2, soreness: 4, energy: 2 }));
  assert.equal(r.score.value, 100);
  assert.equal(r.components.clamp, -37);
  const c = r.components;
  assert.equal(c.sleep + c.soreness + c.energy + c.normalisation - c.restingHrPenalty + c.clamp, r.score.value);
  assert.ok(r.explanation.some((line) => line.includes("Held at 100")));
});

/* ─── The score is Measured, and honest about it ─────────────────────────── */

test("a self-reported score is not verified, and says where it came from", () => {
  const r = computeReadiness(checkIn());
  assert.equal(r.score.verified, false);
  assert.equal(r.score.source, `self-reported check-in, ${TODAY}`);
  assert.equal(r.score.asOf, TODAY);
});

test("the declared wearable slot is what makes it verified — and it is not wired to anything", () => {
  const r = computeReadiness(checkIn({ sleepQuality: 3, soreness: 3, energy: 3 }), [], {
    wearable: { score: 30, source: "Whoop recovery", asOf: TODAY },
  });
  assert.equal(r.score.verified, true);
  assert.match(r.score.source, /Whoop recovery/);
  // Half and half: 0.5 * 30 + 0.5 * 50 = 40.
  assert.equal(r.score.value, 40);
  assert.equal(r.components.wearable, -10);
  // Nothing populates the slot today, so the ordinary path stays unverified.
  assert.equal(computeReadiness(checkIn()).score.verified, false);
});

/* ─── The resting-HR penalty is inert without the athlete's own baseline ─── */

test("a resting heart rate cannot move the score until five of the athlete's own mornings exist", () => {
  const belowThreshold = historyOf(RESTING_HR_BASELINE.minSamples - 1, { restingHrBpm: 50 });
  const r = computeReadiness(checkIn({ restingHrBpm: 75 }), belowThreshold);
  assert.equal(r.components.restingHrPenalty, 0, "a guessed baseline must never silently move the number");
  assert.equal(r.baseline.restingHr, null);
  assert.equal(r.score.value, selfScoreOf(checkIn()), "the score is the raw self report and nothing else");
  assert.ok(
    r.explanation.some((line) => line.includes("75") && /mornings/.test(line)),
    "the athlete is told the reading was taken and why it did not count",
  );
});

test("once the baseline exists, the penalty steps at +5 and +10 beats", () => {
  const history = historyOf(RESTING_HR_BASELINE.minSamples, { restingHrBpm: 50 });
  const penaltyAt = (bpm: number) => computeReadiness(checkIn({ restingHrBpm: bpm }), history).components.restingHrPenalty;
  assert.equal(penaltyAt(50), 0);
  assert.equal(penaltyAt(54), 0);
  assert.equal(penaltyAt(55), 10);
  assert.equal(penaltyAt(59), 10);
  assert.equal(penaltyAt(60), 20);
  assert.equal(penaltyAt(90), 20);
  assert.equal(penaltyAt(40), 0, "a resting HR BELOW your own baseline is never a penalty");
});

test("the baseline is the athlete's own median, and today's own reading is not part of it", () => {
  const history = [
    checkIn({ date: addDays(TODAY, -1), restingHrBpm: 48 }),
    checkIn({ date: addDays(TODAY, -2), restingHrBpm: 50 }),
    checkIn({ date: addDays(TODAY, -3), restingHrBpm: 52 }),
    checkIn({ date: addDays(TODAY, -4), restingHrBpm: 49 }),
    checkIn({ date: addDays(TODAY, -5), restingHrBpm: 51 }),
    // One reading taken after running up the stairs. A mean would drag; a median does not.
    checkIn({ date: addDays(TODAY, -6), restingHrBpm: 92 }),
    checkIn({ date: TODAY, restingHrBpm: 80 }),
  ];
  const baseline = restingHrBaselineOn(history, TODAY);
  assert.deepEqual(baseline, { bpm: 51, samples: 6 });
});

test("readings older than the window, and rows past the most recent fourteen, are not baseline", () => {
  const stale = Array.from({ length: 8 }, (_, i) =>
    checkIn({ date: addDays(TODAY, -(RESTING_HR_BASELINE.maxAgeDays + i + 1)), restingHrBpm: 50 }),
  );
  assert.equal(restingHrBaselineOn(stale, TODAY), null, "a resting HR from four months ago is not your baseline now");

  const many = Array.from({ length: 20 }, (_, i) =>
    checkIn({ date: addDays(TODAY, -(i + 1)), restingHrBpm: i < RESTING_HR_BASELINE.maxRows ? 50 : 90 }),
  );
  assert.equal(restingHrBaselineOn(many, TODAY)!.samples, RESTING_HR_BASELINE.maxRows);
  assert.equal(restingHrBaselineOn(many, TODAY)!.bpm, 50, "the older rows must not reach the median at all");
});

/* ─── DECISIONS C2: the bands are the athlete's own ──────────────────────── */

test("a habitually pessimistic athlete's ordinary morning reads as ready, not as under par", () => {
  const pessimist = checkIn({ sleepQuality: 2, soreness: 3, energy: 3 });
  const cold = computeReadiness(pessimist, []);
  assert.equal(cold.band, "low", "with no history to compare against, 42 is 42");
  assert.equal(cold.acting, false, "and on that evidence the week is not touched");

  const theirNormal = computeReadiness(pessimist, historyOf(10, { sleepQuality: 2, soreness: 3, energy: 3 }));
  assert.equal(theirNormal.baseline.selfScore!.median, 42);
  assert.equal(theirNormal.score.value, READY_CENTRE);
  assert.equal(theirNormal.band, "ready", "their ordinary Tuesday must not downgrade every hard session forever");
  assert.equal(theirNormal.acting, true);
});

test("normalising restores sensitivity at the other end — an optimist's off day still registers", () => {
  const optimistHistory = historyOf(10, { sleepQuality: 5, soreness: 1, energy: 5 });
  const offDay = computeReadiness(checkIn({ sleepQuality: 4, soreness: 2, energy: 4 }), optimistHistory);
  assert.equal(offDay.baseline.selfScore!.median, 100);
  assert.equal(offDay.band, "low", "75 out of 100 is a bad morning for someone who reports 100 every day");

  // Against fixed absolute bands that same morning would have read as ready
  // and nothing would ever have acted on it.
  assert.equal(bandFor(selfScoreOf(checkIn({ sleepQuality: 4, soreness: 2, energy: 4 }))), "ready");
});

test("a genuinely bad morning still drops the pessimist's band", () => {
  const history = historyOf(10, { sleepQuality: 2, soreness: 3, energy: 3 });
  const rough = computeReadiness(checkIn({ sleepQuality: 1, soreness: 5, energy: 1 }), history);
  assert.equal(rough.band, "very_low");
  assert.equal(rough.acting, true);
});

test("acting is false until the athlete's own normal exists, and true the morning it does", () => {
  for (let n = 0; n < SELF_BASELINE.minSamples; n++) {
    const r = computeReadiness(checkIn({ sleepQuality: 1, soreness: 5, energy: 1 }), historyOf(n));
    assert.equal(r.acting, false, `${n} mornings is not enough to restructure a week`);
    assert.equal(r.baseline.selfScore, null);
    assert.equal(r.components.normalisation, 0, "no baseline means no shift, not a guessed one");
    assert.equal(r.band, "very_low", "it may still flag — it just may not act");
  }
  const enough = computeReadiness(checkIn({ sleepQuality: 1, soreness: 5, energy: 1 }), historyOf(SELF_BASELINE.minSamples));
  assert.equal(enough.acting, true);
  assert.equal(enough.baseline.selfScore!.samples, SELF_BASELINE.minSamples);
});

test("check-ins outside the trailing window, and today's own row, are not part of the athlete's normal", () => {
  const stale = Array.from({ length: 10 }, (_, i) =>
    checkIn({ date: addDays(TODAY, -(SELF_BASELINE.windowDays + i + 1)) }),
  );
  assert.equal(selfScoreBaselineOn(stale, TODAY), null, "state that stopped being current stops counting");

  const withToday = [...historyOf(5, { sleepQuality: 2, soreness: 3, energy: 3 }), checkIn({ sleepQuality: 5, soreness: 1, energy: 5 })];
  assert.equal(selfScoreBaselineOn(withToday, TODAY)!.median, 42, "a morning cannot be its own baseline");
});

/* ─── DECISIONS B7: the override ─────────────────────────────────────────── */

test("train-anyway stands the layer down, even on a very low morning with a full baseline", () => {
  const history = historyOf(10);
  const without = computeReadiness(checkIn({ sleepQuality: 1, soreness: 5, energy: 1 }), history);
  assert.equal(without.acting, true);

  const with_ = computeReadiness(checkIn({ sleepQuality: 1, soreness: 5, energy: 1, trainAnywayOverride: true }), history);
  assert.equal(with_.acting, false, "the one gate the slice reads must be closed by the override");
  assert.equal(with_.trainAnywayOverride, true, "and the UI must be able to see it is on, to offer to take it off");
  assert.equal(with_.band, without.band, "the honest record of how they felt is unchanged — only what the app does with it");
  assert.equal(with_.score.value, without.score.value);
  assert.match(with_.actingReason, /train as prescribed/i);
});

/* ─── Words, not ids ─────────────────────────────────────────────────────── */

test("no band id, and no field id, ever reaches the athlete", () => {
  const cases = [
    computeReadiness(checkIn({ sleepQuality: 1, soreness: 5, energy: 1, restingHrBpm: 70 }), historyOf(10, { restingHrBpm: 50 })),
    computeReadiness(checkIn({ restingHrBpm: 70 })),
    computeReadiness(checkIn({ trainAnywayOverride: true }), historyOf(10)),
    computeReadiness(checkIn({ sleepQuality: 5, soreness: 1, energy: 5 }), historyOf(10, { sleepQuality: 1, soreness: 5, energy: 1 }), {
      wearable: { score: 88, source: "Whoop recovery", asOf: TODAY },
    }),
  ];
  // "low" and "high" are ordinary English words; what must never appear is an
  // IDENTIFIER — anything snake_cased or camelCased, which is always a field
  // or an enum value that escaped a label table.
  const forbidden = [...READINESS_BAND_VALUES.filter((b) => b.includes("_")), "sleepQuality", "restingHrBpm", "trainAnywayOverride"];
  for (const r of cases) {
    for (const line of [...r.explanation, r.note, r.actingReason]) {
      for (const id of forbidden) {
        assert.ok(!line.includes(id), `"${line}" leaks the id "${id}"`);
      }
      assert.ok(!/[a-z]_[a-z]|[a-z][A-Z]/.test(line), `"${line}" contains an identifier-shaped token`);
      assert.ok(line.trim().length > 0 && line.trim().endsWith("."), `"${line}" should be a complete sentence`);
    }
  }
});

test("every band has athlete-facing words and a meaning", () => {
  for (const band of READINESS_BAND_VALUES) {
    assert.ok(READINESS_BAND_LABELS[band].length > 0);
    assert.ok(READINESS_BAND_MEANINGS[band].endsWith("."));
  }
});

/* ─── Purity ─────────────────────────────────────────────────────────────── */

test("computing a readiness mutates neither the check-in nor the history", () => {
  const today = Object.freeze(checkIn({ restingHrBpm: 60 }));
  const history = historyOf(10, { restingHrBpm: 50 }).map((c) => Object.freeze(c));
  Object.freeze(history);
  const r = computeReadiness(today, history);
  assert.equal(r.date, TODAY);
  assert.deepEqual(today, { date: TODAY, sleepQuality: 3, soreness: 3, energy: 3, restingHrBpm: 60 });
});

/* ─── Validation ─────────────────────────────────────────────────────────── */

test("validation rejects what a form or a chat tool could get wrong, in plain words", () => {
  assert.equal(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 3, energy: 3 }), null);
  assert.match(validateCheckIn({ date: "2026-02-30", sleepQuality: 3, soreness: 3, energy: 3 })!, /real date/);
  assert.match(validateCheckIn({ sleepQuality: 3, soreness: 3, energy: 3 })!, /real date/);
  assert.match(validateCheckIn({ date: TODAY, sleepQuality: 0, soreness: 3, energy: 3 })!, /Sleep/);
  assert.match(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 6, energy: 3 })!, /Soreness/);
  assert.match(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 3, energy: 2.5 })!, /Energy/);
  assert.match(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 3, energy: 3, restingHrBpm: 250 })!, /heart rate/);
  assert.match(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 3, energy: 3, restingHrBpm: 55.5 })!, /heart rate/);
  assert.equal(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 3, energy: 3, restingHrBpm: null }), null);
  assert.match(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 3, energy: 3, note: "x".repeat(501) })!, /characters/);
  assert.match(validateCheckIn({ date: TODAY, sleepQuality: 3, soreness: 3, energy: 3, trainAnywayOverride: "yes" })!, /yes or a no/);
});
