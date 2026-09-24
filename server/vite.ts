import type { Express } from "express";
import { createServer as createViteServer, createLogger } from "vite";
import type { Server } from "node:http";
import viteConfig from "../vite.config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const viteLogger = createLogger();

export async function setupVite(server: Server, app: Express) {
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: {
      middlewareMode: true,
      hmr: { server, path: "/vite-hmr" },
      allowedHosts: true as const,
    },
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "index.html");
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${Date.now()}"`);
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
