/**
 * The onboarding chat: ask clarifying questions until there's enough to
 * create a goal, ask once about data-connector and feature preferences,
 * and stop there — Phases 1-3 (the Goal model, the predictors, the
 * arbitration engine) are the actual product; this is a thin conversational
 * front door onto createGoal(), not a place for the model to invent its own
 * plan logic.
 *
 * Two rules carried over from HyroxNga's llmCoach.ts, the one piece of
 * either sibling app's LLM integration mature enough to copy the shape of:
 *
 *  1. The model calls tools; the tools do the writing, with real server-side
 *     validation (goalsService.createGoal throws InvalidGoalError on bad
 *     input regardless of what the model's tool-schema promised).
 *  2. It must never claim an action it didn't verify — the tool loop runs
 *     to completion and a closing call (tools withheld) narrates only what
 *     the tool results actually confirmed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createGoal, InvalidGoalError } from "./goalsService";
import { updateConnectorPreferences, updateFeaturePreferences } from "./preferencesService";
import type { GoalTargetMetrics } from "@shared/goal";

const CHAT_MODEL = "claude-sonnet-5";
const FALLBACK_MODEL = "claude-sonnet-4-6";

function apiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || null;
}

async function createWithRetry(client: Anthropic, params: Anthropic.MessageCreateParamsNonStreaming, label = "onboarding"): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const retryable = status === 429 || status === 500 || status === 503 || status === 529 || /overloaded/i.test(String((err as Error)?.message ?? ""));
      if (!retryable || attempt === 3) break;
      const delay = 2000 * 2 ** attempt;
      console.warn(`[Onboarding] ${label}: ${status ?? "?"} — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  const status = (lastErr as { status?: number })?.status ?? 0;
  if (status >= 500 && params.model !== FALLBACK_MODEL) {
    try {
      return await client.messages.create({ ...params, model: FALLBACK_MODEL });
    } catch {
      /* fall through to throwing the original error below */
    }
  }
  throw lastErr;
}

export function friendlyLlmError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (e?.status === 529 || /overloaded/i.test(String(e?.message ?? ""))) return "The onboarding assistant is momentarily overloaded — try again in a minute.";
  if (e?.status === 429) return "Rate limit hit — try again shortly.";
  if (e?.status === 401) return "ANTHROPIC_API_KEY was rejected — check it in the environment.";
  return e?.message ?? "Onboarding chat call failed";
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

const GOAL_TYPES = ["endurance_race", "hyrox", "body_composition", "strength", "general_fitness"] as const;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_goal",
    description:
      "Create one of the athlete's training goals once you have enough to make it useful. You need a clear goal type, a short label, and a target date — you do NOT need every numeric field before calling this; targetMetrics fields are whichever ones actually apply and are known. Call this once per distinct goal the athlete describes, not once per message.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: [...GOAL_TYPES] },
        label: { type: "string", description: "Short name, e.g. 'Berlin Marathon' or 'Cousin's wedding'." },
        targetDate: { type: "string", description: "YYYY-MM-DD" },
        priority: { type: "number", description: "1 = most important. Ask which matters more when there are multiple goals; default to 1 for the first goal." },
        successCriteria: { type: "string", description: "Plain-language description of what success looks like." },
        targetTimeSeconds: { type: "number" },
        targetDistanceKm: { type: "number" },
        targetWeightKg: { type: "number" },
        targetBodyFatPercent: { type: "number" },
        liftId: { type: "string", enum: ["squat1RmKg", "deadlift1RmKg", "bench1RmKg", "ohp1RmKg"] },
      },
      required: ["type", "label", "targetDate", "successCriteria"],
    },
  },
  {
    name: "set_connector_preferences",
    description: "Record which wearable/data connectors the athlete wants. Ask once, near the end of onboarding. Pass only the ones they actually answered.",
    input_schema: {
      type: "object" as const,
      properties: { garmin: { type: "boolean" }, whoop: { type: "boolean" }, appleHealth: { type: "boolean" } },
    },
  },
  {
    name: "set_feature_preferences",
    description: "Record optional feature opt-ins, e.g. physique-progress (photo/measurement) tracking.",
    input_schema: {
      type: "object" as const,
      properties: { physiqueTracking: { type: "boolean" } },
    },
  },
];

