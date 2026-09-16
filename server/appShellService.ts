/**
 * Assembles the app for the current athlete, and records what it couldn't
 * serve.
 *
 * The assembly itself is pure and lives in shared/appShell — this is the thin
 * layer that feeds it the real goal model and persists the gaps it reports.
 * Logging matters because a gap seen once in a session is a curiosity; a gap
 * seen every week by every athlete with a triathlon goal is the next thing to
 * build. Without the log the signal exists only in a response nobody reads.
 */
import { sql } from "drizzle-orm";
import { db } from "./db";
import { capabilityGaps } from "@shared/schema";
import { assembleApp, type AssembledApp } from "@shared/appShell/assemble";
import { BLOCKS } from "@shared/appShell/blocks";
import { listGoals } from "./goalsService";
import { getPreferences } from "./preferencesService";

export function getAppShell(today = new Date().toISOString().slice(0, 10)): AssembledApp {
  const { connectors, features, blocks } = getPreferences();
  return assembleApp(listGoals(), connectors, features, today, blocks);
}

/**
 * Every block in the catalog with what the assembler decided and why, so the
 * athlete can see and change it. Without this the overrides exist but are
 * unreachable — you can't switch on a block you were never shown.
 */
export interface BlockChoiceRow {
  id: string;
  title: string;
  surface: string;
  note?: string;
  status: "built" | "planned";
  /** What the athlete explicitly chose, if anything. */
  choice: "on" | "off" | null;
  /** Whether it's currently part of their app. */
  active: boolean;
  /** True when the athlete's choice differs from what their goals imply. */
  overridden: boolean;
}

export function listBlockChoices(today = new Date().toISOString().slice(0, 10)): BlockChoiceRow[] {
  const { connectors, features, blocks } = getPreferences();
  const goals = listGoals();
  const inferred = assembleApp(goals, connectors, features, today, {});
  const actual = assembleApp(goals, connectors, features, today, blocks);

  const idsIn = (app: AssembledApp) => new Set(app.surfaces.flatMap((s) => s.blocks.map((b) => b.id)));
  const inferredIds = idsIn(inferred);
  const actualIds = idsIn(actual);

  return BLOCKS.filter((block) => block.surface !== "engine").map((block) => ({
    id: block.id,
    title: block.title,
    surface: block.surface,
    ...(block.note ? { note: block.note } : {}),
    status: block.status,
    choice: blocks[block.id] ?? null,
    active: actualIds.has(block.id),
    overridden: actualIds.has(block.id) !== inferredIds.has(block.id),
  }));
}

/** Upsert each reported gap. Never throws into the request path — a failed log must not cost the athlete their app. */
export function recordGaps(app: AssembledApp, now = new Date().toISOString()): void {
  for (const gap of app.gaps) {
    try {
      db.insert(capabilityGaps)
        .values({
          capability: gap.capability,
          wantedByJson: JSON.stringify(gap.wantedBy),
          plannedBlockId: gap.plannedBlockId ?? null,
          firstSeenAt: now,
          lastSeenAt: now,
          seenCount: 1,
        })
        .onConflictDoUpdate({
          target: capabilityGaps.capability,
          set: {
            wantedByJson: JSON.stringify(gap.wantedBy),
            plannedBlockId: gap.plannedBlockId ?? null,
            lastSeenAt: now,
            seenCount: sql`${capabilityGaps.seenCount} + 1`,
          },
        })
        .run();
    } catch {
      // Deliberately swallowed — see the header.
    }
  }
}

export interface GapQueueEntry {
  capability: string;
  wantedBy: string[];
  plannedBlockId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
}

/** The backlog, most-hit first. */
export function listGapQueue(): GapQueueEntry[] {
  return db
    .select()
    .from(capabilityGaps)
    .all()
    .map((row) => ({
      capability: row.capability,
      wantedBy: JSON.parse(row.wantedByJson) as string[],
      plannedBlockId: row.plannedBlockId,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      seenCount: row.seenCount,
    }))
    .sort((a, b) => b.seenCount - a.seenCount || a.capability.localeCompare(b.capability));
}
