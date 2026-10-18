import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import type { GoogleAccountRecord, GoogleAccountStore } from "./google-account-contract.js";
import { createSqliteWorkerBackend } from "./google-account.worker.js";
import { readConnectedInbox, saveRefreshedAccount } from "./google-tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ANNA = "393331111111";
const BRUNO = "393332222222";
const NOW = new Date("2026-10-18T07:40:00.000Z");
const CONFIG = {
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-0123456789",
};
const ACCOUNT: GoogleAccountRecord = {
  email: "shared@example.com",
  refreshToken: "refresh-token-old",
  accessToken: "access-old",
  accessExpiresAtMs: NOW.getTime() - 1_000,
  connectedAtMs: 500,
  scopes: "https://www.googleapis.com/auth/gmail.send",
};
const RECONNECTED: GoogleAccountRecord = {
  ...ACCOUNT,
  refreshToken: "refresh-token-new",
  accessToken: "access-new",
  accessExpiresAtMs: NOW.getTime() + 3_600_000,
  connectedAtMs: 900,
};
const REFRESHED = { accessToken: "access-refreshed", accessExpiresAtMs: NOW.getTime() + 3_600_000 };

function open() {
  const databasePath = path.join(tempDirs.make("ada-google-race-"), "google-account.sqlite");
  const backend = createSqliteWorkerBackend(undefined, { databasePath });
  const storeFor = (owner: string): GoogleAccountStore => ({
    replacePending: async (nonce, expiresAtMs) =>
      backend.execute({ type: "replacePending", input: { owner, nonce, expiresAtMs } }),
    consumePending: async (nonce, nowMs) =>
      backend.execute({ type: "consumePending", input: { owner, nonce, nowMs } }),
    upsertAccount: async (account) =>
      backend.execute({ type: "upsertAccount", input: { owner, account } }),
    readAccount: async () => backend.execute({ type: "readAccount", input: { owner } }),
    clearAccount: async () => backend.execute({ type: "clearAccount", input: { owner } }),
    updateTokensIfStill: async (expected, tokens) =>
      backend.execute({ type: "updateTokensIfStill", input: { owner, expected, tokens } }),
    clearAccountIfStill: async (expected) =>
      backend.execute({ type: "clearAccountIfStill", input: { owner, expected } }),
  });
  return { backend, storeFor };
}

const invalidGrant = () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

describe("the account row only changes while it is still the one that was read", () => {
  it("updates tokens only for the same refresh token and sign-in time, and keeps everything else", async () => {
    const { backend, storeFor } = open();
    try {
      const anna = storeFor(ANNA);
      await anna.upsertAccount(ACCOUNT);
      expect(
        await anna.updateTokensIfStill(
          { ...ACCOUNT, refreshToken: "refresh-token-other" },
          REFRESHED,
        ),
      ).toBe(false);
      expect(await anna.updateTokensIfStill({ ...ACCOUNT, connectedAtMs: 501 }, REFRESHED)).toBe(
        false,
      );
      expect(await anna.readAccount()).toEqual(ACCOUNT);

      expect(await anna.updateTokensIfStill(ACCOUNT, REFRESHED)).toBe(true);
      expect(await anna.readAccount()).toEqual({ ...ACCOUNT, ...REFRESHED });

      expect(
        await anna.updateTokensIfStill(ACCOUNT, {
          ...REFRESHED,
          refreshToken: "refresh-token-rot",
        }),
      ).toBe(true);
      expect(await anna.readAccount()).toMatchObject({ refreshToken: "refresh-token-rot" });
    } finally {
      void backend.close();
    }
  });

  it("clears only the row that failed, for that number only", async () => {
    const { backend, storeFor } = open();
    try {
      const [anna, bruno] = [storeFor(ANNA), storeFor(BRUNO)];
      await anna.upsertAccount(ACCOUNT);
      await bruno.upsertAccount({ ...ACCOUNT, email: "bruno@example.com" });
      expect(await anna.clearAccountIfStill(RECONNECTED)).toBe(false);
      expect(await anna.readAccount()).not.toBeNull();
      expect(await anna.clearAccountIfStill(ACCOUNT)).toBe(true);
      expect(await anna.readAccount()).toBeNull();
      expect(await bruno.readAccount()).not.toBeNull();
      expect(await anna.clearAccountIfStill(ACCOUNT)).toBe(false);
    } finally {
      void backend.close();
    }
  });
});

describe("a token refresh that was in flight while the row changed", () => {
  it("does not bring a mailbox back to the number it moved away from", async () => {
    const { backend, storeFor } = open();
    try {
      const [anna, bruno] = [storeFor(ANNA), storeFor(BRUNO)];
      await anna.upsertAccount(ACCOUNT);
      const readBeforeRefresh = (await anna.readAccount())!;
      // The same mailbox is connected from Bruno's number: Anna's row is released.
      await anna.clearAccount();
      await bruno.upsertAccount(RECONNECTED);

      await saveRefreshedAccount(anna, readBeforeRefresh, REFRESHED);

      expect(await anna.readAccount()).toBeNull();
      expect(await bruno.readAccount()).toEqual(RECONNECTED);
    } finally {
      void backend.close();
    }
  });

  it("does not put an old token over a fresh reconnect", async () => {
    const { backend, storeFor } = open();
    try {
      const anna = storeFor(ANNA);
      await anna.upsertAccount(ACCOUNT);
      const readBeforeRefresh = (await anna.readAccount())!;
      await anna.upsertAccount(RECONNECTED);

      await saveRefreshedAccount(anna, readBeforeRefresh, {
        ...REFRESHED,
        refreshToken: "refresh-token-rotated",
      });

      expect(await anna.readAccount()).toEqual(RECONNECTED);
    } finally {
      void backend.close();
    }
  });

  it("does not delete a new sign-in when the old one's refresh is rejected late", async () => {
    const { backend, storeFor } = open();
    try {
      const anna = storeFor(ANNA);
      await anna.upsertAccount(ACCOUNT);
      const fetchImpl = (async () => {
        await anna.upsertAccount(RECONNECTED);
        return invalidGrant();
      }) as unknown as typeof fetch;

      const result = await readConnectedInbox({ config: CONFIG, store: anna, now: NOW, fetchImpl });

      expect(result).toMatchObject({ ok: false, reason: "not_connected" });
      expect(await anna.readAccount()).toEqual(RECONNECTED);
    } finally {
      void backend.close();
    }
  });

  it("still drops the account when Google rejects the sign-in that is saved", async () => {
    const { backend, storeFor } = open();
    try {
      const anna = storeFor(ANNA);
      await anna.upsertAccount(ACCOUNT);
      const fetchImpl = (async () => invalidGrant()) as unknown as typeof fetch;

      await readConnectedInbox({ config: CONFIG, store: anna, now: NOW, fetchImpl });

      expect(await anna.readAccount()).toBeNull();
    } finally {
      void backend.close();
    }
  });
});
