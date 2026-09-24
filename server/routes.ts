import type { Express } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import multer from "multer";
import { db } from "./db";
import { athleteMeasurements, chatMessages, outcomeLog, trainingSessions } from "@shared/schema";
import { type AthleteRow, ATHLETE_NUMERIC_BOUNDS, withinBounds } from "@shared/athlete";
import { measured } from "@shared/measured";
import type { Sport, TrainingSession } from "@shared/session";
import { computeTrainingLoad } from "@shared/trainingLoad";
// Date helpers have one home (shared/dates.ts); the week itself is built in
// weekService.ts, so this file no longer does any week arithmetic of its own.
import { addDays, isValidISODate, startOfWeek, todayISO } from "@shared/dates";
import { findDuplicate } from "@shared/sessionDedupe";
import { parseFitBufferSafely, fitResultToSession } from "./fitIngest";
import { predictRunRace, predictTriathlon, TRIATHLON_DISTANCES, type TriathlonDistances } from "@shared/predictors/enduranceRace";
import { predictHyrox } from "@shared/predictors/hyrox";
import { predictBodyComposition } from "@shared/predictors/bodyComposition";
import { predictStrength, type LiftId } from "@shared/predictors/strength";
import { arbitratePlan } from "@shared/arbitration/arbitrate";
import { type PlannedSession, type SessionKind } from "@shared/prescription/sessionKinds";
import { followUpFor, type CompletionReason, type CompletionStatus } from "@shared/prescription/completion";
import { InvalidCompletionError, listCompletions, recordCompletion } from "./completionsService";
import { createGoal, InvalidGoalError, listGoals } from "./goalsService";
import { buildWeek, checkInSummaries } from "./weekService";
import { getAthleteParams, plannableConditions } from "./athleteStateService";
import {
  ConditionNotFoundError,
  InvalidConditionError,
  closeCondition,
  listConditions,
  openCondition,
  patchCondition,
  reopenCondition,
} from "./conditionsService";
import { InvalidCheckInError, getCheckIn, listCheckIns, recordCheckIn } from "./checkInsService";
import { InvalidBenchmarkError, getBenchmarks, patchBenchmarks, type BenchmarkPatch } from "./benchmarksService";
import type { PhysiqueEntryInput } from "@shared/physique";
import {
  InvalidPhysiqueEntryError,
  PhysiqueEntryNotFoundError,
  deletePhysiqueEntry,
  listPhysiqueEntries,
  physiqueProgress,
  physiqueSaveWarning,
  physiqueTrend,
  upsertPhysiqueEntry,
} from "./physiqueService";
import { pacingPlan, pacingDisciplineFor, type PacingBasis } from "@shared/pacing/pacing";
import { isLiveGoal } from "@shared/appShell/assemble";
import { runWhatIf, WhatIfPatchError } from "./whatIfService";
import { assessGoalRisk, RISK_BAND_MULTIPLIER, type GoalRisk } from "@shared/conditions";
import { isBenchmarkId } from "@shared/predictors/hyroxStations";
import { chatOnboarding } from "./onboarding";
import { getPreferences, updateBlockPreferences, updateConnectorPreferences, updateFeaturePreferences } from "./preferencesService";
import { connectGarmin, syncGarmin } from "./connectors/garmin";
import { exchangeWhoopCode, getWhoopAuthorizationUrl, syncWhoop } from "./connectors/whoop";
import { importAppleHealthExport } from "./connectors/appleHealth";
import { getAppShell, listBlockChoices, listGapQueue, recordGaps } from "./appShellService";
import { deploymentProblems } from "./health";
import { getCalibrationMultiplier, getCalibrationReport, OutcomeNotFoundError, recordOutcome } from "./calibrationService";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadLarge = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const ATHLETE_ROW_ID = "self";

function parseDaysPerWeek(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? parseInt(raw, 10) : undefined;
  return n != null && Number.isFinite(n) ? n : undefined;
}

function getAthleteRow(): AthleteRow | null {
  const row = db.select().from(athleteMeasurements).where(eq(athleteMeasurements.id, ATHLETE_ROW_ID)).get();
  return row ? (JSON.parse(row.fieldsJson) as AthleteRow) : null;
}

