import type { Express } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import multer from "multer";
import { db } from "./db";
import { athleteMeasurements, chatMessages, outcomeLog, trainingSessions } from "@shared/schema";
import { type AthleteParams, type AthleteRow, athleteParamsFromRow, withinBounds } from "@shared/athlete";
import { measured } from "@shared/measured";
import type { Sport, TrainingSession } from "@shared/session";
import { computeTrainingLoad } from "@shared/trainingLoad";
import { findDuplicate } from "@shared/sessionDedupe";
import { parseFitBufferSafely, fitResultToSession } from "./fitIngest";
import { predictRunRace, predictTriathlon, TRIATHLON_DISTANCES, type TriathlonDistances } from "@shared/predictors/enduranceRace";
import { predictHyrox } from "@shared/predictors/hyrox";
import { predictBodyComposition } from "@shared/predictors/bodyComposition";
import { predictStrength, type LiftId } from "@shared/predictors/strength";
import { arbitratePlan } from "@shared/arbitration/arbitrate";
import { createGoal, InvalidGoalError, listGoals } from "./goalsService";
import { chatOnboarding } from "./onboarding";
import { getPreferences, updateConnectorPreferences, updateFeaturePreferences } from "./preferencesService";
import { connectGarmin, syncGarmin } from "./connectors/garmin";
import { exchangeWhoopCode, getWhoopAuthorizationUrl, syncWhoop } from "./connectors/whoop";
import { importAppleHealthExport } from "./connectors/appleHealth";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadLarge = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const ATHLETE_ROW_ID = "self";

function getAthleteRow(): AthleteRow | null {
  const row = db.select().from(athleteMeasurements).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).get();
  return row ? (JSON.parse(row.fieldsJson) as AthleteRow) : null;
}

function getAthleteParams(): AthleteParams {
  return athleteParamsFromRow(getAthleteRow());
}

function saveAthleteRow(row: AthleteRow): void {
  const fieldsJson = JSON.stringify(row);
  const now = new Date().toISOString();
  const existing = db.select().from(athleteMeasurements).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).get();
  if (existing) {
    db.update(athleteMeasurements).set({ fieldsJson, updatedAt: now }).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).run();
  } else {
    db.insert(athleteMeasurements).values({ id: ATHLETE_ROW_ID, fieldsJson, updatedAt: now }).run();
  }
}

function logPrediction(kind: string, goalId: string | null, prediction: unknown): void {
  db.insert(outcomeLog)
    .values({
      id: randomUUID(),
      goalId,
      kind,
      predictedAt: new Date().toISOString(),
      predictionJson: JSON.stringify(prediction),
      actualJson: null,
      observedAt: null,
    })
    .run();
}

function rowToSession(row: typeof trainingSessions.$inferSelect): TrainingSession {
  return {
    id: row.id,
    date: row.date,
    sport: row.sport as Sport,
    source: row.source as TrainingSession["source"],
    startTime: row.startTime,
    durationMinutes: row.durationMinutes,
    distanceKm: row.distanceKm,
    avgHeartRate: row.avgHeartRate,
    maxHeartRate: row.maxHeartRate,
    avgPaceSecPerKm: row.avgPaceSecPerKm,
    avgPaceSecPer100m: row.avgPaceSecPer100m,
    avgPowerWatts: row.avgPowerWatts,
    normalizedPower: row.normalizedPower,
    tss: row.tss,
    hrZonesJson: row.hrZonesJson,
    rpe: row.rpe,
    externalId: row.externalId,
  };
}

function insertSession(s: TrainingSession): void {
  db.insert(trainingSessions)
    .values({
      id: s.id,
      date: s.date,
      sport: s.sport,
      source: s.source,
      startTime: s.startTime ?? null,
      durationMinutes: s.durationMinutes,
      distanceKm: s.distanceKm ?? null,
      avgHeartRate: s.avgHeartRate ?? null,
      maxHeartRate: s.maxHeartRate ?? null,
      avgPaceSecPerKm: s.avgPaceSecPerKm ?? null,
      avgPaceSecPer100m: s.avgPaceSecPer100m ?? null,
      avgPowerWatts: s.avgPowerWatts ?? null,
      normalizedPower: s.normalizedPower ?? null,
      tss: s.tss ?? null,
      hrZonesJson: s.hrZonesJson ?? null,
      rpe: s.rpe != null ? String(s.rpe) : null,
      externalId: s.externalId ?? null,
    })
    .run();
}

