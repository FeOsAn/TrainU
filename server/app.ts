/**
 * The Express app itself, with no opinion about how its client is served.
 *
 * Split out of `index.ts` so that the two ways of running this app are two
 * ENTRY POINTS rather than one entry point branching on NODE_ENV:
 *
 *   - `server/index.ts` — production. What esbuild bundles into dist/index.js.
 *   - `server/dev.ts`   — development. Run by tsx; the only file that reaches vite.
 *
 * It used to be one file with `await import("./vite")` in the dev branch. That
 * looks lazy and is not: esbuild inlines a dynamically imported relative file
 * into the bundle and hoists ITS imports — `vite`, `@vitejs/plugin-react` — to
 * the top of dist/index.js as static imports. Both are devDependencies, so a
 * production install without them could not even load the bundle
 * (ERR_MODULE_NOT_FOUND 'vite' before a single line of ours ran). A module the
 * production entry cannot reach cannot end up in the production bundle;
 * `scripts/check-bundle-deps.mjs` fails the build if one ever does anyway.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { registerRoutes } from "./routes";
import { registerAuth, requireAuth } from "./auth";

export function log(message: string, source = "express") {
  const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${time} [${source}] ${message}`);
}

/**
 * Everything up to and including the error handler. The caller adds how the
 * client is served (static files or vite middleware) and then listens.
 */
export async function createApp(): Promise<{ app: express.Express; httpServer: Server }> {
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (req.path.startsWith("/api")) {
        log(`${req.method} ${req.path} ${res.statusCode} in ${Date.now() - start}ms`);
      }
    });
    next();
  });

  // Auth first: registerAuth adds the login endpoints, requireAuth gates
  // everything registered after it. Mounted at "/api" — not globally — so the
  // gate is matched by the same (case-insensitive) router as the routes it
  // protects; see requireAuth for the bypass the global mount allowed.
  registerAuth(app);
  app.use("/api", requireAuth);

  await registerRoutes(httpServer, app);

  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("Internal Server Error:", err);
    res.status(err.status || err.statusCode || 500).json({ message: err.message || "Internal Server Error" });
  });

  return { app, httpServer };
}
