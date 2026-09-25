import type { QueryClient } from "@tanstack/react-query";
import type { AthleteParams } from "@shared/athlete";
import type { Goal, GoalType, Discipline } from "@shared/goal";
import type { TrainingSession } from "@shared/session";
import type { TrainingLoadSummary } from "@shared/trainingLoad";
import type { ArbitratedPlan } from "@shared/arbitration/arbitrate";
import type { PlannedSession, SessionKind } from "@shared/prescription/sessionKinds";
import type { CalibrationReport } from "@shared/calibrationReport";
import type { ConnectorPreferences, FeaturePreferences } from "@shared/preferences";
import type { AssembledApp } from "@shared/appShell/assemble";
import type { SurveyAnswers } from "@shared/onboarding/survey";
import type { BuildState, ResetResult } from "../../../server/surveyService";
import type { InterpretResult } from "../../../server/surveyInterpret";

/*
 * The types the pages render come from the modules that DECLARE them —
 * re-exported here so a page imports one thing, never re-typed here.
 *
 * Until Phase 10 this file carried a hand-copied `CompletionStatus` union and
 * a hand-copied `SessionCompletion` interface. That is precisely the drift
 * `shared/prescription/completion.ts` exists to end: the copy could not know
 * about `reason`, so a status the server accepted was a status the client
 * could not name. One declaration, imported by both halves.
 */
export type {
  CompletionStatus,
  CompletionReason,
  CompletionFeedback,
  CompletionFollowUp,
} from "@shared/prescription/completion";
export type { Condition, ConditionKind, Severity, Restriction, BodyPart, GoalRisk } from "@shared/conditions";
export type { CheckIn, Readiness, ReadinessBand } from "@shared/readiness";
export type { Adjustment, AdjustedSession } from "@shared/prescription/adjust";
export type { PhysiqueEntry, PhysiqueEntryInput, MetricTrend, PhysiqueMetric, PhysiqueProgress } from "@shared/physique";
export type { PacingResult, PacingPlan, PacingUnavailable } from "@shared/pacing/pacing";
export type { GoalPatch, WhatIfResult } from "@shared/arbitration/whatIf";
export type { AssembledApp };
export type { SurveyAnswers, SurveyGoalAnswer, RecentEffort } from "@shared/onboarding/survey";

import type { CompletionStatus, CompletionReason, CompletionFeedback, CompletionFollowUp } from "@shared/prescription/completion";
import type { Condition, ConditionInput, ConditionPatch } from "@shared/conditions";
import type { PhysiqueEntry, PhysiqueEntryInput, MetricTrend, PhysiqueMetric, PhysiqueProgress } from "@shared/physique";
import type { PacingResult } from "@shared/pacing/pacing";
import type { GoalPatch, WhatIfResult } from "@shared/arbitration/whatIf";
import type { BenchmarkView, BenchmarkPatch } from "../../../server/benchmarksService";
import type { CheckInRecord } from "../../../server/checkInsService";
import type { WeekView, WeekSession } from "../../../server/weekService";

export interface BlockChoiceRow {
  id: string;
  title: string;
  surface: string;
  note?: string;
  status: "built" | "planned";
  choice: "on" | "off" | null;
  active: boolean;
  overridden: boolean;
}

/** The week as `GET /api/plan/week` returns it — the server's own type, not a second copy of it. */
export type { BuildState, ResetResult, InterpretResult };
export type PlanWeek = WeekView;
export type PlanDay = WeekView["days"][number];
export type PlanSession = WeekSession;
export type { BenchmarkView, BenchmarkPatch, CheckInRecord };

/** The server serves this client (see server/vite.ts), so /api is same-origin — no base URL, no proxy. */
/** Thrown on a 401 so the shell can show the login screen instead of an error per panel. */
export class UnauthorizedError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body?.error ?? body?.message ?? `${res.status} ${res.statusText}`;
    if (res.status === 401) throw new UnauthorizedError(message);
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") q.set(key, String(value));
  return q.toString() ? `?${q}` : "";
}

