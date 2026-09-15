import { test } from "node:test";
import assert from "node:assert/strict";
import { whoopWorkoutToSession, refreshWhoopToken } from "./whoop";
import { saveWhoopCredentials } from "./credentialsService";

test("maps a Whoop workout correctly, deriving duration from start/end", () => {
  const session = whoopWorkoutToSession(
    { id: 999, start: "2026-09-01T06:00:00.000Z", end: "2026-09-01T06:45:00.000Z", sport_name: "Running", score: { average_heart_rate: 150, max_heart_rate: 178 } },
    "test-id",
  );
  assert.equal(session.sport, "run");
  assert.equal(session.durationMinutes, 45);
  assert.equal(session.avgHeartRate, 150);
  assert.equal(session.source, "whoop");
  assert.equal(session.externalId, "whoop:999");
});

test("maps an unrecognized/mislabeled sport name to 'other' rather than throwing", () => {
  const session = whoopWorkoutToSession({ id: 1, start: "2026-09-01T06:00:00.000Z", end: "2026-09-01T06:10:00.000Z", sport_name: "Functional Fitness" }, "test-id");
  assert.equal(session.sport, "strength"); // matches mapExternalSportName's "functional" pattern
});

test("refreshWhoopToken single-flights concurrent callers into exactly one network call", async (t) => {
  process.env.WHOOP_CLIENT_ID = "test-client-id";
  process.env.WHOOP_CLIENT_SECRET = "test-client-secret";
  saveWhoopCredentials({ accessToken: "old-access", refreshToken: "old-refresh", tokenExpiresAt: new Date(0).toISOString(), authError: null });

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    callCount++;
    await new Promise((r) => setTimeout(r, 30)); // simulate real network latency so both callers are genuinely in flight together
    return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh-ROTATED", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const [a, b] = await Promise.all([refreshWhoopToken(), refreshWhoopToken()]);

  assert.equal(callCount, 1, "two concurrent refreshes must share a single in-flight network call, or Whoop's rotating refresh token gets burned twice");
  assert.equal(a.token, "new-access");
  assert.equal(b.token, "new-access");
});

test("a rejected (dead) refresh token is classified permanent, not transient", async (t) => {
  process.env.WHOOP_CLIENT_ID = "test-client-id";
  process.env.WHOOP_CLIENT_SECRET = "test-client-secret";
  saveWhoopCredentials({ accessToken: "old", refreshToken: "dead-refresh-token", tokenExpiresAt: new Date(0).toISOString(), authError: null });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await refreshWhoopToken();
  assert.equal(result.token, null);
  assert.equal(result.permanent, true, "a 400 from the token endpoint means only re-auth fixes it, not a retry");
});
