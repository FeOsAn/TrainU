import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, sqlite } from "./db";
import {
  athleteMeasurements,
  capabilityGaps,
  chatMessages,
  conditions,
  dailyCheckIns,
  garminCredentials,
  goals as goalsTable,
  outcomeLog,
  physiqueEntries,
  preferences,
  sessionCompletions,
  trainingSessions,
} from "@shared/schema";
import { EMPTY_SURVEY, InvalidSurveyError, type SurveyAnswers } from "@shared/onboarding/survey";
import {
  SurveyAlreadyCompleteError,
  completeSurvey,
  getBuildState,
  preferredTrainingDays,
  resetApp,
} from "./surveyService";
import { listGoals } from "./goalsService";
import { getAthleteParams } from "./athleteStateService";
import { getPreferences } from "./preferencesService";

const TODAY = "2026-09-24";

/** Every test here writes to the shared test database, so each starts from nothing. */
function wipe() {
  resetApp({ eraseHistory: true });
}

function answers(over: Partial<SurveyAnswers> = {}): SurveyAnswers {
  return {
    ...EMPTY_SURVEY,
    name: "Sam",
    narrative: "HYROX in November, want to be leaner by Christmas.",
    ageYears: 29,
    heightCm: 181,
    weightKg: 79,
    bodyFatPercent: 13,
    trainingDaysPerWeek: 6,
    hasBike: true,
    goals: [
      { type: "hyrox", discipline: "other", label: "HYROX London", targetDate: "2026-11-14", successCriteria: "Sub 70", targetMetrics: { targetTimeSeconds: 4200 } },
      { type: "body_composition", discipline: "other", label: "Christmas", targetDate: "2026-12-20", successCriteria: "Leaner", targetMetrics: { targetBodyFatPercent: 11 } },
    ],
    connectors: { garmin: true, whoop: false, appleHealth: false },
    physiqueTracking: true,
    ...over,
  };
}

test("a fresh install has no app — which is what sends the athlete to the survey", () => {
  wipe();
  const state = getBuildState();
  assert.equal(state.complete, false);
  assert.equal(state.completedAt, null);
  assert.equal(state.answers, null);
});

test("finishing the survey writes goals, numbers, a weigh-in and preferences in one go", () => {
  wipe();
  const state = completeSurvey(answers(), TODAY);
  assert.equal(state.complete, true);
  assert.ok(state.completedAt);

  const goals = listGoals();
  assert.deepEqual(goals.map((g) => [g.label, g.priority]), [
    ["HYROX London", 1],
    ["Christmas", 2],
  ]);

  const athlete = getAthleteParams();
  assert.equal(athlete.ageYears.value, 29);
  assert.equal(athlete.heightCm.value, 181);
  assert.equal(athlete.ageYears.verified, true, "a number the athlete told us is not a guess");
  // Weight arrives through the physique fold, not the athlete row — one
  // write path per number (DECISIONS C4).
  assert.equal(athlete.weightKg.value, 79);
  assert.equal(db.select().from(physiqueEntries).all().length, 1);

  const prefs = getPreferences();
  assert.equal(prefs.connectors.garmin, true);
  assert.equal(prefs.features.physiqueTracking, true);
  assert.equal(prefs.features.hasBike, true);
});

test("a number the athlete skipped stays a seed and says so", () => {
  wipe();
  completeSurvey(answers({ ageYears: undefined, maxHrBpm: undefined }), TODAY);
  const athlete = getAthleteParams();
  assert.equal(athlete.maxHrBpm.verified, false);
  assert.equal(athlete.ageYears.verified, false);
  assert.match(athlete.maxHrBpm.source, /seed/i, "and the app says so rather than presenting it as a fact");
});

test("the week's day count comes from what the athlete said, not the prescriber's default", () => {
  wipe();
  assert.equal(preferredTrainingDays(), undefined, "nothing to prefer before the survey");
  completeSurvey(answers({ trainingDaysPerWeek: 3 }), TODAY);
  assert.equal(preferredTrainingDays(), 3);
});

test("finishing it twice is refused — it would duplicate every goal it created", () => {
  wipe();
  completeSurvey(answers(), TODAY);
  assert.throws(() => completeSurvey(answers(), TODAY), SurveyAlreadyCompleteError);
  assert.equal(listGoals().length, 2, "still two goals, not four");
});

test("a rejected survey writes NOTHING — no half-built app", () => {
  wipe();
  const bad = answers({ goals: [{ type: "hyrox", discipline: "other", label: "Past race", targetDate: "2026-01-01", successCriteria: "x", targetMetrics: {} }] });
  assert.throws(() => completeSurvey(bad, TODAY), InvalidSurveyError);
  assert.equal(listGoals().length, 0);
  assert.equal(getBuildState().complete, false);
});

test("a goal the validator lets through but createGoal rejects rolls the whole thing back", () => {
  // The transaction is the point: goals written, preferences not and no
  // completion stamp would drop the athlete back on the survey with their
  // goals already created — and finishing it again would duplicate them.
  wipe();
  const bad = answers();
  bad.goals = [bad.goals[0]!, { ...bad.goals[1]!, label: "   " }];
  assert.throws(() => completeSurvey(bad, TODAY));
  assert.equal(listGoals().length, 0, "the first goal must not survive the second's failure");
  assert.equal(getBuildState().complete, false);
  assert.equal(getPreferences().connectors.garmin, false);
});

/* ─── Delete this app ────────────────────────────────────────────────── */

