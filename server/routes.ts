import type { Express } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { goals } from "@shared/schema";
import type { Goal } from "@shared/goal";

export async function registerRoutes(_httpServer: Server, app: Express) {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Phase 1 slice: create/list goals, so the onboarding flow (Phase 4) has
  // something real to write to. No arbitration yet — that's Phase 3.
  app.get("/api/goals", (_req, res) => {
    const rows = db.select().from(goals).all();
    res.json(rows.map(rowToGoal));
  });

  app.post("/api/goals", (req, res) => {
    const body = req.body as Partial<Goal>;
    if (!body.type || !body.label || !body.targetDate || !body.successCriteria) {
      return res.status(400).json({ error: "type, label, targetDate, successCriteria are required" });
    }
    const goal: Goal = {
      id: randomUUID(),
      type: body.type,
      label: body.label,
      targetDate: body.targetDate,
      priority: body.priority ?? 1,
      successCriteria: body.successCriteria,
      constraints: body.constraints ?? [],
      createdAt: new Date().toISOString(),
      active: true,
    };
    db.insert(goals)
      .values({
        id: goal.id,
        type: goal.type,
        label: goal.label,
        targetDate: goal.targetDate,
        priority: goal.priority,
        successCriteria: goal.successCriteria,
        constraintsJson: JSON.stringify(goal.constraints),
        active: goal.active,
        createdAt: goal.createdAt,
      })
      .run();
    res.status(201).json(goal);
  });
}

function rowToGoal(row: typeof goals.$inferSelect): Goal {
  return {
    id: row.id,
    type: row.type as Goal["type"],
    label: row.label,
    targetDate: row.targetDate,
    priority: row.priority,
    successCriteria: row.successCriteria,
    constraints: JSON.parse(row.constraintsJson),
    active: row.active,
    createdAt: row.createdAt,
  };
}
