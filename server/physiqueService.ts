/**
 * Physique persistence — one row per date, and the fold that lets those
 * rows steer the plan without ever writing an athlete row.
 *
 * All the judgement lives in shared/physique.ts: the bounds, the trend, the
 * verdict, and `applyPhysiqueEvidence`. This file is the database half.
 *
 * The one thing worth stating here is what is NOT in it. There is no
 * `syncAthleteFromPhysique`, and no "adopt the weight the athlete typed
 * before this shipped" step. A weigh-in never writes `athleteMeasurements`.
 * `athleteParamsWithPhysique` folds the newest entry in at READ time,
 * exactly as the benchmark values already do, which is what makes deleting
 * and back-dating correct for free:
 *
 *   - delete the newest weigh-in  → the next-newest takes over;
 *   - delete every weigh-in       → the field honestly reverts to whatever
 *                                   the athlete row (or the seed) says;
 *   - back-date an entry          → it cannot displace a newer one, because
 *                                   the fold picks by date, not by write.
 *
 * A second, incremental write path would have to re-implement all three of
 * those, and would eventually get one of them wrong.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull, lte, type SQL } from "drizzle-orm";
import { db } from "./db";
import { physiqueEntries } from "@shared/schema";
import { type AthleteParams } from "@shared/athlete";
import { todayISO } from "@shared/dates";
import type { Goal } from "@shared/goal";
import {
  InvalidPhysiqueEntryError,
  type MetricTrend,
  type PhysiqueEntry,
  type PhysiqueEntryInput,
  type PhysiqueMetric,
  type PhysiqueProgress,
  type TrendWindow,
  applyPhysiqueEvidence,
  progressVsGoal,
  trend,
  validatePhysiqueEntry,
  weightChangeWarning,
} from "@shared/physique";

export { InvalidPhysiqueEntryError };

export class PhysiqueEntryNotFoundError extends Error {}

type Row = typeof physiqueEntries.$inferSelect;

function toEntry(row: Row): PhysiqueEntry {
  return {
    id: row.id,
    date: row.date,
    weightKg: row.weightKg ?? null,
    bodyFatPercent: row.bodyFatPercent ?? null,
    waistCm: row.waistCm ?? null,
    note: row.note ?? null,
    recordedAt: row.recordedAt,
  };
}

function rowFor(date: string): Row | undefined {
  return db.select().from(physiqueEntries).where(eq(physiqueEntries.date, date)).get();
}

/** `undefined` keeps what is stored, `null` clears it, a value sets it. */
function patch<T>(incoming: T | null | undefined, existing: T | null): T | null {
  return incoming === undefined ? existing : incoming;
}

/**
 * Record a weigh-in. Logging twice on the same date CORRECTS that date; it
 * never adds a second row for it, so "what did I weigh on Tuesday" has one
 * answer.
 *
 * The merged row is what gets validated, not the incoming patch: clearing
 * the last remaining number leaves an entry that measures nothing, and that
 * is rejected the same way an empty one is.
 */
export function upsertPhysiqueEntry(input: PhysiqueEntryInput, options: { today?: string } = {}): PhysiqueEntry {
  if (!input || typeof input !== "object") throw new InvalidPhysiqueEntryError("A weigh-in has to be an object.");
  const existing = input.date ? rowFor(input.date) : undefined;
  const previous = existing ? toEntry(existing) : null;

  const merged: PhysiqueEntryInput = {
    date: input.date,
    weightKg: patch(input.weightKg, previous?.weightKg ?? null),
    bodyFatPercent: patch(input.bodyFatPercent, previous?.bodyFatPercent ?? null),
    waistCm: patch(input.waistCm, previous?.waistCm ?? null),
    note: patch(input.note, previous?.note ?? null),
  };

  const error = validatePhysiqueEntry(merged, { today: options.today ?? todayISO() });
  if (error) throw new InvalidPhysiqueEntryError(error);

  const values = {
    date: merged.date,
    weightKg: merged.weightKg ?? null,
    bodyFatPercent: merged.bodyFatPercent ?? null,
    waistCm: merged.waistCm ?? null,
    note: merged.note ?? null,
    recordedAt: new Date().toISOString(),
  };

  if (existing) {
    db.update(physiqueEntries).set(values).where(eq(physiqueEntries.date, merged.date)).run();
    return toEntry({ ...existing, ...values });
  }
  const id = randomUUID();
  db.insert(physiqueEntries).values({ id, ...values }).run();
  return toEntry({ id, ...values } as Row);
}

