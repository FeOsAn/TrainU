import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret, isEncrypted, MissingCredentialKeyError } from "./secrets";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const KEY = "a".repeat(64);

test("a secret round-trips through encryption", () => {
  withEnv({ CREDENTIAL_KEY: KEY }, () => {
    const sealed = encryptSecret("hunter2");
    assert.ok(isEncrypted(sealed));
    assert.ok(!sealed.includes("hunter2"), "the plaintext must not survive in the stored value");
    assert.equal(decryptSecret(sealed), "hunter2");
  });
});

test("the same plaintext encrypts differently every time", () => {
  withEnv({ CREDENTIAL_KEY: KEY }, () => {
    // A fixed IV would let anyone holding the database see that two athletes
    // (or the same athlete across two writes) share a password.
    assert.notEqual(encryptSecret("same"), encryptSecret("same"));
  });
});

test("a tampered ciphertext is rejected rather than silently decrypted", () => {
  withEnv({ CREDENTIAL_KEY: KEY }, () => {
    const sealed = encryptSecret("hunter2");
    const tampered = sealed.slice(0, -4) + "AAAA";
    assert.throws(() => decryptSecret(tampered), "GCM's auth tag is the point — a modified blob must fail, not decode to garbage");
  });
});

test("a passphrase key works as well as a hex key", () => {
  withEnv({ CREDENTIAL_KEY: "a long passphrase that is not hex" }, () => {
    assert.equal(decryptSecret(encryptSecret("hunter2")), "hunter2");
  });
});

test("production refuses to store a credential without a key", () => {
  withEnv({ CREDENTIAL_KEY: undefined, NODE_ENV: "production" }, () => {
    // Fails closed: a forgotten env var must not silently downgrade a Garmin
    // password to plaintext on someone else's infrastructure.
    assert.throws(() => encryptSecret("hunter2"), MissingCredentialKeyError);
  });
});

test("development without a key stores plaintext, and reading it back still works", () => {
  withEnv({ CREDENTIAL_KEY: undefined, NODE_ENV: "development" }, () => {
    const stored = encryptSecret("hunter2");
    assert.equal(stored, "hunter2");
    assert.ok(!isEncrypted(stored));
    assert.equal(decryptSecret(stored), "hunter2");
  });
});

test("a plaintext value written before encryption existed still reads back", () => {
  // Rollout without a migration: old rows pass through, the next write seals them.
  withEnv({ CREDENTIAL_KEY: KEY }, () => {
    assert.equal(decryptSecret("legacy-plaintext-password"), "legacy-plaintext-password");
  });
});

test("an encrypted value with the key removed throws rather than returning ciphertext", () => {
  let sealed = "";
  withEnv({ CREDENTIAL_KEY: KEY }, () => {
    sealed = encryptSecret("hunter2");
  });
  withEnv({ CREDENTIAL_KEY: undefined }, () => {
    // Handing ciphertext to GarminConnect as a password would produce a
    // confusing auth failure instead of naming the real problem.
    assert.throws(() => decryptSecret(sealed), MissingCredentialKeyError);
  });
});

test("the wrong key fails loudly", () => {
  let sealed = "";
  withEnv({ CREDENTIAL_KEY: KEY }, () => {
    sealed = encryptSecret("hunter2");
  });
  withEnv({ CREDENTIAL_KEY: "b".repeat(64) }, () => {
    assert.throws(() => decryptSecret(sealed));
  });
});
