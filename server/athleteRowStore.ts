/**
 * The stored athlete row — one reader, one writer.
 *
 * This pair existed verbatim in three files (routes.ts, benchmarksService.ts,
 * athleteStateService.ts) before onboarding needed a fourth. Three identical
 * copies is the failure mode this codebase keeps writing comments about: they
 * agree right up until one of them learns something (a new row id, a
 * migration, a validation) and the others don't. So it lives here.
 *
 * Note what this is NOT: it is not how you READ the athlete's numbers.
 * `getAthleteParams()` in athleteStateService.ts is, because it folds the
 * newest weigh-in in at read time (DECISIONS C4). This is the raw row
 * underneath that fold.
 */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { athleteMeasurements } from "@shared/schema";
import type { AthleteRow } from "@shared/athlete";

/** Single athlete — see CLAUDE.md. No user table, no tenancy. */
export const ATHLETE_ROW_ID = "self";

export function getAthleteRow(): AthleteRow | null {
  const row = db.select().from(athleteMeasurements).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).get();
  return row ? (JSON.parse(row.fieldsJson) as AthleteRow) : null;
}

export function saveAthleteRow(row: AthleteRow): void {
  const fieldsJson = JSON.stringify(row);
  const now = new Date().toISOString();
  const existing = db.select().from(athleteMeasurements).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).get();
  if (existing) {
    db.update(athleteMeasurements).set({ fieldsJson, updatedAt: now }).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).run();
  } else {
    db.insert(athleteMeasurements).values({ id: ATHLETE_ROW_ID, fieldsJson, updatedAt: now }).run();
  }
}
