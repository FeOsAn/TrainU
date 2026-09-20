import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRM_WEIGHT_DELTA_KG,
  MIN_TREND_SPAN_DAYS,
  PHYSIQUE_BOUNDS,
  PROGRESS_WINDOW_DAYS,
  PHYSIQUE_METRICS,
  PHYSIQUE_METRIC_LABELS,
  PROGRESS_STATUS_LABELS,
  STALE_ENTRY_DAYS,
  type PhysiqueEntry,
  applyPhysiqueEvidence,
  progressVsGoal,
  trend,
  validatePhysiqueEntry,
  weeklyRate,
  weightChangeWarning,
} from "./physique";
import { ATHLETE_NUMERIC_BOUNDS, DEFAULT_ATHLETE, type AthleteParams } from "./athlete";
import { measured } from "./measured";
import type { Goal } from "./goal";
import { addDays } from "./dates";
import { predictBodyComposition } from "./predictors/bodyComposition";

const TODAY = "2026-09-18";

function entry(date: string, over: Partial<PhysiqueEntry> = {}): PhysiqueEntry {
  return {
    id: `e-${date}`,
    date,
    weightKg: null,
    bodyFatPercent: null,
    waistCm: null,
    note: null,
    recordedAt: `${date}T07:00:00.000Z`,
    ...over,
  };
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    type: "body_composition",
    discipline: "other",
    label: "Wedding",
    targetDate: "2026-12-11",
    priority: 1,
    successCriteria: "Fit the suit",
    targetMetrics: { targetWeightKg: 78 },
    constraints: [],
    createdAt: "2026-09-01",
    active: true,
    ...over,
  };
}

/* ─── bounds and validation ──────────────────────────────────────────── */

test("weight and body fat use the athlete bounds table, not a second copy of it", () => {
  assert.deepEqual(PHYSIQUE_BOUNDS.weightKg, ATHLETE_NUMERIC_BOUNDS.weightKg);
  assert.deepEqual(PHYSIQUE_BOUNDS.bodyFatPercent, ATHLETE_NUMERIC_BOUNDS.bodyFatPercent);
});

test("every metric has athlete-facing words", () => {
  for (const metric of PHYSIQUE_METRICS) {
    const label = PHYSIQUE_METRIC_LABELS[metric];
    assert.ok(label && !label.includes("_"), `${metric} needs words, not an id`);
  }
});

test("validation rejects what would corrupt the fold, and says why in words", () => {
  assert.equal(validatePhysiqueEntry({ date: TODAY, weightKg: 78.4 }), null);
  assert.match(validatePhysiqueEntry({ date: "2026-02-30", weightKg: 78 })!, /real date/);
  assert.match(validatePhysiqueEntry({ date: TODAY })!, /at least one measurement/);
  assert.match(validatePhysiqueEntry({ date: TODAY, weightKg: 12 })!, /Weight/);
  assert.match(validatePhysiqueEntry({ date: TODAY, bodyFatPercent: 90 })!, /Body fat/);
  assert.match(validatePhysiqueEntry({ date: TODAY, waistCm: 5 })!, /Waist/);
  assert.match(validatePhysiqueEntry({ date: TODAY, weightKg: Number.NaN })!, /number/);
  // A future weigh-in would pin the fold to a measurement that never happened.
  assert.match(validatePhysiqueEntry({ date: "2026-09-19", weightKg: 78 }, { today: TODAY })!, /future/);
  assert.equal(validatePhysiqueEntry({ date: "2026-09-19", weightKg: 78 }), null, "no clock given, no future rule");
});

test("a big jump asks for confirmation rather than being rejected", () => {
  const previous = entry("2026-09-10", { weightKg: 80 });
  assert.equal(weightChangeWarning(79, previous), null);
  assert.equal(weightChangeWarning(80 - CONFIRM_WEIGHT_DELTA_KG - 0.5, previous)?.includes("3.5 kg down"), true);
  assert.match(weightChangeWarning(85, previous)!, /up from 80 kg/);
  assert.equal(weightChangeWarning(85, null), null, "nothing to compare against yet");
});

/* ─── trend ──────────────────────────────────────────────────────────── */

