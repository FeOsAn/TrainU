/**
 * "Read back what I just said and fill the form in."
 *
 * The survey's first screen asks the athlete to describe themselves in their
 * own words — spoken, usually, since that's the point of the microphone. This
 * turns that paragraph into a DRAFT of the rest of the form.
 *
 * Three rules, and all three are the difference between this and an app that
 * lets a model write itself:
 *
 *  1. It returns a draft. Nothing is written. The athlete sees every field it
 *     filled in, on the same screens they'd have filled in themselves, and
 *     nothing reaches the database until they finish the survey — where it
 *     goes through `validateSurvey` and `createGoal` exactly like a typed
 *     answer does.
 *  2. Every field is bounds-checked HERE too, before the athlete ever sees
 *     it. A model that hears "I'm 34" and writes 340 must not put 340 on
 *     screen for someone to tap past.
 *  3. Missing key, refused key, model down — all of it degrades to "couldn't
 *     read that, fill it in yourself", never to a broken survey. The survey
 *     is the front door; it works offline.
 */
import Anthropic from "@anthropic-ai/sdk";
import { withinBounds } from "@shared/athlete";
import { isValidISODate } from "@shared/dates";
import { DISCIPLINES, type Discipline, type GoalType, defaultDiscipline } from "@shared/goal";
import {
  type SurveyAnswers,
  type SurveyGoalAnswer,
  GOAL_TYPES,
  MAX_TRAINING_DAYS,
  MIN_TRAINING_DAYS,
} from "@shared/onboarding/survey";
import { friendlyLlmError } from "./onboarding";

const MODEL = "claude-sonnet-5";

export interface InterpretResult {
  /** False when there's no API key, or the call failed — the survey carries on regardless. */
  available: boolean;
  /** Only the fields it could actually read. Everything else is left for the athlete. */
  draft: Partial<SurveyAnswers>;
  /** What it filled in, in the athlete's language, so they can see it happened rather than wonder. */
  filled: string[];
  message?: string;
}

const UNAVAILABLE = "No ANTHROPIC_API_KEY is set on this instance, so nothing can read your description back. Fill the next few screens in yourself — it takes about a minute.";

const SYSTEM = `You read one paragraph in which an athlete describes themselves and what they're training for, and you turn it into structured survey answers. You do not talk to them. You return JSON and nothing else.

Return an object with any of these keys you can genuinely support from what they said. LEAVE A KEY OUT rather than guessing — a blank field costs one tap, a wrong one they didn't notice corrupts every plan the app makes for them.

{
  "name": string,
  "ageYears": number, "heightCm": number, "weightKg": number, "bodyFatPercent": number,
  "trainingDaysPerWeek": integer,
  "hasBike": boolean, "hasPool": boolean,
  "goals": [
    {
      "type": "endurance_race" | "hyrox" | "body_composition" | "strength" | "general_fitness",
      "discipline": "run" | "triathlon" | "cycling" | "swimming" | "other",
      "label": string,
      "targetDate": "YYYY-MM-DD",
      "successCriteria": string,
      "targetMetrics": { "targetTimeSeconds": number, "targetDistanceKm": number, "targetWeightKg": number, "targetBodyFatPercent": number, "liftId": "squat1RmKg"|"deadlift1RmKg"|"bench1RmKg"|"ohp1RmKg" }
    }
  ]
}

Rules:
- Goal order is priority order: the goal they care about most comes first. If they said which matters more, obey it. If they didn't, keep the order they said them in.
- "discipline" only means anything for endurance_race. An Ironman or a 70.3 is "triathlon"; a marathon, half or 10k is "run".
- A wedding, a holiday, "getting lean", a weight or a body-fat number is body_composition — the label is the occasion ("Sister's wedding"), not "lose weight".
- Dates: if they gave a month with no day, use a plausible day in that month. If they said "in nine months", count from the date given to you below. Never return a date in the past.
- Times in targetTimeSeconds are total seconds. "Sub 3:30 marathon" is 12600.
- No prose, no markdown fence. JSON only.`;