/*
 * `getAthleteParams` used to live here and read the stored row directly. It
 * is now imported from athleteStateService, which is the ONE read path:
 * stored row → entered benchmarks → newest weigh-in, all folded at read
 * time. A second copy here would mean a weigh-in changed the plan's numbers
 * but not /api/athlete, which is exactly the drift the read-time fold exists
 * to prevent.
 */

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

/** Returns the outcomeLog row's id — the caller needs it back to record the real outcome later via /api/outcomes/:id/record. */
function logPrediction(kind: string, goalId: string | null, prediction: unknown): string {
  const id = randomUUID();
  db.insert(outcomeLog)
    .values({
      id,
      goalId,
      kind,
      predictedAt: new Date().toISOString(),
      predictionJson: JSON.stringify(prediction),
      actualJson: null,
      observedAt: null,
    })
    .run();
  return id;
}

/**
 * What an open injury or illness does to a prediction.
 *
 * It widens the band and NOTHING ELSE — the point estimate is untouched.
 * That is the honest shape of the effect: two weeks of not running does not
 * make a known-slower marathon time, it makes a less knowable one. Folding
 * it into the estimate would be inventing a number; folding it into the
 * confidence is stating what is actually true.
 */
function riskFor(goalId: string | undefined, today: string): { risk: GoalRisk | null; multiplier: number } {
  if (!goalId) return { risk: null, multiplier: 1 };
  const goal = listGoals().find((g) => g.id === goalId);
  if (!goal) return { risk: null, multiplier: 1 };
  const risk = assessGoalRisk(goal, plannableConditions(today), today, today);
  return { risk, multiplier: RISK_BAND_MULTIPLIER[risk.level] };
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

/**
 * The athlete's own calendar day, not the server's.
 *
 * Everything downstream keys off "today": which session the readiness slice
 * may touch, whether a condition is open, whether a date the athlete typed is
 * "in the future". The server runs in UTC, so an athlete far enough east is on
 * tomorrow's date for the whole of their training morning — and every endpoint
 * that validates a submitted date against `todayISO()` refuses them. An
 * athlete in Auckland could not report an injury, mark one healed, log a
 * weigh-in or record a station time between midnight and 1pm local, and was
 * told they were dating it in the future while looking at today's date on
 * their own phone.
 *
 * So the client sends its own day and the server believes it, but only within
 * a day either side of UTC. That covers every real timezone (UTC-12 to UTC+14)
 * while keeping the window small enough that a bad or stale value cannot make
 * the app time-travel into a different training week. Exported so there is one
 * such rule rather than one per endpoint.
 */
export function clientToday(req: { query: Record<string, unknown> }): string {
  const utc = todayISO();
  const claimed = typeof req.query.today === "string" ? req.query.today : undefined;
  if (!claimed || !isValidISODate(claimed)) return utc;
  return claimed >= addDays(utc, -1) && claimed <= addDays(utc, 1) ? claimed : utc;
}

export async function registerRoutes(_httpServer: Server, app: Express) {
  // Public — see auth.ts PUBLIC_API. Railway calls this, with no cookie,
  // before routing traffic to a new deployment; health.ts says what it checks.
  app.get("/api/health", (_req, res) => {
    const problems = deploymentProblems();
    if (problems.length) return res.status(503).json({ ok: false, problems });
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

  /*
   * Every scalar on the athlete row, with three keys that do not belong here
   * and used to be accepted silently:
   *
   *  - an unknown key wrote a top-level field `athleteParamsFromRow` ignores,
   *    so the request returned 200 and changed nothing;
   *  - a HYROX station id looked like a number and went to the same nowhere,
   *    while a real entry endpoint existed;
   *  - weight and body fat are now READ through the physique fold, so writing
   *    them here would be overwritten on read by the newest weigh-in — a
   *    typed value that silently does nothing.
   *
   * The first two are refused with the endpoint that does work; the last is
   * routed to the one write path for weight, so the Athlete page's field
   * keeps working and there is still only ONE writer.
   */
  app.patch("/api/athlete", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "body must be an object of field -> number" });
    }
    const row = getAthleteRow() ?? {};
    const now = new Date().toISOString();
    const physique: Record<string, number> = {};

    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return res.status(400).json({ error: `${key} must be a number` });
      }
      if (isBenchmarkId(key)) {
        return res.status(400).json({ error: `${key} is a timed benchmark — send it to PATCH /api/athlete/benchmarks, which knows its bounds and its format` });
      }
      if (!(key in ATHLETE_NUMERIC_BOUNDS)) {
        return res.status(400).json({ error: `${key} is not something this app measures` });
      }
      if (!withinBounds(key, value)) {
        return res.status(400).json({ error: `${key}=${value} is out of plausible bounds` });
      }
      if (key === "weightKg" || key === "bodyFatPercent") {
        physique[key] = value;
        continue;
      }
      (row as any)[key] = measured(value, "manually entered", now);
    }

    /*
     * Weight and body fat are weigh-ins, so they go where every weigh-in
     * goes — and they now get the same typo confirmation the Physique panel
     * has. `physiqueSaveWarning` was computed on `POST /api/physique` and
     * nowhere else, so the identical value typed into the Athlete page's
     * Weight field was stored in silence: `weightKg` bounds are [35, 200], a
     * fat-fingered 82 for 72 passes them, and Katch-McArdle then moves every
     * day's target by ~300 kcal and resizes a cut. Same value, same table, two
     * levels of protection depending on which screen it was typed into.
     */
    let warning: string | null = null;
    if (Object.keys(physique).length > 0) {
      const date = clientToday(req);
      try {
        warning = physiqueSaveWarning({ date, ...physique });
        upsertPhysiqueEntry({ date, ...physique }, { today: date });
      } catch (e) {
        if (e instanceof InvalidPhysiqueEntryError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    saveAthleteRow(row);
    res.json({ ...getAthleteParams(), ...(warning ? { warning } : {}) });
  });

  /*
   * HYROX station benchmarks: eight stations in race order, then the roxzone.
   * Declared `planned` through Phase 8 because nothing entered them — the
   * predictor could read them and no screen could write them.
   */
  app.get("/api/athlete/benchmarks", (req, res) => {
    // `today` matters on a read here: it is what decides whether a stored
    // effort still reads as current or asks for a retest.
    res.json(getBenchmarks({ today: clientToday(req) }));
  });

  app.patch("/api/athlete/benchmarks", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "body must be an object of benchmark -> seconds, {seconds,date,note}, or null to clear it" });
    }
    try {
      res.json(patchBenchmarks(body as BenchmarkPatch, { today: clientToday(req) }));
    } catch (e) {
      if (e instanceof InvalidBenchmarkError) return res.status(400).json({ error: e.message });
      throw e;
    }
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
    const { risk, multiplier } = riskFor(goalId, todayISO());
    const prediction = predictRunRace(getAthleteParams(), distanceKm, goalMinutes, getCalibrationMultiplier() * multiplier);
    const outcomeId = logPrediction("prediction:run", goalId ?? null, prediction);
    res.json({ ...prediction, outcomeId, risk });
  });

  app.post("/api/predict/triathlon", (req, res) => {
    const { distance, goalMinutes, goalId } = req.body as { distance: keyof typeof TRIATHLON_DISTANCES | TriathlonDistances; goalMinutes?: number; goalId?: string };
    const distances = typeof distance === "string" ? TRIATHLON_DISTANCES[distance] : distance;
    if (!distances) return res.status(400).json({ error: "distance must be sprint|olympic|70.3|full or {swimKm,bikeKm,runKm}" });
    const { risk, multiplier } = riskFor(goalId, todayISO());
    const prediction = predictTriathlon(getAthleteParams(), distances, goalMinutes, getCalibrationMultiplier() * multiplier);
    const outcomeId = logPrediction("prediction:triathlon", goalId ?? null, prediction);
    res.json({ ...prediction, outcomeId, risk });
  });

  app.post("/api/predict/hyrox", (req, res) => {
    const { goalSeconds, goalId } = req.body as { goalSeconds: number; goalId?: string };
    if (typeof goalSeconds !== "number" || goalSeconds <= 0) return res.status(400).json({ error: "goalSeconds is required" });
    const { risk, multiplier } = riskFor(goalId, todayISO());
    // No roxzone override: the athlete's entered benchmark now reaches the
    // predictor through getAthleteParams(), and an override would beat it.
    const prediction = predictHyrox(getAthleteParams(), goalSeconds, undefined, getCalibrationMultiplier() * multiplier);
    const outcomeId = logPrediction("prediction:hyrox", goalId ?? null, prediction);
    res.json({ ...prediction, outcomeId, risk });
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
    const today = clientToday(req);
    const requestedFrom = typeof req.query.from === "string" ? req.query.from : today;
    if (!isValidISODate(requestedFrom)) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
    /*
     * Monday-anchored, like every other week in the app.
     *
     * `arbitratePlan` steps in 7-day increments from whatever it is given, so
     * a Thursday `from` produced a Thursday grid: the Plan page then showed
     * Monday-anchored day cards from `/api/plan/week` and, a few hundred
     * pixels below, a conflict card dated Thursday-to-Thursday spanning two
     * of them — dates matching no week on the screen, and a taper boundary a
     * week away from the one the week route reported. `whatIfService` already
     * normalises at its own call site with the comment "weeks must line up
     * with /api/plan/week or 'the week of the 7th' means two different weeks
     * on two screens"; this route was the one place still missing it.
     *
     * Normalised AFTER validation so garbage still 400s, and before `to` is
     * derived, since that default seeds from `from`.
     */
    const from = startOfWeek(requestedFrom);
    const activeGoals = listGoals().filter((g) => g.active);
    const defaultTo = activeGoals.length
      ? activeGoals.reduce((latest, g) => (g.targetDate > latest ? g.targetDate : latest), from)
      : from;
    const to = typeof req.query.to === "string" ? req.query.to : defaultTo;
    if (!isValidISODate(to)) return res.status(400).json({ error: "to must be YYYY-MM-DD" });
    if (activeGoals.length === 0) {
      return res.json({ fromDate: from, toDate: to, weeks: [], conflicts: [] });
    }
    // Same condition list and same `today` the week route uses, so a cut
    // paused by an open injury reads the same on both screens.
    const plan = arbitratePlan(activeGoals, from, to, getAthleteParams(), plannableConditions(today), today);
    logPrediction("plan:arbitration", null, plan);
    res.json(plan);
  });

  // ─── The week: what to actually do, and what to eat ─────────────────────
  // One call, because this is the screen an athlete opens every morning:
  // the arbitrated week, the sessions it resolves to, each day's macro
  // targets, and which sessions have already been ticked off.
  /*
   * The assembled app: which surfaces and blocks this athlete gets, what the
   * app can do for them, and — the part that matters — what their goals asked
   * for that isn't built. The client renders off this rather than off a
   * hardcoded nav, so an athlete's goals decide their app.
   */
  app.get("/api/app-shell", (req, res) => {
    const requested = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested) || Number.isNaN(Date.parse(`${requested}T00:00:00Z`))) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    const app_ = getAppShell(requested);
    recordGaps(app_);
    res.json(app_);
  });

  /** Every block, what the assembler decided, and what the athlete chose instead. */
  app.get("/api/app-shell/blocks", (_req, res) => {
    res.json({ blocks: listBlockChoices() });
  });

  app.patch("/api/preferences/blocks", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "body must be an object of blockId -> \"on\" | \"off\" | null" });
    }
    const known = new Set(listBlockChoices().map((b) => b.id));
    const patch: Record<string, "on" | "off" | null> = {};
    for (const [blockId, choice] of Object.entries(body)) {
      if (!known.has(blockId)) return res.status(400).json({ error: `unknown block: ${blockId}` });
      if (choice !== "on" && choice !== "off" && choice !== null) {
        return res.status(400).json({ error: `choice for ${blockId} must be "on", "off" or null` });
      }
      patch[blockId] = choice;
    }
    res.json(updateBlockPreferences(patch));
  });

  /** The build queue, accumulated across every assembly. Ours to read, not the athlete's. */
  app.get("/api/app-shell/gaps", (_req, res) => {
    res.json({ gaps: listGapQueue() });
  });

  /*
   * The week is built in weekService.ts, not here: the check-in endpoint has
   * to answer "what did that change?" and the only honest answer is the one
   * the week itself produces, so both go through one builder.
   */
  app.get("/api/plan/week", (req, res) => {
    const today = clientToday(req);
    const requested = typeof req.query.date === "string" ? req.query.date : today;
    if (!isValidISODate(requested)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    res.json(buildWeek({ date: requested, today, daysPerWeek: parseDaysPerWeek(req.query.daysPerWeek) }));
  });

  /*
   * Tick a session off — and, since Phase 10, say how it went and why it did
   * not happen.
   *
   * `rpe`, `reason` and `note` are passed through EXACTLY as the body sent
   * them, never `?? null`. `recordCompletion` patches: `undefined` keeps what
   * is stored, `null` clears it, a value sets it. Coercing absent to null
   * here would mean the second tap of a two-tap flow — status first, then
   * "because I was injured" — wiped the RPE the first tap recorded.
   *
   * A date+kind that is NOT in the current adjusted week is accepted on
   * purpose (DECISIONS B7): it is how "actually, I did this" records a
   * session the modulation layer dropped for a fever or a restriction. The
   * layer then protects it — an answered session is immune to every
   * modulator, so it cannot be dropped again next time the week re-derives.
   */
  app.post("/api/sessions/complete", (req, res) => {
    const body = (req.body ?? {}) as {
      date?: string;
      kind?: SessionKind;
      status?: CompletionStatus;
      rpe?: number | null;
      reason?: CompletionReason | null;
      note?: string | null;
      sessionId?: string | null;
      prescribed?: PlannedSession | null;
    };
    try {
      const record = recordCompletion({
        date: String(body.date ?? ""),
        kind: body.kind as SessionKind,
        status: body.status as CompletionStatus,
        rpe: body.rpe,
        reason: body.reason,
        note: body.note,
        sessionId: body.sessionId,
        prescribed: body.prescribed ?? null,
      });
      // An injury or illness tick is the clearest statement of need the app
      // gets. `followUp` is the offer to open a condition from it, prefilled.
      res.json({ ...record, followUp: followUpFor(record) });
    } catch (e) {
      if (e instanceof InvalidCompletionError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.get("/api/completions", (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    res.json(listCompletions(from, to));
  });

  // ─── Injuries & illness (Phase 10) ──────────────────────────────────────
  /*
   * The athlete's whole history, healed or not — which is NOT the engine's
   * window.
   *
   * This used to apply `CONDITION_HISTORY_DAYS`, a 60-day bound whose entire
   * justification is engine-scoped: nothing healed longer ago can still be
   * inside a return-to-training ramp. Correct for a plan, wrong for a record.
   * The Athlete page's "Injuries & illness" panel is this endpoint's only
   * reader, and a hamstring strain that healed in April simply vanished from
   * it — with no count and no "older entries hidden", so an athlete with
   * nothing recent read "Nothing logged", an affirmatively false statement
   * about their own history. A recurrence could not be reopened either, only
   * logged again as a new, unlinked condition.
   *
   * One window, two purposes, two different correct answers. The engine keeps
   * its window in `plannableConditions`; the record is the record.
   */
  app.get("/api/conditions", (_req, res) => {
    res.json(listConditions());
  });

  app.post("/api/conditions", (req, res) => {
    try {
      res.status(201).json(openCondition(req.body ?? {}, { today: clientToday(req) }));
    } catch (e) {
      if (e instanceof InvalidConditionError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.patch("/api/conditions/:id", (req, res) => {
    try {
      res.json(patchCondition(req.params.id, req.body ?? {}, clientToday(req)));
    } catch (e) {
      if (e instanceof ConditionNotFoundError) return res.status(404).json({ error: "no such injury or illness on record" });
      if (e instanceof InvalidConditionError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  /*
   * Mark it healed — or, with `closedAt: null`, un-heal it. The app never
   * closes a condition on its own (it does not know that anyone healed), and
   * an athlete who ticked healed too early needs the way back.
   */
  app.post("/api/conditions/:id/close", (req, res) => {
    const body = (req.body ?? {}) as { closedAt?: string | null };
    try {
      const today = clientToday(req);
      if (body.closedAt === null) return res.json(reopenCondition(req.params.id, today));
      if (body.closedAt !== undefined && typeof body.closedAt !== "string") {
        return res.status(400).json({ error: "closedAt must be a date in YYYY-MM-DD form, or null to reopen it" });
      }
      res.json(closeCondition(req.params.id, body.closedAt, today));
    } catch (e) {
      if (e instanceof ConditionNotFoundError) return res.status(404).json({ error: "no such injury or illness on record" });
      if (e instanceof InvalidConditionError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  // ─── Morning check-in (Phase 10) ────────────────────────────────────────
  /*
   * Three taps, and an answer to "what did that change?".
   *
   * The answer is produced by rebuilding the week, not by a second copy of
   * the readiness rules: `buildWeek` runs the same pipeline the Plan page
   * reads, and the changes attributable to this morning are the adjustments
   * it produced with a check-in source. That also means the card cannot ever
   * claim a change the plan does not show.
   *
   * `restingHrBpm`, `note` and `trainAnywayOverride` pass through as-is —
   * they patch, and `?? null` would clear a stored resting HR every time the
   * athlete tapped the override.
   */
  app.post("/api/check-ins", (req, res) => {
    const body = (req.body ?? {}) as {
      date?: string;
      sleepQuality?: number;
      soreness?: number;
      energy?: number;
      restingHrBpm?: number | null;
      note?: string | null;
      trainAnywayOverride?: boolean;
    };
    try {
      const today = clientToday(req);
      const { checkIn, readiness } = recordCheckIn({
        date: body.date ?? today,
        sleepQuality: body.sleepQuality as number,
        soreness: body.soreness as number,
        energy: body.energy as number,
        restingHrBpm: body.restingHrBpm,
        note: body.note,
        trainAnywayOverride: body.trainAnywayOverride,
      });
      // Only this morning's check-in can change a week; an edited check-in
      // from last Tuesday is a record, not an instruction.
      // Scoped to today: the week replays every morning it contains, so an
      // unbounded read would answer "what did THIS check-in change?" with
      // Tuesday's rest day as well.
      const adjustments = checkIn.date === today ? checkInSummaries(buildWeek({ today }).adjustments, today) : [];
      res.json({ checkIn: getCheckIn(checkIn.date) ?? checkIn, readiness, adjustments });
    } catch (e) {
      if (e instanceof InvalidCheckInError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.get("/api/check-ins", (req, res) => {
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    if (date !== undefined) {
      if (!isValidISODate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return res.json(getCheckIn(date));
    }
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if ((from !== undefined && !isValidISODate(from)) || (to !== undefined && !isValidISODate(to))) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    }
    res.json(listCheckIns(from, to));
  });

  // ─── Physique (Phase 10) ────────────────────────────────────────────────
  // Entries fold into the athlete's numbers at READ time, so deleting or
  // back-dating one simply works — see physiqueService's header.
  app.get("/api/physique", (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if ((from !== undefined && !isValidISODate(from)) || (to !== undefined && !isValidISODate(to))) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    }
    res.json({ entries: listPhysiqueEntries(from, to), trend: physiqueTrend({ days: 90 }) });
  });

  app.post("/api/physique", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "a weigh-in has to be an object with a date and at least one measurement" });
    }
    try {
      // The warning is computed BEFORE the write, against the previous entry —
      // a 4 kg jump is usually a typo, and the athlete gets to look at it.
      // Only once the date is at least shaped like a date; otherwise the
      // validator inside the write is the one that should do the talking.
      const input = body as PhysiqueEntryInput;
      const warning = isValidISODate(input.date) ? physiqueSaveWarning(input) : null;
      res.status(201).json({ entry: upsertPhysiqueEntry(input, { today: clientToday(req) }), warning });
    } catch (e) {
      if (e instanceof InvalidPhysiqueEntryError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.delete("/api/physique/:date", (req, res) => {
    if (!isValidISODate(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    try {
      res.json(deletePhysiqueEntry(req.params.date));
    } catch (e) {
      if (e instanceof PhysiqueEntryNotFoundError) return res.status(404).json({ error: "no weigh-in recorded on that date" });
      throw e;
    }
  });

  app.get("/api/physique/progress", (req, res) => {
    const goalId = typeof req.query.goalId === "string" ? req.query.goalId : null;
    if (!goalId) return res.status(400).json({ error: "goalId is required" });
    const goal = listGoals().find((g) => g.id === goalId);
    if (!goal) return res.status(404).json({ error: "no such goal" });
    if (goal.type !== "body_composition") {
      return res.status(400).json({ error: "progress against a weigh-in only means something for a body-composition goal" });
    }
    res.json(physiqueProgress(goal, getAthleteParams()));
  });

  // ─── Race-day pacing (Phase 10) ─────────────────────────────────────────
  /*
   * Read-only, and that is load-bearing: opening a pacing plan is not a
   * prediction, so nothing is written to outcome_log. A page-load that
   * logged a prediction would fill the calibration dataset with rows that
   * can never resolve.
   *
   * `targetSecondsOverride` is the "what if I went for 3:15" control. It is
   * ephemeral by construction — it never reaches the goal.
   */
  app.get("/api/pacing", (req, res) => {
    const today = clientToday(req);
    /*
     * `isLiveGoal`, not a hand-rolled `g.active`: nothing in this app can set
     * a goal inactive, so a race stays active forever and this route kept
     * serving a full pacing plan — splits, finish band and all — for a
     * marathon run in May, sitting above the plan for the race the athlete is
     * actually training for with nothing to tell them apart. Arbitration has
     * filtered `phaseName !== "past"` since Phase 3 and `assessGoalRisk` says
     * in its own doc that it is never called for a past goal; pacing simply
     * never got the rule. The helper's boundary is `targetDate >= today`, not
     * `>`: race day itself is the one day the plan is most needed.
     */
    const goals = listGoals().filter((g) => isLiveGoal(g, today) && pacingDisciplineFor(g) !== null);
    res.json(goals.map((g) => pacingPlan(g, getAthleteParams(), getCalibrationMultiplier(), { today })));
  });

  app.get("/api/pacing/:goalId", (req, res) => {
    const goal = listGoals().find((g) => g.id === req.params.goalId);
    if (!goal) return res.status(404).json({ error: "no such goal" });

    const rawBasis = req.query.basis;
    if (rawBasis !== undefined && rawBasis !== "target" && rawBasis !== "predicted") {
      return res.status(400).json({ error: "basis must be target or predicted" });
    }
    const rawOverride = req.query.targetSeconds;
    let targetSecondsOverride: number | null = null;
    if (rawOverride !== undefined) {
      const n = typeof rawOverride === "string" ? Number(rawOverride) : NaN;
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "targetSeconds must be a positive number of seconds" });
      targetSecondsOverride = n;
    }

    res.json(
      pacingPlan(goal, getAthleteParams(), getCalibrationMultiplier(), {
        today: todayISO(),
        basis: rawBasis as PacingBasis | undefined,
        targetSecondsOverride,
      }),
    );
  });

  // ─── What if I changed a goal? (Phase 10) ───────────────────────────────
  // Persists nothing — not the goal, and deliberately not an outcome_log row.
  app.post("/api/plan/what-if", (req, res) => {
    try {
      res.json(runWhatIf(req.body));
    } catch (e) {
      if (e instanceof WhatIfPatchError) return res.status(400).json({ error: e.message });
      if (e instanceof InvalidGoalError) return res.status(400).json({ error: e.message });
      throw e;
    }
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
      // Not configured is a deliberate refusal about this deployment, not a
      // fault in it — 503, never the 500 an actual crash produces.
      res.status(503).json({ error: `Whoop is not configured on this server: ${e?.message ?? "WHOOP_CLIENT_ID/WHOOP_REDIRECT_URI missing"}` });
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

  // ─── Outcome recording & calibration (Phase 6) ──────────────────────────
  // Every /api/predict/* call above already logged its prediction (see
  // logPrediction). This is where the loop closes: once the real outcome is
  // known — the race happened, the wedding came and went — record it here,
  // and predict/run|triathlon|hyrox start reading getCalibrationMultiplier()
  // on every future call.
  app.post("/api/outcomes/:id/record", (req, res) => {
    const { achieved, ...rest } = req.body as { achieved?: boolean; [k: string]: unknown };
    if (typeof achieved !== "boolean") return res.status(400).json({ error: "achieved (boolean) is required in the body" });
    try {
      recordOutcome(req.params.id, { achieved, ...rest });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof OutcomeNotFoundError) return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  app.get("/api/calibration/report", (_req, res) => {
    res.json(getCalibrationReport());
  });
}
