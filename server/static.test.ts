/**
 * How the production server answers for the client — pinned because the old
 * fallback turned a redeploy into a blank page for every open tab.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serveStatic } from "./static";

const dist = mkdtempSync(path.join(os.tmpdir(), "trainu-static-"));
mkdirSync(path.join(dist, "assets"));
writeFileSync(path.join(dist, "index.html"), `<!doctype html><div id="root"></div><script type="module" src="/assets/index-new.js"></script>`);
writeFileSync(path.join(dist, "assets", "index-new.js"), "console.log('new build')");

const app = express();
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
serveStatic(app, dist);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  rmSync(dist, { recursive: true, force: true });
});

async function get(p: string, method = "GET") {
  const res = await fetch(base + p, { method });
  return { status: res.status, type: res.headers.get("content-type") ?? "", cache: res.headers.get("cache-control") ?? "", body: await res.text() };
}

test("DEFECT: the previous build's asset is a 404, not index.html with a 200", async () => {
  // What a tab left open across a redeploy requests next.
  const res = await get("/assets/index-old.js");
  assert.equal(res.status, 404);
  assert.ok(!res.type.includes("text/html"), `served ${res.type} for a missing script — the browser's MIME error and a blank page`);
});

test("any path that looks like a file and isn't one is a 404", async () => {
  for (const p of ["/favicon.ico", "/robots.txt", "/goals/chunk.js", "/foo.map"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("page navigations get the client, including nested and trailing-slash URLs", async () => {
  for (const p of ["/", "/athlete", "/goals", "/app", "/goals/123", "/athlete/", "/no/such/page"]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.body, /<div id="root">/, p);
  }
});

test("index.html is always revalidated; hashed assets are immutable", async () => {
  assert.equal((await get("/")).cache, "no-cache");
  assert.equal((await get("/athlete")).cache, "no-cache");
  assert.match((await get("/assets/index-new.js")).cache, /immutable/);
});

test("non-GET requests to client paths are not answered with the page", async () => {
  assert.equal((await get("/athlete", "POST")).status, 404);
});

test("the API's own 404 is never replaced by the client", async () => {
  const res = await get("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.type, /json/);
});
