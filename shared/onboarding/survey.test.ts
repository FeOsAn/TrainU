import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SURVEY,
  InvalidSurveyError,
  MAX_TRAINING_DAYS,
  MIN_TRAINING_DAYS,
  type SurveyAnswers,
  surveyToWrites,
  validateSurvey,
} from "./survey";
import { ATHLETE_NUMERIC_BOUNDS } from "../athlete";
import { freshKmPaceFrom } from "../calibration";

const TODAY = "2026-09-24";

function answers(over: Partial<SurveyAnswers> = {}): SurveyAnswers {
  return {
    ...EMPTY_SURVEY,
    goals: [
      {
        type: "endurance_race",
        discipline: "run",
        label: "Berlin Marathon",
        targetDate: "2027-09-26",
        successCriteria: "Sub 3:30",
        targetMetrics: { targetTimeSeconds: 12600, targetDistanceKm: 42.2 },
      },
    ],
    ...over,
  };
}

function rejects(over: Partial<SurveyAnswers> | Record<string, unknown>, match: RegExp) {
  assert.throws(() => validateSurvey({ ...answers(), ...over }, TODAY), (err: unknown) => {
    assert.ok(err instanceof InvalidSurveyError, `expected InvalidSurveyError, got ${err}`);
    assert.match((err as Error).message, match);
    return true;
  });
}

/* ─── Validation ─────────────────────────────────────────────────────── */

test("a complete, plausible survey validates", () => {
  assert.doesNotThrow(() => validateSurvey(answers(), TODAY));
});

test("at least one goal is required — the whole app is assembled off them", () => {
  rejects({ goals: [] }, /at least one goal/i);
});

test("a goal dated in the past is refused rather than silently assembled around", () => {
  // Phase 3's bug in reverse: a past goal contributes nothing to arbitration,
  // so accepting one here builds an app around a race that has been and gone.
  rejects({ goals: [{ ...answers().goals[0]!, targetDate: "2026-09-23" }] }, /in the past/i);
});

test("a goal dated today is fine — race day is a live goal", () => {
  assert.doesNotThrow(() => validateSurvey(answers({ goals: [{ ...answers().goals[0]!, targetDate: TODAY }] }), TODAY));
});

test("a hallucinated goal type is refused, whoever produced it", () => {
  rejects({ goals: [{ ...answers().goals[0]!, type: "powerlifting" as never }] }, /goal type must be/i);
});

test("training days stay inside the range the prescriber can honour", () => {
  rejects({ trainingDaysPerWeek: MIN_TRAINING_DAYS - 1 }, /between 3 and 7/);
  rejects({ trainingDaysPerWeek: MAX_TRAINING_DAYS + 1 }, /between 3 and 7/);
  for (let n = MIN_TRAINING_DAYS; n <= MAX_TRAINING_DAYS; n++) {
    assert.doesNotThrow(() => validateSurvey(answers({ trainingDaysPerWeek: n }), TODAY), `${n} days should be accepted`);
  }
});

test("every optional number is bounds-checked against the athlete model's own bounds", () => {
  const [lo, hi] = ATHLETE_NUMERIC_BOUNDS.weightKg!;
  rejects({ weightKg: hi + 1 }, /weightKg must be a number between/);
  rejects({ weightKg: lo - 1 }, /weightKg must be a number between/);
  assert.doesNotThrow(() => validateSurvey(answers({ weightKg: 78 }), TODAY));
  // Absent is a real answer and must stay one: it leaves the field a seed.
  assert.doesNotThrow(() => validateSurvey(answers({ weightKg: undefined }), TODAY));
});

test("a lift outside plausible bounds is refused", () => {
  rejects({ lifts: { squat1RmKg: 900 } }, /squat1RmKg must be a number between/);
});

