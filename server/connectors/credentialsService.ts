import { eq } from "drizzle-orm";
import { db } from "../db";
import { garminCredentials, whoopCredentials } from "@shared/schema";

const ROW_ID = "self";

export interface GarminCreds {
  email: string | null;
  password: string | null;
  tokenJson: string | null;
  tokenExpiresAt: string | null;
  authError: string | null;
}

export function getGarminCredentials(): GarminCreds | null {
  const row = db.select().from(garminCredentials).where(eq(garminCredentials.id, ROW_ID)).get();
  if (!row) return null;
  return { email: row.email, password: row.password, tokenJson: row.tokenJson, tokenExpiresAt: row.tokenExpiresAt, authError: row.authError };
}

export function saveGarminCredentials(patch: Partial<GarminCreds>): void {
  const current = getGarminCredentials();
  const merged = { ...current, ...patch };
  const now = new Date().toISOString();
  const values = {
    email: merged.email ?? null,
    password: merged.password ?? null,
    tokenJson: merged.tokenJson ?? null,
    tokenExpiresAt: merged.tokenExpiresAt ?? null,
    authError: merged.authError ?? null,
    updatedAt: now,
  };
  if (current) {
    db.update(garminCredentials).set(values).where(eq(garminCredentials.id, ROW_ID)).run();
  } else {
    db.insert(garminCredentials).values({ id: ROW_ID, ...values }).run();
  }
}

export interface WhoopCreds {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  authError: string | null;
}

export function getWhoopCredentials(): WhoopCreds | null {
  const row = db.select().from(whoopCredentials).where(eq(whoopCredentials.id, ROW_ID)).get();
  if (!row) return null;
  return { accessToken: row.accessToken, refreshToken: row.refreshToken, tokenExpiresAt: row.tokenExpiresAt, authError: row.authError };
}

export function saveWhoopCredentials(patch: Partial<WhoopCreds>): void {
  const current = getWhoopCredentials();
  const merged = { ...current, ...patch };
  const now = new Date().toISOString();
  const values = {
    accessToken: merged.accessToken ?? null,
    refreshToken: merged.refreshToken ?? null,
    tokenExpiresAt: merged.tokenExpiresAt ?? null,
    authError: merged.authError ?? null,
    updatedAt: now,
  };
  if (current) {
    db.update(whoopCredentials).set(values).where(eq(whoopCredentials.id, ROW_ID)).run();
  } else {
    db.insert(whoopCredentials).values({ id: ROW_ID, ...values }).run();
  }
}
