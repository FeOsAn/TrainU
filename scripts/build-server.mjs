/**
 * Bundle the server for production, and refuse to produce a bundle that
 * cannot run.
 *
 * Both of the first deployment's failures were visible at BUILD time and
 * nothing looked:
 *
 *   1. It built and ran on Node 18 because nothing pinned a version, and the
 *      server used a Node 20.11 API at module scope. A build that checks the
 *      Node it is running on against `engines` fails in the builder's log,
 *      naming the fix, instead of in a crash loop after the deploy swapped in.
 *
 *   2. The bundle imported `vite` — a devDependency — at the top of
 *      dist/index.js, because esbuild inlines a dynamically imported file and
 *      hoists its imports. Any install without devDependencies could not even
 *      load the server. esbuild's metafile lists every import the bundle leaves
 *      external; each must be a Node builtin or a declared `dependencies`
 *      entry, or the build fails here.
 *
 * A failed build is the cheap outcome: Railway keeps serving the previous
 * deployment and the log says exactly what to change.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enginesAdmits, unresolvableExternals } from "./bundleGuards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// ─── 1. The Node this is being built with is the Node `engines` asks for ────

const wanted = pkg.engines?.node;
const running = process.versions.node;
if (!wanted) {
  fail(`package.json has no engines.node. Without it the builder picks its own Node version, which is how the first deploy ended up on Node 18.`);
}
if (!enginesAdmits(wanted, Number(running.split(".")[0]))) {
  fail(
    `Building with Node ${running}, but package.json engines.node is "${wanted}".\n` +
      `  The server would then run on a Node it was never tested on — the first deployment crashed exactly this way.\n` +
      `  On Railway, the builder should read engines.node; if it didn't, set NIXPACKS_NODE_VERSION / RAILPACK_NODE_VERSION to match.`,
  );
}

// ─── 2. Bundle ──────────────────────────────────────────────────────────────

const result = await build({
  absWorkingDir: root,
  entryPoints: ["server/index.ts", "server/fitParseWorker.ts"],
  platform: "node",
  packages: "external",
  bundle: true,
  format: "esm",
  outdir: "dist",
  metafile: true,
  logLevel: "info",
  // dist/ is the production build by construction. Baking this in means the
  // fail-closed checks (auth without APP_PASSWORD, credentials without
  // CREDENTIAL_KEY) and the /data default for the database hold even if the
  // start command is ever changed to run `node dist/index.js` directly
  // without the `NODE_ENV=production` prefix.
  define: { "process.env.NODE_ENV": '"production"' },
});

// ─── 3. Everything the bundle leaves external is installed in production ───

const problems = unresolvableExternals(result.metafile, pkg);
if (problems.length) fail(`The server bundle would not load in production:\n  - ${problems.join("\n  - ")}`);

console.log(`✓ server bundle: Node ${running} satisfies engines "${wanted}"; every external import is a builtin or a runtime dependency`);

function fail(message) {
  console.error(`\n✗ build-server: ${message}\n`);
  process.exit(1);
}
