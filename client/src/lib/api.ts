import type { AthleteParams } from "@shared/athlete";
import type { Goal, GoalType } from "@shared/goal";
import type { TrainingSession } from "@shared/session";
import type { TrainingLoadSummary } from "@shared/trainingLoad";
import type { ArbitratedPlan, ArbitratedWeek } from "@shared/arbitration/arbitrate";
import type { PlannedSession, SessionKind } from "@shared/prescription/sessionKinds";
import type { MacroTarget } from "@shared/nutrition";
import type { CalibrationReport } from "@shared/calibrationReport";
export type { AssembledApp };
import type { ConnectorPreferences, FeaturePreferences } from "@shared/preferences";
import type { AssembledApp } from "@shared/appShell/assemble";
import type { Discipline } from "@shared/goal";

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

export type CompletionStatus = "completed" | "partial" | "skipped";

export interface SessionCompletion {
  key: string;
  date: string;
  kind: SessionKind;
  status: CompletionStatus;
  rpe: number | null;
  note: string | null;
  recordedAt: string;
}

export interface PlanDay {
  date: string;
  sessions: Array<PlannedSession & { completion: SessionCompletion | null }>;
  dailyTss: number;
  nutrition: MacroTarget;
}

export interface PlanWeek {
  weekStart: string;
  arbitrated: ArbitratedWeek;
  days: PlanDay[];
  totalMinutes: number;
  totalTss: number;
  note: string;
  adherence: { prescribed: number; completed: number; partial: number; skipped: number; adherenceRate: number | null };
}

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
  return res.json() as Promise<T>;
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

  athlete: () => request<AthleteParams>("/api/athlete"),
  patchAthlete: (fields: Record<string, number>) => request<AthleteParams>("/api/athlete", { method: "PATCH", body: JSON.stringify(fields) }),

  sessions: () => request<TrainingSession[]>("/api/sessions"),
  trainingLoad: () => request<TrainingLoadSummary>("/api/training-load"),

  plan: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    return request<ArbitratedPlan>(`/api/plan/arbitrate${q.toString() ? `?${q}` : ""}`);
  },

  week: (date?: string) => request<PlanWeek>(`/api/plan/week${date ? `?date=${date}` : ""}`),
  completeSession: (body: { date: string; kind: SessionKind; status: CompletionStatus; rpe?: number; note?: string; prescribed?: PlannedSession }) =>
    request<SessionCompletion>("/api/sessions/complete", { method: "POST", body: JSON.stringify(body) }),

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

export function formatPace(secPerKm: number | null | undefined): string {
  if (!secPerKm) return "—";
  return `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, "0")}/km`;
}

export function daysUntil(dateStr: string): number {
  return Math.ceil((Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  endurance_race: "Endurance race",
  hyrox: "HYROX",
  body_composition: "Body composition",
  strength: "Strength",
  general_fitness: "General fitness",
};
