/**
 * The checks `build-server.mjs` runs on every production build, kept pure so
 * they can be tested without building anything.
 */
import { builtinModules } from "node:module";

/** Whether an `engines.node` range admits a Node major version, for the forms this repo uses. */
export function enginesAdmits(range, major) {
  const r = String(range).trim();
  let m;
  if ((m = /^(\d+)(\.x)?(\.x)?$/.exec(r))) return major === Number(m[1]);
  if ((m = /^[\^~](\d+)(\.\d+){0,2}$/.exec(r))) return major === Number(m[1]);
  if ((m = /^>=\s*(\d+)(\.\d+){0,2}$/.exec(r))) return major >= Number(m[1]);
  throw new Error(`bundleGuards does not understand engines.node "${r}" — extend enginesAdmits() rather than skip the check.`);
}

/** "drizzle-orm/better-sqlite3" -> "drizzle-orm", "@scope/pkg/x" -> "@scope/pkg". */
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/**
 * Every import an esbuild metafile says the bundle leaves external, that a
 * production install (`dependencies` only) would not be able to resolve.
 * Returns human-readable problems; empty means the bundle can load.
 */
export function unresolvableExternals(metafile, pkg) {
  const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}));
  const problems = [];
  for (const [output, meta] of Object.entries(metafile.outputs)) {
    for (const imp of meta.imports) {
      if (!imp.external) continue;
      if (BUILTINS.has(imp.path) || BUILTINS.has(imp.path.split("/")[0])) continue;
      if (imp.path.startsWith(".") || imp.path.startsWith("/")) {
        problems.push(`${output} imports "${imp.path}", a relative/absolute path left external — it will not exist next to the bundle.`);
        continue;
      }
      const name = packageName(imp.path);
      if (runtimeDeps.has(name)) continue;
      const importers = Object.entries(metafile.inputs)
        .filter(([, input]) => input.imports.some((i) => i.path === imp.path))
        .map(([file]) => file);
      const where = pkg.devDependencies?.[name] ? "a devDependency" : "not declared at all";
      problems.push(
        `${output} imports "${imp.path}", but "${name}" is ${where} — a production install will not have it.\n` +
          `    imported by: ${importers.join(", ") || "(unknown)"}\n` +
          `    fix: move "${name}" to dependencies if production needs it, or make sure nothing reachable from server/index.ts imports it.`,
      );
    }
  }
  return [...new Set(problems)];
}
