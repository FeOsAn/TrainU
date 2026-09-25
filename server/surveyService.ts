/**
 * The survey's write path, and the one that undoes it.
 *
 * Two operations, and the interesting part is that they are inverses:
 * `completeSurvey` builds the app out of the athlete's answers, `resetApp`
 * takes it apart. If a later phase adds something the survey writes, it has
 * to be removable here too, or "delete this app" quietly leaves part of the
 * old one behind — which is worse than not offering it, because the athlete
 * believes they started clean. `RESET_TABLES` below is that contract, stated
 * once.
 *
 * Nothing here validates by hand: `validateSurvey` (pure, shared/) checks the
 * answers, and each write goes through the service that already owns it —
 * `createGoal` re-validates every goal, `upsertPhysiqueEntry` owns weigh-ins,
 * `updateFeaturePreferences` owns preferences. The survey is a form
 * submission with a nicer coat on; it gets no special trust.
 */
import { eq } from "drizzle-orm";
import { db, sqlite } from "./db";
import {
  appBuild,
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
  whoopCredentials,
} from "@shared/schema";
import { measured } from "@shared/measured";
import { todayISO } from "@shared/dates";
import {
  type SurveyAnswers,
  EMPTY_SURVEY,
  InvalidSurveyError,
  surveyToWrites,
  validateSurvey,
} from "@shared/onboarding/survey";
import { getAthleteRow, saveAthleteRow } from "./athleteRowStore";
import { createGoal } from "./goalsService";
import { upsertPhysiqueEntry } from "./physiqueService";
import { updateConnectorPreferences, updateFeaturePreferences } from "./preferencesService";

const ROW_ID = "self";

export { InvalidSurveyError };
export class SurveyAlreadyCompleteError extends Error {}

export interface BuildState {
  /** The switch the client routes on. False → the app opens on the survey. */
  complete: boolean;
  completedAt: string | null;
  /** What was answered, so "Your app" can show it and the survey can reopen prefilled. */
  answers: SurveyAnswers | null;
}

/**
 * Whether this install already has goals — i.e. was built before the survey
 * existed, or by the Goals form / coach rather than the survey.
 *
 * Phase 11's migration created `app_build` empty, so every existing install
 * booted with no build row and opened on the survey; finishing it wrote a
 * second copy of every goal. Migration 0003 backfills the row, and this makes
 * the rule hold even on a volume the migration somehow missed: goals exist,
 * so the app exists.
 */
function hasGoals(): boolean {
  return Boolean(db.select({ id: goalsTable.id }).from(goalsTable).limit(1).get());
}

export function getBuildState(): BuildState {
  const row = db.select().from(appBuild).where(eq(appBuild.id, ROW_ID)).get();
  if (!row) {
    return hasGoals()
      ? { complete: true, completedAt: null, answers: null }
      : { complete: false, completedAt: null, answers: null };
  }
  let answers: SurveyAnswers | null = null;
  try {
    const parsed = JSON.parse(row.answersJson);
    answers = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0 ? (parsed as SurveyAnswers) : null;
  } catch {
    // A snapshot we can't parse is a display problem, never a reason to make
    // an athlete with a built app redo the survey. `completedAt` is the switch.
    answers = null;
  }
  return { complete: Boolean(row.completedAt), completedAt: row.completedAt, answers };
}

/**
 * How many days a week this athlete said they train.
 *
 * Read by `GET /api/plan/week` as the default, which is the entire reason the
 * survey asks. Before this the client never sent `daysPerWeek` and the
 * prescriber always used its own default of 5 — so someone who trains three
 * days a week was being handed five sessions with nothing anywhere to say
 * otherwise.
 */