test("changePerWeek is a least-squares slope over an uneven series", () => {
  // Four weigh-ins on days 0, 1, 2 and 28, one of them after a heavy meal.
  // First-to-last would let that single morning set the trend.
  const entries = [
    entry("2026-09-01", { weightKg: 82 }),
    entry("2026-09-02", { weightKg: 83.5 }),
    entry("2026-09-03", { weightKg: 82 }),
    entry("2026-09-29", { weightKg: 80.2 }),
  ];
  const t = trend(entries).weightKg!;
  assert.equal(t.samples, 4);
  assert.equal(t.spanDays, 28);
  assert.deepEqual(t.first, { date: "2026-09-01", value: 82, dayOffset: 0 });
  assert.deepEqual(t.last, { date: "2026-09-29", value: 80.2, dayOffset: 28 });
  assert.equal(t.change, -1.8);

  // Worked by hand: meanX = 7.75, meanY = 81.925, slope = -46.575 / 548.75
  // = -0.084873 kg/day = -0.594 kg/week.
  const firstToLast = (-1.8 / 28) * 7;
  assert.ok(Math.abs(t.changePerWeek! - -0.594) < 0.002, `got ${t.changePerWeek}`);
  assert.ok(Math.abs(t.changePerWeek! - firstToLast) > 0.1, "least squares is not first-to-last");
});

test("a series too short to be anything but noise reports no rate at all", () => {
  const entries = [entry("2026-09-14", { weightKg: 81 }), entry("2026-09-18", { weightKg: 79.8 })];
  const t = trend(entries).weightKg!;
  assert.equal(t.samples, 2);
  assert.equal(t.changePerWeek, null, `under ${MIN_TREND_SPAN_DAYS} days a slope is daily water weight`);
  assert.equal(t.change, -1.2, "the raw change is still reported — it just is not a rate");
  assert.equal(weeklyRate([{ date: TODAY, value: 80, dayOffset: 0 }]), null);
});

test("the series carries real elapsed days, so a fortnight of silence looks like one", () => {
  const t = trend([entry("2026-09-01", { weightKg: 82 }), entry("2026-09-15", { weightKg: 81 })]).weightKg!;
  assert.deepEqual(t.series.map((p) => p.dayOffset), [0, 14]);
});

test("a metric with nothing logged is null, not a zeroed trend", () => {
  const t = trend([entry("2026-09-01", { weightKg: 82 })]);
  assert.equal(t.waistCm, null);
  assert.equal(t.bodyFatPercent, null);
  assert.equal(t.weightKg!.samples, 1);
});

test("the window is measured in days from today, not in number of entries", () => {
  const entries = [
    entry("2026-08-01", { weightKg: 84 }),
    entry("2026-09-01", { weightKg: 82 }),
    entry("2026-09-15", { weightKg: 81 }),
  ];
  const t = trend(entries, { days: 28, today: TODAY }).weightKg!;
  assert.equal(t.samples, 2, "August is outside a 28-day window");
  assert.equal(t.first.date, "2026-09-01");
});

/* ─── the fold (DECISIONS C4) ────────────────────────────────────────── */

test("the newest entry wins, as a measured value carrying its own date", () => {
  const entries = [
    entry("2026-09-01", { weightKg: 82, bodyFatPercent: 19 }),
    entry("2026-09-15", { weightKg: 80.4 }),
  ];
  const folded = applyPhysiqueEvidence(DEFAULT_ATHLETE, entries);
  assert.equal(folded.weightKg.value, 80.4);
  assert.equal(folded.weightKg.verified, true);
  assert.equal(folded.weightKg.source, "scale, 2026-09-15");
  assert.equal(folded.weightKg.asOf, "2026-09-15");
  // Body fat falls back to the newest entry that actually carries one.
  assert.equal(folded.bodyFatPercent.value, 19);
  assert.equal(folded.bodyFatPercent.asOf, "2026-09-01");
});

