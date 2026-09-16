import type { AthleteParams } from "@shared/athlete";
import type { Goal, GoalType } from "@shared/goal";
import type { TrainingSession } from "@shared/session";
import type { TrainingLoadSummary } from "@shared/trainingLoad";
import type { ArbitratedPlan } from "@shared/arbitration/arbitrate";
import type { CalibrationReport } from "@shared/calibrationReport";
import type { ConnectorPreferences, FeaturePreferences } from "@shared/preferences";

/** The server serves this client (see server/vite.ts), so /api is same-origin — no base URL, no proxy. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? body?.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  goals: () => request<Goal[]>("/api/goals"),
  createGoal: (goal: {
    type: GoalType;
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

  chatHistory: () => request<Array<{ role: "user" | "assistant"; content: string; createdAt: string }>>("/api/onboarding/history"),
  chat: (message: string) => request<{ reply: string; toolResults: string[] }>("/api/onboarding/chat", { method: "POST", body: JSON.stringify({ message }) }),

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
