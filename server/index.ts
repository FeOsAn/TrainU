/**
 * Production entry point — what esbuild bundles into dist/index.js and what
 * Railway runs. Development runs `server/dev.ts` instead; see `app.ts`.
 */
import "dotenv/config";
import { createApp, log } from "./app";
import { serveStatic } from "./static";
import { sqlite } from "./db";
import { deploymentProblems } from "./health";

// Our own code has NODE_ENV baked in at build time (scripts/build-server.mjs);
// this makes the libraries we don't bundle — express — agree with it.
Object.assign(process.env, { NODE_ENV: "production" });

process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason instanceof Error ? reason.stack : reason);
});

/**
 * A boot failure must END the process.
 *
 * This used to run inside a bare async IIFE, so anything that threw during
 * boot — serveStatic finding no build, a route module failing to initialise —
 * became an unhandled rejection, which the handler above logs and swallows.
 * The process then sat there alive and not listening: nothing for Railway's
 * restart policy to restart, and a deploy that reads as "running" while every
 * request times out. Exiting non-zero is what lets the platform see it.
 */
async function boot(): Promise<void> {
  const { app, httpServer } = await createApp();
  serveStatic(app);

  const port = parseInt(process.env.PORT || "5000", 10);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen({ port, host: "0.0.0.0" }, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  log(`serving on port ${port} (node ${process.versions.node})`);

  // The same checks the healthcheck fails on, said once where the operator
  // reading the deploy log will see them.
  for (const problem of deploymentProblems()) console.error(`[config] ${problem}`);

  /*
   * Railway sends SIGTERM before replacing a deployment. Stop taking new
   * requests, let in-flight ones finish, then close SQLite so the WAL is
   * checkpointed into the main file on the volume rather than left for the
   * next boot to recover. A hard deadline stops a stuck keep-alive socket
   * from holding the old deployment (and the volume) hostage.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);
    const deadline = setTimeout(() => {
      console.error("[shutdown] did not finish within 10s, exiting anyway");
      process.exit(1);
    }, 10_000);
    deadline.unref();
    httpServer.close(() => {
      try {
        sqlite.close();
      } catch (err) {
        console.error("[shutdown] closing the database failed:", err);
      }
      process.exit(0);
    });
    httpServer.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

boot().catch((err) => {
  console.error("[boot] failed — exiting so the platform can see it:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