export async function registerRoutes(_httpServer: Server, app: Express) {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ─── Goals (Phase 1) ────────────────────────────────────────────────────
  app.get("/api/goals", (_req, res) => {
    res.json(listGoals());
  });

  app.post("/api/goals", (req, res) => {
    try {
      res.status(201).json(createGoal(req.body ?? {}));
    } catch (e) {
      if (e instanceof InvalidGoalError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  // ─── Athlete measurements (Phase 2) ────────────────────────────────────
  app.get("/api/athlete", (_req, res) => {
    res.json(getAthleteParams());
  });

  app.patch("/api/athlete", (req, res) => {
    const body = req.body as Record<string, number>;
    const row = getAthleteRow() ?? {};
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return res.status(400).json({ error: `${key} must be a number` });
      }
      if (!withinBounds(key, value)) {
        return res.status(400).json({ error: `${key}=${value} is out of plausible bounds` });
      }
      (row as any)[key] = measured(value, "manually entered", now);
    }
    saveAthleteRow(row);
    res.json(getAthleteParams());
  });

  // ─── Sessions (Phase 2) ─────────────────────────────────────────────────
  app.get("/api/sessions", (_req, res) => {
    res.json(db.select().from(trainingSessions).all().map(rowToSession));
  });

  app.post("/api/sessions", (req, res) => {
    const body = req.body as Partial<TrainingSession>;
    if (!body.date || !body.sport || !body.durationMinutes) {
      return res.status(400).json({ error: "date, sport, durationMinutes are required" });
    }
    const session: TrainingSession = {
      id: randomUUID(),
      date: body.date,
      sport: body.sport,
      source: "manual",
      startTime: body.startTime ?? null,
      durationMinutes: body.durationMinutes,
      distanceKm: body.distanceKm ?? null,
      avgHeartRate: body.avgHeartRate ?? null,
      maxHeartRate: body.maxHeartRate ?? null,
      avgPaceSecPerKm: body.avgPaceSecPerKm ?? null,
      avgPaceSecPer100m: body.avgPaceSecPer100m ?? null,
      avgPowerWatts: body.avgPowerWatts ?? null,
      normalizedPower: body.normalizedPower ?? null,
      tss: body.tss ?? null,
      hrZonesJson: body.hrZonesJson ?? null,
      rpe: body.rpe ?? null,
      externalId: null,
    };
    const existing = db.select().from(trainingSessions).all().map(rowToSession);
    const dup = findDuplicate(session, existing);
    if (dup) return res.status(409).json({ error: "duplicate", existing: dup });
    insertSession(session);
    res.status(201).json(session);
  });

  app.post("/api/sessions/fit-upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file is required (multipart field name: file)" });
    try {
      const parsed = await parseFitBufferSafely(req.file.buffer);
      const session = fitResultToSession(parsed, randomUUID());
      const existing = db.select().from(trainingSessions).all().map(rowToSession);
      const dup = findDuplicate(session, existing);
      if (dup) return res.status(409).json({ error: "duplicate", existing: dup });
      insertSession(session);
      res.status(201).json(session);
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "failed to parse FIT file" });
    }
  });

  // ─── Training load (Phase 2) ────────────────────────────────────────────
  app.get("/api/training-load", (_req, res) => {
    const sessions = db.select().from(trainingSessions).all().map(rowToSession);
    res.json(computeTrainingLoad(sessions, getAthleteParams()));
  });

  // ─── Predictors (Phase 2) — every one logs to outcomeLog so Phase 6 has
  // something to check itself against once the real outcome is known. ────
  app.post("/api/predict/run", (req, res) => {
    const { distanceKm, goalMinutes, goalId } = req.body as { distanceKm: number; goalMinutes?: number; goalId?: string };
    if (typeof distanceKm !== "number" || distanceKm <= 0) return res.status(400).json({ error: "distanceKm is required" });
    const prediction = predictRunRace(getAthleteParams(), distanceKm, goalMinutes);
    logPrediction("prediction:run", goalId ?? null, prediction);
    res.json(prediction);
  });

  app.post("/api/predict/triathlon", (req, res) => {
    const { distance, goalMinutes, goalId } = req.body as { distance: keyof typeof TRIATHLON_DISTANCES | TriathlonDistances; goalMinutes?: number; goalId?: string };
    const distances = typeof distance === "string" ? TRIATHLON_DISTANCES[distance] : distance;
    if (!distances) return res.status(400).json({ error: "distance must be sprint|olympic|70.3|full or {swimKm,bikeKm,runKm}" });
    const prediction = predictTriathlon(getAthleteParams(), distances, goalMinutes);
    logPrediction("prediction:triathlon", goalId ?? null, prediction);
    res.json(prediction);
  });

  app.post("/api/predict/hyrox", (req, res) => {
    const { goalSeconds, goalId } = req.body as { goalSeconds: number; goalId?: string };
    if (typeof goalSeconds !== "number" || goalSeconds <= 0) return res.status(400).json({ error: "goalSeconds is required" });
    const prediction = predictHyrox(getAthleteParams(), goalSeconds);
    logPrediction("prediction:hyrox", goalId ?? null, prediction);
    res.json(prediction);
  });

  app.post("/api/predict/body-composition", (req, res) => {
    const body = req.body as { targetWeightKg?: number; targetBodyFatPercent?: number; targetDate: string; goalId?: string };
    if (!body.targetDate) return res.status(400).json({ error: "targetDate is required" });
    const prediction = predictBodyComposition(getAthleteParams(), body);
    logPrediction("prediction:body_composition", body.goalId ?? null, prediction);
    res.json(prediction);
  });

  app.post("/api/predict/strength", (req, res) => {
    const { lift, targetDate, goalId } = req.body as { lift: LiftId; targetDate: string; goalId?: string };
    if (!lift || !targetDate) return res.status(400).json({ error: "lift and targetDate are required" });
    const prediction = predictStrength(getAthleteParams(), lift, targetDate);
    logPrediction("prediction:strength", goalId ?? null, prediction);
    res.json(prediction);
  });

  // ─── Goal arbitration (Phase 3) ─────────────────────────────────────────
  app.get("/api/plan/arbitrate", (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const from = typeof req.query.from === "string" ? req.query.from : today;
    const activeGoals = listGoals().filter((g) => g.active);
    const defaultTo = activeGoals.length
      ? activeGoals.reduce((latest, g) => (g.targetDate > latest ? g.targetDate : latest), from)
      : from;
    const to = typeof req.query.to === "string" ? req.query.to : defaultTo;
    if (activeGoals.length === 0) {
      return res.json({ fromDate: from, toDate: to, weeks: [], conflicts: [] });
    }
    const plan = arbitratePlan(activeGoals, from, to, getAthleteParams());
    logPrediction("plan:arbitration", null, plan);
    res.json(plan);
  });

  // ─── Onboarding chat (Phase 4) ──────────────────────────────────────────
  app.get("/api/onboarding/history", (_req, res) => {
    res.json(
      db
        .select()
        .from(chatMessages)
        .all()
        .map((r) => ({ role: r.role, content: r.content, createdAt: r.createdAt })),
    );
  });

  app.post("/api/onboarding/chat", async (req, res) => {
    const { message } = req.body as { message?: string };
    if (!message?.trim()) return res.status(400).json({ error: "message is required" });

    const history = db
      .select()
      .from(chatMessages)
      .all()
      .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));

    const result = await chatOnboarding(message, history);

    const now = new Date().toISOString();
    db.insert(chatMessages).values({ id: randomUUID(), role: "user", content: message, createdAt: now }).run();
    db.insert(chatMessages).values({ id: randomUUID(), role: "assistant", content: result.reply, createdAt: new Date().toISOString() }).run();

    res.json(result);
  });

  // ─── Preferences (Phase 4) ──────────────────────────────────────────────
  app.get("/api/preferences", (_req, res) => {
    res.json(getPreferences());
  });

  app.patch("/api/preferences/connectors", (req, res) => {
    res.json(updateConnectorPreferences(req.body ?? {}));
  });

  app.patch("/api/preferences/features", (req, res) => {
    res.json(updateFeaturePreferences(req.body ?? {}));
  });

  // ─── Wearable connectors (Phase 5) ──────────────────────────────────────
  // Not verified against real Garmin/Whoop accounts or a real Apple Health
  // export in this environment — no credentials, and Whoop/Garmin OAuth need
  // a real registered redirect URI. See CLAUDE.md.
  app.get("/api/connectors/whoop/authorize", (_req, res) => {
    try {
      res.json({ url: getWhoopAuthorizationUrl(randomUUID()) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "WHOOP_CLIENT_ID/WHOOP_REDIRECT_URI not configured" });
    }
  });

  app.get("/api/connectors/whoop/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    if (!code) return res.status(400).json({ error: "code is required" });
    try {
      await exchangeWhoopCode(code);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Whoop token exchange failed" });
    }
  });

  app.post("/api/connectors/whoop/sync", async (_req, res) => {
    const existing = db.select().from(trainingSessions).all().map(rowToSession);
    const result = await syncWhoop(existing, insertSession);
    res.json(result);
  });

  app.post("/api/connectors/garmin/connect", async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return res.status(400).json({ error: "email and password are required" });
    try {
      await connectGarmin(email, password);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Garmin login failed" });
    }
  });

  app.post("/api/connectors/garmin/sync", async (_req, res) => {
    const existing = db.select().from(trainingSessions).all().map(rowToSession);
    const result = await syncGarmin(existing, insertSession);
    res.json(result);
  });

  app.post("/api/connectors/apple-health/import", uploadLarge.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file is required (multipart field name: file)" });
    const existing = db.select().from(trainingSessions).all().map(rowToSession);
    const result = importAppleHealthExport(req.file.buffer.toString("utf-8"), existing, insertSession);
    res.json(result);
  });
}