test("removing the newest entry reverts the fold to the next-newest, and then to the seed", () => {
  const older = entry("2026-09-01", { weightKg: 82 });
  const newer = entry("2026-09-15", { weightKg: 80.4 });
  assert.equal(applyPhysiqueEvidence(DEFAULT_ATHLETE, [older, newer]).weightKg.value, 80.4);
  assert.equal(applyPhysiqueEvidence(DEFAULT_ATHLETE, [older]).weightKg.value, 82);

  const bare = applyPhysiqueEvidence(DEFAULT_ATHLETE, []);
  assert.equal(bare.weightKg.value, DEFAULT_ATHLETE.weightKg.value);
  assert.equal(bare.weightKg.verified, false, "with nothing logged the field is honestly a seed again");
});

test("back-dating an entry cannot displace a newer measurement", () => {
  const newer = entry("2026-09-15", { weightKg: 80.4 });
  const backDated = entry("2026-07-04", { weightKg: 88, recordedAt: "2026-09-18T09:00:00.000Z" });
  const folded = applyPhysiqueEvidence(DEFAULT_ATHLETE, [newer, backDated]);
  assert.equal(folded.weightKg.value, 80.4, "written last, but it describes July");
});

test("the fold never mutates the params it is given, and folding twice changes nothing", () => {
  const stored: AthleteParams = { ...DEFAULT_ATHLETE, weightKg: measured(79, "manually entered", "2026-08-20") };
  const entries = [entry("2026-09-15", { weightKg: 80.4 })];
  const once = applyPhysiqueEvidence(stored, entries);
  assert.equal(stored.weightKg.value, 79, "the caller's Measured<T> is untouched");
  assert.deepEqual(applyPhysiqueEvidence(once, entries), once, "the fold is idempotent");
});

test("with no entry for a metric the stored athlete row survives the fold", () => {
  const stored: AthleteParams = { ...DEFAULT_ATHLETE, bodyFatPercent: measured(14, "DEXA, 2026-06-02", "2026-06-02") };
  const folded = applyPhysiqueEvidence(stored, [entry("2026-09-15", { weightKg: 80.4 })]);
  assert.deepEqual(folded.bodyFatPercent, stored.bodyFatPercent);
});

test("an out-of-bounds row never reaches a prediction as a measurement", () => {
  const folded = applyPhysiqueEvidence(DEFAULT_ATHLETE, [
    entry("2026-09-01", { weightKg: 80.4 }),
    entry("2026-09-15", { weightKg: 4000 }),
  ]);
  assert.equal(folded.weightKg.value, 80.4);
});

/* ─── progressVsGoal ─────────────────────────────────────────────────── */

const losing = [
  entry("2026-08-18", { weightKg: 84 }),
  entry("2026-08-28", { weightKg: 83.2 }),
  entry("2026-09-08", { weightKg: 82.3 }),
  entry("2026-09-17", { weightKg: 81.6 }),
];

test("the verdict is the finishing weight, judged against the predictor's own required rate", () => {
  // 81.6 kg on 17 Sep, target 78 kg on 11 Dec: 12 weeks, 0.3 kg/week needed.
  const g = goal();
  const p = progressVsGoal(losing, g, DEFAULT_ATHLETE, { today: TODAY });
  const predicted = predictBodyComposition(applyPhysiqueEvidence(DEFAULT_ATHLETE, losing), {
    targetWeightKg: 78,
    targetDate: g.targetDate,
    today: TODAY,
  });
  assert.equal(p.requiredWeeklyChangeKg, predicted.requiredWeeklyChangeKg, "one predictor, not a second copy of the maths");
  assert.equal(p.latestWeightKg, 81.6);
  assert.equal(p.targetWeightKg, 78);
  assert.ok(p.observedWeeklyChangeKg! < -0.5, `observed ${p.observedWeeklyChangeKg}`);
  assert.equal(p.status, "ahead", "losing ~0.6/wk against a 0.3/wk requirement overshoots the target");
  assert.match(p.summary, /78 kg/);
});

