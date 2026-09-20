/**
 * The one place the athlete's current state is assembled.
 *
 * `adjustWeek` is pure and takes an `AthleteState`. Something has to read the
 * database and build that object, and it matters that it is ONE something:
 * six features each loading "the bits I need" is six chances for the week
 * route and the check-in endpoint to disagree about which conditions were
 * open on Tuesday.
 *
 * So this file is a loader with no policy in it. It decides nothing about
 * training: every judgement — which conditions apply on a given date, what a
 * check-in means, how a week gets clamped — belongs to the pure functions in
 * `shared/`, which is where it can be unit-tested without a database. What
 * lives here is which rows to fetch and how far back.
 *
 * `today` is always passed in, never read off the clock here, for the same
 * reason every other layer takes it: a week must be reproducible against any
 * date, and "today" computed in two places with two offsets is how a plan
 * silently shifts by a day.
 */

import { eq } from "drizzle-orm";
import { db } from "./db";
import { athleteMeasurements, trainingSessions } from "@shared/schema";
import { type AthleteParams, type AthleteRow, athleteParamsFromRow } from "@shared/athlete";
import { addDays } from "@shared/dates";
import { type Condition, crossTrainingAvailability } from "@shared/conditions";
import type { Readiness } from "@shared/readiness";
import type { Sport } from "@shared/session";
import { actualTssFor } from "@shared/prescription/completion";
import type { AthleteState, LoggedLoad } from "@shared/prescription/adjust";
import { listConditions } from "./conditionsService";
import { listCompletions, loggedSessionsFor, type CompletionRecord } from "./completionsService";
import { getCheckIn, listCheckIns, readinessFor, type CheckInRecord } from "./checkInsService";
import { athleteParamsWithPhysique } from "./physiqueService";
import { getPreferences } from "./preferencesService";
import { listGoals } from "./goalsService";
import { getAppShell } from "./appShellService";

/** Single-athlete app: the same row every other athlete read and write uses. */
const ATHLETE_ROW_ID = "self";

/**
 * How far back logged sessions are loaded for the weekly load ceiling.
 *
 * The ceiling itself only needs the trailing 28 days, but `computeTrainingLoad`
 * walks the whole history forward through a 42-day EWMA, so handing it four
 * weeks would start CTL at zero and report an athlete as untrained. Four
 * months is comfortably past that warm-up and still a small read.
 */
export const LOAD_HISTORY_DAYS = 120;

/**
 * How far back closed conditions are loaded.
 *
 * A condition that healed longer ago than this cannot still be inside a
 * return-to-training ramp, so loading it would be work with no possible
 * effect — and a stale injury still steering a plan is the Phase 3 archetype
 * this app has already been bitten by once.
 */
export const CONDITION_HISTORY_DAYS = 60;

function getAthleteRow(): AthleteRow | null {
  const row = db.select().from(athleteMeasurements).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).get();
  return row ? (JSON.parse(row.fieldsJson) as AthleteRow) : null;
}

/**
 * The athlete's numbers as everything downstream should read them: the
 * stored row (which already carries entered benchmarks), with the newest
 * weigh-in folded in at READ time.
 *
 * Read-time rather than a write-back, so deleting or back-dating a weigh-in
 * simply works and no athlete row is ever silently rewritten from a
 * measurement the athlete did not enter as one (DECISIONS C4).
 */
export function getAthleteParams(): AthleteParams {
  return athleteParamsWithPhysique(athleteParamsFromRow(getAthleteRow()));
}

/**
 * Rows from the training ledger — connector syncs and FIT uploads.
 *
 * Only half the athlete's history: the other half is the sessions they
 * ticked off in the app, which `completedLoad` prices below.
 */
