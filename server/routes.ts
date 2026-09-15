import type { Express } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import multer from "multer";
import { db } from "./db";
import { athleteMeasurements, goals, outcomeLog, trainingSessions } from "@shared/schema";
import type { Goal } from "@shared/goal";
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

function rowToGoal(row: typeof goals.$inferSelect): Goal {
  return {
    id: row.id,
    type: row.type as Goal["type"],
    label: row.label,
    targetDate: row.targetDate,
    priority: row.priority,
    successCriteria: row.successCriteria,
    constraints: JSON.parse(row.constraintsJson),
    active: row.active,
    createdAt: row.createdAt,
  };
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
    res.json(db.select().from(goals).all().map(rowToGoal));
  });

  app.post("/api/goals", (req, res) => {
    const body = req.body as Partial<Goal>;
    if (!body.type || !body.label || !body.targetDate || !body.successCriteria) {
      return res.status(400).json({ error: "type, label, targetDate, successCriteria are required" });
    }
    const goal: Goal = {
      id: randomUUID(),
      type: body.type,
      label: body.label,
      targetDate: body.targetDate,
      priority: body.priority ?? 1,
      successCriteria: body.successCriteria,
      constraints: body.constraints ?? [],
      createdAt: new Date().toISOString(),
      active: true,
    };
    db.insert(goals)
      .values({
        id: goal.id,
        type: goal.type,
        label: goal.label,
        targetDate: goal.targetDate,
        priority: goal.priority,
        successCriteria: goal.successCriteria,
        constraintsJson: JSON.stringify(goal.constraints),
        active: goal.active,
        createdAt: goal.createdAt,
      })
      .run();
    res.status(201).json(goal);
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
}
