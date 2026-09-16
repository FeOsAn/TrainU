/**
 * Encryption for third-party credentials held at rest.
 *
 * Garmin has no OAuth for a hobbyist app (see connectors/garmin.ts), so the
 * only way to sync is to hold the athlete's actual Garmin account password.
 * On a laptop, storing that in a local SQLite file is roughly as safe as the
 * laptop. On a hosted deployment it is a real credential sitting in a
 * database on someone else's infrastructure, and anyone who gets a copy of
 * the volume gets the password to a Garmin account — which is very often the
 * same password as something else.
 *
 * AES-256-GCM under a key from the environment. The key never touches the
 * database, so a leaked volume yields ciphertext.
 *
 * Fails CLOSED in production: with no CREDENTIAL_KEY, storing a credential
 * throws rather than silently writing plaintext. A forgotten env var must not
 * quietly downgrade the protection.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const PREFIX = "enc.v1:";

export class MissingCredentialKeyError extends Error {}

function keyMaterial(): Buffer | undefined {
  const raw = process.env.CREDENTIAL_KEY;
  if (!raw) return undefined;
  // Accept a 64-char hex key directly; otherwise stretch whatever was given.
  // The salt is fixed because the key must survive restarts — this is key
  // derivation for convenience, not password hashing.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return scryptSync(raw, "trainu-credential-key-v1", 32);
}

export function credentialKeyConfigured(): boolean {
  return keyMaterial() !== undefined;
}

/** Encrypt a secret for storage. Returns a self-describing string. */
export function encryptSecret(plaintext: string): string {
  const key = keyMaterial();
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new MissingCredentialKeyError(
        "Refusing to store a third-party credential in plaintext. Set CREDENTIAL_KEY (32 random bytes as hex) and try again.",
      );
    }
    // Development convenience only, and marked so `decryptSecret` knows.
    return plaintext;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a stored secret. A value written before encryption existed (or in
 * development without a key) comes back unchanged, so this can be rolled out
 * without a migration — the next write encrypts it.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = keyMaterial();
  if (!key) {
    throw new MissingCredentialKeyError(
      "A stored credential is encrypted but CREDENTIAL_KEY is not set. Set the same key the credential was written with.",
    );
  }
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Stored credential is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** True when the value is stored encrypted — used by tests and the connector status endpoint. */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}
