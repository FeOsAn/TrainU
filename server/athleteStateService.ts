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
import { crossTrainingAvailability } from "@shared/conditions";
import type { AthleteState, LoggedLoad } from "@shared/prescription/adjust";
import { listConditions } from "./conditionsService";
import { listCompletions } from "./completionsService";
import { getCheckIn, readinessFor } from "./checkInsService";
import { athleteParamsWithPhysique } from "./physiqueService";
import { getPreferences } from "./preferencesService";
import { listGoals } from "./goalsService";

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

/** Recent logged training, priced by the same engine the Data page reads. */
export function recentLoad(today: string, days: number = LOAD_HISTORY_DAYS): LoggedLoad[] {
  const from = addDays(today, -days);
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
  return {
    params,
    conditions: listConditions({ closedOnOrAfter: addDays(today, -CONDITION_HISTORY_DAYS) }),
    available: crossTrainingAvailability(listGoals(), getPreferences().features, today),
    answeredKeys: listCompletions(weekStart, weekEnd).map((c) => c.key),
    checkIn: getCheckIn(today),
    readiness: readinessFor(today),
    recentLoad: recentLoad(today),
  };
}
