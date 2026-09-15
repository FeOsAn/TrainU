import { test } from "node:test";
import assert from "node:assert/strict";
import { garminActivityToSession, withTimeout } from "./garmin";

test("maps a running activity correctly, including naive-UTC startTimeGMT passthrough", () => {
  const session = garminActivityToSession(
    {
      activityId: 12345,
      activityName: "Morning Run",
      startTimeGMT: "2026-09-01 06:15:00",
      duration: 1800,
      distance: 5000,
      averageHR: 145,
      maxHR: 172,
      activityType: { typeKey: "running" },
    },
    "test-id",
  );
  assert.equal(session.sport, "run");
  assert.equal(session.date, "2026-09-01");
  assert.equal(session.startTime, "2026-09-01 06:15:00");
  assert.equal(session.durationMinutes, 30);
  assert.equal(session.distanceKm, 5);
  assert.equal(session.avgHeartRate, 145);
  assert.equal(session.source, "garmin");
  assert.equal(session.externalId, "garmin:12345");
});

test("maps an unrecognized activity type to 'other' rather than throwing", () => {
  const session = garminActivityToSession(
    { activityId: 1, startTimeGMT: "2026-09-01 06:15:00", duration: 600, activityType: { typeKey: "stand_up_paddleboarding" } },
    "test-id",
  );
  assert.equal(session.sport, "other");
});

test("handles a missing distance/heart-rate gracefully", () => {
  const session = garminActivityToSession({ activityId: 2, startTimeGMT: "2026-09-01 06:15:00", duration: 600, activityType: { typeKey: "strength_training" } }, "test-id");
  assert.equal(session.distanceKm, null);
  assert.equal(session.avgHeartRate, null);
  assert.equal(session.sport, "strength");
});

test("withTimeout resolves normally when the promise finishes first", async () => {
  const result = await withTimeout(Promise.resolve("done"), 1000, "should not fire");
  assert.equal(result, "done");
});

test("withTimeout rejects with its own message when the promise never settles — the fix for garmin-connect's timeout-less axios client", async () => {
  const neverResolves = new Promise(() => {}); // simulates a hung/dropped network call
  await assert.rejects(() => withTimeout(neverResolves, 30, "Garmin login timed out after 30ms"), /timed out after 30ms/);
});
