/**
 * Ticking sessions off — the adherence half of the moat dataset.
 *
 * See shared/schema.ts's sessionCompletions comment for why this is keyed by
 * date#kind and why the prescription is snapshotted rather than re-derived.
 * The vocabulary (statuses, reasons, what each status permits, pricing,
 * validation) lives in shared/prescription/completion.ts so the server, the
 * routes, the client and the modulation layer read one list rather than four
 * copies of it.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { sessionCompletions, trainingSessions } from "@shared/schema";
import { sessionCompletionKey, type PlannedSession, type SessionKind } from "@shared/prescription/sessionKinds";
import {
  COMPLETION_STATUSES,
  STATUS_ALLOWS,
  actualTssFor,
  parseReason,
  validateFeedback,
  type CompletionFeedback,
  type CompletionReason,
  type CompletionStatus,
} from "@shared/prescription/completion";
import type { AthleteParams } from "@shared/athlete";
import type { SessionForTss } from "@shared/trainingLoad";
import type { Sport } from "@shared/session";

/**
 * Re-exported so existing importers keep compiling; the declaration moved to
 * shared/prescription/completion.ts. New code should import it from there.
 */
export { COMPLETION_STATUSES };
export type { CompletionStatus, CompletionReason };

/** One record, as the rest of the server sees it. */
export type CompletionRecord = CompletionFeedback;

export class InvalidCompletionError extends Error {}

/**
 * PATCH semantics on the optional fields: `undefined` keeps what is stored,
 * `null` clears it, a value sets it. That is what lets the UI stay one tap for
 * Done, with the effort rating and the reason as optional second taps that
 * don't erase each other.
 */
export interface RecordCompletionInput {
  date: string;
  kind: SessionKind;
  /** Always required — a tap always asserts a status. */
  status: CompletionStatus;
  rpe?: number | null;
  reason?: CompletionReason | null;
  note?: string | null;
  sessionId?: string | null;
  /** What was on the card when it was ticked. Absent keeps the ORIGINAL snapshot. */
  prescribed?: PlannedSession | null;
}

function patch<T>(incoming: T | null | undefined, existing: T | null): T | null {
  return incoming === undefined ? existing : incoming;
}

/** Upsert — ticking the same session twice corrects the record rather than duplicating it. */
export function recordCompletion(input: RecordCompletionInput): CompletionRecord {
  const error = validateFeedback(input);
  if (error) throw new InvalidCompletionError(error);

  const key = sessionCompletionKey(input.date, input.kind);
  const existing = db.select().from(sessionCompletions).where(eq(sessionCompletions.key, key)).get();

  const allows = STATUS_ALLOWS[input.status];
  // Explicit contradictions were already rejected by validateFeedback, so
  // anything cleared here is INHERITED: a skipped+injury row flipped to Done
  // loses its reason, because the reason was about not doing it.
  const rpe = allows.rpe ? patch(input.rpe, existing?.rpe ?? null) : null;
  const reason = allows.reason ? patch(input.reason, parseReason(existing?.reason)) : null;

  const values = {
    key,
    date: input.date,
    kind: input.kind,
    status: input.status,
    prescribedJson: input.prescribed ? JSON.stringify(input.prescribed) : (existing?.prescribedJson ?? null),
    rpe,
    reason: reason as string | null,
    note: patch(input.note, existing?.note ?? null),
    sessionId: patch(input.sessionId, existing?.sessionId ?? null),
    recordedAt: new Date().toISOString(),
  };

  if (existing) {
    db.update(sessionCompletions).set(values).where(eq(sessionCompletions.key, key)).run();
  } else {
    db.insert(sessionCompletions).values(values).run();
  }

  return toRecord(values);
}

function toRecord(row: typeof sessionCompletions.$inferSelect): CompletionRecord {
  return {
    key: row.key,
    date: row.date,
    kind: row.kind as SessionKind,
    status: row.status as CompletionStatus,
    // An unrecognised stored string maps to null rather than leaking out as a
    // signal nothing knows how to read.
    reason: parseReason(row.reason),
    rpe: row.rpe,
    note: row.note,
    sessionId: row.sessionId,
    recordedAt: row.recordedAt,
    prescribed: row.prescribedJson ? (JSON.parse(row.prescribedJson) as PlannedSession) : null,
  };
}

export function listCompletions(from?: string, to?: string): CompletionRecord[] {
  return db
    .select()
    .from(sessionCompletions)
    .all()
    .filter((row) => (!from || row.date >= from) && (!to || row.date <= to))
    .map(toRecord);
}

/**
 * The logged rows behind whichever completions carry a `sessionId`, keyed by
 * that id — so `actualTssFor` can price off the real file (real duration, real
 * HR/power) instead of the prescribed duration at a self-reported effort.
 */
export function loggedSessionsFor(records: readonly CompletionRecord[]): Map<string, SessionForTss> {
  const ids = Array.from(new Set(records.map((r) => r.sessionId).filter((id): id is string => !!id)));
  if (ids.length === 0) return new Map();
  const rows = db.select().from(trainingSessions).where(inArray(trainingSessions.id, ids)).all();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        sport: row.sport as Sport,
        durationMinutes: row.durationMinutes,
        tss: row.tss,
        avgHeartRate: row.avgHeartRate,
        avgPaceSecPerKm: row.avgPaceSecPerKm,
        avgPaceSecPer100m: row.avgPaceSecPer100m,
        avgPowerWatts: row.avgPowerWatts,
        normalizedPower: row.normalizedPower,
        hrZonesJson: row.hrZonesJson,
        rpe: row.rpe,
      } satisfies SessionForTss,
    ]),
  );
}

export interface AdherenceSummary {
  prescribed: number;
  completed: number;
  partial: number;
  skipped: number;
  /** Completed (counting partials as half) over everything prescribed, 0-1. Null when nothing's been prescribed yet. */
  adherenceRate: number | null;
  /**
   * Training stress actually done, against the week's planned `totalTss`.
   * Null when no athlete numbers were supplied or nothing could be priced —
   * never 0, which would read as "you did nothing" rather than "unknown".
   */
  actualTss: number | null;
}

/**
 * Adherence over a window. `prescribedCount` is passed in rather than
 * inferred, because an untouched session is neither completed nor skipped —
 * it just hasn't been answered, and only the plan knows how many there were.
 *
 * `athlete` and `logged` are optional so every existing caller keeps working;
 * pass them to get `actualTss`.
 */
export function summariseAdherence(
  records: readonly CompletionRecord[],
  prescribedCount: number,
  athlete?: AthleteParams,
  logged?: ReadonlyMap<string, SessionForTss>,
): AdherenceSummary {
  const completed = records.filter((r) => r.status === "completed").length;
  const partial = records.filter((r) => r.status === "partial").length;
  const skipped = records.filter((r) => r.status === "skipped").length;

  let actualTss: number | null = null;
  if (athlete) {
    for (const r of records) {
      const tss = actualTssFor(r, athlete, r.sessionId ? logged?.get(r.sessionId) : null);
      if (tss != null) actualTss = (actualTss ?? 0) + tss;
    }
  }

  return {
    prescribed: prescribedCount,
    completed,
    partial,
    skipped,
    adherenceRate: prescribedCount > 0 ? Math.round(((completed + partial * 0.5) / prescribedCount) * 100) / 100 : null,
    actualTss,
  };
}
