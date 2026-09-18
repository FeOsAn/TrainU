/**
 * Storing the morning check-in, and answering with what it means.
 *
 * All the judgement lives in shared/readiness.ts — the formula, the bands,
 * the athlete's own baselines, the gate that says whether a band has earned
 * the right to change a week. This file is the database half: one row per
 * date, upserted, plus the history that `computeReadiness` needs to know
 * what an ordinary morning looks like FOR THIS ATHLETE.
 *
 * Two things are worth stating about what is stored.
 *
 * WHAT A CHECK-IN CHANGED is snapshotted, not re-derived. The plan
 * re-derives on every request, so a month from now "Thursday's threshold run
 * became an easy run" is unreproducible once the goals, the athlete's paces
 * or the calendar have moved on. Same reason `sessionCompletions.prescribedJson`
 * exists. This service does not COMPUTE those changes — the modulation
 * layer's slice does, and the caller hands them here to be kept.
 *
 * EDITING A CHECK-IN CLEARS THEM. If the athlete corrects how they slept,
 * the previous "here is what this morning changed" no longer describes
 * anything the app is doing, and a card that still claimed it would be
 * asserting something untrue. The caller re-runs the week and records the
 * new summaries.
 */

import { and, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import { db } from "./db";
import { dailyCheckIns } from "@shared/schema";
import { SESSION_KINDS, type SessionKind } from "@shared/prescription/sessionKinds";
import {
  RESTING_HR_BASELINE,
  SELF_BASELINE,
  computeReadiness,
  validateCheckIn,
  type CheckIn,
  type Readiness,
  type ReadinessOptions,
} from "@shared/readiness";
import { addDays } from "@shared/dates";

export class InvalidCheckInError extends Error {}

/**
 * One line of "what this check-in changed", in the words the athlete was
 * shown. The modulation layer produces these; this file only keeps them.
 *
 * `action` is a LABEL, never an action id — the caller passes the words from
 * the layer's own label table, so nothing id-shaped can reach a card by way
 * of the database.
 */
export interface CheckInAdjustmentSummary {
  /** The day the change landed on. */
  date: string;
  kind: SessionKind;
  /** e.g. "Moved to Thursday", "Made easy", "Rest day". */
  action: string;
  /** The full sentence, e.g. "Your morning came in well below your own normal, so Tuesday's intervals became an easy run." */
  reason: string;
}

export interface CheckInRecord extends CheckIn {
  restingHrBpm: number | null;
  note: string | null;
  trainAnywayOverride: boolean;
  /** Empty until the layer reports back, and empty again if the check-in is edited. */
  adjustments: CheckInAdjustmentSummary[];
  recordedAt: string;
}

/**
 * The three taps are always required — a check-in always asserts how the
 * morning was. The optional fields patch, exactly as `recordCompletion`
 * does: `undefined` keeps what is stored, `null` clears it, a value sets it.
 * That is what lets "add a resting HR" and "turn the override on" be
 * separate taps that do not erase each other.
 */
export interface UpsertCheckInInput {
  date: string;
  sleepQuality: number;
  soreness: number;
  energy: number;
  restingHrBpm?: number | null;
  note?: string | null;
  trainAnywayOverride?: boolean;
}

/** How far back the history load has to reach to satisfy BOTH baselines. */
const HISTORY_DAYS = Math.max(RESTING_HR_BASELINE.maxAgeDays, SELF_BASELINE.windowDays);

/*
 * `adjustments_json` holds a small envelope rather than a bare array.
 *
 * The column was created to answer "what did this check-in change"; the
 * train-anyway override is the athlete's answer to the same morning and has
 * no column of its own yet. Keeping both behind this service means one
 * writer and one reader, and a bare legacy array still loads — see the
 * report's INTEGRATION NEEDS for the column this should become.
 */
interface StoredExtras {
  trainAnyway: boolean;
  adjustments: CheckInAdjustmentSummary[];
}

function parseExtras(json: string | null | undefined): StoredExtras {
  if (!json) return { trainAnyway: false, adjustments: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Unreadable state stops influencing output rather than taking the row down with it.
    return { trainAnyway: false, adjustments: [] };
  }
  if (Array.isArray(parsed)) return { trainAnyway: false, adjustments: parsed as CheckInAdjustmentSummary[] };
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { trainAnyway?: unknown; adjustments?: unknown };
    return {
      trainAnyway: obj.trainAnyway === true,
      adjustments: Array.isArray(obj.adjustments) ? (obj.adjustments as CheckInAdjustmentSummary[]) : [],
    };
  }
  return { trainAnyway: false, adjustments: [] };
}

function serialiseExtras(extras: StoredExtras): string {
  return JSON.stringify({ v: 1, trainAnyway: extras.trainAnyway, adjustments: extras.adjustments });
}

function toRecord(row: typeof dailyCheckIns.$inferSelect): CheckInRecord {
  const extras = parseExtras(row.adjustmentsJson);
  return {
    date: row.date,
    sleepQuality: row.sleepQuality,
    soreness: row.soreness,
    energy: row.energy,
    restingHrBpm: row.restingHrBpm ?? null,
    note: row.note ?? null,
    trainAnywayOverride: extras.trainAnyway,
    adjustments: extras.adjustments,
    recordedAt: row.recordedAt,
  };
}

