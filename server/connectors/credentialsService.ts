/**
 * Credential persistence, and the one place secrets get encrypted.
 *
 * Every secret crosses this boundary — a Garmin password, a Garmin session
 * token, a Whoop access and refresh token — so encrypting here rather than at
 * each call site means a new connector cannot forget to. The alternative,
 * encrypting in garmin.ts and whoop.ts separately, is two implementations
 * that drift, and the one that drifts writes plaintext.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { garminCredentials, whoopCredentials } from "@shared/schema";
import { decryptSecret, encryptSecret } from "../secrets";

const ROW_ID = "self";

/** null passes through untouched — an absent secret must stay absent, not become ciphertext of "". */
const seal = (v: string | null | undefined): string | null => (v == null ? null : encryptSecret(v));
const open_ = (v: string | null): string | null => (v == null ? null : decryptSecret(v));

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
  return {
    email: row.email,
    password: open_(row.password),
    tokenJson: open_(row.tokenJson),
    tokenExpiresAt: row.tokenExpiresAt,
    authError: row.authError,
  };
}

export function saveGarminCredentials(patch: Partial<GarminCreds>): void {
  const current = getGarminCredentials();
  const merged = { ...current, ...patch };
  const now = new Date().toISOString();
  const values = {
    email: merged.email ?? null,
    password: seal(merged.password),
    tokenJson: seal(merged.tokenJson),
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
  return {
    accessToken: open_(row.accessToken),
    refreshToken: open_(row.refreshToken),
    tokenExpiresAt: row.tokenExpiresAt,
    authError: row.authError,
  };
}

export function saveWhoopCredentials(patch: Partial<WhoopCreds>): void {
  const current = getWhoopCredentials();
  const merged = { ...current, ...patch };
  const now = new Date().toISOString();
  const values = {
    accessToken: seal(merged.accessToken),
    refreshToken: seal(merged.refreshToken),
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
