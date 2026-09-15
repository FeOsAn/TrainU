import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeFitFile, parseFitBufferSafely } from "./fitIngest";

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
