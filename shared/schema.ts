import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Used by server/db.ts's foreign-database guard — see that file for why it exists. */
export const APP_ID = "trainu";

export const appIdentity = sqliteTable("app_identity", {
  app: text("app").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  /** Discipline — see shared/goal.ts. Defaults per type for rows written before it existed. */
  discipline: text("discipline").notNull().default("other"),
  label: text("label").notNull(),
  targetDate: text("target_date").notNull(),
  priority: integer("priority").notNull(),
  successCriteria: text("success_criteria").notNull(),
  /** GoalTargetMetrics — see shared/goal.ts. */
  targetMetricsJson: text("target_metrics_json").notNull().default("{}"),
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
 * Prescription → adherence. The other half of the moat dataset: outcomeLog
 * records what the app PREDICTED and what happened; this records what it
 * PRESCRIBED and whether it got done. Predictions resolve a few times a year;
 * this resolves several times a week, which is where the signal actually
 * accumulates.
 *
 * Keyed by `${date}#${kind}` (see shared/prescription/sessionKinds.ts) because
 * the plan is derived deterministically and never stored — there's no row id
 * to point at. `prescribedJson` snapshots what was on the card at tick-off
 * time on purpose: the plan re-derives from the athlete's current numbers, so
 * without the snapshot, improving your threshold pace would silently rewrite
 * what last month's sessions "were" and the adherence record would become a
 * record of something that never happened.
 */
export const sessionCompletions = sqliteTable("session_completions", {
  key: text("key").primaryKey(),
  date: text("date").notNull(),
  kind: text("kind").notNull(),
  /** "completed" | "partial" | "skipped" */
  status: text("status").notNull(),
  prescribedJson: text("prescribed_json"),
  rpe: integer("rpe"),
  /**
   * WHY, from a fixed list — see shared/prescription/completion.ts.
   *
   * Free text in `note` is unanalysable: "knee" and "sore knee" and "left
   * knee again" are the same fact three ways and no rule can count them. A
   * structured reason is what lets a skip mean something later — and it is
   * also the honest half of asking someone to tick "skipped": if the app
   * asks why, it owes them something done with the answer.
   */
  reason: text("reason"),
  note: text("note"),
  /** The logged/synced trainingSessions row this was satisfied by, when one matches. */
  sessionId: text("session_id"),
  recordedAt: text("recorded_at").notNull(),
});

/** The onboarding chat's transcript — single-athlete app, so one linear history rather than a per-conversation table. */
export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});

