import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/** Used by server/db.ts's foreign-database guard — see that file for why it exists. */
export const APP_ID = "trainu";

export const appIdentity = sqliteTable("app_identity", {
  app: text("app").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  label: text("label").notNull(),
  targetDate: text("target_date").notNull(),
  priority: integer("priority").notNull(),
  successCriteria: text("success_criteria").notNull(),
  /** GoalConstraint[] — see shared/goal.ts. */
  constraintsJson: text("constraints_json").notNull().default("[]"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

/**
 * One row per athlete. `fieldsJson` is Record<string, Measured<number | string>>
 * (see shared/measured.ts) rather than one column per field — deliberate for
 * v0: the sibling apps' flat-column approach is exactly what let 7 of 8
 * physiological fields default silently with no confidence tracking at all.
 * Revisit as flat+typed columns once specific fields need indexed queries.
 */
export const athleteMeasurements = sqliteTable("athlete_measurements", {
  id: text("id").primaryKey(),
  fieldsJson: text("fields_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One physical activity per row — see shared/session.ts for the shape this
 * mirrors. `externalId` plus (source, date) is the idempotency key sync
 * jobs check before inserting, so a re-poll of the same Garmin activity
 * doesn't need shared/sessionDedupe.ts's fuzzy matching at all; that fuzzy
 * matching exists for the case dedupe can't sidestep — the SAME activity
 * arriving from two DIFFERENT sources (Garmin's recording and Whoop's
 * auto-detect of the same run).
 */
export const trainingSessions = sqliteTable("training_sessions", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  sport: text("sport").notNull(),
  source: text("source").notNull(),
  startTime: text("start_time"),
  durationMinutes: integer("duration_minutes").notNull(),
  distanceKm: real("distance_km"),
  avgHeartRate: integer("avg_heart_rate"),
  maxHeartRate: integer("max_heart_rate"),
  avgPaceSecPerKm: integer("avg_pace_sec_per_km"),
  avgPaceSecPer100m: integer("avg_pace_sec_per_100m"),
  avgPowerWatts: integer("avg_power_watts"),
  normalizedPower: integer("normalized_power"),
  tss: real("tss"),
  hrZonesJson: text("hr_zones_json"),
  rpe: text("rpe"),
  externalId: text("external_id"),
});

/**
 * The outcome-data log: every prediction or plan decision the app makes,
 * paired with what actually happened once it's known. This is the asset the
 * whole "moat" conversation was about — it only compounds if it's written
 * from day one, not bolted on once there's enough traffic to seem worth it.
 */
export const outcomeLog = sqliteTable("outcome_log", {
  id: text("id").primaryKey(),
  goalId: text("goal_id"),
  /** "prediction" | "plan_prescription" | "adaptation_decision" */
  kind: text("kind").notNull(),
  predictedAt: text("predicted_at").notNull(),
  /** What was predicted/prescribed, plus which Measured<> inputs (and their confidence) drove it. */
  predictionJson: text("prediction_json").notNull(),
  /** Filled in once the real outcome is known — null until then. */
  actualJson: text("actual_json"),
  observedAt: text("observed_at"),
});