test("on track means the projected finishing weight lands inside the tolerance band", () => {
  // ~0.6 kg/week for 12 more weeks off 81.6 → about 74.5 kg.
  const p = progressVsGoal(losing, goal({ targetMetrics: { targetWeightKg: 74.5 } }), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(p.status, "on_track");
  assert.ok(Math.abs(p.projectedWeightKg! - 74.5) <= p.toleranceKg);
  assert.equal(p.statusLabel, PROGRESS_STATUS_LABELS.on_track);
});

test("six weeks of no progress reads as behind, which comparing rates would not catch", () => {
  const flat = [
    entry("2026-08-07", { weightKg: 84 }),
    entry("2026-08-21", { weightKg: 84.1 }),
    entry("2026-09-04", { weightKg: 83.9 }),
    entry("2026-09-17", { weightKg: 84 }),
  ];
  const p = progressVsGoal(flat, goal({ targetMetrics: { targetWeightKg: 78 } }), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(p.status, "behind");
  assert.ok(p.projectedWeightKg! > 83, `projected ${p.projectedWeightKg}`);
  assert.match(p.summary, /off the 78 kg/);
});

test("a stale weigh-in stops producing a confident verdict, and names the staleness", () => {
  const stale = losing.map((e, i) => entry(["2026-06-01", "2026-06-15", "2026-07-01", "2026-07-20"][i], { weightKg: e.weightKg }));
  const p = progressVsGoal(stale, goal(), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(p.status, "unknown");
  assert.ok(p.daysSinceLatestEntry! > STALE_ENTRY_DAYS);
  assert.match(p.summary, /60 days ago/);
});

test("one weigh-in, or a fortnight that has not elapsed, is honestly not a verdict", () => {
  const single = progressVsGoal([entry("2026-09-17", { weightKg: 81.6 })], goal(), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(single.status, "unknown");
  assert.equal(single.observedWeeklyChangeKg, null);
  assert.match(single.summary, /not a trend/);

  const short = progressVsGoal(
    [entry("2026-09-12", { weightKg: 82.4 }), entry("2026-09-17", { weightKg: 81.6 })],
    goal(),
    DEFAULT_ATHLETE,
    { today: TODAY },
  );
  assert.equal(short.status, "unknown");
  assert.match(short.summary, /noise/);
});

test("a goal with no number to aim at, and a goal already past, both say so", () => {
  const noTarget = progressVsGoal(losing, goal({ targetMetrics: {} }), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(noTarget.status, "unknown");
  assert.match(noTarget.summary, /target weight or body-fat/);

  const past = progressVsGoal(losing, goal({ targetDate: "2026-08-01" }), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(past.status, "unknown");
  assert.match(past.summary, /in the past/);
});

test("a body-fat target is turned into a weight by the predictor, not by a second solve here", () => {
  const g = goal({ targetMetrics: { targetBodyFatPercent: 12 } });
  const athlete: AthleteParams = { ...DEFAULT_ATHLETE, bodyFatPercent: measured(18, "DEXA, 2026-08-01", "2026-08-01") };
  const p = progressVsGoal(losing, g, athlete, { today: TODAY });
  const leanMass = 81.6 * (1 - 18 / 100);
  assert.ok(Math.abs(p.targetWeightKg! - leanMass / (1 - 12 / 100)) < 0.2, `got ${p.targetWeightKg}`);
  assert.notEqual(p.status, "unknown");
});

test("no status id and no field name ever reaches the athlete's sentence", () => {
  for (const p of [
    progressVsGoal(losing, goal(), DEFAULT_ATHLETE, { today: TODAY }),
    progressVsGoal([], goal(), DEFAULT_ATHLETE, { today: TODAY }),
    progressVsGoal(losing, goal({ targetMetrics: { targetWeightKg: 74.5 } }), DEFAULT_ATHLETE, { today: TODAY }),
  ]) {
    for (const forbidden of ["on_track", "weightKg", "bodyFatPercent", "body_composition", "unknown"]) {
      assert.ok(!p.summary.includes(forbidden), `"${forbidden}" leaked into "${p.summary}"`);
    }
  }
});

/* ─── the verdict's window ───────────────────────────────────────────────
 *
 * Defect: `progressVsGoal` regressed the athlete's ENTIRE logged history, so
 * weight lost months ago kept driving the projection forward. Every fixture
 * above spans six weeks or less, where windowed and unwindowed agree — which
 * is exactly why 568 tests missed it. These pin the boundary on both sides.
 */

/** Weekly weigh-ins ending on `lastDate`, oldest first. */
function weekly(lastDate: string, values: number[]): PhysiqueEntry[] {
  return values.map((weightKg, i) => entry(addDays(lastDate, -7 * (values.length - 1 - i)), { weightKg }));
}

test("a cut that stalled two months ago stops reading on track — the rate is windowed", () => {
  // Seven weeks of real loss, then eight weeks of nothing. Least squares over
  // the lifetime series projects the June loss forward and lands the athlete
  // on their target; the trailing window says they have not moved since July.
  const stalled = [...weekly("2026-07-23", [86, 85.3, 84.6, 83.9, 83.2, 82.5, 81.8]), ...weekly("2026-09-17", [81.8, 81.8, 81.8, 81.8, 81.8, 81.8, 81.8, 81.8])];
  const g = goal({ targetMetrics: { targetWeightKg: 80 }, targetDate: "2026-11-15" });
  const p = progressVsGoal(stalled, g, DEFAULT_ATHLETE, { today: TODAY });

  assert.equal(p.observedWeeklyChangeKg, 0, "eight weeks at the same weight is a rate of zero, whatever June says");
  assert.equal(p.status, "behind");
  assert.ok(p.projectedWeightKg! > 81, `projected ${p.projectedWeightKg} — a stalled athlete lands where they are`);
  assert.ok(!p.summary.includes("within"), `a stalled cut must not be told it is on course: ${p.summary}`);
});

test("the verdict reads the same trend the panel plots, over the same window", () => {
  // Defect: two windows for one set of numbers — `trend()` took one, the
  // verdict took none. An old completed cut made the verdict assert a descent
  // the athlete had not been on for ten months while the panel showed flat.
  const entries = [...weekly("2025-12-20", [85, 84, 83, 82, 81, 80, 79, 78]), ...weekly("2026-09-17", [78, 78.1, 78, 78.1, 78])];
  const g = goal({ targetMetrics: { targetWeightKg: 72 }, targetDate: "2026-12-20" });
  const p = progressVsGoal(entries, g, DEFAULT_ATHLETE, { today: TODAY });
  const shown = trend(entries, { days: PROGRESS_WINDOW_DAYS, today: TODAY }).weightKg!;

  assert.equal(p.observedWeeklyChangeKg, shown.changePerWeek, "one mechanism: the verdict's rate IS the displayed trend's rate");
  assert.ok(Math.abs(p.observedWeeklyChangeKg!) < 0.05, `got ${p.observedWeeklyChangeKg} — last year's cut is not this month's trend`);
  assert.equal(p.status, "behind");
});

test("a weigh-in one day either side of the window boundary is in or out of the rate", () => {
  // The boundary itself, because "it spans less than six weeks" is what let
  // the bug through. Same flat recent block, one heavy old reading moved by a
  // single day across the edge of the window.
  const flat = weekly("2026-09-17", [80, 80, 80, 80]);
  const inside = entry(addDays(TODAY, -(PROGRESS_WINDOW_DAYS - 1)), { weightKg: 86 });
  const outside = entry(addDays(TODAY, -PROGRESS_WINDOW_DAYS), { weightKg: 86 });
  const g = goal({ targetMetrics: { targetWeightKg: 76 }, targetDate: "2026-12-20" });

  const withInside = progressVsGoal([inside, ...flat], g, DEFAULT_ATHLETE, { today: TODAY });
  const withOutside = progressVsGoal([outside, ...flat], g, DEFAULT_ATHLETE, { today: TODAY });
  const withNeither = progressVsGoal(flat, g, DEFAULT_ATHLETE, { today: TODAY });

  assert.ok(withInside.observedWeeklyChangeKg! < -0.5, `the last day of the window still counts, got ${withInside.observedWeeklyChangeKg}`);
  assert.equal(withOutside.observedWeeklyChangeKg, withNeither.observedWeeklyChangeKg, "one day older and it stops steering the verdict at all");
  assert.equal(withOutside.observedWeeklyChangeKg, 0);
});

test("a long history with one recent weigh-in says THAT, not 'one weigh-in'", () => {
  // The window makes this branch reachable for a new reason: years of data,
  // nothing recent enough to be a trend. Telling that athlete they have one
  // weigh-in is false and looks broken.
  const entries = [...weekly("2026-02-06", [88, 87, 86, 85]), entry("2026-09-15", { weightKg: 84 })];
  const p = progressVsGoal(entries, goal(), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(p.status, "unknown");
  assert.equal(p.observedWeeklyChangeKg, null);
  assert.ok(!p.summary.includes("One weigh-in is a number"), `they have five: ${p.summary}`);
  assert.match(p.summary, new RegExp(`${PROGRESS_WINDOW_DAYS} days`));
});

/* ─── the verdict's direction ────────────────────────────────────────────
 *
 * Defect: `direction` came from `requiredWeeklyChangeKg`, which
 * `predictBodyComposition` recomputes from TODAY's weight — so it reads 0
 * both for "hold this weight" and for "you already got there", and the
 * fallback called both of them behind.
 */

test("an athlete who reached their target early is not told they are behind", () => {
  const reached = weekly("2026-09-17", [76.2, 75.9, 75.6, 75.3, 75]);
  const g = goal({ targetMetrics: { targetWeightKg: 75 }, targetDate: "2026-11-15" });
  const p = progressVsGoal(reached, g, DEFAULT_ATHLETE, { today: TODAY });

  assert.equal(p.requiredWeeklyChangeKg, 0, "standing on the target needs nothing per week — which is not the same as failing");
  assert.equal(p.status, "ahead");
  assert.ok(!/Needs 0 kg/.test(p.summary), `"Needs 0 kg a week" is not a sentence: ${p.summary}`);
  assert.match(p.summary, /ease the deficit/);
});

test("half a kilo PAST a cut target still reads ahead, not behind", () => {
  // Wider than the original claim: at 74.5 against 75 the required rate is a
  // small POSITIVE number, which the old code read as a lean-gain goal being
  // undershot and called behind.
  const past = weekly("2026-09-17", [75.7, 75.4, 75.1, 74.8, 74.5]);
  const p = progressVsGoal(past, goal({ targetMetrics: { targetWeightKg: 75 }, targetDate: "2026-11-15" }), DEFAULT_ATHLETE, { today: TODAY });
  assert.ok(p.requiredWeeklyChangeKg! > 0, "the required rate now points the wrong way — which is why it cannot be the discriminator");
  assert.equal(p.status, "ahead");
});

test("a genuine hold-a-weight goal still reads behind when it drifts, and never says 'Needs 0 kg'", () => {
  // The control for the two above: start ON the target, drift off it. This
  // one MUST stay behind — the fix must not buy the target-reached case by
  // silencing real drift.
  const drifting = weekly("2026-09-17", [75, 75.1, 75.2, 75.3]);
  const g = goal({ targetMetrics: { targetWeightKg: 75 }, targetDate: "2027-06-25" });
  const p = progressVsGoal(drifting, g, DEFAULT_ATHLETE, { today: TODAY });

  assert.equal(p.status, "behind", "drifting off a weight you meant to hold is off plan in either direction");
  assert.ok(Math.abs(p.requiredWeeklyChangeKg!) < 0.05, `required rounds away to nothing here (${p.requiredWeeklyChangeKg}) — the old summary printed it anyway`);
  assert.ok(!/Needs 0 kg/.test(p.summary), `"Needs 0 kg a week from here" reached the athlete: ${p.summary}`);
  assert.match(p.summary, /75 kg/);
});

test("a lean-gain goal that overshoots is told to ease the SURPLUS, not the deficit", () => {
  const gaining = weekly("2026-09-17", [70, 70.3, 70.6, 70.9, 71.2]);
  const p = progressVsGoal(gaining, goal({ targetMetrics: { targetWeightKg: 72 }, targetDate: "2026-11-15" }), DEFAULT_ATHLETE, { today: TODAY });
  assert.equal(p.status, "ahead");
  assert.ok(!p.summary.includes("deficit"), `a gaining athlete is not in a deficit: ${p.summary}`);
  assert.match(p.summary, /surplus/);
});