function seedHistory() {
  const now = new Date().toISOString();
  db.insert(trainingSessions).values({ id: "s1", date: TODAY, source: "manual", sport: "run", durationMinutes: 50 }).run();
  db.insert(dailyCheckIns).values({ date: TODAY, sleepQuality: 4, soreness: 2, energy: 4, recordedAt: now }).run();
  db.insert(conditions)
    .values({ id: "c1", kind: "injury", label: "Calf", severity: 2, openedAt: TODAY, createdAt: now, updatedAt: now })
    .run();
  db.insert(outcomeLog).values({ id: "o1", kind: "prediction", predictedAt: now, predictionJson: "{}" }).run();
  db.insert(garminCredentials).values({ id: "self", email: "a@b.c", password: "enc.v1:xyz", updatedAt: now }).run();
  db.insert(chatMessages).values({ id: "m1", role: "user", content: "hi", createdAt: now }).run();
  db.insert(capabilityGaps).values({ capability: "adherence_learning", firstSeenAt: now, lastSeenAt: now }).run();
}

function counts() {
  const of = (name: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  return {
    goals: of("goals"),
    preferences: of("preferences"),
    chat: of("chat_messages"),
    gaps: of("capability_gaps"),
    garmin: of("garmin_credentials"),
    sessions: of("training_sessions"),
    checkIns: of("daily_check_ins"),
    conditions: of("conditions"),
    outcomes: of("outcome_log"),
    physique: of("physique_entries"),
    athlete: of("athlete_measurements"),
    build: of("app_build"),
  };
}

test("deleting the app clears the blueprint and sends the athlete back to the survey", () => {
  wipe();
  completeSurvey(answers(), TODAY);
  seedHistory();

  const result = resetApp();
  assert.equal(result.eraseHistory, false);

  const after = counts();
  assert.equal(after.build, 0, "no build state means the survey is what opens");
  assert.equal(getBuildState().complete, false);
  assert.equal(after.goals, 0);
  assert.equal(after.preferences, 0);
  assert.equal(after.chat, 0);
  assert.equal(after.gaps, 0);
  // A Garmin password is the athlete's real account password. Leaving it in
  // the database of an app they just deleted is not a thing to get wrong to
  // save them a reconnect.
  assert.equal(after.garmin, 0);
});

test("...and by default keeps everything they actually DID", () => {
  wipe();
  completeSurvey(answers(), TODAY);
  seedHistory();
  resetApp();

  const after = counts();
  assert.equal(after.sessions, 1);
  assert.equal(after.checkIns, 1);
  assert.equal(after.conditions, 1);
  assert.equal(after.outcomes, 1);
  assert.equal(after.physique, 1, "the weigh-in the survey wrote is history, not blueprint");
  assert.equal(after.athlete, 1);
});

test("erase-history takes the rest, and says how much it took", () => {
  wipe();
  completeSurvey(answers(), TODAY);
  seedHistory();

  const result = resetApp({ eraseHistory: true });
  assert.equal(result.eraseHistory, true);
  assert.equal(result.removed["training_sessions"], 1);
  assert.equal(result.removed["goals"], 2);

  const after = counts();
  for (const [table, n] of Object.entries(after)) assert.equal(n, 0, `${table} should be empty`);
});

test("after a delete the survey can be done again — that is the whole point of the control", () => {
  wipe();
  completeSurvey(answers(), TODAY);
  resetApp({ eraseHistory: true });
  assert.doesNotThrow(() => completeSurvey(answers({ trainingDaysPerWeek: 4 }), TODAY));
  assert.equal(listGoals().length, 2);
  assert.equal(preferredTrainingDays(), 4);
});

test("every table the survey writes is named in the reset contract", () => {
  /*
   * The guard that keeps `resetApp` honest as the app grows: finish a survey
   * against an empty database, erase everything, and assert that no table
   * came out of it still holding rows. A later phase that makes the survey
   * write somewhere new fails here until it is added to one of the two
   * groups — rather than quietly leaving part of the old app behind in an app
   * the athlete believes they deleted.
   */
  wipe();
  completeSurvey(answers(), TODAY);
  resetApp({ eraseHistory: true });

  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const exempt = new Set(["app_identity", "__drizzle_migrations"]);
  const leftover: string[] = [];
  for (const { name } of tables) {
    if (exempt.has(name)) continue;
    const { n } = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
    if (n > 0) leftover.push(`${name} (${n})`);
  }
  assert.deepEqual(leftover, [], "these tables survived a full delete and are not in the reset contract");
});

test.after(() => {
  wipe();
  db.run(sql`SELECT 1`);
});

/*
 * ─── Installs that existed before the survey ────────────────────────────────
 *
 * Phase 11's migration created app_build empty. Every existing install booted
 * with goals and no build row, opened on the survey, and finishing it wrote a
 * second copy of every goal — with no way to delete a goal to undo it.
 */
test("DEFECT: goals with no build row read as a built app, not as a survey to fill in", () => {
  wipe();
  db.insert(goalsTable).values({
    id: "pre-survey", type: "endurance_race", discipline: "run", label: "Ironman Barcelona", targetDate: "2027-10-03",
    priority: 1, successCriteria: "Finish", targetMetricsJson: "{}", constraintsJson: "[]", active: true, createdAt: "2026-09-01T00:00:00.000Z",
  } as any).run();
  assert.equal(getBuildState().complete, true);
});

test("DEFECT: the survey refuses to build over existing goals, even with no build row", () => {
  wipe();
  db.insert(goalsTable).values({
    id: "pre-survey", type: "endurance_race", discipline: "run", label: "Ironman Barcelona", targetDate: "2027-10-03",
    priority: 1, successCriteria: "Finish", targetMetricsJson: "{}", constraintsJson: "[]", active: true, createdAt: "2026-09-01T00:00:00.000Z",
  } as any).run();
  assert.throws(() => completeSurvey(answers(), TODAY), SurveyAlreadyCompleteError);
  assert.equal(listGoals().length, 1, "no duplicate goals");
});
