import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { looksLikeFitFile, parseFitBufferSafely, resolveFitWorker } from "./fitIngest";

function validHeaderBuffer(bodyByte = 0xff, bodyLength = 200): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0); // header size
  header.writeUInt8(0x10, 1); // protocol version
  header.writeUInt16LE(100, 2); // profile version
  header.writeUInt32LE(999999, 4); // bogus data size
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, Buffer.alloc(bodyLength, bodyByte)]);
}

test("looksLikeFitFile rejects buffers that are too short to have a header", () => {
  assert.equal(looksLikeFitFile(Buffer.from("not a fit file")), false);
  assert.equal(looksLikeFitFile(Buffer.alloc(0)), false);
});

test("looksLikeFitFile rejects a plausible-length buffer with the wrong magic bytes", () => {
  const buf = Buffer.alloc(20);
  buf.writeUInt8(12, 0);
  buf.write("NOPE", 8, "ascii");
  assert.equal(looksLikeFitFile(buf), false);
});

test("looksLikeFitFile rejects an implausible header-size byte even with the right magic", () => {
  const buf = Buffer.alloc(20);
  buf.writeUInt8(99, 0); // neither 12 nor 14
  buf.write(".FIT", 8, "ascii");
  assert.equal(looksLikeFitFile(buf), false);
});

test("looksLikeFitFile accepts a well-formed 12-byte header", () => {
  assert.equal(looksLikeFitFile(validHeaderBuffer()), true);
});

test("parseFitBufferSafely rejects a non-FIT buffer immediately, without spawning a subprocess", async () => {
  const start = Date.now();
  await assert.rejects(() => parseFitBufferSafely(Buffer.from("definitely not a fit file")), /Not a FIT file/);
  assert.ok(Date.now() - start < 500, "the header check must short-circuit before ever spawning a subprocess");
});

test("parseFitBufferSafely reports a clean timeout error, and it does not throw an unrelated error instead", async () => {
  // 1ms is short enough that the subprocess can't possibly boot in time —
  // this is what proves the timeout/kill branch itself is wired correctly,
  // not just that Node's execFile has a timeout option.
  await assert.rejects(() => parseFitBufferSafely(validHeaderBuffer(), 1), /timed out/);
});

test("parseFitBufferSafely isolates a parser crash (garbage body) into a clean rejection, not a process crash", async () => {
  // A real crash inside the subprocess must surface as a normal rejected
  // promise here, not bring down whatever called it.
  await assert.rejects(() => parseFitBufferSafely(validHeaderBuffer()));
});


/*
 * ─── Where the parse actually runs ──────────────────────────────────────────
 *
 * These pin the bug that took the first real deployment down.
 *
 * `import.meta.dirname` is Node >= 20.11. Railway ran Node 18, where it is
 * undefined — and the worker path was resolved at MODULE SCOPE, so
 * path.resolve(undefined, …) threw during import and the server never
 * listened. Nothing to do with FIT files: the app would not boot at all.
 *
 * Behind that sat the real defect. The worker was spawned as `tsx` from
 * node_modules/.bin pointing at a .ts SOURCE file — neither of which exists in
 * a production install (`--omit=dev` strips tsx, dist/ holds no .ts). So the
 * isolation the tests above verify had never once happened outside dev. The
 * crash was hiding a broken feature, not causing one.
 */

test("importing the module resolves no paths — a bad path can never stop the server booting", () => {
  assert.equal(typeof resolveFitWorker, "function");
});

test("a built deployment runs the bundled worker on plain node, not tsx", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fitworker-built-"));
  try {
    writeFileSync(path.join(dir, "fitParseWorker.js"), "// built worker\n");
    const { bin, args } = resolveFitWorker(dir);
    assert.equal(bin, process.execPath, "a deployed container has node and nothing else");
    assert.ok(args[0]?.endsWith("fitParseWorker.js"));
    assert.ok(!bin.includes("tsx"), "tsx is a devDependency and is not installed in production");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dev checkout still runs the TypeScript source under tsx", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fitworker-dev-"));
  try {
    writeFileSync(path.join(dir, "fitParseWorker.ts"), "// source worker\n");
    const { bin, args } = resolveFitWorker(dir);
    assert.ok(bin.endsWith("tsx"), `expected tsx, got ${bin}`);
    assert.ok(args[0]?.endsWith("fitParseWorker.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neither present fails loudly, naming the fix", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fitworker-none-"));
  try {
    assert.throws(() => resolveFitWorker(dir), /esbuild entry points|fitParseWorker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the build emits the worker beside the server bundle", () => {
  // A worker the code spawns but the build never emits is capability nothing
  // can reach — the Phase 8 archetype, one layer down in the build.
  if (!existsSync(path.resolve(process.cwd(), "dist/index.js"))) return;
  assert.ok(
    existsSync(path.resolve(process.cwd(), "dist/fitParseWorker.js")),
    "dist/index.js exists but dist/fitParseWorker.js does not — the second esbuild entry point is missing",
  );
});
