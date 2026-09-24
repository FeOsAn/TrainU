import express from "express";
import type { Express, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serve the built client, and the SPA fallback for its routes.
 *
 * The fallback used to answer EVERY unmatched path with index.html and a 200
 * — including a missing `/assets/index-abc123.js`. That is exactly what a tab
 * left open across a redeploy asks for: its old index.html names the previous
 * build's asset hashes, the new deployment doesn't have them, and the browser
 * got HTML where it expected JavaScript — a MIME error and a blank page, with
 * nothing in the server log to say why. Now only a page navigation (a GET for
 * a path with no file extension) gets index.html; anything that looks like a
 * file and isn't one is a 404.
 *
 * Caching follows from the same event: hashed assets never change, so they
 * are immutable; index.html must be revalidated every time, so a new deploy's
 * asset names reach the browser on the next load rather than whenever a cache
 * decides to let go.
 */
export function serveStatic(app: Express, distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public")) {
  if (!fs.existsSync(distPath)) {
    throw new Error(`Could not find the build directory: ${distPath}, make sure to build the client first`);
  }
  const assetsDir = path.join(distPath, "assets") + path.sep;
  const indexHtml = path.resolve(distPath, "index.html");

  app.use(
    express.static(distPath, {
      setHeaders(res, filePath) {
        res.setHeader("Cache-Control", filePath.startsWith(assetsDir) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );

  // No mount path: under `app.use("/{*path}", …)` Express strips the matched
  // path and `req.path` is always "/", so every request would look like a
  // page navigation — the very thing this is here to stop.
  app.use((req: Request, res: Response) => {
    const lastSegment = req.path.split("/").pop() ?? "";
    const isNavigation = (req.method === "GET" || req.method === "HEAD") && !lastSegment.includes(".") && !req.path.startsWith("/assets/");
    if (!isNavigation) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });
}
