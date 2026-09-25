/**
 * Route-level regressions.
 *
 * Every assertion here is about WIRING — which date a handler validates
 * against, which list it filters, which grid it steps on. None of it can be
 * pinned by calling the service underneath, because in each case the service
 * was already correct and the route was passing it the wrong argument. So
 * these boot the real Express app the same way `server/index.ts` does (minus
 * auth, which `index.ts` mounts around this) and go over HTTP.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "./db";
import { conditions, goals, outcomeLog, physiqueEntries, preferences, sessionCompletions, trainingSessions } from "@shared/schema";
import { addDays, startOfWeek, todayISO, weekdayOf } from "@shared/dates";
import { registerRoutes } from "./routes";
import { plannableConditions } from "./athleteStateService";

for (const table of [goals, conditions, physiqueEntries, sessionCompletions, trainingSessions, preferences]) {
  db.delete(table).run();
}

const app = express();
app.use(express.json());
// `registerRoutes` never touches the http server it is handed; index.ts passes
// one only so a connector could upgrade a socket later.
await registerRoutes(null as unknown as Server, app);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
after(() => server.close());

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * The athlete's own calendar day, one ahead of the server's.
 *
 * This is not a contrivance: UTC+13 is a real timezone and its athletes spend
 * every morning from midnight to 1pm on tomorrow's UTC date.
 */
const UTC_TODAY = todayISO();
const THEIR_TODAY = addDays(UTC_TODAY, 1);

test("DEFECT: the four other date-taking endpoints validate against the athlete's day, not the server's", async () => {
  // Every one of these was reachable only between 1pm and midnight for an
  // athlete in Auckland, and told them they were dating it in the future
  // while they looked at today's date on their own phone.
  const opened = await call("POST", `/api/conditions?today=${THEIR_TODAY}`, {
    kind: "injury",
    label: "Right hamstring",
    bodyPart: "hamstring",
    severity: 2,
    openedAt: THEIR_TODAY,
  });
  assert.equal(opened.status, 201, `reporting an injury: ${JSON.stringify(opened.body)}`);

  const patched = await call("PATCH", `/api/conditions/${opened.body.id}?today=${THEIR_TODAY}`, { severity: 3 });
  assert.equal(patched.status, 200, `editing it: ${JSON.stringify(patched.body)}`);

  const closed = await call("POST", `/api/conditions/${opened.body.id}/close?today=${THEIR_TODAY}`, { closedAt: THEIR_TODAY });
  assert.equal(closed.status, 200, `marking it healed: ${JSON.stringify(closed.body)}`);

  const weighIn = await call("POST", `/api/physique?today=${THEIR_TODAY}`, { date: THEIR_TODAY, weightKg: 72 });
  assert.equal(weighIn.status, 201, `logging a weigh-in: ${JSON.stringify(weighIn.body)}`);

  const station = await call("PATCH", `/api/athlete/benchmarks?today=${THEIR_TODAY}`, {
    sled_push: { seconds: 200, date: THEIR_TODAY },
  });
  assert.equal(station.status, 200, `recording a station time: ${JSON.stringify(station.body)}`);

  // The other side of the clamp, which is what makes believing the client
  // safe: two days out is not a timezone, it is a broken clock.
  const tooFar = addDays(UTC_TODAY, 2);
  const timeTravel = await call("POST", `/api/conditions?today=${tooFar}`, {
    kind: "injury",
    label: "Left knee",
    bodyPart: "knee",
    severity: 1,
    openedAt: tooFar,
  });
  assert.equal(timeTravel.status, 400, "a date no timezone can justify is still refused");

  db.delete(conditions).run();
  db.delete(physiqueEntries).run();
});

test("DEFECT: the athlete's injury history is not truncated by the engine's 60-day window", async () => {
  const openedAt = addDays(UTC_TODAY, -400);
  const closedAt = addDays(UTC_TODAY, -200);
  const created = await call("POST", "/api/conditions", {
    kind: "injury",
    label: "Old hamstring strain",
    bodyPart: "hamstring",
    severity: 2,
    openedAt,
  });
  assert.equal(created.status, 201);
  assert.equal((await call("POST", `/api/conditions/${created.body.id}/close`, { closedAt })).status, 200);

  const listed = await call("GET", "/api/conditions");
  assert.equal(listed.status, 200);
  assert.ok(
    listed.body.some((c: { id: string }) => c.id === created.body.id),
    "the Athlete page's history panel is this endpoint; a strain that healed last year happened",
  );

  // …and the engine's window is unchanged, which is the half that keeps the
  // two from being re-merged: nothing healed that long ago can still steer a
  // plan.
  assert.ok(
    !plannableConditions(UTC_TODAY).some((c) => c.id === created.body.id),
    "a record the athlete can read is not a condition the plan may act on",
  );

  db.delete(conditions).run();
});

