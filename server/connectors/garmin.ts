/**
 * Garmin has no public OAuth2 API for a hobbyist third-party app — both
 * sibling apps authenticate through the unofficial `garmin-connect` package
 * (email/password via Garmin's own SSO), and this does the same. The
 * session tokens it returns get cached so every sync doesn't re-login.
 */
import GarminModule from "garmin-connect";
// See sub5-dashboard's garminSync.ts for why this two-step import exists:
// garmin-connect is CJS re-exporting via a getter Node's ESM interop can't
// see statically, so `import { GarminConnect }` throws at runtime.
const GarminConnect = GarminModule.GarminConnect;
type GarminConnect = InstanceType<typeof GarminConnect>;

import { findDuplicate, mapExternalSportName } from "@shared/sessionDedupe";
import type { TrainingSession } from "@shared/session";
import { getGarminCredentials, saveGarminCredentials } from "./credentialsService";

const LOGIN_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 15_000;

/**
 * garmin-connect builds its axios instance with `axios.create()` and no
 * `timeout` option, and exposes no way to set one — a network hang (a
 * silently-dropped connection, an unreachable host) would otherwise leave
 * the calling request stuck forever. This doesn't cancel the underlying
 * axios call (it has no cancellation hook either), it just stops that from
 * being the caller's problem too.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

interface IActivity {
  activityId: number;
  activityName?: string;
  startTimeGMT?: string;
  duration?: number;
  distance?: number;
  averageHR?: number;
  maxHR?: number;
  activityType?: { typeKey?: string };
}

export async function connectGarmin(email: string, password: string): Promise<void> {
  const client = new GarminConnect({ username: email, password });
  try {
    await withTimeout(client.login(), LOGIN_TIMEOUT_MS, `Garmin login timed out after ${LOGIN_TIMEOUT_MS}ms`);
  } catch (err) {
    saveGarminCredentials({ authError: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  saveGarminCredentials({
    email,
    password,
    tokenJson: JSON.stringify(client.exportToken()),
    // garmin-connect doesn't surface a clean expiry; re-login proactively after a day.
    tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    authError: null,
  });
}

async function getClient(): Promise<GarminConnect | null> {
  const creds = getGarminCredentials();
  if (!creds?.email || !creds.password) return null;

  const client = new GarminConnect({ username: creds.email, password: creds.password });
  const tokenFresh = creds.tokenExpiresAt && Date.now() < Date.parse(creds.tokenExpiresAt);
  if (creds.tokenJson && tokenFresh) {
    try {
      const tokens = JSON.parse(creds.tokenJson);
      client.loadToken(tokens.oauth1, tokens.oauth2);
      return client;
    } catch {
      /* fall through to a fresh login */
    }
  }

  try {
    await withTimeout(client.login(), LOGIN_TIMEOUT_MS, `Garmin login timed out after ${LOGIN_TIMEOUT_MS}ms`);
    saveGarminCredentials({ tokenJson: JSON.stringify(client.exportToken()), tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), authError: null });
    return client;
  } catch (err) {
    saveGarminCredentials({ authError: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function garminActivityToSession(a: IActivity, id: string): TrainingSession {
  return {
    id,
    date: (a.startTimeGMT ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
    sport: mapExternalSportName(a.activityType?.typeKey),
    source: "garmin",
    // Naive UTC ("YYYY-MM-DD HH:MM:SS") — sessionDedupe.ts's parseUtcMs handles this shape directly.
    startTime: a.startTimeGMT ?? null,
    durationMinutes: Math.max(1, Math.round((a.duration ?? 60) / 60)),
    distanceKm: a.distance ? Math.round((a.distance / 1000) * 100) / 100 : null,
    avgHeartRate: a.averageHR ?? null,
    maxHeartRate: a.maxHR ?? null,
    avgPaceSecPerKm: null,
    avgPaceSecPer100m: null,
    avgPowerWatts: null,
    normalizedPower: null,
    tss: null,
    hrZonesJson: null,
    rpe: null,
    externalId: `garmin:${a.activityId}`,
  };
}

export interface GarminSyncResult {
  fetched: number;
  inserted: number;
  skippedDuplicates: number;
  error?: string;
}

export async function syncGarmin(existingSessions: TrainingSession[], insert: (s: TrainingSession) => void): Promise<GarminSyncResult> {
  const client = await getClient();
  if (!client) return { fetched: 0, inserted: 0, skippedDuplicates: 0, error: "Garmin not connected" };

  let activities: IActivity[];
  try {
    activities = await withTimeout(client.getActivities(0, 25), SYNC_TIMEOUT_MS, `Garmin activity fetch timed out after ${SYNC_TIMEOUT_MS}ms`);
  } catch (err) {
    return { fetched: 0, inserted: 0, skippedDuplicates: 0, error: err instanceof Error ? err.message : String(err) };
  }

  let inserted = 0;
  let skippedDuplicates = 0;
  const seenExternalIds = new Set(existingSessions.map((s) => s.externalId).filter(Boolean));

  for (const a of activities) {
    const externalId = `garmin:${a.activityId}`;
    if (seenExternalIds.has(externalId)) continue;
    const session = garminActivityToSession(a, `garmin-${a.activityId}`);
    if (findDuplicate(session, existingSessions)) {
      skippedDuplicates++;
      continue;
    }
    insert(session);
    existingSessions.push(session);
    inserted++;
  }

  return { fetched: activities.length, inserted, skippedDuplicates };
}