function syncedLoad(from: string, today: string): LoggedLoad[] {
  return db
    .select()
    .from(trainingSessions)
    .all()
    .filter((row) => row.date >= from && row.date <= today)
    .map((row) => ({
      date: row.date,
      sport: row.sport as LoggedLoad["sport"],
      durationMinutes: row.durationMinutes,
      tss: row.tss,
      avgHeartRate: row.avgHeartRate,
      avgPaceSecPerKm: row.avgPaceSecPerKm,
      avgPaceSecPer100m: row.avgPaceSecPer100m,
      avgPowerWatts: row.avgPowerWatts,
      normalizedPower: row.normalizedPower,
      hrZonesJson: row.hrZonesJson,
      rpe: row.rpe,
    }));
}

/**
 * The sessions the athlete ticked off, priced as load.
 *
 * Without this the weekly load ceiling (DECISIONS B4) was unreachable for
 * the exact athlete CLAUDE.md says the app is for — "tick sessions off every
 * week", no watch connected. `recentLoad` read `training_sessions` only,
 * which nothing but a connector sync or a FIT upload ever writes, so
 * `chronicWeeklyLoad` returned null on its first line and the ceiling
 * returned the week untouched, every time. Twelve weeks of completions the
 * adherence line was already pricing at ~275 TSS a week were invisible to it:
 * a built capability nothing asked for, the Phase 8 archetype, in the file
 * whose own comment claims to be fixing it.
 *
 * Three rules, each of which is a way to get this wrong:
 *
 *  1. **A row that cannot be priced is dropped, never counted as zero.**
 *     `actualTssFor` returns null when there is no prescription snapshot to
 *     price against — that is "no evidence", not "no training", and counting
 *     it as 0 would deflate the baseline and clamp a legitimate week.
 *  2. **A skipped session IS kept, at zero.** That is a genuine rest day and
 *     it is what makes a missed week actually lower chronic load — the case
 *     B4 names. Its duration goes to 0 too, because `estimateSessionTss`
 *     ignores a falsy `tss` and would otherwise re-price the prescribed
 *     duration as if it had happened.
 *  3. **The synced file wins.** Dedupe is by (date, sport), NOT by
 *     `sessionId`: that field is null for an ordinary tick-off, so keying on
 *     it would double-count every session for an athlete who has Garmin
 *     connected AND ticks their cards — doubling chronic load and making the
 *     ceiling unreachable in the other direction.
 */
function completedLoad(records: readonly CompletionRecord[], athlete: AthleteParams, synced: readonly LoggedLoad[]): LoggedLoad[] {
  const files = loggedSessionsFor(records);
  const alreadyCounted = new Set(synced.map((s) => `${s.date}#${s.sport}`));
  const out: LoggedLoad[] = [];

  for (const record of records) {
    const prescribed = record.prescribed;
    if (!prescribed) continue;
    const sport = prescribed.sport as Sport;
    if (alreadyCounted.has(`${record.date}#${sport}`)) continue;
    const tss = actualTssFor(record, athlete, record.sessionId ? files.get(record.sessionId) : null);
    if (tss == null) continue;
    out.push({ date: record.date, sport, durationMinutes: tss > 0 ? prescribed.durationMinutes : 0, tss });
  }
  return out;
}

/**
 * Recent training, priced by the same engine the Data page reads: synced
 * files first, then everything the athlete ticked off that no file covers.
 */
export function recentLoad(today: string, days: number = LOAD_HISTORY_DAYS, athlete: AthleteParams = getAthleteParams()): LoggedLoad[] {
  const from = addDays(today, -days);
  const synced = syncedLoad(from, today);
  return [...synced, ...completedLoad(listCompletions(from, today), athlete, synced)];
}

