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
import path from "node:path";
import fs from "node:fs";
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
stampIdentity(sqlite);
