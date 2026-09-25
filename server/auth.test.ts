/**
 * The access gate, tested on the app as it is actually composed.
 *
 * Phase 9 shipped the gate verified by hand and by nothing else, and it had a
 * hole the width of a shift key: `requireAuth` decided what counted as the
 * API with `req.path.startsWith("/api")`, while Express routes
 * CASE-INSENSITIVELY. So `/API/goals` skipped the gate and then matched the
 * `/api/goals` handler — every read and every write in the app, including a
 * Garmin sync on the athlete's stored credentials, open to anyone who typed
 * the path in capitals. Two definitions of "is this the API" disagreeing is
 * the whole bug; the fix mounts the gate with `app.use("/api", …)` so the
 * gate and the routes are matched by the same router.
 *
 * These boot `createApp()` — the same function both entry points use — and go
 * over HTTP, because the defect lived in how the pieces were composed, not in
 * any one of them.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

const PASSWORD = "correct horse battery staple";
process.env.APP_PASSWORD = PASSWORD;

const { createApp } = await import("./app");
const { db } = await import("./db");
const { goals } = await import("@shared/schema");

const { app, httpServer } = await createApp();
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
after(() => httpServer.close());

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: "manual" });
  return { status: res.status, setCookie: res.headers.get("set-cookie") ?? "", text: await res.text() };
}

/** Every spelling of the API prefix Express will route to the same handlers. */
const PREFIXES = ["/api", "/API", "/Api", "/aPi", "/apI"];

test("DEFECT: no casing of /api reaches a handler without the password", async () => {
  for (const prefix of PREFIXES) {
    const res = await call("GET", `${prefix}/goals`);
    assert.equal(res.status, 401, `GET ${prefix}/goals answered ${res.status} with no cookie: ${res.text.slice(0, 80)}`);
  }
});

test("DEFECT: an uppercase write is refused, and writes nothing", async () => {
  const before = db.select().from(goals).all().length;
  const res = await call("POST", "/API/goals", {
    body: { type: "strength", label: "planted by a stranger", targetDate: "2027-01-01", successCriteria: "x" },
  });
  assert.equal(res.status, 401);
  assert.equal(db.select().from(goals).all().length, before, "the goal was written despite the 401");
});

test("every registered API route, in any casing, is gated", async () => {
  // Read the routes off the app itself rather than listing them here, so a
  // route added next month is covered without anyone remembering this file.
  const stack = (app as any).router?.stack ?? [];
  const routes: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route || typeof route.path !== "string" || !route.path.toLowerCase().startsWith("/api")) continue;
    for (const method of Object.keys(route.methods)) {
      routes.push({ method: method.toUpperCase(), path: route.path.replace(/:[A-Za-z]+/g, "x") });
    }
  }
  assert.ok(routes.length > 40, `expected the full route table, found ${routes.length} — has the router's shape changed?`);

  const PUBLIC = new Set(["/api/auth/login", "/api/auth/status", "/api/auth/logout", "/api/health"]);
  const leaks: string[] = [];
  for (const { method, path } of routes) {
    if (PUBLIC.has(path)) continue;
    for (const variant of [path, "/API" + path.slice(4), "/Api" + path.slice(4)]) {
      const res = await call(method, variant, method === "GET" ? {} : { body: {} });
      if (res.status !== 401) leaks.push(`${method} ${variant} → ${res.status}`);
    }
  }
  assert.deepEqual(leaks, [], `reachable without the password:\n${leaks.join("\n")}`);
});

test("the right password opens every casing; a wrong one opens none", async () => {
  assert.equal((await call("POST", "/api/auth/login", { body: { password: "wrong" } })).status, 401);
  const login = await call("POST", "/api/auth/login", { body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  const cookie = login.setCookie.split(";")[0];
  assert.match(cookie, /^trainu_session=/);
  for (const prefix of PREFIXES) {
    assert.equal((await call("GET", `${prefix}/goals`, { cookie })).status, 200, `${prefix}/goals with a valid cookie`);
  }
  assert.equal((await call("GET", "/api/goals", { cookie: "trainu_session=forged" })).status, 401);
});

test("the login endpoints and the healthcheck answer without a cookie", async () => {
  assert.equal((await call("GET", "/api/auth/status")).status, 200);
  assert.equal((await call("GET", "/API/auth/status")).status, 200);
  const health = await call("GET", "/api/health");
  assert.equal(health.status, 200, `Railway's healthcheck has no cookie; /api/health answered ${health.status}`);
});