/**
 * The conditions that may STEER a plan: inside the engine's window, and only
 * if the athlete still has the block.
 *
 * One rule, in one place, for every consumer — the week, the arbitration
 * endpoint and the risk a prediction's band is widened by. Switching
 * "Something hurts?" off used to stop the week's engine and nothing else, so
 * a block that was off still paused the athlete's cut and still widened
 * their race prediction, with the Plan page reading "deficit" at the top and
 * "your cut is paused while Calf strain is open" below it — naming a feature
 * they had just switched off. Phase 9's promise is ONE matching rule for
 * what renders and what acts; this is that rule.
 *
 * Deliberately NOT applied to `GET /api/conditions`: an athlete must still be
 * able to see and close what they logged before switching the block off. The
 * bug is conditions steering output, not conditions being readable.
 */
export function plannableConditions(today: string): Condition[] {
  if (!getAppShell(today).capabilities.includes("condition_adjustment")) return [];
  return listConditions({ closedOnOrAfter: addDays(today, -CONDITION_HISTORY_DAYS) });
}

/** One morning: what the athlete reported and what it meant. */
export interface DailyReadiness {
  date: string;
  checkIn: CheckInRecord | null;
  readiness: Readiness | null;
}

/**
 * Every morning of this week that has already happened.
 *
 * `AthleteState` carries ONE check-in — this morning's — because the
 * readiness slice acts on today. But the week it modifies is seven days long
 * and re-derives from scratch on every request, so yesterday's adjustment
 * evaporated at midnight: an athlete who checked in very low on Tuesday,
 * was told to rest and rested, opened the app on Wednesday to find Tuesday
 * showing a full 52-minute threshold run they never did, no reason text, no
 * "actually, I did this" control, and an adherence line counting the session
 * the app itself had removed as one they failed to do. Conditions are
 * durable rows covering a date range, so the asymmetry was invisible
 * everywhere the conditions slice was tested.
 *
 * Loaded up to `today` and no further: a check-in cannot say anything about
 * a day that has not happened, and a week being browsed ahead of time must
 * stay free of this morning entirely.
 */
export function weekReadiness(weekStart: string, weekEnd: string, today: string): DailyReadiness[] {
  if (!getAppShell(today).capabilities.includes("readiness_modulation")) return [];
  const last = today < weekEnd ? today : weekEnd;
  if (last < weekStart) return [];
  return listCheckIns(weekStart, last).map((checkIn) => ({
    date: checkIn.date,
    checkIn,
    readiness: readinessFor(checkIn.date),
  }));
}

/**
 * Everything `adjustWeek` is allowed to know, for one week.
 *
 * `weekStart`/`weekEnd` scope what the athlete has already ANSWERED (a
 * completion from another week must not make this week's session immune),
 * while `today` scopes everything that is a fact about now — which
 * conditions have gone stale, this morning's check-in, the trailing load.
 * Keeping the two apart is what lets next week be viewed without today's
 * check-in being applied to it.
 */
export function buildAthleteState(weekStart: string, weekEnd: string, today: string): AthleteState {
  const params = getAthleteParams();
  /*
   * Block off = engine off, decided HERE rather than by the caller.
   *
   * The two health blocks carry their own capabilities rather than having a
   * separate engine twin, so switching "Morning check-in" or "Something
   * hurts?" off in Your app switches the behaviour off through the ONE
   * matching rule that already decides what renders. It used to be applied
   * in `buildWeek`, which left the arbitration, prediction and what-if call
   * sites reading the store directly — see `plannableConditions`.
   *
   * `checkIn` is deliberately NOT gated: it is the record of what the
   * athlete told the app, and a record is not an instruction. Only
   * `readiness` — the thing that acts — is.
   */
  const readinessOn = getAppShell(today).capabilities.includes("readiness_modulation");
  return {
    params,
    conditions: plannableConditions(today),
    available: crossTrainingAvailability(listGoals(), getPreferences().features, today),
    answeredKeys: listCompletions(weekStart, weekEnd).map((c) => c.key),
    checkIn: getCheckIn(today),
    readiness: readinessOn ? readinessFor(today) : null,
    recentLoad: recentLoad(today, LOAD_HISTORY_DAYS, params),
  };
}
