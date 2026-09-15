/**
 * Apple Health has no server-side sync API at all — the only way to get
 * data out is the "Export Health Data" flow in the Health app, which
 * produces an `export.xml` the athlete uploads by hand. This parses that.
 *
 * Deliberately a regex attribute-extractor over `<Workout .../>` elements
 * rather than a full XML parser: every field this reads (activity type
 * enum, ISO-ish dates, numbers) is a plain attribute value with no nested
 * markup or escaping to worry about, and a full DOM parse of a
 * years-long export (routinely hundreds of MB) is real memory pressure for
 * no benefit here. Revisit as a streaming parser if the size limit below
 * becomes a real complaint, not before.
 */
import { findDuplicate, mapExternalSportName } from "@shared/sessionDedupe";
import type { TrainingSession } from "@shared/session";

export interface AppleWorkout {
  activityType: string;
  startDate: string;
  endDate: string;
  durationMinutes: number;
  distanceKm?: number;
}

/** "2026-09-01 07:00:00 -0700" → epoch ms. Apple's own format, not ISO — must be converted, never passed straight to Date.parse. */
function parseAppleDate(s: string): number | null {
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isNaN(t) ? null : t;
}

const WORKOUT_TAG_RE = /<Workout\b([^>]*?)\/?>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag))) out[m[1]] = m[2];
  return out;
}

export function parseAppleHealthExport(xml: string): AppleWorkout[] {
  const workouts: AppleWorkout[] = [];
  let match: RegExpExecArray | null;
  WORKOUT_TAG_RE.lastIndex = 0;
  while ((match = WORKOUT_TAG_RE.exec(xml))) {
    const attrs = parseAttributes(match[1]!);
    if (!attrs.workoutActivityType || !attrs.startDate || !attrs.endDate) continue;
    const startMs = parseAppleDate(attrs.startDate);
    const endMs = parseAppleDate(attrs.endDate);
    if (startMs == null || endMs == null) continue;

    const durationMinutes = attrs.duration ? parseFloat(attrs.duration) : (endMs - startMs) / 60000;
    let distanceKm: number | undefined;
    if (attrs.totalDistance) {
      const val = parseFloat(attrs.totalDistance);
      if (Number.isFinite(val)) distanceKm = attrs.totalDistanceUnit === "mi" ? Math.round(val * 1.60934 * 100) / 100 : val;
    }

    workouts.push({
      activityType: attrs.workoutActivityType,
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
      durationMinutes: Math.max(1, Math.round(durationMinutes)),
      distanceKm,
    });
  }
  return workouts;
}

export function appleWorkoutToSession(w: AppleWorkout, id: string): TrainingSession {
  return {
    id,
    date: w.startDate.slice(0, 10),
    sport: mapExternalSportName(w.activityType.replace(/^HKWorkoutActivityType/, "")),
    source: "apple_health",
    startTime: w.startDate,
    durationMinutes: w.durationMinutes,
    distanceKm: w.distanceKm ?? null,
    avgHeartRate: null,
    maxHeartRate: null,
    avgPaceSecPerKm: null,
    avgPaceSecPer100m: null,
    avgPowerWatts: null,
    normalizedPower: null,
    tss: null,
    hrZonesJson: null,
    rpe: null,
    externalId: `apple:${w.startDate}:${w.endDate}`,
  };
}

export interface AppleHealthImportResult {
  fetched: number;
  inserted: number;
  skippedDuplicates: number;
}

export function importAppleHealthExport(xml: string, existingSessions: TrainingSession[], insert: (s: TrainingSession) => void): AppleHealthImportResult {
  const workouts = parseAppleHealthExport(xml);
  let inserted = 0;
  let skippedDuplicates = 0;
  const seenExternalIds = new Set(existingSessions.map((s) => s.externalId).filter(Boolean));

  for (const w of workouts) {
    const session = appleWorkoutToSession(w, `apple-${w.startDate}`);
    if (seenExternalIds.has(session.externalId)) continue;
    if (findDuplicate(session, existingSessions)) {
      skippedDuplicates++;
      continue;
    }
    insert(session);
    existingSessions.push(session);
    inserted++;
  }

  return { fetched: workouts.length, inserted, skippedDuplicates };
}
