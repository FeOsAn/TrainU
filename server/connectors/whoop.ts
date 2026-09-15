/**
 * Whoop OAuth2 + sync. The one hardening lesson carried over verbatim from
 * sub5-dashboard's whoopSync.ts, which learned it from a real production
 * incident (2026-07-28: a day of data lost before anyone noticed): Whoop
 * ROTATES the refresh token on every use, and two independent callers
 * refreshing at once both read the same (about-to-be-invalidated) token —
 * whoever loses the race presents an already-rotated token, gets rejected,
 * and Whoop can revoke the whole token family. So refreshes are single-
 * flighted here, and the new token is persisted before anything else can
 * throw.
 *
 * What's NOT ported from that file: its rate-limit backoff tuning and
 * mirrored-edit reconciliation are real, valuable, but tuned against
 * production incidents specific to that deployment. Retry-on-429 with the
 * server's own Retry-After header (below) is the generic, defensible
 * version; revisit the rest once this app has its own operational history.
 */
import { findDuplicate } from "@shared/sessionDedupe";
import { mapExternalSportName } from "@shared/sessionDedupe";
import type { TrainingSession } from "@shared/session";
import { getWhoopCredentials, saveWhoopCredentials } from "./credentialsService";

const WHOOP_BASE = "https://api.prod.whoop.com/developer/v2";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const REQUEST_TIMEOUT_MS = 10_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function getWhoopAuthorizationUrl(state: string): string {
  const clientId = requireEnv("WHOOP_CLIENT_ID");
  const redirectUri = requireEnv("WHOOP_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read:profile read:workout read:cycles offline",
    state,
  });
  return `https://api.prod.whoop.com/oauth/oauth2/auth?${params}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  // No outbound call in this connector is allowed to hang the request that
  // triggered it indefinitely — the FIT-parser incident (Phase 2) is the
  // same lesson applied to a different kind of external call.
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function exchangeWhoopCode(code: string): Promise<void> {
  const clientId = requireEnv("WHOOP_CLIENT_ID");
  const clientSecret = requireEnv("WHOOP_CLIENT_SECRET");
  const redirectUri = requireEnv("WHOOP_REDIRECT_URI");

  const resp = await fetchWithTimeout(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!resp.ok) throw new Error(`Whoop token exchange failed: ${resp.status} ${await resp.text()}`);
  const token = (await resp.json()) as TokenResponse;
  saveWhoopCredentials({
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    authError: null,
  });
}

export interface WhoopRefreshResult {
  token: string | null;
  /** true when the refresh token itself is dead — only re-auth (exchangeWhoopCode) fixes it. */
  permanent: boolean;
  error?: string;
}

/** Single-flight gate — see the module comment for why this exists. */
let refreshInFlight: Promise<WhoopRefreshResult> | null = null;

export function refreshWhoopToken(): Promise<WhoopRefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<WhoopRefreshResult> {
  const creds = getWhoopCredentials();
  if (!creds?.refreshToken) return { token: null, permanent: true, error: "Whoop not connected" };

  const clientId = requireEnv("WHOOP_CLIENT_ID");
  const clientSecret = requireEnv("WHOOP_CLIENT_SECRET");

  try {
    const resp = await fetchWithTimeout(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (resp.status === 400 || resp.status === 401) {
      const error = `Whoop refresh rejected (${resp.status}) — reconnect required`;
      saveWhoopCredentials({ authError: error });
      return { token: null, permanent: true, error };
    }
    if (!resp.ok) {
      return { token: null, permanent: false, error: `Whoop refresh failed: ${resp.status}` };
    }
    const token = (await resp.json()) as TokenResponse;
    // Persist the rotated refresh token BEFORE returning — the old one is
    // already dead the moment Whoop issued this response.
    saveWhoopCredentials({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      authError: null,
    });
    return { token: token.access_token, permanent: false };
  } catch (err) {
    return { token: null, permanent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function getValidToken(): Promise<string | null> {
  const creds = getWhoopCredentials();
  if (!creds?.accessToken) return null;
  const expiresAt = creds.tokenExpiresAt ? Date.parse(creds.tokenExpiresAt) : 0;
  // Refresh with 5 minutes of headroom rather than waiting for the exact expiry.
  if (Date.now() < expiresAt - 5 * 60 * 1000) return creds.accessToken;
  const result = await refreshWhoopToken();
  return result.token;
}

interface WhoopWorkout {
  id: string | number;
  start: string;
  end: string;
  sport_name?: string;
  sport_id?: number;
  score?: { average_heart_rate?: number; max_heart_rate?: number };
}

export function whoopWorkoutToSession(w: WhoopWorkout, id: string): TrainingSession {
  const startMs = Date.parse(w.start);
  const endMs = Date.parse(w.end);
  return {
    id,
    date: new Date(startMs).toISOString().slice(0, 10),
    sport: mapExternalSportName(w.sport_name),
    source: "whoop",
    startTime: w.start,
    durationMinutes: Math.max(1, Math.round((endMs - startMs) / 60000)),
    distanceKm: null,
    avgHeartRate: w.score?.average_heart_rate ?? null,
    maxHeartRate: w.score?.max_heart_rate ?? null,
    avgPaceSecPerKm: null,
    avgPaceSecPer100m: null,
    avgPowerWatts: null,
    normalizedPower: null,
    tss: null,
    hrZonesJson: null,
    rpe: null,
    externalId: `whoop:${w.id}`,
  };
}

export interface WhoopSyncResult {
  fetched: number;
  inserted: number;
  skippedDuplicates: number;
  error?: string;
}

export async function syncWhoop(existingSessions: TrainingSession[], insert: (s: TrainingSession) => void): Promise<WhoopSyncResult> {
  const token = await getValidToken();
  if (!token) return { fetched: 0, inserted: 0, skippedDuplicates: 0, error: "Whoop not connected" };

  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const resp = await fetchWithTimeout(`${WHOOP_BASE}/activity/workout?${new URLSearchParams({ limit: "25", start: since })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return { fetched: 0, inserted: 0, skippedDuplicates: 0, error: `Whoop fetch failed: ${resp.status}` };

  const body = (await resp.json()) as { records?: WhoopWorkout[] };
  const workouts = body.records ?? [];

  let inserted = 0;
  let skippedDuplicates = 0;
  const seenExternalIds = new Set(existingSessions.map((s) => s.externalId).filter(Boolean));

  for (const w of workouts) {
    const externalId = `whoop:${w.id}`;
    if (seenExternalIds.has(externalId)) continue; // already synced this exact workout
    const session = whoopWorkoutToSession(w, `whoop-${w.id}`);
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
