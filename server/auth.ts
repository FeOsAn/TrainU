/**
 * A single-user access gate.
 *
 * This app has no user table — everything is keyed `"self"` (see
 * preferencesService, routes' ATHLETE_ROW_ID). That's a deliberate and
 * correct choice for a personal app, right up until it gets a public URL.
 * Deployed without a gate, anyone who finds the hostname can read the
 * athlete's training history, create goals, and trigger a Garmin sync using
 * stored credentials.
 *
 * So: one shared password, checked on every request, held in an
 * HTTP-only cookie once it's been given. Not an identity system — it does not
 * pretend to be one, and the day a second athlete exists this gets replaced
 * rather than extended.
 *
 * Deliberately fails CLOSED in production: with no APP_PASSWORD set, every
 * request is refused rather than served openly. An app that silently
 * publishes a Garmin password because an env var was forgotten is worse than
 * an app that won't start.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";

const COOKIE = "trainu_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Paths that must work before the athlete has authenticated. `/api/health` is
 * Railway's healthcheck, which has no cookie; it reveals nothing but whether
 * this deployment can serve.
 */
const PUBLIC_API = new Set(["/api/auth/login", "/api/auth/status", "/api/health"]);

function password(): string | undefined {
  const raw = process.env.APP_PASSWORD;
  return raw && raw.length > 0 ? raw : undefined;
}

/**
 * A secret for signing the session cookie. Falls back to the password itself
 * so there's only one thing to configure; a random per-boot value would log
 * the athlete out on every deploy.
 */
function signingSecret(): string {
  return process.env.SESSION_SECRET || password() || randomBytes(32).toString("hex");
}

function token(): string {
  return createHmac("sha256", signingSecret()).update("trainu-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function cookieValue(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

export function isAuthenticated(req: Request): boolean {
  const configured = password();
  // No password configured in development: open, so `npm run dev` needs no setup.
  if (!configured) return process.env.NODE_ENV !== "production";
  const cookie = cookieValue(req);
  return Boolean(cookie && safeEqual(cookie, token()));
}

export function registerAuth(app: Express): void {
  app.post("/api/auth/login", (req: Request, res: Response) => {
    const configured = password();
    if (!configured) {
      return res.status(503).json({ error: "APP_PASSWORD is not set on the server." });
    }
    const given = typeof req.body?.password === "string" ? req.body.password : "";
    if (!safeEqual(given, configured)) {
      return res.status(401).json({ error: "Wrong password." });
    }
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    res.json({ ok: true });
  });

  app.get("/api/auth/status", (req: Request, res: Response) => {
    res.json({ authenticated: isAuthenticated(req), passwordRequired: Boolean(password()) });
  });

  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
}

/**
 * Gate every /api route that isn't explicitly public.
 *
 * Mount it as `app.use("/api", requireAuth)`, so that what counts as "the
 * API" is decided by the same router that dispatches to the handlers. It used
 * to be mounted globally and test `req.path.startsWith("/api")` — but Express
 * matches routes case-INsensitively, so `/API/goals` sailed past this check
 * and straight into the `/api/goals` handler, and every read and write in the
 * app was open to anyone who typed the path in capitals. The comparison below
 * is lowercased as well, so the gate holds however it is mounted.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const fullPath = (req.baseUrl + req.path).toLowerCase();
  if (!fullPath.startsWith("/api") || PUBLIC_API.has(fullPath)) return next();
  if (isAuthenticated(req)) return next();

  if (process.env.NODE_ENV === "production" && !password()) {
    res.status(503).json({
      error: "This deployment has no APP_PASSWORD set, so it refuses to serve data. Set APP_PASSWORD and redeploy.",
    });
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}
