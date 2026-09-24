/**
 * The checks that make a production build refuse to produce something that
 * cannot boot. See scripts/build-server.mjs for why each exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
// @ts-expect-error — plain .mjs, no type declarations
import { enginesAdmits, packageName, unresolvableExternals } from "./bundleGuards.mjs";

const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));

test("enginesAdmits: the forms package.json uses", () => {
  assert.equal(enginesAdmits("22.x", 22), true);
  assert.equal(enginesAdmits("22.x", 18), false, "the version the first deployment actually ran");
  assert.equal(enginesAdmits("22.x", 20), false);
  assert.equal(enginesAdmits("22.x", 24), false);
  assert.equal(enginesAdmits("22", 22), true);
  assert.equal(enginesAdmits("^22.12.0", 22), true);
  assert.equal(enginesAdmits("^22.12.0", 23), false);
  assert.equal(enginesAdmits(">=20", 22), true);
  assert.equal(enginesAdmits(">=20", 18), false);
  assert.throws(() => enginesAdmits("20 || 22", 22), /does not understand/, "an unknown form must fail loudly, never pass");
});

test("the engines field this repo actually declares is one the build understands", () => {
  assert.ok(pkg.engines?.node, "package.json must pin engines.node — without it the builder picks its own Node");
  assert.doesNotThrow(() => enginesAdmits(pkg.engines.node, 22));
});

test("packageName", () => {
  assert.equal(packageName("drizzle-orm/better-sqlite3"), "drizzle-orm");
  assert.equal(packageName("@anthropic-ai/sdk"), "@anthropic-ai/sdk");
  assert.equal(packageName("@vitejs/plugin-react/x"), "@vitejs/plugin-react");
  assert.equal(packageName("dotenv/config"), "dotenv");
});

async function metafileFor(files: Record<string, string>, entry: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bundleguards-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    const result = await build({
      absWorkingDir: dir,
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      write: false,
      outdir: "out",
      metafile: true,
      logLevel: "silent",
    });
    return result.metafile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("DEFECT: a dev-only module behind a dynamic import is still caught", async () => {
  // The exact shape of the first deploy's second crash: index.ts only ever
  // `await import("./vite")` in development, but esbuild inlines the file and
  // hoists its `import ... from "vite"` to the top of the bundle.
  const metafile = await metafileFor(
    {
      "index.ts": `import express from "express"; if (process.env.DEV) { await import("./devserver"); } export default express;`,
      "devserver.ts": `import { createServer } from "vite"; export const s = createServer;`,
    },
    "index.ts",
  );
  const problems = unresolvableExternals(metafile, pkg);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /"vite" is a devDependency/);
  assert.match(problems[0], /devserver\.ts/, "the message names the file that pulled it in");
});

test("DEFECT: a runtime import declared only as a devDependency is caught", async () => {
  const metafile = await metafileFor({ "index.ts": `import Database from "better-sqlite3"; export default Database;` }, "index.ts");
  const asDevDep = {
    dependencies: {},
    devDependencies: { "better-sqlite3": "^11.7.0" },
  };
  assert.match(unresolvableExternals(metafile, asDevDep).join(), /"better-sqlite3" is a devDependency/);
  assert.deepEqual(unresolvableExternals(metafile, { dependencies: { "better-sqlite3": "^11.7.0" } }), []);
});

test("undeclared packages, builtins, and subpath imports", async () => {
  const metafile = await metafileFor(
    { "index.ts": `import "node:fs"; import "path"; import "dotenv/config"; import "left-pad"; export {};` },
    "index.ts",
  );
  const problems = unresolvableExternals(metafile, { dependencies: { dotenv: "^16" } });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /"left-pad" is not declared at all/);
});

test("the real production entry points reach no devDependency", async () => {
  // The same check `npm run build` makes, run here in-memory so `npm test`
  // catches it without a full build.
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: ["server/index.ts", "server/fitParseWorker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    outdir: "dist",
    metafile: true,
    logLevel: "silent",
  });
  assert.deepEqual(unresolvableExternals(result.metafile, pkg), []);
});

test("the build script is what `npm run build` runs", () => {
  // A guard nobody invokes guards nothing.
  assert.match(pkg.scripts.build, /node scripts\/build-server\.mjs/);
});
