/**
 * The database file, and the guard that keeps it ours.
 *
 * Same lesson HyroxNga's db.ts already learned: this athlete runs multiple
 * Node services (sub5-dashboard, HyroxNga, this one) that each keep a SQLite
 * file on disk. Nothing stops a copied env var or a shared volume from
 * pointing this app at one of the others' files, and SQLite will happily
 * open it and start writing. So:
 *
 *   1. A distinct filename — trainu.db, never data.db or hyroxnga.db.
 *   2. An identity stamp written on first boot; refuse to start against a
 *      file stamped with a different app's name.
 *   3. A signature check for a pre-existing foreign file that predates any
 *      stamp — sub5-dashboard's athlete_profile.ftp_watts or HyroxNga's
 *      athletes.station_benchmarks_json can only belong to those apps.
 *
 * Fails loud, before any write. Refusing to start is a 30-second fix;
 * writing tables into the wrong database is not.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_ID } from "@shared/schema";

const FOREIGN_SIGNATURES: Array<{ table: string; column: string; app: string }> = [
  { table: "athlete_profile", column: "ftp_watts", app: "sub5-dashboard" },
  { table: "athletes", column: "station_benchmarks_json", app: "HyroxNga" },
];

export class ForeignDatabaseError extends Error {}

function resolveDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const dir = process.env.NODE_ENV === "production" ? "/data" : process.cwd();
  return path.join(dir, "trainu.db");
}

export const DB_PATH = resolveDbPath();

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function assertOwnDatabase(db: Database.Database): void {
  for (const sig of FOREIGN_SIGNATURES) {
    if (columnExists(db, sig.table, sig.column)) {
      throw new ForeignDatabaseError(
        `Refusing to start: ${DB_PATH} already contains a "${sig.table}.${sig.column}" column, ` +
          `which belongs to ${sig.app}. Point DB_PATH at a different file.`,
      );
    }
  }

  if (tableExists(db, "app_identity")) {
    const rows = db.prepare("SELECT app FROM app_identity").all() as Array<{ app: string }>;
    const foreign = rows.find((r) => r.app !== APP_ID);
    if (foreign) {
      throw new ForeignDatabaseError(
        `Refusing to start: ${DB_PATH} is stamped as belonging to "${foreign.app}", not "${APP_ID}". ` +
          `Point DB_PATH at a different file.`,
      );
    }
  }
}

export function stampIdentity(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS app_identity (app TEXT PRIMARY KEY, created_at TEXT)");
  db.prepare("INSERT OR IGNORE INTO app_identity (app, created_at) VALUES (?, datetime('now'))").run(APP_ID);
}

function open(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  assertOwnDatabase(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export const sqlite = open();
export const db = drizzle(sqlite);

/**
 * Bring the schema up to date on every boot.
 *
 * `drizzle-kit push` is a development convenience and is not available in a
 * deployed container — so without this, a fresh volume gives you a database
 * file containing nothing but the identity stamp, and every single endpoint
 * 500s on "no such table". Committed migrations applied at startup is the
 * only version of this that survives a deploy.
 *
 * Idempotent: drizzle records which migrations have run in its own table, so
 * a restart against an up-to-date database is a no-op.
 */
function migrationsFolder(): string {
  // Resolved relative to this file so it works from `tsx server/index.ts` in
  // development and from the esbuild bundle at dist/index.js in production,
  // which have different __dirname values.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, "../migrations"), path.resolve(here, "./migrations"), path.resolve(process.cwd(), "migrations")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Refusing to start: no migrations folder found. Run `npx drizzle-kit generate` and commit migrations/.");
}

// Migrate BEFORE stamping: `app_identity` is part of the schema, so the
// migration creates it. Stamping first left a table the migration then tried
// to create again, which failed the whole boot on a fresh volume — the exact
// situation this code exists to handle.
migrate(db, { migrationsFolder: migrationsFolder() });
stampIdentity(sqlite);