function clampGoal(raw: unknown, today: string): SurveyGoalAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const type = GOAL_TYPES.includes(g.type as GoalType) ? (g.type as GoalType) : null;
  const label = typeof g.label === "string" ? g.label.trim().slice(0, 80) : "";
  if (!type || !label) return null;

  const targetDate = typeof g.targetDate === "string" && isValidISODate(g.targetDate) && g.targetDate >= today ? g.targetDate : "";
  if (!targetDate) return null;

  const discipline = DISCIPLINES.includes(g.discipline as Discipline) ? (g.discipline as Discipline) : defaultDiscipline(type);
  const metrics: SurveyGoalAnswer["targetMetrics"] = {};
  const m = (g.targetMetrics ?? {}) as Record<string, unknown>;
  if (typeof m.targetTimeSeconds === "number" && m.targetTimeSeconds > 60 && m.targetTimeSeconds < 24 * 3600) metrics.targetTimeSeconds = Math.round(m.targetTimeSeconds);
  if (typeof m.targetDistanceKm === "number" && m.targetDistanceKm > 0 && m.targetDistanceKm <= 300) metrics.targetDistanceKm = m.targetDistanceKm;
  if (typeof m.targetWeightKg === "number" && withinBounds("weightKg", m.targetWeightKg)) metrics.targetWeightKg = m.targetWeightKg;
  if (typeof m.targetBodyFatPercent === "number" && withinBounds("bodyFatPercent", m.targetBodyFatPercent)) metrics.targetBodyFatPercent = m.targetBodyFatPercent;
  if (typeof m.liftId === "string" && ["squat1RmKg", "deadlift1RmKg", "bench1RmKg", "ohp1RmKg"].includes(m.liftId)) {
    metrics.liftId = m.liftId as SurveyGoalAnswer["targetMetrics"]["liftId"];
  }

  return {
    type,
    discipline,
    label,
    targetDate,
    successCriteria: typeof g.successCriteria === "string" ? g.successCriteria.trim().slice(0, 240) : "",
    targetMetrics: metrics,
  };
}

/** Exported separately from the network call so the whole clamp can be tested without an API key — which is the only way it gets tested in this environment at all. */
export function draftFromModelJson(text: string, today: string): { draft: Partial<SurveyAnswers>; filled: string[] } {
  const draft: Partial<SurveyAnswers> = {};
  const filled: string[] = [];

  // Models occasionally fence JSON despite being told not to; a stray ```json
  // is not a reason to throw the athlete's whole paragraph away.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { draft, filled };

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { draft, filled };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { draft, filled };
  const p = parsed as Record<string, unknown>;

  if (typeof p.name === "string" && p.name.trim()) {
    draft.name = p.name.trim().slice(0, 40);
    filled.push(`your name (${draft.name})`);
  }
  for (const field of ["ageYears", "heightCm", "weightKg", "bodyFatPercent"] as const) {
    const value = p[field];
    if (typeof value === "number" && withinBounds(field, value)) {
      (draft as Record<string, number>)[field] = Math.round(value * 10) / 10;
    }
  }
  const numbers = (["ageYears", "heightCm", "weightKg", "bodyFatPercent"] as const).filter((f) => draft[f] !== undefined);
  if (numbers.length > 0) filled.push(`${numbers.length} of your numbers`);

  if (typeof p.trainingDaysPerWeek === "number" && Number.isInteger(p.trainingDaysPerWeek)) {
    const days = Math.min(MAX_TRAINING_DAYS, Math.max(MIN_TRAINING_DAYS, p.trainingDaysPerWeek));
    draft.trainingDaysPerWeek = days;
    filled.push(`${days} training days a week`);
  }
  if (typeof p.hasBike === "boolean") draft.hasBike = p.hasBike;
  if (typeof p.hasPool === "boolean") draft.hasPool = p.hasPool;

  if (Array.isArray(p.goals)) {
    const goals = p.goals.map((g) => clampGoal(g, today)).filter((g): g is SurveyGoalAnswer => g !== null).slice(0, 6);
    if (goals.length > 0) {
      draft.goals = goals;
      filled.push(goals.length === 1 ? `one goal (${goals[0]!.label})` : `${goals.length} goals`);
    }
  }

  return { draft, filled };
}

export async function interpretNarrative(narrative: string, today: string): Promise<InterpretResult> {
  const text = narrative.trim();
  if (!text) return { available: true, draft: {}, filled: [], message: "There was nothing to read — say or type a few sentences first." };
  if (!process.env.ANTHROPIC_API_KEY) return { available: false, draft: {}, filled: [], message: UNAVAILABLE };

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: `${SYSTEM}\n\nToday is ${today}.`,
      messages: [{ role: "user", content: text.slice(0, 6000) }],
    });
    const body = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    const { draft, filled } = draftFromModelJson(body, today);
    if (filled.length === 0) {
      return { available: true, draft, filled, message: "Couldn't pull anything solid out of that — fill the next screens in yourself, or say more about your goals and try again." };
    }
    return { available: true, draft, filled };
  } catch (err) {
    return { available: false, draft: {}, filled: [], message: friendlyLlmError(err) };
  }
}
