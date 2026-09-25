/**
 * Migrations as a deployed volume sees them: applied on top of a database
 * that already holds the athlete's data, not only on an empty one.
 *
 * Every other test (and the smoke) starts from an empty volume, which is the
 * one situation production is in exactly once. The Phase 11 survey shipped a
 * migration that was correct on an empty database and wrong on every real
 * one — see the app_build test below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MIGRATIONS = path.resolve(process.cwd(), "migrations");
const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

/** A copy of migrations/ that stops after `lastTag` — the schema an older deploy left on the volume. */
function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "trainu-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const upTo = journal.entries.findIndex((e) => e.tag === lastTag);
  assert.ok(upTo >= 0, `no migration tagged ${lastTag}`);
  writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo + 1) }));
  return dir;
}

function withVolume(fn: (sqlite: Database.Database, dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "trainu-volume-"));
  const sqlite = new Database(path.join(dir, "trainu.db"));
  try {
    fn(sqlite, dir);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const insertGoal = (sqlite: Database.Database) =>
  sqlite
    .prepare(
      `INSERT INTO goals (id, type, discipline, label, target_date, priority, success_criteria, target_metrics_json, constraints_json, active, created_at)
       VALUES ('g1', 'endurance_race', 'run', 'Ironman Barcelona', '2027-10-03', 1, 'Finish', '{}', '[]', 1, '2026-09-01T00:00:00.000Z')`,
    )
    .run();

test("the journal is in order and every migration it names exists", () => {
  // Drizzle's migrator applies by `when`, and on an existing volume it SKIPS
  // any migration older than the newest one already applied — so a migration
  // generated on an older branch and merged later is applied on a fresh
  // volume but silently never on the real one.
  for (let i = 0; i < journal.entries.length; i++) {
    const e = journal.entries[i];
    assert.equal(e.idx, i, `entry ${i} has idx ${e.idx}`);
    assert.ok(existsSync(path.join(MIGRATIONS, `${e.tag}.sql`)), `${e.tag}.sql is missing`);
    if (i > 0) assert.ok(e.when > journal.entries[i - 1].when, `${e.tag} is not newer than ${journal.entries[i - 1].tag}`);
  }
});

test("DEFECT: an install that had goals before the survey existed is marked built on upgrade", () => {
  withVolume((sqlite) => {
    const db = drizzle(sqlite);
    const before = migrationsUpTo("0001_exotic_scorpion");
    migrate(db, { migrationsFolder: before });
    insertGoal(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS });
    const row = sqlite.prepare("SELECT completed_at FROM app_build WHERE id = 'self'").get() as { completed_at: string } | undefined;
    assert.ok(row?.completed_at, "no build row — this athlete would open on the survey, and finishing it duplicates every goal");
    rmSync(before, { recursive: true, force: true });
  });
});

test("…including a volume that already ran Phase 11's migration (0002) before the fix", () => {
  withVolume((sqlite) => {
    const db = drizzle(sqlite);
    const before = migrationsUpTo("0002_flippant_nick_fury");
    migrate(db, { migrationsFolder: before });
    insertGoal(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS });
    assert.ok(sqlite.prepare("SELECT 1 FROM app_build WHERE id = 'self'").get());
    rmSync(before, { recursive: true, force: true });
  });
});

test("a fresh install is NOT marked built — it still gets the survey", () => {
  withVolume((sqlite) => {
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM app_build").get().n, 0);
  });
});

test("an already-built app keeps its own build row", () => {
  withVolume((sqlite) => {
    const db = drizzle(sqlite);
    const before = migrationsUpTo("0002_flippant_nick_fury");
    migrate(db, { migrationsFolder: before });
    insertGoal(sqlite);
    sqlite.prepare(`INSERT INTO app_build (id, completed_at, answers_json, updated_at) VALUES ('self', '2026-09-24T10:00:00.000Z', '{"name":"Sam"}', '2026-09-24T10:00:00.000Z')`).run();
    migrate(db, { migrationsFolder: MIGRATIONS });
    const row = sqlite.prepare("SELECT completed_at, answers_json FROM app_build").get() as { completed_at: string; answers_json: string };
    assert.equal(row.completed_at, "2026-09-24T10:00:00.000Z");
    assert.equal(row.answers_json, '{"name":"Sam"}');
    rmSync(before, { recursive: true, force: true });
  });
});

test("DEFECT: unresolvable plan logs are removed on upgrade; real predictions are kept", () => {
  withVolume((sqlite) => {
    const db = drizzle(sqlite);
    const before = migrationsUpTo("0002_flippant_nick_fury");
    migrate(db, { migrationsFolder: before });
    const log = sqlite.prepare(
      `INSERT INTO outcome_log (id, goal_id, kind, predicted_at, prediction_json, actual_json, observed_at) VALUES (?, NULL, ?, '2026-09-24', '{}', NULL, NULL)`,
    );
    log.run("plan-1", "plan:arbitration");
    log.run("plan-2", "plan:arbitration");
    log.run("pred-1", "prediction:run");
    migrate(db, { migrationsFolder: MIGRATIONS });
    const kinds = (sqlite.prepare("SELECT kind FROM outcome_log ORDER BY id").all() as Array<{ kind: string }>).map((r) => r.kind);
    assert.deepEqual(kinds, ["prediction:run"]);
    rmSync(before, { recursive: true, force: true });
  });
});