export function getPhysiqueEntry(date: string): PhysiqueEntry | null {
  const row = rowFor(date);
  return row ? toEntry(row) : null;
}

/** Inclusive at both ends, oldest first. Either bound may be omitted. */
export function listPhysiqueEntries(from?: string, to?: string): PhysiqueEntry[] {
  const bounds: SQL[] = [];
  if (from) bounds.push(gte(physiqueEntries.date, from));
  if (to) bounds.push(lte(physiqueEntries.date, to));
  const query = db.select().from(physiqueEntries);
  const rows = bounds.length ? query.where(and(...bounds)).all() : query.all();
  return rows.map(toEntry).sort((a, b) => (a.date === b.date ? a.recordedAt.localeCompare(b.recordedAt) : a.date < b.date ? -1 : 1));
}

/**
 * Delete one date's weigh-in. Throws rather than succeeding silently on a
 * date that was never logged: "deleted" and "there was nothing there" are
 * different answers, and only one of them means the athlete's tap did what
 * they thought.
 */
export function deletePhysiqueEntry(date: string): PhysiqueEntry {
  const row = rowFor(date);
  if (!row) throw new PhysiqueEntryNotFoundError(`There is no weigh-in recorded for ${date}.`);
  db.delete(physiqueEntries).where(eq(physiqueEntries.date, date)).run();
  return toEntry(row);
}

/**
 * The newest row that actually carries this metric. Two one-row queries
 * instead of loading the whole history, because this runs on every athlete
 * read — and the fold only ever looks at the newest of each.
 */
function newestWith(metric: Extract<PhysiqueMetric, "weightKg" | "bodyFatPercent">): PhysiqueEntry | null {
  const column = metric === "weightKg" ? physiqueEntries.weightKg : physiqueEntries.bodyFatPercent;
  const row = db.select().from(physiqueEntries).where(isNotNull(column)).orderBy(desc(physiqueEntries.date)).limit(1).get();
  return row ? toEntry(row) : null;
}

/**
 * THE HOOK the athlete read path calls (see INTEGRATION NEEDS): fold the
 * newest logged weight and body fat over the stored athlete row, as measured
 * values with the weigh-in's own date as provenance.
 *
 * Idempotent and side-effect free — it reads rows and returns a new
 * `AthleteParams`. Nothing is written, so an athlete who deletes their
 * weigh-ins is not left with a stale "measured" value nobody can explain.
 */
export function athleteParamsWithPhysique(params: AthleteParams): AthleteParams {
  const newest = [newestWith("weightKg"), newestWith("bodyFatPercent")].filter((e): e is PhysiqueEntry => e != null);
  return applyPhysiqueEvidence(params, newest);
}

/** The trend over the stored history, for the Athlete page's sparkline. */
export function physiqueTrend(window: TrendWindow = {}): Record<PhysiqueMetric, MetricTrend | null> {
  return trend(listPhysiqueEntries(), { today: todayISO(), ...window });
}

/** Where a body-composition goal stands against the logged history. */
export function physiqueProgress(goal: Goal, params: AthleteParams, options: { today?: string } = {}): PhysiqueProgress {
  return progressVsGoal(listPhysiqueEntries(), goal, params, { today: options.today ?? todayISO() });
}

/**
 * The confirmation question for a weight a long way from the last logged
 * one, answered against what is actually stored — so the client asks the
 * same question the server would.
 */
export function physiqueSaveWarning(input: PhysiqueEntryInput): string | null {
  const previous = listPhysiqueEntries(undefined, input.date).filter((e) => e.date !== input.date).at(-1) ?? null;
  return weightChangeWarning(input.weightKg, previous);
}
