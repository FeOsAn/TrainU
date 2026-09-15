/**
 * Same-activity detection across sources (Garmin, Whoop, a manual FIT
 * upload). Ported from sub5-dashboard's dupeMatch.ts/sessionDedupe.ts —
 * the real incident that shaped this logic: Whoop auto-detect mislabels
 * sessions, so sport-label matching can't catch a duplicate whose label
 * disagrees. Two records of the same physical activity agree on WHEN it
 * happened even when they disagree on what to call it.
 *
 * Primary basis — time overlap: windows overlapping by ≥40% of the shorter
 * one are the same activity. Fallback — same day, duration within 15%, and
 * average heart rate within 8 bpm (two devices on the same body in the same
 * hour agree on HR; two different activities of similar length almost never
 * do). Missing HR on either side makes no claim — a false "keep" costs a
 * manual delete, a false "delete" costs real data.
 */

import type { Sport, TrainingSession } from "./session";

export interface ActivityWindow {
  date: string;
  startTime?: string | null;
  durationMinutes: number;
  avgHeartRate?: number | null;
}

export type MatchBasis = "overlap" | "fingerprint";

/** ISO UTC and Garmin-style naive-UTC ("2026-08-07 13:15:06") both parse; naive-LOCAL strings must be converted before calling this. */
export function parseUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") + "Z" : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function overlapRatio(aStartMs: number, aDurMin: number, bStartMs: number, bDurMin: number): number {
  const aEnd = aStartMs + aDurMin * 60000;
  const bEnd = bStartMs + bDurMin * 60000;
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStartMs, bStartMs);
  if (overlap <= 0) return 0;
  const shorter = Math.min(aDurMin, bDurMin) * 60000;
  return shorter > 0 ? overlap / shorter : 0;
}

export function isSameActivity(candidate: ActivityWindow, groundTruth: ActivityWindow): { match: boolean; basis: MatchBasis | null } {
  const a = candidate, b = groundTruth;
  if (a.date !== b.date) return { match: false, basis: null };
  if (a.durationMinutes <= 0 || b.durationMinutes <= 0) return { match: false, basis: null };

  const aStart = parseUtcMs(a.startTime);
  const bStart = parseUtcMs(b.startTime);
  if (aStart != null && bStart != null) {
    const ratio = overlapRatio(aStart, a.durationMinutes, bStart, b.durationMinutes);
    if (ratio >= 0.4) {
      // Spanning-block guard: an auto-detect block can cover a whole gym visit
      // (a swim AND the strength work after it). That "overlaps" the swim
      // 100% but isn't a pure copy — deleting it would erase real data outside
      // the overlap. If the candidate extends well beyond the ground truth,
      // keep it rather than call it a duplicate.
      const aEnd = aStart + a.durationMinutes * 60000;
      const bEnd = bStart + b.durationMinutes * 60000;
      const extensionMs = Math.max(0, bStart - aStart) + Math.max(0, aEnd - bEnd);
      if (extensionMs > 20 * 60000) return { match: false, basis: null };
      return { match: true, basis: "overlap" };
    }
    return { match: false, basis: null }; // both windows known and don't overlap — definitively different
  }

  const longer = Math.max(a.durationMinutes, b.durationMinutes);
  if (Math.abs(a.durationMinutes - b.durationMinutes) > 0.15 * longer) return { match: false, basis: null };
  if (a.avgHeartRate == null || b.avgHeartRate == null) return { match: false, basis: null };
  if (Math.abs(a.avgHeartRate - b.avgHeartRate) > 8) return { match: false, basis: null };
  return { match: true, basis: "fingerprint" };
}

/**
 * Given a new session and the existing log, is it a duplicate of something
 * already there? Returns the existing session it matches, or null.
 */
export function findDuplicate(candidate: TrainingSession, existing: TrainingSession[]): TrainingSession | null {
  for (const other of existing) {
    if (other.id === candidate.id) continue;
    const result = isSameActivity(
      { date: candidate.date, startTime: candidate.startTime, durationMinutes: candidate.durationMinutes, avgHeartRate: candidate.avgHeartRate },
      { date: other.date, startTime: other.startTime, durationMinutes: other.durationMinutes, avgHeartRate: other.avgHeartRate },
    );
    if (result.match) return other;
  }
  return null;
}

/** External sport labels → the app's Sport union, name-first (device sport IDs are known to get renumbered/misrouted between API versions). */
export function mapExternalSportName(name: string | null | undefined): Sport {
  if (!name) return "other";
  const n = name.toLowerCase();
  if (/cycl|bik|spin/.test(n)) return "bike";
  if (/run|jog|track/.test(n)) return "run";
  if (/swim/.test(n)) return "swim";
  if (/triathlon|duathlon|brick/.test(n)) return "brick";
  if (/hyrox|compromised|simulation/.test(n)) return "race";
  if (/strength|weight|lift|gym|functional|hiit|crossfit|box|yoga|pilates|stretch|calisthen|muscle/.test(n)) return "strength";
  return "other";
}
