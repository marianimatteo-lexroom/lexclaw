import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { LexroomAccountStore } from "./lexroom-account-contract.js";
import { createConnectState } from "./lexroom-connect.js";
import { handleVeraLexroomConnect } from "./lexroom-connect-http.js";

const SECRET = "0123456789abcdef";

function createStore(): LexroomAccountStore & {
  pending: Map<string, number>;
  account: Awaited<ReturnType<LexroomAccountStore["readAccount"]>>;
} {
  const pending = new Map<string, number>();
  const store = {
    pending,
    account: null as Awaited<ReturnType<LexroomAccountStore["readAccount"]>>,
    async replacePending(nonce: string, expiresAtMs: number) {
      pending.clear();
      pending.set(nonce, expiresAtMs);
    },
    async hasPending(nonce: string, nowMs: number) {
      const exp = pending.get(nonce);
      return typeof exp === "number" && exp > nowMs;
    },
    async consumePending(nonce: string, nowMs: number) {
      const exp = pending.get(nonce);
      pending.delete(nonce);
      return typeof exp === "number" && exp > nowMs;
    },
    async upsertAccount(account) {
      store.account = account;
    },
    async readAccount() {
      return store.account;
    },
    async clearAccount() {
      store.account = null;
    },
  } satisfies LexroomAccountStore & {
    pending: Map<string, number>;
    account: Awaited<ReturnType<LexroomAccountStore["readAccount"]>>;
  };
  return store;
}

function mockRes() {
  const headers = new Map<string, string>();
  let body = "";
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  };
  return {
    res: res as unknown as ServerResponse,
    headers,
    body: () => body,
  };
}

function mockReq(params: {
  method: string;
  url: string;
  body?: string;
}): IncomingMessage {
  const chunks = params.body === undefined ? [] : [Buffer.from(params.body)];
  let index = 0;
  return {
    method: params.method,
    url: params.url,
    async *[Symbol.asyncIterator]() {
      while (index < chunks.length) {
        yield chunks[index++]!;
      }
    },
  } as IncomingMessage;
}

describe("handleVeraLexroomConnect", () => {
  it("shows the login form for a valid pending state", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const store = createStore();
    const issued = createConnectState(SECRET, now);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const out = mockRes();
    await handleVeraLexroomConnect(
      mockReq({ method: "GET", url: `/vera/lexroom/connect?state=${issued.state}` }),
      out.res,
      {
        config: {
          lexroomConnectUri: "https://gateway.example/vera/lexroom/connect",
          lexroomStateSecret: SECRET,
        },
        now: () => now,
        store,
        log: { error: vi.fn() },
      },
    );
    expect(out.res.statusCode).toBe(200);
    expect(out.body()).toContain("Connect Lexroom");
    expect(out.body()).toContain(`name="state" value="${issued.state}"`);
  });

  it("redisplays MFA as HTTP 200 with a sealed ticket", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const store = createStore();
    const issued = createConnectState(SECRET, now);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const out = mockRes();
    await handleVeraLexroomConnect(
      mockReq({
        method: "POST",
        url: "/vera/lexroom/connect",
        body: new URLSearchParams({
          state: issued.state,
          email: "lawyer@lexroom.ai",
          password: "secret",
        }).toString(),
      }),
      out.res,
      {
        config: {
          lexroomConnectUri: "https://gateway.example/vera/lexroom/connect",
          lexroomStateSecret: SECRET,
        },
        now: () => now,
        store,
        log: { error: vi.fn() },
        login: async () => ({
          ok: false,
          reason: "mfa_required",
          mfaTicket: "ticket-1",
          method: "totp",
          error: "Lexroom needs a one-time code from your authenticator.",
        }),
      },
    );
    expect(out.res.statusCode).toBe(200);
    expect(out.body()).toContain('name="mfaTicket" value="ticket-1"');
    expect(out.body()).toContain('name="otp"');
    expect(out.body()).toContain("Verify and connect");
    expect(store.pending.size).toBe(1);
  });

  it("stores the account after a successful login POST", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const store = createStore();
    const issued = createConnectState(SECRET, now);
    await store.replacePending(issued.nonce, issued.expiresAtMs);
    const out = mockRes();
    const notify = vi.fn(async () => ({ ok: true as const }));
    const access = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ exp: Math.floor(now.getTime() / 1000) + 3600 })).toString(
        "base64url",
      ),
      "sig",
    ].join(".");
    await handleVeraLexroomConnect(
      mockReq({
        method: "POST",
        url: "/vera/lexroom/connect",
        body: new URLSearchParams({
          state: issued.state,
          email: "lawyer@lexroom.ai",
          password: "secret",
        }).toString(),
      }),
      out.res,
      {
        config: {
          lexroomConnectUri: "https://gateway.example/vera/lexroom/connect",
          lexroomStateSecret: SECRET,
        },
        now: () => now,
        store,
        log: { error: vi.fn() },
        notifyConnected: notify,
        login: async () => ({
          ok: true,
          email: "lawyer@lexroom.ai",
          accessToken: access,
          refreshToken: "refresh",
          accessExpiresAtMs: now.getTime() + 3_600_000,
        }),
      },
    );
    expect(out.res.statusCode).toBe(200);
    expect(out.body()).toContain("Connected");
    expect(store.account?.email).toBe("lawyer@lexroom.ai");
    expect(store.account?.accessToken).toBe(access);
    expect(notify).toHaveBeenCalledWith("lawyer@lexroom.ai");
    expect(store.pending.size).toBe(0);
  });
});
