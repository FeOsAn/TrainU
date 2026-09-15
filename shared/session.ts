/**
 * One physical activity, one session — sport-agnostic so training-load,
 * dedupe, and every predictor read the same shape regardless of which goal
 * type or which sibling app's sport vocabulary it came from.
 */

export type Sport = "run" | "bike" | "swim" | "brick" | "strength" | "hybrid" | "race" | "station" | "other";

export type SessionSource = "manual" | "garmin" | "whoop" | "apple_health" | "fit_upload";

export interface TrainingSession {
  id: string;
  /** YYYY-MM-DD, athlete-local. */
  date: string;
  sport: Sport;
  source: SessionSource;
  /** ISO UTC, or a naive local "YYYY-MM-DD HH:MM:SS" — see sessionDedupe.ts for how each is interpreted. */
  startTime?: string | null;
  durationMinutes: number;
  distanceKm?: number | null;
  avgHeartRate?: number | null;
  maxHeartRate?: number | null;
  avgPaceSecPerKm?: number | null;
  avgPaceSecPer100m?: number | null;
  avgPowerWatts?: number | null;
  normalizedPower?: number | null;
  tss?: number | null;
  /** Garmin/Whoop-style time-in-zone breakdown: [{zone:"Z2", secs_in_zone: 4643}, ...] */
  hrZonesJson?: string | null;
  rpe?: number | string | null;
  /** Idempotency/dedupe key from the source (a Garmin activity ID, a Whoop cycle ID). */
  externalId?: string | null;
}