export function preferredTrainingDays(): number | undefined {
  const answers = getBuildState().answers;
  const n = answers?.trainingDaysPerWeek;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Build the app.
 *
 * Wrapped in one transaction: a half-built app — goals written, preferences
 * not, no completion stamp — would drop the athlete back onto the survey with
 * their goals already created, and finishing it a second time would duplicate
 * every one of them.
 */
export function completeSurvey(raw: unknown, today: string = todayISO()): BuildState {
  if (getBuildState().complete || hasGoals()) {
    throw new SurveyAlreadyCompleteError("this app has already been built — delete it first if you want to start over");
  }
  validateSurvey(raw, today);
  const answers: SurveyAnswers = { ...EMPTY_SURVEY, ...raw };
  const writes = surveyToWrites(answers, today);

  sqlite.transaction(() => {
    for (const goal of writes.goals) createGoal(goal);

    if (writes.athlete.length > 0) {
      const row = getAthleteRow() ?? {};
      const now = new Date().toISOString();
      for (const { field, value, source } of writes.athlete) {
        (row as Record<string, unknown>)[field] = measured(value, source, now);
      }
      saveAthleteRow(row);
    }

    // Weight and body fat are weigh-ins. Through the physique path like every
    // other weigh-in, so the newest-entry fold in getAthleteParams picks them
    // up and a later correction simply replaces them (DECISIONS C4).
    if (writes.weighIn.weightKg !== undefined || writes.weighIn.bodyFatPercent !== undefined) {
      upsertPhysiqueEntry({ date: today, ...writes.weighIn }, { today });
    }

    updateConnectorPreferences(writes.connectors);
    updateFeaturePreferences(writes.features);

    const now = new Date().toISOString();
    db.insert(appBuild)
      .values({ id: ROW_ID, completedAt: now, answersJson: JSON.stringify(answers), updatedAt: now })
      .onConflictDoUpdate({ target: appBuild.id, set: { completedAt: now, answersJson: JSON.stringify(answers), updatedAt: now } })
      .run();
  })();

  return getBuildState();
}

/**
 * What "delete this app" removes, split by what it costs to lose.
 *
 * BLUEPRINT is what the app was assembled FROM — goals, preferences, block
 * overrides, the survey answers, the coach transcript, the gap queue. All of
 * it is re-stated in a minute by doing the survey again, so it always goes:
 * leaving any of it behind would mean the "new" app is still partly the old
 * one.
 *
 * HISTORY is what the athlete DID — sessions, completions, weigh-ins,
 * check-ins, injuries, predictions and their outcomes. Months of it, and it
 * is the only thing here that can't be retyped. So it is opt-in, behind its
 * own checkbox, and off by default. Keeping it is also the better app: the
 * rebuilt one starts from real numbers instead of seeds.
 *
 * Third-party credentials go with the blueprint regardless of that checkbox.
 * A Garmin password is the athlete's actual account password (Garmin has no
 * OAuth for an app like this — see server/connectors/garmin.ts); leaving it
 * in the database of an app someone just deleted is not a thing to get wrong
 * to save them a reconnect.
 */
const BLUEPRINT_TABLES = [goalsTable, preferences, chatMessages, capabilityGaps, garminCredentials, whoopCredentials] as const;
const HISTORY_TABLES = [athleteMeasurements, trainingSessions, sessionCompletions, conditions, dailyCheckIns, physiqueEntries, outcomeLog] as const;

export interface ResetOptions {
  /** Also erase everything the athlete DID, not just what the app was built from. Off by default. */
  eraseHistory?: boolean;
}

export interface ResetResult {
  eraseHistory: boolean;
  /** Table name → rows removed, so the app can say what it actually did rather than "done". */
  removed: Record<string, number>;
}

export function resetApp(options: ResetOptions = {}): ResetResult {
  const eraseHistory = options.eraseHistory === true;
  const removed: Record<string, number> = {};

  sqlite.transaction(() => {
    const tables = eraseHistory ? [...BLUEPRINT_TABLES, ...HISTORY_TABLES] : BLUEPRINT_TABLES;
    for (const table of tables) {
      const name = tableName(table);
      const result = sqlite.prepare(`DELETE FROM "${name}"`).run();
      removed[name] = result.changes;
    }
    // Last, and only once everything above succeeded: the switch that sends
    // the athlete back to the survey. If any delete threw, the transaction
    // rolls back and they still have the app they had a second ago.
    const result = sqlite.prepare(`DELETE FROM "app_build"`).run();
    removed["app_build"] = result.changes;
  })();

  return { eraseHistory, removed };
}

/** Drizzle keeps the SQL name on a symbol; reading it beats hand-copying twelve strings that then drift from the schema. */
function tableName(table: (typeof BLUEPRINT_TABLES)[number] | (typeof HISTORY_TABLES)[number]): string {
  const symbol = Object.getOwnPropertySymbols(table).find((s) => s.description === "drizzle:Name");
  const name = symbol ? (table as unknown as Record<symbol, string>)[symbol] : undefined;
  if (!name) throw new Error("could not read a table name off the schema — reset refuses to guess");
  return name;
}