function patch<T>(incoming: T | null | undefined, existing: T | null): T | null {
  return incoming === undefined ? existing : incoming;
}

function rowFor(date: string): typeof dailyCheckIns.$inferSelect | undefined {
  return db.select().from(dailyCheckIns).where(eq(dailyCheckIns.date, date)).get();
}

/** Upsert the morning. Checking in twice corrects the record; it never adds a second row for the same day. */
export function upsertCheckIn(input: UpsertCheckInInput): CheckInRecord {
  const error = validateCheckIn(input);
  if (error) throw new InvalidCheckInError(error);

  const existing = rowFor(input.date);
  const previous = existing ? toRecord(existing) : null;

  const values = {
    date: input.date,
    sleepQuality: input.sleepQuality,
    soreness: input.soreness,
    energy: input.energy,
    restingHrBpm: patch(input.restingHrBpm, previous?.restingHrBpm ?? null),
    note: patch(input.note, previous?.note ?? null),
    // Answering the morning again invalidates whatever the last answer changed.
    adjustmentsJson: serialiseExtras({
      trainAnyway: input.trainAnywayOverride ?? previous?.trainAnywayOverride ?? false,
      adjustments: [],
    }),
    recordedAt: new Date().toISOString(),
  };

  if (existing) {
    db.update(dailyCheckIns).set(values).where(eq(dailyCheckIns.date, input.date)).run();
  } else {
    db.insert(dailyCheckIns).values(values).run();
  }
  return toRecord({ ...(existing ?? {}), ...values } as typeof dailyCheckIns.$inferSelect);
}

export function getCheckIn(date: string): CheckInRecord | null {
  const row = rowFor(date);
  return row ? toRecord(row) : null;
}

/** Inclusive at both ends. Either bound may be omitted. */
export function listCheckIns(from?: string, to?: string): CheckInRecord[] {
  const bounds: SQL[] = [];
  if (from) bounds.push(gte(dailyCheckIns.date, from));
  if (to) bounds.push(lte(dailyCheckIns.date, to));
  const query = db.select().from(dailyCheckIns);
  const rows = bounds.length ? query.where(and(...bounds)).all() : query.all();
  return rows.map(toRecord).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Every earlier morning `computeReadiness` is entitled to judge `date`
 * against. Strictly before `date`: a morning is never its own baseline.
 */
function historyBefore(date: string): CheckIn[] {
  return db
    .select()
    .from(dailyCheckIns)
    .where(and(lt(dailyCheckIns.date, date), gte(dailyCheckIns.date, addDays(date, -HISTORY_DAYS))))
    .all()
    .map(toRecord);
}

/**
 * The readiness for one date, or null when that morning was never answered.
 *
 * Null rather than a neutral default on purpose: "we don't know how you feel"
 * and "you feel average" are different facts, and only the first of them is
 * true of a day with no check-in.
 */
export function readinessFor(date: string, options: ReadinessOptions = {}): Readiness | null {
  const record = getCheckIn(date);
  if (!record) return null;
  return computeReadiness(record, historyBefore(date), options);
}

/** Record the morning and answer with what it means — one call, so the two can never disagree. */
export function recordCheckIn(
  input: UpsertCheckInInput,
  options: ReadinessOptions = {},
): { checkIn: CheckInRecord; readiness: Readiness } {
  const checkIn = upsertCheckIn(input);
  return { checkIn, readiness: computeReadiness(checkIn, historyBefore(checkIn.date), options) };
}

function validateSummaries(summaries: readonly CheckInAdjustmentSummary[]): string | null {
  if (!Array.isArray(summaries)) return "Adjustments have to be a list.";
  for (const s of summaries) {
    if (!s || typeof s !== "object") return "Each adjustment has to be an object.";
    if (typeof s.date !== "string" || !s.date) return "Each adjustment needs the day it landed on.";
    if (!SESSION_KINDS.includes(s.kind)) return `"${String(s.kind)}" is not a session this app prescribes.`;
    if (typeof s.action !== "string" || !s.action.trim()) return "Each adjustment needs to say what happened, in words.";
    if (typeof s.reason !== "string" || !s.reason.trim()) return "Each adjustment needs a reason the athlete can read.";
  }
  return null;
}

/**
 * Keep what the modulation layer's readiness slice did with this morning, so
 * the card can still say it long after the plan has re-derived past it.
 *
 * Deliberately a separate call from `recordCheckIn`: the changes are not
 * knowable until the week has been built, and building a week here would put
 * the prescriber behind a POST that is supposed to store three taps.
 */
export function recordCheckInAdjustments(date: string, summaries: readonly CheckInAdjustmentSummary[]): CheckInRecord {
  const error = validateSummaries(summaries);
  if (error) throw new InvalidCheckInError(error);

  const row = rowFor(date);
  if (!row) throw new InvalidCheckInError(`There is no check-in recorded for ${date}.`);

  const extras = parseExtras(row.adjustmentsJson);
  const adjustmentsJson = serialiseExtras({ trainAnyway: extras.trainAnyway, adjustments: [...summaries] });
  db.update(dailyCheckIns).set({ adjustmentsJson }).where(eq(dailyCheckIns.date, date)).run();
  return toRecord({ ...row, adjustmentsJson });
}
