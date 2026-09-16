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
import { listGoals } from "./goalsService";
import { getPreferences } from "./preferencesService";

export function getAppShell(today = new Date().toISOString().slice(0, 10)): AssembledApp {
  const { connectors, features } = getPreferences();
  return assembleApp(listGoals(), connectors, features, today);
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