export const api = {
  goals: () => request<Goal[]>("/api/goals"),
  createGoal: (goal: {
    type: GoalType;
    discipline?: Discipline;
    label: string;
    targetDate: string;
    priority: number;
    successCriteria: string;
    targetMetrics?: Record<string, unknown>;
  }) => request<Goal>("/api/goals", { method: "POST", body: JSON.stringify(goal) }),
  deleteGoal: (id: string) => request<void>(`/api/goals/${encodeURIComponent(id)}`, { method: "DELETE" }),

  athlete: () => request<AthleteParams>("/api/athlete"),
  patchAthlete: (fields: Record<string, number>) => request<AthleteParams>("/api/athlete", { method: "PATCH", body: JSON.stringify(fields) }),

  /** Eight HYROX stations in race order, then the roxzone. Each row carries its own bounds, hint and provenance. */
  benchmarks: () => request<BenchmarkView[]>("/api/athlete/benchmarks"),
  patchBenchmarks: (patch: BenchmarkPatch) =>
    request<BenchmarkView[]>("/api/athlete/benchmarks", { method: "PATCH", body: JSON.stringify(patch) }),

  sessions: () => request<TrainingSession[]>("/api/sessions"),
  trainingLoad: () => request<TrainingLoadSummary>("/api/training-load"),

  plan: (from?: string, to?: string) => request<ArbitratedPlan>(`/api/plan/arbitrate${query({ from, to })}`),

  // `today` is the athlete's local day — see todayStr. Without it the server
  // answers in UTC and the morning check-in modulates a day that has not
  // started yet, or one that already ended.
  week: (date?: string, daysPerWeek?: number) =>
    request<PlanWeek>(`/api/plan/week${query({ date, daysPerWeek, today: todayStr() })}`),

  /*
   * Send ONLY the field being changed. `recordCompletion` patches, so an
   * absent `rpe` keeps the stored one and an explicit `null` clears it —
   * which is what lets "Done", then "how hard was it", then "actually it was
   * partial" be three taps rather than three complete re-submissions.
   *
   * `prescribed` goes on the FIRST tap: it snapshots what the session was, so
   * improving your threshold pace in March cannot rewrite what February's
   * sessions "were", and it is what prices `adherence.actualTss`.
   */
  completeSession: (body: {
    date: string;
    kind: SessionKind;
    status: CompletionStatus;
    rpe?: number | null;
    reason?: CompletionReason | null;
    note?: string | null;
    prescribed?: PlannedSession | null;
  }) => request<CompletionFeedback & { followUp: CompletionFollowUp | null }>("/api/sessions/complete", { method: "POST", body: JSON.stringify(body) }),

  completions: (from?: string, to?: string) => request<CompletionFeedback[]>(`/api/completions${query({ from, to })}`),

  // ─── Injuries & illness ───────────────────────────────────────────────
  conditions: () => request<Condition[]>("/api/conditions"),
  openCondition: (body: ConditionInput) => request<Condition>("/api/conditions", { method: "POST", body: JSON.stringify(body) }),
  patchCondition: (id: string, patch: ConditionPatch) =>
    request<Condition>(`/api/conditions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** `closedAt: null` reopens — the app never closes a condition on its own, and an early tick needs a way back. */
  closeCondition: (id: string, closedAt: string | null) =>
    request<Condition>(`/api/conditions/${encodeURIComponent(id)}/close`, { method: "POST", body: JSON.stringify({ closedAt }) }),

  // ─── Morning check-in ─────────────────────────────────────────────────
  checkIn: (date: string) => request<CheckInRecord | null>(`/api/check-ins${query({ date })}`),
  recordCheckIn: (body: {
    date?: string;
    sleepQuality: number;
    soreness: number;
    energy: number;
    restingHrBpm?: number | null;
    note?: string | null;
    trainAnywayOverride?: boolean;
  }) =>
    // The athlete's own day travels as a query param too, so the server
    // reports what the check-in changed against the same day it recorded
    // against — otherwise a correct check-in can come back "nothing changed".
    request<{ checkIn: CheckInRecord; readiness: import("@shared/readiness").Readiness; adjustments: CheckInRecord["adjustments"] }>(
      `/api/check-ins${query({ today: todayStr() })}`,
      { method: "POST", body: JSON.stringify({ date: todayStr(), ...body }) },
    ),

  // ─── Physique ─────────────────────────────────────────────────────────
  physique: (from?: string, to?: string) =>
    request<{ entries: PhysiqueEntry[]; trend: Record<PhysiqueMetric, MetricTrend | null> }>(`/api/physique${query({ from, to })}`),
  savePhysique: (body: PhysiqueEntryInput) =>
    request<{ entry: PhysiqueEntry; warning: string | null }>("/api/physique", { method: "POST", body: JSON.stringify(body) }),
  deletePhysique: (date: string) => request<PhysiqueEntry>(`/api/physique/${date}`, { method: "DELETE" }),
  physiqueProgress: (goalId: string) => request<PhysiqueProgress>(`/api/physique/progress${query({ goalId })}`),

  // ─── Race-day pacing ──────────────────────────────────────────────────
  // Read-only by construction: opening a pacing plan is not a prediction, so
  // nothing is written and no outcome_log row is created by looking at it.
  pacing: () => request<PacingResult[]>("/api/pacing"),
  pacingFor: (goalId: string, options: { basis?: "target" | "predicted"; targetSeconds?: number } = {}) =>
    request<PacingResult>(`/api/pacing/${encodeURIComponent(goalId)}${query({ basis: options.basis, targetSeconds: options.targetSeconds })}`),

  // ─── What if I changed a goal? ────────────────────────────────────────
  whatIf: (body: { patch: GoalPatch; fromDate?: string; toDate?: string }) =>
    request<WhatIfResult>("/api/plan/what-if", { method: "POST", body: JSON.stringify(body) }),

  /** The switch the whole app routes on: no build state, no app — you get the survey. See server/surveyService.ts. */
  buildState: () => request<BuildState>("/api/onboarding/state"),
  // `today` goes in the query string because that is where clientToday() reads
  // it — one rule for the client's own calendar day, not one per endpoint.
  submitSurvey: (answers: SurveyAnswers) =>
    request<BuildState>(`/api/onboarding/survey${query({ today: todayStr() })}`, { method: "POST", body: JSON.stringify(answers) }),
  interpretNarrative: (narrative: string) =>
    request<InterpretResult>(`/api/onboarding/interpret${query({ today: todayStr() })}`, { method: "POST", body: JSON.stringify({ narrative }) }),
  deleteApp: (eraseHistory: boolean) =>
    request<ResetResult>("/api/onboarding/reset", { method: "POST", body: JSON.stringify({ confirm: "DELETE", eraseHistory }) }),

  chatHistory: () => request<Array<{ role: "user" | "assistant"; content: string; createdAt: string }>>("/api/onboarding/history"),
  chat: (message: string) => request<{ reply: string; toolResults: string[] }>("/api/onboarding/chat", { method: "POST", body: JSON.stringify({ message }) }),

  authStatus: () => request<{ authenticated: boolean; passwordRequired: boolean }>("/api/auth/status"),
  login: (password: string) => request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  blockChoices: () => request<{ blocks: BlockChoiceRow[] }>("/api/app-shell/blocks"),
  patchBlocks: (patch: Record<string, "on" | "off" | null>) =>
    request<Record<string, "on" | "off">>("/api/preferences/blocks", { method: "PATCH", body: JSON.stringify(patch) }),
  appShell: () => request<AssembledApp>("/api/app-shell"),
  preferences: () => request<{ connectors: ConnectorPreferences; features: FeaturePreferences }>("/api/preferences"),
  patchConnectors: (patch: Partial<ConnectorPreferences>) => request<ConnectorPreferences>("/api/preferences/connectors", { method: "PATCH", body: JSON.stringify(patch) }),
  patchFeatures: (patch: Partial<FeaturePreferences>) => request<FeaturePreferences>("/api/preferences/features", { method: "PATCH", body: JSON.stringify(patch) }),

  calibration: () => request<CalibrationReport>("/api/calibration/report"),

  syncGarmin: () => request<{ fetched: number; inserted: number; skippedDuplicates: number; error?: string }>("/api/connectors/garmin/sync", { method: "POST" }),
  syncWhoop: () => request<{ fetched: number; inserted: number; skippedDuplicates: number; error?: string }>("/api/connectors/whoop/sync", { method: "POST" }),
};

/*
 * ─── What re-derives when a training input changes ────────────────────────
 *
 * `["week"]` carries the sessions, the per-day macros and the resolved
 * nutrition stance. `["plan"]` carries the conflicts that EXPLAIN them: the
 * DECISIONS B5 sentence — "your cut is paused while the calf strain is open"
 * — is emitted only as a `GoalConflict`, and only `GET /api/plan/arbitrate`
 * returns those. Invalidating one without the other changes what the athlete
 * is told to do while withholding the reason, which is the exact failure the
 * conflict channel exists to prevent.
 *
 * So the pair travels TOGETHER, out of ONE list, rather than being re-listed
 * at every mutation — three hand-written copies is how logging an injury came
 * to refetch the week and not the explanation.
 */
export const ENGINE_ANSWER_KEYS: ReadonlyArray<ReadonlyArray<string>> = [["week"], ["plan"]];

/** Invalidate both halves of the engine's answer, plus whatever else this change touched. */
export function invalidateEngineAnswer(
  queryClient: QueryClient,
  ...alsoInvalidate: ReadonlyArray<ReadonlyArray<string>>
): void {
  for (const key of [...ENGINE_ANSWER_KEYS, ...alsoInvalidate]) {
    queryClient.invalidateQueries({ queryKey: [...key] });
  }
}

export function formatPace(secPerKm: number | null | undefined): string {
  if (!secPerKm) return "—";
  return `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, "0")}/km`;
}

/**
 * The athlete's own calendar day, in THEIR timezone.
 *
 * `toISOString()` is UTC, which made this wrong for anyone not on it: at 07:00
 * in Sydney it still returned yesterday, so the check-in recorded against the
 * wrong day, the "today" highlight sat on the wrong card, and the readiness
 * slice — which only ever touches today — silently did nothing while the app
 * said it had saved. The server bounds whatever this sends to within a day of
 * UTC, so a wrong clock cannot move the athlete into a different week.
 */
export function todayStr(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function daysUntil(dateStr: string): number {
  return Math.ceil((Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${todayStr()}T00:00:00Z`)) / 86_400_000);
}

export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  endurance_race: "Endurance race",
  hyrox: "HYROX",
  body_composition: "Body composition",
  strength: "Strength",
  general_fitness: "General fitness",
};

/** The latest goal date the server accepts (server/goalValidation.ts), for a date input's `max`. */
export function tenYearsFrom(day: string): string {
  return `${Number(day.slice(0, 4)) + 10}${day.slice(4)}`;
}
