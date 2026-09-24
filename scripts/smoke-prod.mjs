#!/usr/bin/env node
/**
 * Boot the real production artifact the way Railway will, and prove it serves.
 *
 *   npm run smoke            # the files git would ship (tracked + untracked, minus ignored)
 *   npm run smoke -- --ref HEAD   # exactly one commit, via git archive
 *   npm run smoke -- --keep       # leave the scratch directory for inspection
 *
 * Every deploy failure so far was invisible to `npm test`, because the tests
 * run TypeScript source under tsx with every devDependency installed — the
 * one configuration production never is. This runs the other one:
 *
 *   1. a clean copy of the repo — nothing that isn't committed or committable
 *   2. `npm ci` + `npm run build`, as the builder does
 *   3. `npm prune --omit=dev` — the strictest production install, so a
 *      runtime import of a devDependency fails HERE rather than on Railway
 *   4. railway.json's own startCommand, against an EMPTY volume, with
 *      NODE_ENV deliberately unset, on a free port
 *   5. railway.json's healthcheckPath must answer 200 without a cookie
 *   6. the client and its assets, a deep link, the auth gate, login, a real
 *      write, every parameterless GET route in server/routes.ts (none may
 *      5xx), and the FIT worker actually spawning from dist/
 *   7. SIGTERM must exit 0 promptly; a second boot on the same volume must
 *      find the data the first one wrote
 *   8. with no APP_PASSWORD the deployment must fail closed AND fail its
 *      healthcheck, so it never replaces a working one
 *
 * Any 5xx, any "[UnhandledRejection]" or "Internal Server Error" in the
 * server's own log, fails the run.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const refIdx = args.indexOf("--ref");
const ref = refIdx >= 0 ? args[refIdx + 1] : undefined;

const PASSWORD = "smoke-test-password";
const CREDENTIAL_KEY = "a".repeat(64);
let failures = 0;
const servers = new Set();

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function bad(msg) {
  failures++;
  console.log(`  ✗ ${msg}`);
}
function check(cond, msg, detail = "") {
  if (cond) ok(msg);
  else bad(detail ? `${msg}\n      ${detail}` : msg);
  return cond;
}
function step(title) {
  console.log(`\n▸ ${title}`);
}
function sh(cmd, argv, cwd, extraEnv = {}) {
  execFileSync(cmd, argv, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

// ─── 1. A clean copy ────────────────────────────────────────────────────────

const work = mkdtempSync(path.join(os.tmpdir(), "trainu-smoke-"));
const app = path.join(work, "app");
const volume = path.join(work, "volume");
mkdirSync(app);
mkdirSync(volume);

process.on("exit", () => {
  for (const s of servers) s.kill("SIGKILL");
  if (!keep) rmSync(work, { recursive: true, force: true });
  else console.log(`\n(kept ${work})`);
});

step(`export ${ref ? `git ref ${ref}` : "the files git would ship"} to ${app}`);
if (ref) {
  execFileSync("sh", ["-c", `git -C "${repo}" archive "${ref}" | tar -x -C "${app}"`], { stdio: "inherit" });
} else {
  const files = execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((f) => existsSync(path.join(repo, f)));
  const untracked = execFileSync("git", ["-C", repo, "ls-files", "-o", "--exclude-standard"], { encoding: "utf8" }).trim();
  if (untracked) {
    console.log(`  ! these files are NOT committed — Railway will not have them until they are:\n    ${untracked.split("\n").join("\n    ")}`);
  }
  for (const f of files) {
    mkdirSync(path.dirname(path.join(app, f)), { recursive: true });
    copyFileSync(path.join(repo, f), path.join(app, f));
  }
}
const railway = JSON.parse(readFileSync(path.join(app, "railway.json"), "utf8"));
const startCommand = railway.deploy?.startCommand;
const healthPath = railway.deploy?.healthcheckPath;
check(Boolean(startCommand), `railway.json has a startCommand (${startCommand})`);
check(
  Boolean(healthPath),
  `railway.json has a healthcheckPath (${healthPath})`,
  "without one Railway routes traffic to a deployment that never proved it can serve",
);

// ─── 2–3. Install, build, prune ─────────────────────────────────────────────

step("npm ci && npm run build (as the builder does)");
sh("npm", ["ci", "--no-audit", "--no-fund"], app);
sh("npm", ["run", "build"], app);

step("npm prune --omit=dev (the strictest production install)");
sh("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], app);
check(!existsSync(path.join(app, "node_modules", "vite")), "devDependencies are gone (vite is not installed)");

// ─── 4. Boot ────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function boot(env) {
  const port = await freePort();
  const childEnv = { ...process.env, PORT: String(port), DB_PATH: path.join(volume, "trainu.db"), ...env };
  // NODE_ENV is deliberately NOT set: the artifact has to be production by
  // construction, not because a wrapper script remembered to say so.
  delete childEnv.NODE_ENV;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  // `exec` so the signal reaches the server itself, as it does when the
  // platform runs the start command as the container's main process.
  const child = spawn("sh", ["-c", `exec ${startCommand}`], { cwd: app, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  servers.add(child);
  const server = { child, port, log: "", exited: null, base: `http://127.0.0.1:${port}` };
  child.stdout.on("data", (d) => (server.log += d));
  child.stderr.on("data", (d) => (server.log += d));
  server.done = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      servers.delete(child);
      server.exited = { code, signal };
      resolve(server.exited);
    }),
  );
  return server;
}

async function waitForHealth(server, expectStatus, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exited) return { status: -1, body: `process exited ${JSON.stringify(server.exited)}` };
    try {
      const res = await fetch(server.base + healthPath);
      if (res.status === expectStatus) return { status: res.status, body: await res.text() };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const res = await fetch(server.base + healthPath).catch(() => null);
  return { status: res?.status ?? -1, body: res ? await res.text() : "never listened" };
}

function dumpLog(server) {
  console.log(`\n----- server log -----\n${server.log.trim()}\n----------------------`);
}

async function request(server, method, url, { cookie, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (cookie) init.headers.cookie = cookie;
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(server.base + url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function stop(server, label) {
  const t0 = Date.now();
  server.child.kill("SIGTERM");
  const timeout = new Promise((r) => setTimeout(() => r("timeout"), 15_000));
  const result = await Promise.race([server.done, timeout]);
  if (result === "timeout") {
    bad(`${label}: SIGTERM did not stop the server within 15s`);
    server.child.kill("SIGKILL");
    await server.done;
    return;
  }
  check(
    result.code === 0,
    `${label}: SIGTERM exits cleanly (code ${result.code}${result.signal ? `, signal ${result.signal}` : ""}, ${Date.now() - t0}ms)`,
  );
}

function logIsClean(server, label) {
  const bad5xx = server.log.match(/ 5(?!03)\d\d in \d+ms/g) ?? [];
  const markers = ["[UnhandledRejection]", "Internal Server Error", "[boot] failed"].filter((m) => server.log.includes(m));
  check(
    bad5xx.length === 0 && markers.length === 0,
    `${label}: server log has no 5xx, unhandled rejection or boot failure`,
    [...bad5xx, ...markers].join(", "),
  );
}

/** A 12-byte FIT header with a body the parser cannot make sense of. */
function brokenFit() {
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt16LE(2132, 2);
  header.writeUInt32LE(200, 4);
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, Buffer.alloc(202, 0xff)]);
}