const SYSTEM_PROMPT = `You are TrainU's onboarding assistant. TrainU is a training app built around one idea: most athletes don't have one goal, they have several at once (a race, a wedding to look good for, a lift to hit) with different deadlines and sometimes CONFLICTING demands — and the app's job is to reconcile them into one plan rather than silently picking one and ignoring the rest.

Your job here is narrow: ask clarifying questions, one or two at a time — never dump a long questionnaire — until you have enough to call create_goal for each goal the athlete describes. "Enough" means a goal type, a short label, and a target date; grab whatever numeric target applies (a time, a distance, a weight, a body-fat %, a lift) if the athlete states or implies one, but don't interrogate them for a number they don't have or care about. If they mention more than one goal, ask which matters more to them and set priority accordingly (1 = most important) — this is what lets the app arbitrate between them later, so it matters more than any other single question you'll ask.

Once you have at least one goal created, ask ONCE which data connectors they want (Garmin, Whoop, Apple Health — they can pick none, some, or all) and whether they want optional features like physique-progress tracking, then call the matching setter tools.

Never claim a goal was created, or a preference was saved, unless a tool result in this same turn confirmed it — if a tool call fails, say so plainly and ask what to fix, don't pretend it worked.`;

export interface ChatTurnResult {
  reply: string;
  toolResults: string[];
}

export async function chatOnboarding(userMessage: string, history: Array<{ role: "user" | "assistant"; content: string }>): Promise<ChatTurnResult> {
  const key = apiKey();
  if (!key) {
    return { reply: "Set ANTHROPIC_API_KEY in the environment to enable the onboarding assistant.", toolResults: [] };
  }

  const client = new Anthropic({ apiKey: key });
  const messages: Anthropic.MessageParam[] = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: userMessage }];
  const toolResults: string[] = [];

  try {
    let finalText = "";
    let endedOnTools = false;
    // Runs to completion — executing only the first round of tool calls
    // while still announcing a final reply is exactly what rule 2 forbids.
    for (let round = 0; round < 5; round++) {
      endedOnTools = false;
      const msg = await createWithRetry(client, { model: CHAT_MODEL, max_tokens: 1200, system: SYSTEM_PROMPT, messages, tools: TOOLS });
      finalText = textOf(msg) || finalText;

      const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;
      endedOnTools = true;

      messages.push({ role: "assistant", content: msg.content });
      messages.push({
        role: "user",
        content: toolUses.map((tu) => {
          const result = runTool(tu.name, tu.input as Record<string, unknown>);
          toolResults.push(result);
          return { type: "tool_result" as const, tool_use_id: tu.id, content: result };
        }),
      });
    }

    if (endedOnTools) {
      const closing = await createWithRetry(client, { model: CHAT_MODEL, max_tokens: 800, system: SYSTEM_PROMPT, messages }, "onboarding-close");
      finalText = textOf(closing) || finalText;
    }

    return { reply: finalText || "I didn't have anything to add there — tell me more and I'll pick it up.", toolResults };
  } catch (err) {
    return { reply: friendlyLlmError(err), toolResults };
  }
}

/** Exported for direct testing — the tool loop's actual writes go through this, and there's no other way to exercise it without a live Anthropic API key. */
export function runTool(name: string, input: Record<string, unknown>): string {
  try {
    switch (name) {
      case "create_goal": {
        const targetMetrics: GoalTargetMetrics = {};
        if (typeof input.targetTimeSeconds === "number") targetMetrics.targetTimeSeconds = input.targetTimeSeconds;
        if (typeof input.targetDistanceKm === "number") targetMetrics.targetDistanceKm = input.targetDistanceKm;
        if (typeof input.targetWeightKg === "number") targetMetrics.targetWeightKg = input.targetWeightKg;
        if (typeof input.targetBodyFatPercent === "number") targetMetrics.targetBodyFatPercent = input.targetBodyFatPercent;
        if (typeof input.liftId === "string") targetMetrics.liftId = input.liftId as GoalTargetMetrics["liftId"];

        const goal = createGoal({
          type: input.type as any,
          label: String(input.label ?? ""),
          targetDate: String(input.targetDate ?? ""),
          priority: typeof input.priority === "number" ? input.priority : undefined,
          successCriteria: String(input.successCriteria ?? ""),
          targetMetrics,
        });
        return `Created goal "${goal.label}" (id ${goal.id}, type ${goal.type}, target ${goal.targetDate}, priority ${goal.priority}).`;
      }
      case "set_connector_preferences": {
        const patch: Record<string, boolean> = {};
        for (const k of ["garmin", "whoop", "appleHealth"] as const) {
          if (typeof input[k] === "boolean") patch[k] = input[k] as boolean;
        }
        const saved = updateConnectorPreferences(patch);
        return `Saved connector preferences: ${JSON.stringify(saved)}.`;
      }
      case "set_feature_preferences": {
        const patch: Record<string, boolean> = {};
        if (typeof input.physiqueTracking === "boolean") patch.physiqueTracking = input.physiqueTracking;
        const saved = updateFeaturePreferences(patch);
        return `Saved feature preferences: ${JSON.stringify(saved)}.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof InvalidGoalError) return `Could not create the goal: ${err.message}`;
    return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
