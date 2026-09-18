/**
 * Ticking sessions off — the adherence half of the moat dataset.
 *
 * See shared/schema.ts's sessionCompletions comment for why this is keyed by
 * date#kind and why the prescription is snapshotted rather than re-derived.
 */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { sessionCompletions } from "@shared/schema";
import { SESSION_KINDS, sessionCompletionKey, type PlannedSession, type SessionKind } from "@shared/prescription/sessionKinds";

export const COMPLETION_STATUSES = ["completed", "partial", "skipped"] as const;
export type CompletionStatus = (typeof COMPLETION_STATUSES)[number];

export class InvalidCompletionError extends Error {}

export interface RecordCompletionInput {
  date: string;
  kind: SessionKind;
  status: CompletionStatus;
  rpe?: number | null;
  note?: string | null;
  sessionId?: string | null;
  /** What was on the card when it was ticked. Snapshotted so the record can't drift. */
  prescribed?: PlannedSession | null;
}

export interface CompletionRecord {
  key: string;
  date: string;
  kind: string;
  status: string;
  rpe: number | null;
  note: string | null;
  sessionId: string | null;
  recordedAt: string;
  prescribed: PlannedSession | null;
}

function validate(input: RecordCompletionInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) {
    throw new InvalidCompletionError("date must be a valid YYYY-MM-DD date");
  }
  if (!(SESSION_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidCompletionError(`kind must be one of ${SESSION_KINDS.join(", ")}`);
  }
  if (!(COMPLETION_STATUSES as readonly string[]).includes(input.status)) {
    throw new InvalidCompletionError(`status must be one of ${COMPLETION_STATUSES.join(", ")}`);
  }
  if (input.rpe != null && (!Number.isFinite(input.rpe) || input.rpe < 1 || input.rpe > 10)) {
    throw new InvalidCompletionError("rpe must be between 1 and 10");
  }
}

/** Upsert — ticking the same session twice corrects the record rather than duplicating it. */
export function recordCompletion(input: RecordCompletionInput): CompletionRecord {
  validate(input);
  const key = sessionCompletionKey(input.date, input.kind);
  const values = {
    key,
    date: input.date,
    kind: input.kind,
    status: input.status,
    prescribedJson: input.prescribed ? JSON.stringify(input.prescribed) : null,
    rpe: input.rpe ?? null,
    // The structured skip reason: the column exists, nothing collects it yet.
    // Written as an explicit null rather than left off so the row shape and
    // the table agree in one place.
    reason: null as string | null,
    note: input.note ?? null,
    sessionId: input.sessionId ?? null,
    recordedAt: new Date().toISOString(),
  };

  const existing = db.select().from(sessionCompletions).where(eq(sessionCompletions.key, key)).get();
  if (existing) {
    // Keep the ORIGINAL prescription snapshot if the correction doesn't carry
    // one — the point of the snapshot is what was asked for at the time.
    db.update(sessionCompletions)
      .set({ ...values, prescribedJson: values.prescribedJson ?? existing.prescribedJson })
      .where(eq(sessionCompletions.key, key))
      .run();
  } else {
    db.insert(sessionCompletions).values(values).run();
  }

  return toRecord({ ...values, prescribedJson: values.prescribedJson ?? existing?.prescribedJson ?? null });
}

function toRecord(row: typeof sessionCompletions.$inferSelect): CompletionRecord {
  return {
    key: row.key,
    date: row.date,
    kind: row.kind,
    status: row.status,
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

export interface AdherenceSummary {
  prescribed: number;
  completed: number;
  partial: number;
  skipped: number;
  /** Completed (counting partials as half) over everything prescribed, 0-1. Null when nothing's been prescribed yet. */
  adherenceRate: number | null;
}

/**
 * Adherence over a window. `prescribedCount` is passed in rather than
 * inferred, because an untouched session is neither completed nor skipped —
 * it just hasn't been answered, and only the plan knows how many there were.
 */
export function summariseAdherence(records: CompletionRecord[], prescribedCount: number): AdherenceSummary {
  const completed = records.filter((r) => r.status === "completed").length;
  const partial = records.filter((r) => r.status === "partial").length;
  const skipped = records.filter((r) => r.status === "skipped").length;
  return {
    prescribed: prescribedCount,
    completed,
    partial,
    skipped,
    adherenceRate: prescribedCount > 0 ? Math.round(((completed + partial * 0.5) / prescribedCount) * 100) / 100 : null,
  };
}
