import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWorkerBackend } from "./google-account.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ANNA = "393331111111";
const BRUNO = "393332222222";
const ACCOUNT = {
  email: "anna@example.com",
  refreshToken: "test-refresh-token",
  accessToken: "test-access-token",
  accessExpiresAtMs: 1_000,
  connectedAtMs: 500,
  scopes: "https://www.googleapis.com/auth/gmail.send",
};

function open(name = "ada-google-") {
  const databasePath = path.join(tempDirs.make(name), "google-account.sqlite");
  return { databasePath, backend: createSqliteWorkerBackend(undefined, { databasePath }) };
}

describe("ada google account store", () => {
  it("keeps one pending connect and one account per number", () => {
    const { backend } = open();
    try {
      backend.execute({
        type: "replacePending",
        input: { owner: ANNA, nonce: "pending-nonce-aaaaaa", expiresAtMs: 200 },
      });
      backend.execute({
        type: "replacePending",
        input: { owner: ANNA, nonce: "pending-nonce-bbbbbb", expiresAtMs: 300 },
      });
      const consume = (nonce: string, nowMs: number, owner = ANNA) =>
        backend.execute({ type: "consumePending", input: { owner, nonce, nowMs } });
      expect(consume("pending-nonce-aaaaaa", 50)).toBe(false);
      expect(consume("pending-nonce-bbbbbb", 250)).toBe(true);
      expect(consume("pending-nonce-bbbbbb", 250)).toBe(false);
      expect(consume("pending-nonce-cccccc", 10)).toBe(false);

      const upsert = (owner: string, account: typeof ACCOUNT) =>
        backend.execute({ type: "upsertAccount", input: { owner, account } });
      upsert(ANNA, ACCOUNT);
      upsert(ANNA, {
        ...ACCOUNT,
        email: "other@example.com",
        refreshToken: "test-refresh-token-2",
      });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        email: "other@example.com",
        refreshToken: "test-refresh-token-2",
      });
      backend.execute({ type: "clearAccount", input: { owner: ANNA } });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toBeNull();
    } finally {
      void backend.close();
    }
  });

  it("rejects an expired pending connect", () => {
    const { backend } = open("ada-google-expired-");
    try {
      backend.execute({
        type: "replacePending",
        input: { owner: ANNA, nonce: "pending-nonce-expired", expiresAtMs: 100 },
      });
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: ANNA, nonce: "pending-nonce-expired", nowMs: 100 },
        }),
      ).toBe(false);
    } finally {
      void backend.close();
    }
  });

  it("keeps every number's account and link apart", () => {
    const { backend } = open("ada-google-isolated-");
    try {
      backend.execute({ type: "upsertAccount", input: { owner: ANNA, account: ACCOUNT } });
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toBeNull();
      expect(backend.execute({ type: "listOwners", input: undefined })).toEqual([ANNA]);

      backend.execute({
        type: "upsertAccount",
        input: { owner: BRUNO, account: { ...ACCOUNT, email: "bruno@example.com" } },
      });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        email: "anna@example.com",
      });
      expect(backend.execute({ type: "listOwners", input: undefined })).toEqual([ANNA, BRUNO]);

      backend.execute({
        type: "replacePending",
        input: { owner: ANNA, nonce: "pending-nonce-anna-1", expiresAtMs: 900 },
      });
      backend.execute({
        type: "replacePending",
        input: { owner: BRUNO, nonce: "pending-nonce-bruno-1", expiresAtMs: 900 },
      });
      // Bruno's link is not Anna's, and presenting it as hers neither works nor burns it.
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: ANNA, nonce: "pending-nonce-bruno-1", nowMs: 10 },
        }),
      ).toBe(false);
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: BRUNO, nonce: "pending-nonce-bruno-1", nowMs: 10 },
        }),
      ).toBe(true);
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: ANNA, nonce: "pending-nonce-anna-1", nowMs: 10 },
        }),
      ).toBe(true);

      backend.execute({ type: "clearAccount", input: { owner: BRUNO } });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).not.toBeNull();
    } finally {
      void backend.close();
    }
  });

  it("refuses anything that is not a phone number as an owner", () => {
    const { backend } = open("ada-google-owner-");
    try {
      for (const owner of ["lawyer", "", "39333", "+393331111111", "393331111111; DROP"]) {
        expect(() => backend.execute({ type: "readAccount", input: { owner } })).toThrow(
          /owner is invalid/u,
        );
      }
    } finally {
      void backend.close();
    }
  });

  it("moves the account saved before accounts belonged to a number to the lawyer, once", () => {
    const { databasePath, backend: fresh } = open("ada-google-legacy-");
    void fresh.close();
    const old = new DatabaseSync(databasePath);
    old.exec(`INSERT INTO vera_google_account (id, email, refresh_token, access_token, access_expires_at_ms, connected_at_ms, scopes)
      VALUES ('lawyer', 'lawyer@example.com', 'legacy-refresh', 'legacy-access', 5, 7, 'https://www.googleapis.com/auth/gmail.send');
      INSERT INTO vera_google_pending (nonce, expires_at_ms) VALUES ('legacy-pending-nonce-1', 999999);`);
    old.close();

    const backend = createSqliteWorkerBackend(undefined, { databasePath });
    try {
      // A link issued before links named a number belongs to no one and is gone.
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: ANNA, nonce: "legacy-pending-nonce-1", nowMs: 1 },
        }),
      ).toBe(false);
      expect(backend.execute({ type: "listOwners", input: undefined })).toEqual([]);
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toBeNull();

      expect(backend.execute({ type: "adoptLegacy", input: { owner: ANNA } })).toBe(true);
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        email: "lawyer@example.com",
        refreshToken: "legacy-refresh",
        accessToken: "legacy-access",
      });
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toBeNull();
      expect(backend.execute({ type: "adoptLegacy", input: { owner: ANNA } })).toBe(false);
      expect(backend.execute({ type: "listOwners", input: undefined })).toEqual([ANNA]);
    } finally {
      void backend.close();
    }
  });

  it("drops the old row, rather than lend it to someone else, when the lawyer already has an account", () => {
    const { databasePath, backend: fresh } = open("ada-google-legacy-dup-");
    fresh.execute({ type: "upsertAccount", input: { owner: ANNA, account: ACCOUNT } });
    void fresh.close();
    const old = new DatabaseSync(databasePath);
    old.exec(`INSERT INTO vera_google_account (id, email, refresh_token, access_token, access_expires_at_ms, connected_at_ms, scopes)
      VALUES ('lawyer', 'old@example.com', 'legacy-refresh', NULL, NULL, 7, NULL);`);
    old.close();
    const backend = createSqliteWorkerBackend(undefined, { databasePath });
    try {
      expect(backend.execute({ type: "adoptLegacy", input: { owner: ANNA } })).toBe(false);
      expect(backend.execute({ type: "adoptLegacy", input: { owner: BRUNO } })).toBe(false);
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        email: "anna@example.com",
      });
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toBeNull();
    } finally {
      void backend.close();
    }
  });
});
