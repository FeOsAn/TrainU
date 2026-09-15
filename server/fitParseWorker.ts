/**
 * Standalone entry point, run as its OWN OS process by fitIngest.ts's
 * parseFitBufferSafely — never imported directly into the main server.
 * See that function's comment for why: fit-file-parser can take 10+ seconds
 * AND block the whole Node event loop on a malformed file, confirmed by
 * sending a concurrent request during a bad parse and getting no response
 * for 8+ seconds. Isolating the parse in a killable subprocess is what
 * makes that bounded and non-blocking for every other request.
 */
import { readFileSync } from "node:fs";
import { parseFitBuffer } from "./fitIngest";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write("usage: fitParseWorker <path-to-fit-file>\n");
    process.exit(2);
  }
  try {
    const buffer = readFileSync(filePath);
    const result = await parseFitBuffer(buffer);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (e: any) {
    process.stderr.write(JSON.stringify({ error: e?.message ?? String(e) }));
    process.exit(1);
  }
}

main();
