import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAccountRecord, GoogleAccountStore } from "./google-account-contract.js";
import { handleVeraGoogleCallback } from "./google-callback.js";
import { createConnectState, type GoogleConnectConfig } from "./google-connect.js";

const NOW = new Date("2026-10-09T07:40:00.000Z");
const CONFIG: GoogleConnectConfig = {
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/vera/google/callback",
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

describe("handleVeraGoogleCallback", () => {
  it("stores the Google account once and ignores a replay", async () => {
    const store = memoryStore();
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW);
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
    await handleVeraGoogleCallback(
      {
        method: "GET",
        url: `/vera/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      first as unknown as ServerResponse,
      { config: CONFIG, now: () => NOW, store, exchange, log: { error() {} } },
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
    await handleVeraGoogleCallback(
      {
        method: "GET",
        url: `/vera/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      second as unknown as ServerResponse,
      { config: CONFIG, now: () => NOW, store, exchange, log: { error() {} } },
    );
    expect(second.statusCode).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("does not exchange a code when the lawyer denies consent", async () => {
    const exchange = vi.fn();
    const res = response();
    await handleVeraGoogleCallback(
      { method: "GET", url: "/vera/google/callback?error=access_denied" } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        store: memoryStore(),
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
    const issued = createConnectState(CONFIG.googleStateSecret ?? "", NOW);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const res = response();
    await handleVeraGoogleCallback(
      {
        method: "GET",
        url: `/vera/google/callback?code=test-auth-code&state=${issued.state}`,
      } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => NOW,
        store,
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
});
