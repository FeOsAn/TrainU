/**
 * Pure validation, deliberately free of any DB import — goalsService.ts and
 * this module's own tests both need to use it without pulling in server/db.ts's
 * module-load side effect (opening/stamping the SQLite file).
 *
 * This is the defense-in-depth layer for server/onboarding.ts's create_goal
 * tool: an LLM tool call is a hostile-ish input source in the same sense a
 * form submission is — the tool schema is a hint to the model, not an
 * enforcement mechanism, so a hallucinated type or a mangled date must be
 * rejected here regardless of what the tool definition promised.
 */
import { type Discipline, type Goal, type GoalConstraint, type GoalTargetMetrics, DISCIPLINES } from "@shared/goal";
import { addDays, isValidISODate, todayISO } from "@shared/dates";

/**
 * How far from today a goal's date may be. A year back covers logging a goal
 * that has just finished; ten years ahead covers any real plan. Beyond that is
 * a typo (2207 for 2027) or a placeholder (9999-12-31) — and before the plan
 * had a horizon cap, either one ran the server out of memory.
 */
export const GOAL_DATE_MIN_DAYS_BACK = 366;
export const GOAL_DATE_MAX_DAYS_AHEAD = 3653;

export interface CreateGoalInput {
  type: Goal["type"];
  discipline?: Discipline;
  label: string;
  targetDate: string;
  priority?: number;
  successCriteria: string;
  targetMetrics?: GoalTargetMetrics;
  constraints?: GoalConstraint[];
}

export const VALID_GOAL_TYPES = new Set<Goal["type"]>(["endurance_race", "hyrox", "body_composition", "strength", "general_fitness"]);
export const VALID_DISCIPLINES = new Set<Discipline>(DISCIPLINES);

export class InvalidGoalError extends Error {}

export function validateGoalInput(input: CreateGoalInput, today: string = todayISO()): void {
  if (!VALID_GOAL_TYPES.has(input.type)) throw new InvalidGoalError(`type must be one of ${[...VALID_GOAL_TYPES].join(", ")}`);
  if (input.discipline !== undefined && !VALID_DISCIPLINES.has(input.discipline)) {
    throw new InvalidGoalError(`discipline must be one of ${[...VALID_DISCIPLINES].join(", ")}`);
  }
  if (!input.label?.trim()) throw new InvalidGoalError("label is required");
  // isValidISODate, not Date.parse: Date.parse rolls 2026-02-30 over to
  // 2026-03-02 and calls it valid.
  if (typeof input.targetDate !== "string" || !isValidISODate(input.targetDate)) {
    throw new InvalidGoalError("targetDate must be a valid YYYY-MM-DD date");
  }
  if (input.targetDate < addDays(today, -GOAL_DATE_MIN_DAYS_BACK) || input.targetDate > addDays(today, GOAL_DATE_MAX_DAYS_AHEAD)) {
    throw new InvalidGoalError("targetDate must be within a year before today and ten years after it");
  }
  if (!input.successCriteria?.trim()) throw new InvalidGoalError("successCriteria is required");
  if (input.priority != null && (!Number.isFinite(input.priority) || input.priority < 1)) {
    throw new InvalidGoalError("priority must be a number >= 1");
  }
}
