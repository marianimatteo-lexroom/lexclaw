import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAccountRecord, GoogleAccountStore } from "./google-account-contract.js";
import { handleAdaGoogleCallback } from "./google-callback.js";
import { createConnectState, type GoogleConnectConfig } from "./google-connect.js";

const NOW = new Date("2026-10-09T07:40:00.000Z");
const OWNER = "393331111111";
const OTHER = "393332222222";
const CONFIG: GoogleConnectConfig = {
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

function memoryStore(): GoogleAccountStore & { account: GoogleAccountRecord | null } {
  const pending = new Map<string, number>();
  let account: GoogleAccountRecord | null = null;
  return {
    get account() {
      return account;
    },
    replacePending: async (nonce, expiresAtMs) => {
      pending.clear();
      pending.set(nonce, expiresAtMs);
    },
    consumePending: async (nonce, nowMs) => {
      const expiresAtMs = pending.get(nonce);
      pending.delete(nonce);
      return expiresAtMs !== undefined && expiresAtMs > nowMs;
    },
    upsertAccount: async (next) => {
      account = next;
    },
    readAccount: async () => account,
    clearAccount: async () => {
      account = null;
    },
  };
}

function response() {
  const headers = new Map<string, string>();
  return {
    statusCode: 0,
    headers,
    body: "",
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(body = "") {
      this.body = body;
    },
  };
}

describe("handleAdaGoogleCallback", () => {
  it("stores the Google account once and ignores a replay", async () => {
    const store = memoryStore();
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OWNER);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const exchange = vi.fn(async () => ({
      ok: true as const,
      token: {
        email: "lawyer@example.com",
        refreshToken: "test-refresh-token",
        accessToken: "test-access-token",
        accessExpiresAtMs: NOW.getTime() + 3_600_000,
      },
    }));
    const first = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      first as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async () => store,
        exchange,
        log: { error() {} },
      },
    );
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain("lawyer@example.com");
    expect(first.body).toContain("Gmail and Google Calendar");
    expect(first.body).toContain("You can close this page and return to WhatsApp.");
    expect(first.body).toContain('name="viewport"');
    expect(first.body).not.toContain("<script");
    expect(first.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(store.account?.refreshToken).toBe("test-refresh-token");

    const second = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      second as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async () => store,
        exchange,
        log: { error() {} },
      },
    );
    expect(second.statusCode).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("does not exchange a code when the user denies consent", async () => {
    const exchange = vi.fn();
    const res = response();
    await handleAdaGoogleCallback(
      { method: "GET", url: "/ada/google/callback?error=access_denied" } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async () => memoryStore(),
        exchange,
        log: { error() {} },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("did not connect");
    expect(res.body).toContain("Not connected");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("escapes the connected account address", async () => {
    const store = memoryStore();
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OWNER);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const res = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async () => store,
        exchange: async () => ({
          ok: true as const,
          token: {
            email: `lawyer+<tag>@example.com`,
            refreshToken: "test-refresh-token",
            accessToken: "test-access-token",
            accessExpiresAtMs: NOW.getTime() + 3_600_000,
          },
        }),
        log: { error() {} },
      },
    );
    expect(res.body).toContain("lawyer+&lt;tag&gt;@example.com");
    expect(res.body).not.toContain("<tag>");
  });

  it("texts WhatsApp after the Google account is stored", async () => {
    const store = memoryStore();
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OWNER);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const notifyConnected = vi.fn(async () => ({ ok: true as const }));
    const res = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async () => store,
        exchange: async () => ({
          ok: true as const,
          token: {
            email: "lawyer@example.com",
            refreshToken: "test-refresh-token",
            accessToken: "test-access-token",
            accessExpiresAtMs: NOW.getTime() + 3_600_000,
          },
        }),
        log: { error() {} },
        notifyConnected,
      },
    );
    expect(res.statusCode).toBe(200);
    expect(notifyConnected).toHaveBeenCalledExactlyOnceWith(OWNER, "lawyer@example.com");
    expect(store.account?.email).toBe("lawyer@example.com");
  });

  it("keeps the account connected when the WhatsApp confirmation fails", async () => {
    const store = memoryStore();
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OWNER);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const errors: string[] = [];
    const res = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async () => store,
        exchange: async () => ({
          ok: true as const,
          token: {
            email: "lawyer@example.com",
            refreshToken: "test-refresh-token",
            accessToken: "test-access-token",
            accessExpiresAtMs: NOW.getTime() + 3_600_000,
          },
        }),
        log: {
          error(message: string) {
            errors.push(message);
          },
        },
        notifyConnected: async () => ({ ok: false as const, error: "outbound down" }),
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Connected");
    expect(store.account?.email).toBe("lawyer@example.com");
    expect(errors).toEqual(["ada google connect confirmation was not sent: outbound down"]);
  });

  it("saves the account for the number that requested the link, and for no other", async () => {
    const stores = new Map<string, ReturnType<typeof memoryStore>>();
    const storeFor = (owner: string) => {
      let store = stores.get(owner);
      if (!store) {
        store = memoryStore();
        stores.set(owner, store);
      }
      return store;
    };
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OWNER);
    await storeFor(OWNER).replacePending(issued.nonce, issued.expiresAtMs);
    // Someone else opens Anna's link and signs in with their own Google account.
    const notified: string[] = [];
    const res = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async (owner) => storeFor(owner),
        exchange: async () => ({
          ok: true as const,
          token: {
            email: "someone.else@example.com",
            refreshToken: "test-refresh-token",
            accessToken: "test-access-token",
            accessExpiresAtMs: NOW.getTime() + 3_600_000,
          },
        }),
        log: { error() {} },
        notifyConnected: async (owner) => {
          notified.push(owner);
          return { ok: true as const };
        },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(storeFor(OWNER).account?.email).toBe("someone.else@example.com");
    expect(storeFor(OTHER).account).toBeNull();
    expect(notified).toEqual([OWNER]);
  });

  it("does not let a link issued to one number consume another number's pending connect", async () => {
    const owner = memoryStore();
    const other = memoryStore();
    const issuedOther = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OTHER);
    await other.replacePending(issuedOther.nonce, issuedOther.expiresAtMs);
    // A state signed for OWNER, carrying a nonce that was only ever issued to OTHER.
    const forged = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OWNER);
    const exchange = vi.fn();
    const res = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${forged.state}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async (who) => (who === OWNER ? owner : other),
        exchange,
        log: { error() {} },
      },
    );
    expect(res.statusCode).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
    expect(owner.account).toBeNull();
    expect(other.account).toBeNull();
  });

  it("gives the mailbox to the connecting number after saving, and a failure there never fails the connect", async () => {
    const store = memoryStore();
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW, OWNER);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const order: string[] = [];
    const errors: string[] = [];
    const res = response();
    await handleAdaGoogleCallback(
      {
        method: "GET",
        url: `/ada/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        openStore: async () => store,
        exchange: async () => ({
          ok: true as const,
          token: {
            email: "shared@example.com",
            refreshToken: "test-refresh-token",
            accessToken: "test-access-token",
            accessExpiresAtMs: NOW.getTime() + 3_600_000,
          },
        }),
        log: {
          error(message: string) {
            errors.push(message);
          },
        },
        releaseMailbox: async (owner, email) => {
          order.push(`release:${owner}:${email}:saved=${store.account !== null}`);
          throw new Error("db busy");
        },
        notifyConnected: async () => {
          order.push("notify");
          return { ok: true as const };
        },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(order).toEqual([`release:${OWNER}:shared@example.com:saved=true`, "notify"]);
    expect(errors).toEqual(["ada google mailbox release failed: db busy"]);
  });
});