test("a recent effort with a pace nobody has run is refused as the typo it is", () => {
  // 5 km in 5 minutes: almost always minutes typed where seconds were meant,
  // and it would otherwise be stored as a MEASURED fresh kilometre with a
  // provenance string vouching for it.
  rejects({ recentEffort: { distanceKm: 5, timeSeconds: 300, date: "2026-09-01" } }, /pace this app doesn't believe/);
});

test("a recent effort dated in the future is refused", () => {
  rejects({ recentEffort: { distanceKm: 5, timeSeconds: 1200, date: "2026-10-01" } }, /past date/);
});

/* ─── Translation ────────────────────────────────────────────────────── */

test("goal order becomes priority order — the answer arbitration leans on hardest", () => {
  const writes = surveyToWrites(
    answers({
      goals: [
        { type: "hyrox", discipline: "other", label: "HYROX London", targetDate: "2026-11-14", successCriteria: "Sub 70", targetMetrics: {} },
        { type: "body_composition", discipline: "other", label: "Wedding", targetDate: "2026-12-20", successCriteria: "Lean", targetMetrics: {} },
      ],
    }),
    TODAY,
  );
  assert.deepEqual(writes.goals.map((g) => [g.label, g.priority]), [
    ["HYROX London", 1],
    ["Wedding", 2],
  ]);
});

test("weight and body fat go to the weigh-in, never onto the athlete row", () => {
  // Two write paths for the same number is how a weigh-in ends up changing
  // the plan's calories but not /api/athlete (DECISIONS C4).
  const writes = surveyToWrites(answers({ weightKg: 78.4, bodyFatPercent: 13, heightCm: 183 }), TODAY);
  assert.deepEqual(writes.weighIn, { weightKg: 78.4, bodyFatPercent: 13 });
  assert.deepEqual(
    writes.athlete.map((a) => a.field),
    ["heightCm"],
  );
});

test("a recent race is stored as the FRESH KILOMETRE, through calibration's own projection", () => {
  // The Phase 7 bug: `runThresholdSecPerKm` holds an all-out kilometre, not
  // threshold pace. Anchoring a 10 km pace onto it directly reads an hour-long
  // effort as a three-minute one.
  const writes = surveyToWrites(
    answers({ recentEffort: { distanceKm: 10, timeSeconds: 2400, date: "2026-09-06" } }),
    TODAY,
  );
  const stored = writes.athlete.find((a) => a.field === "runThresholdSecPerKm");
  assert.ok(stored, "the effort should land on runThresholdSecPerKm");
  assert.equal(stored!.value, Math.round(freshKmPaceFrom(10, 240)));
  assert.ok(stored!.value < 240, "a kilometre is faster than 10 km pace, not slower");
  // The month is whatever the runtime's locale data calls it ("Sep"/"Sept"),
  // so this pins the parts that carry meaning rather than the abbreviation.
  assert.match(stored!.source, /^10 km in 40:00 on 6 Sept? 2026, projected to 1 km$/);
});

test("a marathon also anchors marathonPbMinutes, which the predictor prefers", () => {
  const writes = surveyToWrites(
    answers({ recentEffort: { distanceKm: 42.2, timeSeconds: 12_900, date: "2026-05-10" } }),
    TODAY,
  );
  const pb = writes.athlete.find((a) => a.field === "marathonPbMinutes");
  assert.equal(pb?.value, 215);
});

test("a shorter race does not claim a marathon PB", () => {
  const writes = surveyToWrites(answers({ recentEffort: { distanceKm: 21.1, timeSeconds: 5400, date: "2026-05-10" } }), TODAY);
  assert.equal(writes.athlete.find((a) => a.field === "marathonPbMinutes"), undefined);
});

test("a triathlon goal implies a bike and a pool even when the athlete said neither", () => {
  // `hasBike: false` for someone training for a 70.3 is a wrong answer that
  // costs them every cross-training substitute the moment they get injured.
  const writes = surveyToWrites(
    answers({
      hasBike: false,
      hasPool: false,
      goals: [{ type: "endurance_race", discipline: "triathlon", label: "Outlaw 70.3", targetDate: "2027-07-11", successCriteria: "Finish", targetMetrics: {} }],
    }),
    TODAY,
  );
  assert.equal(writes.features.hasBike, true);
  assert.equal(writes.features.hasPool, true);
});

test("a runner's own answer is never overwritten downward by inference", () => {
  const writes = surveyToWrites(answers({ hasBike: true, hasPool: false }), TODAY);
  assert.equal(writes.features.hasBike, true, "they said they have one");
  assert.equal(writes.features.hasPool, false, "a marathon implies nothing about a pool");
});

test("a blank successCriteria is filled with something readable, never left empty", () => {
  // `validateGoalInput` rejects an empty one, so an optional field on the form
  // has to become a non-empty string here or finishing the survey 400s.
  const writes = surveyToWrites(
    answers({ goals: [{ type: "strength", discipline: "other", label: "Squat", targetDate: "2027-03-01", successCriteria: "   ", targetMetrics: { targetWeightKg: 150, liftId: "squat1RmKg" } }] }),
    TODAY,
  );
  assert.match(writes.goals[0]!.successCriteria, /^Lift 150 kg by 1 Mar(ch)? 2027$/);
});

test("an out-of-bounds number that slipped past validation is dropped, not stored", () => {
  // Defence in depth: `surveyToWrites` is pure and could be called with
  // anything, so it re-checks rather than trusting that it was validated.
  const writes = surveyToWrites({ ...answers(), ageYears: 400 } as SurveyAnswers, TODAY);
  assert.equal(writes.athlete.find((a) => a.field === "ageYears"), undefined);
});

test("a goal with no numbers at all gets words that read under its own name", () => {
  const writes = surveyToWrites(
    answers({
      goals: [
        { type: "body_composition", discipline: "other", label: "Christmas", targetDate: "2026-12-20", successCriteria: "", targetMetrics: {} },
        { type: "hyrox", discipline: "other", label: "HYROX London", targetDate: "2026-11-14", successCriteria: "", targetMetrics: {} },
      ],
    }),
    TODAY,
  );
  assert.match(writes.goals[0]!.successCriteria, /^Be where you want to be by 20 Dec(ember)? 2026$/);
  assert.match(writes.goals[1]!.successCriteria, /start line of HYROX London/);
  for (const goal of writes.goals) {
    assert.ok(goal.successCriteria.trim().length > 0, "an empty one is refused by createGoal");
    assert.doesNotMatch(goal.successCriteria, /_/, "no enum ids reach the athlete");
  }
});