// ─── 5–6. First boot: empty volume ──────────────────────────────────────────

step(`boot #1 — empty volume, \`${startCommand}\`, NODE_ENV unset`);
// Railway's own variables, with the volume attached where DB_PATH points.
const RAILWAY_ENV = { RAILWAY_ENVIRONMENT_NAME: "smoke", RAILWAY_PROJECT_ID: "smoke", RAILWAY_VOLUME_MOUNT_PATH: volume };
const s1 = await boot({ APP_PASSWORD: PASSWORD, CREDENTIAL_KEY, ...RAILWAY_ENV });
const h1 = await waitForHealth(s1, 200);
if (!check(h1.status === 200, `${healthPath} answers 200 without a cookie`, `got ${h1.status}: ${h1.body}`)) {
  dumpLog(s1);
  process.exit(1);
}

const index = await request(s1, "GET", "/");
check(index.status === 200 && /<div id="root">/.test(index.text), "GET / serves the client");
const assets = [...index.text.matchAll(/(?:src|href)="(\.?\/assets\/[^"]+)"/g)].map((m) => m[1].replace(/^\./, ""));
check(assets.length > 0, `index.html references its assets (${assets.length})`);
for (const asset of assets) {
  const res = await request(s1, "GET", asset);
  const type = res.headers.get("content-type") ?? "";
  check(res.status === 200 && !type.includes("text/html"), `asset ${asset} → ${res.status} ${type}`);
}
for (const link of ["/athlete", "/goals/123", "/athlete/"]) {
  const deep = await request(s1, "GET", link);
  const deepAssets = [...deep.text.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((m) => new URL(m[1], s1.base + link).pathname);
  const resolved = await Promise.all(deepAssets.map((a) => request(s1, "GET", a).then((r) => r.status)));
  check(
    deep.status === 200 && /<div id="root">/.test(deep.text) && deepAssets.length > 0 && resolved.every((st) => st === 200),
    `a deep link (${link}) serves the client and its assets resolve from there`,
    `page ${deep.status}; assets ${deepAssets.map((a, i) => `${a} → ${resolved[i]}`).join(", ")}`,
  );
}
const missingAsset = await request(s1, "GET", "/assets/does-not-exist.js");
check(missingAsset.status === 404, `a missing asset is a 404, not index.html (got ${missingAsset.status})`);

check((await request(s1, "GET", "/api/goals")).status === 401, "the API is gated: /api/goals without a cookie → 401");
check((await request(s1, "GET", "/API/goals")).status !== 200, "the gate is not case-sensitive: /API/goals without a cookie is refused");
check((await request(s1, "POST", "/api/auth/login", { body: { password: "wrong" } })).status === 401, "a wrong password → 401");
const login = await request(s1, "POST", "/api/auth/login", { body: { password: PASSWORD } });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
check(login.status === 200 && cookie.startsWith("trainu_session="), "the right password → 200 and a session cookie");

const goal = await request(s1, "POST", "/api/goals", {
  cookie,
  body: { type: "endurance_race", discipline: "run", label: "Smoke marathon", targetDate: "2027-04-18", successCriteria: "Finish" },
});
check(goal.status === 201 && goal.json?.id, `a real write: POST /api/goals → ${goal.status}`, goal.text.slice(0, 200));
const week = await request(s1, "GET", "/api/plan/week", { cookie });
check(week.status === 200, `the plan builds on a fresh volume: GET /api/plan/week → ${week.status}`, week.text.slice(0, 200));

// Every parameterless GET route, read from the routes file itself so a new
// route is smoke-tested the day it is added.
const routesSrc = readFileSync(path.join(app, "server", "routes.ts"), "utf8");
const getRoutes = [...new Set([...routesSrc.matchAll(/app\.get\(\s*"(\/api\/[^"]+)"/g)].map((m) => m[1]))].filter((r) => !r.includes(":"));
const serverErrors = [];
for (const route of getRoutes) {
  const res = await request(s1, "GET", route, { cookie });
  // 503 is this app's deliberate "not configured here" (Whoop without its
  // env vars, the gate without APP_PASSWORD); anything else 5xx is a fault.
  if (res.status >= 500 && res.status !== 503) serverErrors.push(`${route} → ${res.status} ${res.text.slice(0, 120)}`);
}
check(serverErrors.length === 0, `all ${getRoutes.length} parameterless GET routes answer without a fault (5xx other than a deliberate 503)`, serverErrors.join("\n      "));

const form = new FormData();
form.append("file", new Blob([brokenFit()]), "broken.fit");
const fit = await request(s1, "POST", "/api/sessions/fit-upload", { cookie, body: form });
check(
  fit.status === 400 && !/No FIT parse worker|ENOENT|Cannot find|ERR_MODULE_NOT_FOUND/.test(fit.text),
  `the FIT worker spawns from dist/ and rejects a corrupt file cleanly (${fit.status})`,
  fit.text.slice(0, 300),
);

logIsClean(s1, "boot #1");
await stop(s1, "boot #1");

// ─── 7. Second boot: same volume, as after a redeploy ───────────────────────

step("boot #2 — same volume, as after a redeploy");
const s2 = await boot({ APP_PASSWORD: PASSWORD, CREDENTIAL_KEY, ...RAILWAY_ENV });
const h2 = await waitForHealth(s2, 200);
if (check(h2.status === 200, `boots again on an existing volume (${h2.status})`, h2.body)) {
  const again = await request(s2, "POST", "/api/auth/login", { body: { password: PASSWORD } });
  const cookie2 = (again.headers.get("set-cookie") ?? "").split(";")[0];
  const goals = await request(s2, "GET", "/api/goals", { cookie: cookie2 });
  check(
    Array.isArray(goals.json) && goals.json.some((g) => g.label === "Smoke marathon"),
    "the goal written before the restart is still there",
  );
  logIsClean(s2, "boot #2");
} else dumpLog(s2);
await stop(s2, "boot #2");

// ─── 8. Misconfigured: no APP_PASSWORD ──────────────────────────────────────

step("boot #3 — APP_PASSWORD unset: must fail closed and fail its healthcheck");
const s3 = await boot({ APP_PASSWORD: undefined, CREDENTIAL_KEY });
const h3 = await waitForHealth(s3, 503, 15_000);
check(h3.status === 503, `${healthPath} → 503, so Railway never swaps this deployment in (got ${h3.status})`, h3.body);
if (!s3.exited) {
  const open = await request(s3, "GET", "/api/goals");
  check(open.status === 503, `data is refused, not served openly (/api/goals → ${open.status})`);
  await stop(s3, "boot #3");
}

// ─── 9. Misconfigured: on Railway with no volume ────────────────────────────

step("boot #4 — on Railway with no volume attached: must fail its healthcheck");
const s4 = await boot({ APP_PASSWORD: PASSWORD, CREDENTIAL_KEY, ...RAILWAY_ENV, RAILWAY_VOLUME_MOUNT_PATH: undefined });
const h4 = await waitForHealth(s4, 503, 15_000);
check(
  h4.status === 503 && /No volume is attached/.test(h4.body),
  `${healthPath} → 503 naming the missing volume, so the data-erasing deployment never goes live (got ${h4.status})`,
  h4.body,
);
check(/\[config\] No volume is attached/.test(s4.log), "the deploy log says so too");
if (!s4.exited) await stop(s4, "boot #4");

// ─── Result ─────────────────────────────────────────────────────────────────

if (failures) {
  console.log(`\n✗ smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\n✓ smoke: the production artifact builds, boots, serves, persists, and shuts down cleanly");
