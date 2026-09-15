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
import type { Goal, GoalConstraint, GoalTargetMetrics } from "@shared/goal";

export interface CreateGoalInput {
  type: Goal["type"];
  label: string;
  targetDate: string;
  priority?: number;
  successCriteria: string;
  targetMetrics?: GoalTargetMetrics;
  constraints?: GoalConstraint[];
}

export const VALID_GOAL_TYPES = new Set<Goal["type"]>(["endurance_race", "hyrox", "body_composition", "strength", "general_fitness"]);

export class InvalidGoalError extends Error {}

export function validateGoalInput(input: CreateGoalInput): void {
  if (!VALID_GOAL_TYPES.has(input.type)) throw new InvalidGoalError(`type must be one of ${[...VALID_GOAL_TYPES].join(", ")}`);
  if (!input.label?.trim()) throw new InvalidGoalError("label is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate) || Number.isNaN(Date.parse(`${input.targetDate}T00:00:00Z`))) {
    throw new InvalidGoalError("targetDate must be a valid YYYY-MM-DD date");
  }
  if (!input.successCriteria?.trim()) throw new InvalidGoalError("successCriteria is required");
  if (input.priority != null && (!Number.isFinite(input.priority) || input.priority < 1)) {
    throw new InvalidGoalError("priority must be a number >= 1");
  }
}
