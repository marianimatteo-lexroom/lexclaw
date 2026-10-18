import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteWorkerBackend as createGoogleBackend } from "./google-account.worker.js";
import { createSqliteWorkerBackend as createLexroomBackend } from "./lexroom-account.worker.js";
import { resolveTokenCipher } from "./token-crypto.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const OWNER = "393331111111";
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("hex");

const GOOGLE = {
  email: "lawyer@example.com",
  refreshToken: "google-refresh-token-plain",
  accessToken: "google-access-token-plain",
  accessExpiresAtMs: 1_000,
  connectedAtMs: 500,
  scopes: "https://www.googleapis.com/auth/gmail.send",
};
const LEXROOM = {
  email: "lawyer@example.com",
  accessToken: "lexroom-access-token-plain",
  password: "lexroom-password-plain",
  refreshToken: "lexroom-refresh-token-plain",
  accessExpiresAtMs: 1_000,
  connectedAtMs: 500,
};

function rawRow(dbPath: string, table: string): Record<string, unknown> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function useKey(key: string | undefined, nodeEnv = "test") {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("ADA_TOKEN_KEY", key ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("token cipher", () => {
  it("round-trips, uses a fresh nonce, and binds the value to its column", () => {
    useKey(KEY_A);
    const cipher = resolveTokenCipher();
    const first = cipher.seal("secret-value", "table.column");
    expect(first).not.toContain("secret-value");
    expect(first).not.toBe(cipher.seal("secret-value", "table.column"));
    expect(cipher.open(first, "table.column")).toEqual({ value: "secret-value", legacy: false });
    expect(() => cipher.open(first, "table.other")).toThrow(/Could not decrypt/);
  });

  it("rejects a wrong key and a malformed key", () => {
    useKey(KEY_A);
    const sealed = resolveTokenCipher().seal("secret-value", "ctx");
    useKey(KEY_B);
    expect(() => resolveTokenCipher().open(sealed, "ctx")).toThrow(/differs from the key/);
    useKey("too-short");
    expect(() => resolveTokenCipher()).toThrow(/32 bytes/);
  });

  it("requires a key in production and only there", () => {
    useKey(undefined, "production");
    expect(() => resolveTokenCipher()).toThrow(/ADA_TOKEN_KEY is required in production/);
    useKey(undefined);
    const cipher = resolveTokenCipher();
    expect(cipher.encrypting).toBe(false);
    expect(cipher.seal("plain", "ctx")).toBe("plain");
  });

  it("refuses encrypted data when the key is gone", () => {
    useKey(KEY_A);
    const sealed = resolveTokenCipher().seal("secret-value", "ctx");
    useKey(undefined);
    expect(() => resolveTokenCipher().open(sealed, "ctx")).toThrow(/is not set/);
  });
});

describe("encrypted Google account tokens", () => {
  it("stores ciphertext and reads plaintext back", () => {
    useKey(KEY_A);
    const databasePath = path.join(tempDirs.make("ada-google-enc-"), "google-account.sqlite");
    const backend = createGoogleBackend(undefined, { databasePath });
    try {
      backend.execute({ type: "upsertAccount", input: { owner: OWNER, account: GOOGLE } });
      expect(backend.execute({ type: "readAccount", input: { owner: OWNER } })).toEqual(GOOGLE);
    } finally {
      void backend.close();
    }
    const row = rawRow(databasePath, "vera_google_account");
    expect(String(row.refresh_token)).toMatch(/^enc:v1:/);
    expect(String(row.access_token)).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain("plain");
  });

  it("encrypts a legacy plaintext row when it is opened with a key", () => {
    useKey(undefined);
    const databasePath = path.join(tempDirs.make("ada-google-legacy-"), "google-account.sqlite");
    const legacy = createGoogleBackend(undefined, { databasePath });
    try {
      legacy.execute({ type: "upsertAccount", input: { owner: OWNER, account: GOOGLE } });
    } finally {
      void legacy.close();
    }
    expect(rawRow(databasePath, "vera_google_account").refresh_token).toBe(GOOGLE.refreshToken);

    useKey(KEY_A);
    const upgraded = createGoogleBackend(undefined, { databasePath });
    try {
      expect(upgraded.execute({ type: "readAccount", input: { owner: OWNER } })).toEqual(GOOGLE);
    } finally {
      void upgraded.close();
    }
    const row = rawRow(databasePath, "vera_google_account");
    expect(String(row.refresh_token)).toMatch(/^enc:v1:/);
    expect(String(row.access_token)).toMatch(/^enc:v1:/);
  });

  it("keeps a missing access token empty", () => {
    useKey(KEY_A);
    const backend = createGoogleBackend(undefined, {
      databasePath: path.join(tempDirs.make("ada-google-null-"), "google-account.sqlite"),
    });
    try {
      const account = { ...GOOGLE, accessToken: null, accessExpiresAtMs: null };
      backend.execute({ type: "upsertAccount", input: { owner: OWNER, account: account } });
      expect(backend.execute({ type: "readAccount", input: { owner: OWNER } })).toEqual(account);
    } finally {
      void backend.close();
    }
  });

  it("fails to open in production without a key", () => {
    useKey(undefined, "production");
    expect(() =>
      createGoogleBackend(undefined, {
        databasePath: path.join(tempDirs.make("ada-google-prod-"), "google-account.sqlite"),
      }),
    ).toThrow(/ADA_TOKEN_KEY is required in production/);
  });
});

describe("encrypted Lexroom account tokens", () => {
  it("stores ciphertext and reads plaintext back", () => {
    useKey(KEY_A);
    const databasePath = path.join(tempDirs.make("ada-lexroom-enc-"), "lexroom-account.sqlite");
    const backend = createLexroomBackend(undefined, { databasePath });
    try {
      backend.execute({ type: "upsertAccount", input: { owner: OWNER, account: LEXROOM } });
      expect(backend.execute({ type: "readAccount", input: { owner: OWNER } })).toEqual(LEXROOM);
    } finally {
      void backend.close();
    }
    const row = rawRow(databasePath, "vera_lexroom_account");
    expect(String(row.access_token)).toMatch(/^enc:v1:/);
    expect(String(row.refresh_token)).toMatch(/^enc:v1:/);
    expect(String(row.password)).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain("plain");
  });

  it("encrypts a legacy plaintext row when it is opened with a key", () => {
    useKey(undefined);
    const databasePath = path.join(tempDirs.make("ada-lexroom-legacy-"), "lexroom-account.sqlite");
    const legacy = createLexroomBackend(undefined, { databasePath });
    try {
      legacy.execute({ type: "upsertAccount", input: { owner: OWNER, account: LEXROOM } });
    } finally {
      void legacy.close();
    }
    expect(rawRow(databasePath, "vera_lexroom_account").access_token).toBe(LEXROOM.accessToken);

    useKey(KEY_A);
    const upgraded = createLexroomBackend(undefined, { databasePath });
    try {
      expect(upgraded.execute({ type: "readAccount", input: { owner: OWNER } })).toEqual(LEXROOM);
    } finally {
      void upgraded.close();
    }
    const row = rawRow(databasePath, "vera_lexroom_account");
    expect(String(row.access_token)).toMatch(/^enc:v1:/);
    expect(String(row.refresh_token)).toMatch(/^enc:v1:/);
    expect(String(row.password)).toMatch(/^enc:v1:/);
  });

  it("adds the password column to a database created before passwords were kept", () => {
    useKey(KEY_A);
    const databasePath = path.join(tempDirs.make("ada-lexroom-old-"), "lexroom-account.sqlite");
    const old = new DatabaseSync(databasePath);
    old.exec(`CREATE TABLE vera_lexroom_account (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL, access_expires_at_ms INTEGER, connected_at_ms INTEGER NOT NULL
    ) STRICT;
    INSERT INTO vera_lexroom_account VALUES ('lawyer', 'lawyer@example.com', 'old-access-token', '', NULL, 7);`);
    old.close();
    const backend = createLexroomBackend(undefined, { databasePath });
    try {
      backend.execute({ type: "adoptLegacy", input: { owner: OWNER } });
      expect(backend.execute({ type: "readAccount", input: { owner: OWNER } })).toEqual({
        email: "lawyer@example.com",
        accessToken: "old-access-token",
        password: "",
        refreshToken: "",
        accessExpiresAtMs: null,
        connectedAtMs: 7,
      });
    } finally {
      void backend.close();
    }
  });

  it("derives the key from the gateway token when no Ada key is set, and refuses neither in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADA_TOKEN_KEY", "");
    vi.stubEnv("VERA_TOKEN_KEY", "");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-secret-for-test-0123456789");
    const databasePath = path.join(tempDirs.make("ada-lexroom-gw-"), "lexroom-account.sqlite");
    const backend = createLexroomBackend(undefined, { databasePath });
    try {
      backend.execute({ type: "upsertAccount", input: { owner: OWNER, account: LEXROOM } });
      expect(backend.execute({ type: "readAccount", input: { owner: OWNER } })).toEqual(LEXROOM);
    } finally {
      void backend.close();
    }
    expect(String(rawRow(databasePath, "vera_lexroom_account").password)).toMatch(/^enc:v1:/);
  });

  it("fails to open in production without a key", () => {
    useKey(undefined, "production");
    expect(() =>
      createLexroomBackend(undefined, {
        databasePath: path.join(tempDirs.make("ada-lexroom-prod-"), "lexroom-account.sqlite"),
      }),
    ).toThrow(/ADA_TOKEN_KEY is required in production/);
  });
});