/** One row (id "self"). See shared/preferences.ts for the shapes of connectorsJson/featuresJson. */
export const preferences = sqliteTable("preferences", {
  id: text("id").primaryKey(),
  connectorsJson: text("connectors_json").notNull().default("{}"),
  featuresJson: text("features_json").notNull().default("{}"),
  /** BlockPreferences — the athlete's explicit on/off over the assembler. See shared/preferences.ts. */
  blocksJson: text("blocks_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Garmin has no public OAuth2 API for hobbyist third-party apps — both
 * sibling apps authenticate via the unofficial `garmin-connect` package
 * (email/password through Garmin's own SSO), and store the resulting
 * session tokens exactly like this. Plaintext, matching the sibling apps'
 * own security posture for what's a single-athlete deployment; worth
 * revisiting before this is ever multi-tenant.
 */
export const garminCredentials = sqliteTable("garmin_credentials", {
  id: text("id").primaryKey(), // "self"
  email: text("email"),
  password: text("password"),
  tokenJson: text("token_json"),
  tokenExpiresAt: text("token_expires_at"),
  authError: text("auth_error"),
  updatedAt: text("updated_at").notNull(),
});

/** Whoop has real OAuth2 (authorization-code flow) and rotates the refresh token on every use — see server/connectors/whoop.ts for why that matters. */
export const whoopCredentials = sqliteTable("whoop_credentials", {
  id: text("id").primaryKey(), // "self"
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: text("token_expires_at"),
  authError: text("auth_error"),
  updatedAt: text("updated_at").notNull(),
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

/**
 * Capabilities an athlete's goals asked for that the block library couldn't
 * serve. This is the build queue, written by real goals rather than guessed
 * at — the same idea as outcomeLog, one level up: outcomeLog records where a
 * prediction was wrong, this records where the app was simply absent.
 */
export const capabilityGaps = sqliteTable("capability_gaps", {
  capability: text("capability").primaryKey(),
  /** Goal labels (or the stated-preference marker) that wanted it, JSON array. */
  wantedByJson: text("wanted_by_json").notNull().default("[]"),
  /** The declared-but-unbuilt block covering it, when there is one. */
  plannedBlockId: text("planned_block_id"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  /** How many times assembly has hit this gap — a proxy for how much it matters. */
  seenCount: integer("seen_count").notNull().default(1),
});

/**
 * Injuries and illnesses — see shared/conditions.ts for the shapes and the
 * rules that read them.
 *
 * No goal id: a condition is a fact about the BODY, and a calf strain rules
 * out running whether the goal is a marathon or a wedding. `closed_at` null
 * means still open, and the app never fills it in on its own — it does not
 * know that anyone healed.
 */
export const conditions = sqliteTable("conditions", {
  id: text("id").primaryKey(),
  /** "injury" | "illness" — CONDITION_KINDS. */
  kind: text("kind").notNull(),
  /** The athlete's own words, ≤80 chars: "Left calf strain". */
  label: text("label").notNull(),
  /** A UI hint source for suggested restrictions. The engine never reads it — it acts on `restrictions_json`, which the athlete confirmed. */
  bodyPart: text("body_part"),
  /** 1, 2 or 3. See SEVERITY_LABELS — what it means differs for an injury and an illness. */
  severity: integer("severity").notNull(),
  /** Restriction[] (shared/conditions.ts). `[]` is "nothing ruled out". */
  restrictionsJson: text("restrictions_json").notNull().default("[]"),
  openedAt: text("opened_at").notNull(),
  /** YYYY-MM-DD, or null while open. */
  closedAt: text("closed_at"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * The morning check-in: one row per DATE, so the primary key IS the upsert
 * key — checking in twice corrects the day rather than creating a second
 * opinion about it.
 *
 * `adjustments_json` snapshots what this check-in actually changed, for the
 * same reason `session_completions.prescribed_json` exists: the plan
 * re-derives, so without the snapshot a month-old "moved Thursday's
 * threshold session" becomes unreproducible as soon as the goals change.
 */
export const dailyCheckIns = sqliteTable("daily_check_ins", {
  date: text("date").primaryKey(),
  /** 1 (rough) … 5 (great). */
  sleepQuality: integer("sleep_quality").notNull(),
  /** 1 (none) … 5 (wrecked) — inverted in the readiness formula. */
  soreness: integer("soreness").notNull(),
  /** 1 (flat) … 5 (fired up). */
  energy: integer("energy").notNull(),
  /** Optional. Only ever penalises the score once the athlete's OWN baseline exists — a guessed baseline never moves a number. */
  restingHrBpm: integer("resting_hr_bpm"),
  note: text("note"),
  /** Adjustment[] this check-in produced at write time; "[]" when it wasn't for today. */
  adjustmentsJson: text("adjustments_json").notNull().default("[]"),
  recordedAt: text("recorded_at").notNull(),
});

/**
 * Weigh-ins and measurements over a cut or a gaining phase.
 *
 * Unique per date rather than a free log: bodyweight swings a kilo within a
 * day, so two entries dated the same day are a correction, not two facts.
 * The row keeps its own id so a mistyped entry can be deleted — which
 * matters, because the newest entry is what the plan's calorie targets are
 * sized from, and an un-deletable typo would steer the athlete's eating for
 * weeks.
 */
export const physiqueEntries = sqliteTable(
  "physique_entries",
  {
    id: text("id").primaryKey(),
    /** YYYY-MM-DD. */
    date: text("date").notNull(),
    weightKg: real("weight_kg"),
    bodyFatPercent: real("body_fat_percent"),
    waistCm: real("waist_cm"),
    note: text("note"),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => ({
    dateUnique: uniqueIndex("physique_entries_date_unique").on(table.date),
  }),
);