test("DEFECT: arbitration weeks are Monday-anchored, like every other week in the app", async () => {
  const created = await call("POST", "/api/goals", {
    type: "endurance_race",
    discipline: "run",
    label: "Autumn half",
    targetDate: addDays(UTC_TODAY, 120),
    priority: 1,
    successCriteria: "Finish under 1:35",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const plan = await call("GET", "/api/plan/arbitrate");
  assert.equal(plan.status, 200);
  assert.equal(plan.body.fromDate, startOfWeek(UTC_TODAY), "the default grid is the week route's grid");
  assert.equal(weekdayOf(plan.body.weeks[0].date), 0, "every week starts on a Monday");

  // An explicit `from` is normalised too — otherwise the caller decides the
  // grid and a conflict card can still be dated Thursday-to-Thursday.
  const thursday = addDays(startOfWeek(UTC_TODAY), 3);
  const fromThursday = await call("GET", `/api/plan/arbitrate?from=${thursday}`);
  assert.equal(fromThursday.body.fromDate, startOfWeek(UTC_TODAY));
  assert.equal(weekdayOf(fromThursday.body.weeks[0].date), 0);

  // Validation still happens BEFORE normalisation, so garbage never reaches
  // the date arithmetic.
  assert.equal((await call("GET", "/api/plan/arbitrate?from=not-a-date")).status, 400);
});

test("DEFECT: a race that has already been run is not a race to pace", async () => {
  const past = await call("POST", "/api/goals", {
    type: "endurance_race",
    discipline: "run",
    label: "Spring marathon",
    targetDate: addDays(UTC_TODAY, -120),
    priority: 1,
    successCriteria: "Finish under 3:30",
  });
  assert.equal(past.status, 201, JSON.stringify(past.body));

  const plans = await call("GET", "/api/pacing");
  assert.equal(plans.status, 200);
  assert.ok(
    !plans.body.some((p: { goalId: string }) => p.goalId === past.body.id),
    "nothing can set a goal inactive, so a finished race would otherwise be paced forever",
  );

  // The boundary that matters in the other direction: race day itself is the
  // single day the plan is most needed, so the rule is `>= today`, not `>`.
  const raceDay = await call("POST", "/api/goals", {
    type: "endurance_race",
    discipline: "run",
    label: "Race day today",
    targetDate: UTC_TODAY,
    priority: 1,
    successCriteria: "Finish under 3:30",
  });
  assert.equal(raceDay.status, 201, JSON.stringify(raceDay.body));
  const onTheDay = await call("GET", "/api/pacing");
  assert.ok(
    onTheDay.body.some((p: { goalId: string }) => p.goalId === raceDay.body.id),
    "blanking the pacing plan on the morning of the race would be a worse bug than the one being fixed",
  );

  db.delete(goals).run();
});

test("DEFECT: the Athlete page's weight field gets the same typo confirmation the Physique panel does", async () => {
  assert.equal((await call("POST", "/api/physique", { date: addDays(UTC_TODAY, -7), weightKg: 72 })).status, 201);

  const fatFingered = await call("PATCH", "/api/athlete", { weightKg: 82 });
  assert.equal(fatFingered.status, 200);
  assert.ok(
    typeof fatFingered.body.warning === "string" && fatFingered.body.warning.includes("72"),
    "10 kg overnight moves every day's target by ~300 kcal and resizes a cut; it should cost one tap to confirm",
  );

  // A real weigh-in, of the size a week of training produces, says nothing —
  // a confirmation that fires on every save is one nobody reads. (The
  // comparison is against the previous DAY's entry, so this is 72 → 72.4.)
  const ordinary = await call("PATCH", "/api/athlete", { weightKg: 72.4 });
  assert.equal(ordinary.body.warning, undefined);

  db.delete(physiqueEntries).run();
});

test("DEFECT: a goal can be removed — there was no way to, short of SQL on the volume", async () => {
  const created = await call("POST", "/api/goals", { type: "strength", label: "Duplicate", targetDate: addDays(UTC_TODAY, 60), successCriteria: "x" });
  assert.equal(created.status, 201);
  assert.equal((await call("DELETE", `/api/goals/${created.body.id}`)).status, 204);
  const after = await call("GET", "/api/goals");
  assert.ok(!after.body.some((g: { id: string }) => g.id === created.body.id));
  assert.equal((await call("DELETE", `/api/goals/${created.body.id}`)).status, 404, "deleting it twice is a 404, not a 500");
});

test("DEFECT: opening the Plan page does not write to outcome_log", async () => {
  // It used to log the whole multi-week plan (~35 KB) on every load, as a
  // row nothing could ever resolve.
  await call("POST", "/api/goals", { type: "endurance_race", label: "Plan-log probe", targetDate: addDays(UTC_TODAY, 120), successCriteria: "x" });
  const before = db.select().from(outcomeLog).all().length;
  for (let i = 0; i < 3; i++) assert.equal((await call("GET", "/api/plan/arbitrate")).status, 200);
  assert.equal(db.select().from(outcomeLog).all().length, before);
});
