import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteWorkerBackend } from "./lexroom-account.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const KEY = Buffer.alloc(32, 9).toString("base64");
const ANNA = "393331111111";
const BRUNO = "393332222222";
const account = (email: string, password = "") => ({
  email,
  accessToken: `${email}-access-token`,
  password,
  refreshToken: `${email}-refresh-token`,
  accessExpiresAtMs: 5_000,
  connectedAtMs: 1,
});

function open() {
  const databasePath = path.join(tempDirs.make("ada-lexroom-accounts-"), "lexroom-account.sqlite");
  return { databasePath, backend: createSqliteWorkerBackend(undefined, { databasePath }) };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ADA_TOKEN_KEY", KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Lexroom accounts, one per number", () => {
  it("keeps each number's sign-in, saved password and link to itself", () => {
    const { backend } = open();
    try {
      const upsert = (owner: string, record: ReturnType<typeof account>) =>
        backend.execute({ type: "upsertAccount", input: { owner, account: record } });
      upsert(ANNA, account("anna@lexroom.ai", "anna-password"));
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toBeNull();

      upsert(BRUNO, account("bruno@lexroom.ai", "bruno-password"));
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        email: "anna@lexroom.ai",
        password: "anna-password",
      });
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toMatchObject({
        email: "bruno@lexroom.ai",
        password: "bruno-password",
      });

      // Replacing or clearing one number's account leaves the other's alone.
      upsert(ANNA, account("anna.new@lexroom.ai"));
      backend.execute({ type: "clearAccount", input: { owner: ANNA } });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toBeNull();
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toMatchObject({
        email: "bruno@lexroom.ai",
      });
    } finally {
      void backend.close();
    }
  });

  it("keeps each number's pending link apart and refuses another number's nonce", () => {
    const { backend } = open();
    try {
      for (const [owner, nonce] of [
        [ANNA, "pending-nonce-anna-0001"],
        [BRUNO, "pending-nonce-bruno-001"],
      ] as const) {
        backend.execute({ type: "replacePending", input: { owner, nonce, expiresAtMs: 900 } });
      }
      const has = (owner: string, nonce: string) =>
        backend.execute({ type: "hasPending", input: { owner, nonce, nowMs: 10 } });
      expect(has(ANNA, "pending-nonce-anna-0001")).toBe(true);
      expect(has(BRUNO, "pending-nonce-bruno-001")).toBe(true);
      expect(has(ANNA, "pending-nonce-bruno-001")).toBe(false);
      expect(has(BRUNO, "pending-nonce-anna-0001")).toBe(false);
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: BRUNO, nonce: "pending-nonce-anna-0001", nowMs: 10 },
        }),
      ).toBe(false);
      expect(has(ANNA, "pending-nonce-anna-0001")).toBe(true);
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: ANNA, nonce: "pending-nonce-anna-0001", nowMs: 10 },
        }),
      ).toBe(true);
      expect(has(BRUNO, "pending-nonce-bruno-001")).toBe(true);
    } finally {
      void backend.close();
    }
  });

  it("moves the single account saved before accounts belonged to a number to the lawyer, encrypted data intact", () => {
    const { databasePath, backend: fresh } = open();
    // Saved the way the previous release saved it: one row under a fixed id, encrypted.
    fresh.execute({
      type: "upsertAccount",
      input: { owner: ANNA, account: account("old@lexroom.ai", "old-password") },
    });
    void fresh.close();
    const db = new DatabaseSync(databasePath);
    db.exec("UPDATE vera_lexroom_account SET id = 'lawyer'");
    db.exec(
      "INSERT INTO vera_lexroom_pending (nonce, expires_at_ms, owner) VALUES ('legacy-pending-nonce-1', 99999, '')",
    );
    db.close();

    const backend = createSqliteWorkerBackend(undefined, { databasePath });
    try {
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toBeNull();
      expect(
        backend.execute({
          type: "hasPending",
          input: { owner: ANNA, nonce: "legacy-pending-nonce-1", nowMs: 1 },
        }),
      ).toBe(false);

      expect(backend.execute({ type: "adoptLegacy", input: { owner: ANNA } })).toBe(true);
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        email: "old@lexroom.ai",
        password: "old-password",
        accessToken: "old@lexroom.ai-access-token",
      });
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toBeNull();
      expect(backend.execute({ type: "adoptLegacy", input: { owner: ANNA } })).toBe(false);
    } finally {
      void backend.close();
    }
  });

  it("refuses anything that is not a phone number as an owner", () => {
    const { backend } = open();
    try {
      for (const owner of ["lawyer", "", "123", "393331111111 OR 1=1"]) {
        expect(() => backend.execute({ type: "readAccount", input: { owner } })).toThrow(
          /owner is invalid/u,
        );
      }
    } finally {
      void backend.close();
    }
  });
});
