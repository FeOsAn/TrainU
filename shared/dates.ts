/**
 * The one date module.
 *
 * Every date in this app is a plain `YYYY-MM-DD` string in UTC, never a
 * `Date` object crossing a module boundary — the same discipline
 * `Measured<T>` applies to physiological numbers, applied to time: a bare
 * `Date` carries a timezone nobody declared, and "today" computed in two
 * places with two different offsets is how a plan silently shifts by a day.
 *
 * These helpers were copied private into prescribe.ts, routes.ts and
 * goalPhase.ts before this file existed. Same bodies, one home, so a fix to
 * week-boundary handling can't land in one copy and miss the others.
 *
 * Every function here is pure except `todayISO()`, which is the single place
 * the app reads the clock — a pure helper that secretly consults
 * `Date.now()` is untestable, and the layer above always has a real `today`
 * to pass down.
 */

const MS_PER_DAY = 86_400_000;

function utc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Today, UTC. The ONE clock read — everything downstream takes `today` as a parameter so it can be tested against any date. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `date` shifted by `n` days (negative goes back). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`. Positive when `b` is later; `daysBetween(d, d) === 0`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / MS_PER_DAY);
}

/**
 * The Monday on or before `date`.
 *
 * Monday-start so "this week" means the same thing to the plan engine, the
 * athlete and the adherence ledger. A Sunday therefore belongs to the week
 * that STARTED six days earlier — it is the end of that week, not the start
 * of the next one.
 */
export function startOfWeek(date: string): string {
  const dayOfWeek = weekdayOf(date);
  return addDays(date, -dayOfWeek);
}

/**
 * Weeks from `from` to `to`, FRACTIONAL on purpose — a race 10 days out is
 * 1.43 weeks out, and rounding that to 1 or 2 is what makes a taper start on
 * the wrong day.
 */
export function weeksUntil(from: string, to: string): number {
  return (utc(to) - utc(from)) / (7 * MS_PER_DAY);
}

/** A real calendar date in `YYYY-MM-DD`. Rejects "2026-02-30" and "2026-13-01", which `Date.parse` quietly rolls over. */
export function isValidISODate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
}

/** 0 = Monday … 6 = Sunday — the same indexing `assignDates` lays a week out with, so an offset means one thing everywhere. */
export function weekdayOf(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Indexed by `weekdayOf`, so `WEEKDAY_LABELS[weekdayOf(d)]` is always the right name. The athlete reads these; no index ever reaches them. */
export const WEEKDAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Same order, for cards and chips where the full name doesn't fit. */
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
