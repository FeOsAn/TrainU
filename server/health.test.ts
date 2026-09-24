/**
 * What Railway's healthcheck fails on. Each case is a deployment that would
 * otherwise have gone live looking healthy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentProblems } from "./health";

function inProduction<T>(fn: () => T): T {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

const RAILWAY = { RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_PROJECT_ID: "p" };

test("a correctly configured Railway deployment is healthy", () => {
  const env = { ...RAILWAY, APP_PASSWORD: "pw", RAILWAY_VOLUME_MOUNT_PATH: "/data" };
  assert.deepEqual(inProduction(() => deploymentProblems(env, "/data/trainu.db")), []);
});

test("production without APP_PASSWORD is unhealthy — it refuses every request", () => {
  const problems = inProduction(() => deploymentProblems({}, "/data/trainu.db"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /APP_PASSWORD is not set/);
});

test("development without APP_PASSWORD is fine — `npm run dev` needs no setup", () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    assert.deepEqual(deploymentProblems({}, "./trainu.db"), []);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test("DEFECT: Railway with no volume attached is unhealthy — the next deploy would erase everything", () => {
  const problems = inProduction(() => deploymentProblems({ ...RAILWAY, APP_PASSWORD: "pw" }, "/data/trainu.db"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /No volume is attached/);
});

test("DEFECT: a volume mounted somewhere other than where the database is written is unhealthy", () => {
  const env = { ...RAILWAY, APP_PASSWORD: "pw", RAILWAY_VOLUME_MOUNT_PATH: "/app/storage" };
  const problems = inProduction(() => deploymentProblems(env, "/data/trainu.db"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not on the attached volume \(\/app\/storage\)/);
  // …and pointing DB_PATH inside it fixes it.
  assert.deepEqual(inProduction(() => deploymentProblems(env, "/app/storage/trainu.db")), []);
});

test("a path that merely starts with the mount path is not inside it", () => {
  const env = { ...RAILWAY, APP_PASSWORD: "pw", RAILWAY_VOLUME_MOUNT_PATH: "/data" };
  assert.equal(inProduction(() => deploymentProblems(env, "/data-old/trainu.db")).length, 1);
  assert.equal(inProduction(() => deploymentProblems(env, "/data/../trainu.db")).length, 1);
});

test("an intentionally ephemeral deployment can say so", () => {
  const env = { ...RAILWAY, APP_PASSWORD: "pw", ALLOW_EPHEMERAL_DB: "1" };
  assert.deepEqual(inProduction(() => deploymentProblems(env, "/data/trainu.db")), []);
});

test("off Railway, no volume check applies", () => {
  assert.deepEqual(inProduction(() => deploymentProblems({ APP_PASSWORD: "pw" }, "/srv/trainu.db")), []);
});

test("problems are sentences about configuration, never secret values", () => {
  const env = { ...RAILWAY, RAILWAY_VOLUME_MOUNT_PATH: "/elsewhere", CREDENTIAL_KEY: "k".repeat(64), SESSION_SECRET: "s3cr3t" };
  const text = inProduction(() => deploymentProblems(env, "/data/trainu.db")).join(" ");
  assert.ok(!text.includes("k".repeat(64)) && !text.includes("s3cr3t"));
});
