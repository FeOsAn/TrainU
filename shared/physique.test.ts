import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRM_WEIGHT_DELTA_KG,
  MIN_TREND_SPAN_DAYS,
  PHYSIQUE_BOUNDS,
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
