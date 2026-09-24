/**
 * Development entry point: `npm run dev`.
 *
 * The ONLY module that imports ./vite. Production runs `server/index.ts`,
 * which cannot reach this file — see the note at the top of `app.ts` for why
 * that has to be structural rather than an `if`.
 */
import "dotenv/config";
import { createApp, log } from "./app";
import { setupVite } from "./vite";

process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason instanceof Error ? reason.stack : reason);
});

const { app, httpServer } = await createApp();
await setupVite(httpServer, app);

const port = parseInt(process.env.PORT || "5000", 10);
httpServer.listen({ port, host: "0.0.0.0" }, () => {
  log(`serving on port ${port} (development)`);
});
