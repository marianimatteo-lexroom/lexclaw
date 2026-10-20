import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRANOLA_REMINDER_INTERVAL_MS } from "./granola-account-contract.js";
import { createSqliteWorkerBackend } from "./granola-account.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ANNA = "393331111111";
const BRUNO = "393332222222";
const ACCOUNT = {
  accessToken: "access-token-secret-anna",
  refreshToken: "refresh-token-secret-anna",
  accessExpiresAtMs: 5_000,
  scope: "openid mcp",
  clientId: "client-1",
  connectedAtMs: 1_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function open() {
  const databasePath = path.join(tempDirs.make("ada-granola-store-"), "granola-account.sqlite");
  return { databasePath, backend: createSqliteWorkerBackend(undefined, { databasePath }) };
}

describe("Granola account store", () => {
  it("encrypts the tokens, the client secret and the PKCE verifier at rest", () => {
    vi.stubEnv("ADA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
    const { databasePath, backend } = open();
    try {
      backend.execute({ type: "upsertAccount", input: { owner: ANNA, account: ACCOUNT } });
      backend.execute({
        type: "saveClient",
        input: {
          client: {
            clientId: "client-1",
            clientSecret: "client-secret-value",
            redirectUri: "https://vera.example/ada/granola/callback",
            registeredAtMs: 1,
            secretExpiresAtMs: null,
          },
        },
      });
      backend.execute({
        type: "replacePending",
        input: {
          owner: ANNA,
          nonce: "pending-nonce-aaaaaa",
          expiresAtMs: 9_000,
          pending: {
            codeVerifier: "verifier-secret-value",
            clientId: "client-1",
            scope: "openid mcp",
          },
        },
      });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        accessToken: ACCOUNT.accessToken,
        refreshToken: ACCOUNT.refreshToken,
      });
      expect(backend.execute({ type: "readClient", input: undefined })).toMatchObject({
        clientSecret: "client-secret-value",
      });
      const raw = new DatabaseSync(databasePath);
      const stored = JSON.stringify([
        raw.prepare("SELECT * FROM ada_granola_account").all(),
        raw.prepare("SELECT * FROM ada_granola_client").all(),
        raw.prepare("SELECT * FROM ada_granola_pending").all(),
      ]);
      raw.close();
      for (const secret of [
        "access-token-secret",
        "refresh-token-secret",
        "client-secret-value",
        "verifier-secret",
      ]) {
        expect(stored).not.toContain(secret);
      }
      expect(stored).toContain("enc:v1:");
    } finally {
      void backend.close();
    }
  });

  it("keeps one account per number, spends a pending connect once, and binds it to its number", () => {
    const { backend } = open();
    try {
      const pending = { codeVerifier: "verifier-value", clientId: "client-1", scope: "openid mcp" };
      backend.execute({
        type: "replacePending",
        input: { owner: ANNA, nonce: "pending-nonce-aaaaaa", expiresAtMs: 200, pending },
      });
      const consume = (owner: string, nonce: string, nowMs: number) =>
        backend.execute({ type: "consumePending", input: { owner, nonce, nowMs } });
      expect(consume(BRUNO, "pending-nonce-aaaaaa", 50)).toBeNull();
      expect(consume(ANNA, "pending-nonce-aaaaaa", 50)).toEqual(pending);
      expect(consume(ANNA, "pending-nonce-aaaaaa", 50)).toBeNull();
      backend.execute({
        type: "replacePending",
        input: { owner: ANNA, nonce: "pending-nonce-bbbbbb", expiresAtMs: 100, pending },
      });
      expect(consume(ANNA, "pending-nonce-bbbbbb", 100)).toBeNull();

      backend.execute({ type: "upsertAccount", input: { owner: ANNA, account: ACCOUNT } });
      backend.execute({
        type: "upsertAccount",
        input: { owner: BRUNO, account: { ...ACCOUNT, accessToken: "access-token-bruno" } },
      });
      expect(backend.execute({ type: "listOwners", input: undefined })).toEqual([ANNA, BRUNO]);
      backend.execute({ type: "clearAccount", input: { owner: ANNA } });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toBeNull();
      expect(backend.execute({ type: "readAccount", input: { owner: BRUNO } })).toMatchObject({
        accessToken: "access-token-bruno",
      });
    } finally {
      void backend.close();
    }
  });

  it("claims the reconnect reminder once per day per number", () => {
    const { backend } = open();
    try {
      const claim = (owner: string, nowMs: number) =>
        backend.execute({ type: "claimReconnectReminder", input: { owner, nowMs } });
      expect(claim(ANNA, 1_000)).toBe(true);
      expect(claim(ANNA, 1_000 + GRANOLA_REMINDER_INTERVAL_MS - 1)).toBe(false);
      expect(claim(BRUNO, 2_000)).toBe(true);
      expect(claim(ANNA, 1_000 + GRANOLA_REMINDER_INTERVAL_MS)).toBe(true);
    } finally {
      void backend.close();
    }
  });

  it("adds its tables without touching an existing database", () => {
    const { databasePath, backend } = open();
    void backend.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec("CREATE TABLE IF NOT EXISTS unrelated (id TEXT)");
    raw.close();
    const reopened = createSqliteWorkerBackend(undefined, { databasePath });
    try {
      const check = new DatabaseSync(databasePath);
      const tables = (
        check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      )
        .map((row) => row.name)
        .filter((name) => name.startsWith("ada_granola_") || name === "unrelated")
        .toSorted();
      check.close();
      expect(tables).toEqual([
        "ada_granola_account",
        "ada_granola_client",
        "ada_granola_pending",
        "ada_granola_reminder",
        "unrelated",
      ]);
    } finally {
      void reopened.close();
    }
  });

  it("adds the pending scope column to a store made before it, and reads old rows as the default", () => {
    const { databasePath, backend } = open();
    void backend.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TABLE ada_granola_pending");
    raw.exec(
      "CREATE TABLE ada_granola_pending (nonce TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, code_verifier TEXT NOT NULL, client_id TEXT NOT NULL) STRICT",
    );
    raw.exec(
      `INSERT INTO ada_granola_pending VALUES ('old-nonce-aaaaaaaaaa', '${ANNA}', 9000, 'plain-verifier', 'client-1')`,
    );
    raw.close();
    const reopened = createSqliteWorkerBackend(undefined, { databasePath });
    try {
      expect(
        reopened.execute({
          type: "consumePending",
          input: { owner: ANNA, nonce: "old-nonce-aaaaaaaaaa", nowMs: 100 },
        }),
      ).toEqual({ codeVerifier: "plain-verifier", clientId: "client-1", scope: "" });
    } finally {
      void reopened.close();
    }
  });
});
