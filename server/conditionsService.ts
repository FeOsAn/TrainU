/**
 * Condition persistence — the only place a condition row is written.
 *
 * Every write goes through `shared/conditions.ts`'s DB-free validation, for
 * the same reason `createGoal` goes through `goalValidation.ts`: the REST
 * endpoint, a tick-off that says "I skipped this, my calf hurts", and the
 * chat tool that will eventually take "I tweaked my calf yesterday" must all
 * be held to one definition of a valid condition. Two write paths is how the
 * app ends up with a row the engine cannot read.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { conditions as conditionsTable } from "@shared/schema";
import { todayISO } from "@shared/dates";
import {
  type BodyPart,
  type Condition,
  type ConditionKind,
  type ConditionPatch,
  type Restriction,
  type Severity,
  InvalidConditionError,
  RESTRICTIONS,
  SEVERITIES,
  isOpenOn,
  validateConditionInput,
  validateConditionPatch,
} from "@shared/conditions";

export { InvalidConditionError };

export class ConditionNotFoundError extends Error {}

/**
 * A row could have been written by an older schema, hand-edited, or restored
 * from a backup, so nothing coming out of the database is trusted to be a
 * valid enum member. An unreadable restriction is dropped rather than carried
 * into the engine, where it would silently forbid nothing at all.
 */
function rowToCondition(row: typeof conditionsTable.$inferSelect): Condition {
  let restrictions: Restriction[] = [];
  try {
    const parsed = JSON.parse(row.restrictionsJson) as unknown;
    if (Array.isArray(parsed)) restrictions = RESTRICTIONS.filter((r) => parsed.includes(r));
  } catch {
    restrictions = [];
  }
  return {
    id: row.id,
    kind: row.kind as ConditionKind,
    label: row.label,
    bodyPart: (row.bodyPart as BodyPart | null) ?? null,
    // Severity drives whether the athlete is told to rest, so an out-of-range
    // number reads as the most cautious value rather than as nothing.
    severity: ((SEVERITIES as readonly number[]).includes(row.severity) ? row.severity : 3) as Severity,
    restrictions,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ConditionFilter {
  /** Only conditions with no `closedAt`. */
  openOnly?: boolean;
  /**
   * Drop conditions that healed before this date. The week adjuster passes
   * today − 60 days: a condition closed longer ago than that cannot still be
   * in a return-to-training ramp, so loading it would be work with no
   * possible effect.
   */
  closedOnOrAfter?: string;
  /** Open on this specific date — the per-date rule, applied in SQL's stead. */
  openOn?: string;
}

/** Newest first: the athlete reads the thing that just happened to them at the top. */
export function listConditions(filter: ConditionFilter = {}): Condition[] {
  return db
    .select()
    .from(conditionsTable)
    .all()
    .map(rowToCondition)
    .filter((c) => {
      if (filter.openOnly && c.closedAt !== null) return false;
      if (filter.openOn !== undefined && !isOpenOn(c, filter.openOn)) return false;
      if (filter.closedOnOrAfter !== undefined && c.closedAt !== null && c.closedAt < filter.closedOnOrAfter) return false;
      return true;
    })
    .sort((a, b) => (a.openedAt === b.openedAt ? b.createdAt.localeCompare(a.createdAt) : b.openedAt.localeCompare(a.openedAt)));
}

export function getCondition(id: string): Condition | null {
  const row = db.select().from(conditionsTable).where(eq(conditionsTable.id, id)).get();
  return row ? rowToCondition(row) : null;
}

function requireCondition(id: string): Condition {
  const existing = getCondition(id);
  if (!existing) throw new ConditionNotFoundError(`no condition with id ${id}`);
  return existing;
}

export interface OpenConditionOptions {
  today?: string;
  /**
   * The `date#kind` of the session whose tick-off opened this — "skipped,
   * injured" leading straight into the form.
   *
   * ACCEPTED BUT NOT YET STORED: the `conditions` table has no column for it.
   * It is validated here so the call site is correct today and one line in
   * this function persists it the moment the column lands; it is deliberately
   * NOT smuggled into `note`, which is the athlete's own text. What is lost
   * until then is only the back-link ("this came from Tuesday's skip") — the
   * condition itself is complete.
   */
  sourceCompletionKey?: string | null;
}

/** Throws InvalidConditionError on bad input — a form post and a model's tool call are equally untrusted. */
export function openCondition(input: unknown, opts: OpenConditionOptions = {}): Condition {
  const today = opts.today ?? todayISO();
  const valid = validateConditionInput(input, today);
  if (opts.sourceCompletionKey != null && typeof opts.sourceCompletionKey !== "string") {
    throw new InvalidConditionError("sourceCompletionKey must be text");
  }

  const now = new Date().toISOString();
  const condition: Condition = {
    id: randomUUID(),
    kind: valid.kind,
    label: valid.label,
    bodyPart: valid.bodyPart,
    severity: valid.severity,
    restrictions: valid.restrictions,
    openedAt: valid.openedAt,
    closedAt: null,
    note: valid.note,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(conditionsTable)
    .values({
      id: condition.id,
      kind: condition.kind,
      label: condition.label,
      bodyPart: condition.bodyPart,
      severity: condition.severity,
      restrictionsJson: JSON.stringify(condition.restrictions),
      openedAt: condition.openedAt,
      closedAt: null,
      note: condition.note,
      createdAt: condition.createdAt,
      updatedAt: condition.updatedAt,
    })
    .run();

  return condition;
}

/**
 * Change an existing condition.
 *
 * `updatedAt` moves on every patch, which is also what un-suspends a stale
 * condition (see `isSuspended`): the athlete confirming "yes, still sore" is
 * exactly the edit that proves it is still true.
 */
export function patchCondition(id: string, patch: unknown, today: string = todayISO()): Condition {
  const existing = requireCondition(id);
  const valid: ConditionPatch = validateConditionPatch(patch, existing, today);
  const updated: Condition = { ...existing, ...valid, updatedAt: new Date().toISOString() };

  db.update(conditionsTable)
    .set({
      label: updated.label,
      bodyPart: updated.bodyPart,
      severity: updated.severity,
      restrictionsJson: JSON.stringify(updated.restrictions),
      openedAt: updated.openedAt,
      closedAt: updated.closedAt,
      note: updated.note,
      updatedAt: updated.updatedAt,
    })
    .where(eq(conditionsTable.id, id))
    .run();

  return updated;
}

/**
 * Mark it healed, on a date the athlete chooses — "it settled on Tuesday" is
 * a normal thing to say on Thursday, and back-dating it is what makes the
 * return-to-training ramp line up with the days it actually covers.
 *
 * Closing an already-closed condition CORRECTS the date rather than failing.
 * The athlete is telling the app something truer than what it had; refusing
 * that would leave them with a wrong date and no way to fix it except opening
 * a duplicate condition.
 */
export function closeCondition(id: string, closedAt?: string, today: string = todayISO()): Condition {
  return patchCondition(id, { closedAt: closedAt ?? today }, today);
}

/** Undo a close — the app never does this on its own, but the athlete may well have ticked healed too early. */
export function reopenCondition(id: string, today: string = todayISO()): Condition {
  return patchCondition(id, { closedAt: null }, today);
}
