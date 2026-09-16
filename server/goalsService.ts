/**
 * Goal persistence — pulled out of routes.ts so the onboarding chat's
 * create_goal tool (server/onboarding.ts) and the REST endpoint go through
 * the exact same write path instead of two copies that could drift apart.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { goals } from "@shared/schema";
import { type Discipline, type Goal, defaultDiscipline } from "@shared/goal";
import { type CreateGoalInput, InvalidGoalError, validateGoalInput } from "./goalValidation";

export type { CreateGoalInput };
export { InvalidGoalError };

export function rowToGoal(row: typeof goals.$inferSelect): Goal {
  return {
    id: row.id,
    type: row.type as Goal["type"],
    // Rows written before `discipline` existed store the column default
    // ("other"), which is wrong for an endurance race — fall back to the
    // type's own default so an old marathon row still reads as a run.
    discipline: (row.discipline as Discipline) || defaultDiscipline(row.type as Goal["type"]),
    label: row.label,
    targetDate: row.targetDate,
    priority: row.priority,
    successCriteria: row.successCriteria,
    targetMetrics: JSON.parse(row.targetMetricsJson),
    constraints: JSON.parse(row.constraintsJson),
    active: row.active,
    createdAt: row.createdAt,
  };
}

export function listGoals(): Goal[] {
  return db.select().from(goals).all().map(rowToGoal);
}

/** Throws InvalidGoalError on bad input — never trust a caller's data uncritically, including the LLM tool loop's. */
export function createGoal(input: CreateGoalInput): Goal {
  validateGoalInput(input);
  const goal: Goal = {
    id: randomUUID(),
    type: input.type,
    discipline: input.discipline ?? defaultDiscipline(input.type),
    label: input.label,
    targetDate: input.targetDate,
    priority: input.priority ?? 1,
    successCriteria: input.successCriteria,
    targetMetrics: input.targetMetrics ?? {},
    constraints: input.constraints ?? [],
    createdAt: new Date().toISOString(),
    active: true,
  };
  db.insert(goals)
    .values({
      id: goal.id,
      type: goal.type,
      discipline: goal.discipline,
      label: goal.label,
      targetDate: goal.targetDate,
      priority: goal.priority,
      successCriteria: goal.successCriteria,
      targetMetricsJson: JSON.stringify(goal.targetMetrics),
      constraintsJson: JSON.stringify(goal.constraints),
      active: goal.active,
      createdAt: goal.createdAt,
    })
    .run();
  return goal;
}
