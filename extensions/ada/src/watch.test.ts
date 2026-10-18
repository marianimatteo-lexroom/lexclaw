import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runCollect = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./service.js", () => ({ runAdaCollectPass: runCollect }));
vi.mock("./memory.js", () => ({ openAdaMemoryFromApi: vi.fn(async () => ({})) }));
const ACCOUNTS = vi.hoisted(() => ({
  byOwner: new Map<string, { email: string }>([
    ["393331111111", { email: "Lawyer@Example.com" }],
    ["393332222222", { email: "bruno@example.com" }],
  ]),
}));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountDbFromApi: async () => ({
    listOwners: async () => [...ACCOUNTS.byOwner.keys()],
    readAccount: async (owner: string) => ACCOUNTS.byOwner.get(owner) ?? null,
  }),
}));

import { createNotifyState, handleAdaGoogleNotify, NOTIFY_MIN_INTERVAL_MS } from "./watch.js";

const NOW_MS = Date.parse("2026-10-14T12:00:00.000Z");
const AUDIENCE = "https://gateway.example/ada/google/notify";
const STATIC_TOKEN = "static-notify-token-0123456789";
const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwt(overrides: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "RS256", kid: "kid-1" });
  const body = encode({
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    exp: NOW_MS / 1000 + 300,
    ...overrides,
  });
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${head}.${body}`), pair.privateKey)
    .toString("base64url");
  return `${head}.${body}.${signature}`;
}

function push(historyId: string | number | null): string {
  const data =
    historyId === null ? "{}" : JSON.stringify({ emailAddress: "Lawyer@example.com", historyId });
  return JSON.stringify({ message: { data: Buffer.from(data).toString("base64") } });
}

function request(options: { method?: string; bearer?: string; body?: string }): IncomingMessage {
  const req = Readable.from([Buffer.from(options.body ?? "")]) as unknown as IncomingMessage;
  req.method = options.method ?? "POST";
  req.headers = options.bearer ? { authorization: `Bearer ${options.bearer}` } : {};
  return req;
}

function response() {
  const headers = new Map<string, string>();
  return {
    statusCode: 0,
    headers,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end() {},
  };
}

function api(config: Record<string, unknown>): OpenClawPluginApi {
  return {
    pluginConfig: config,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    runtime: { hooks: {} },
  } as unknown as OpenClawPluginApi;
}

const JWT_CONFIG = { googleNotifyAudience: AUDIENCE };

describe("handleAdaGoogleNotify", () => {
  let nowMs = NOW_MS;
  let certs: { getKey: ReturnType<typeof vi.fn> };
  let state = createNotifyState();
  const deps = () => ({ certs, now: () => nowMs, state });
  const call = async (
    config: Record<string, unknown>,
    options: Parameters<typeof request>[0],
  ): Promise<number> => {
    const res = response();
    await handleAdaGoogleNotify(
      request(options),
      res as unknown as ServerResponse,
      api(config),
      deps(),
    );
    return res.statusCode;
  };

  beforeEach(() => {
    nowMs = NOW_MS;
    state = createNotifyState();
    runCollect.mockClear();
    certs = { getKey: vi.fn(async (kid: string) => (kid === "kid-1" ? pair.publicKey : null)) };
  });

  it("collects for a valid Google OIDC token, for the number that owns the mailbox only", async () => {
    expect(await call(JWT_CONFIG, { bearer: jwt(), body: push(100) })).toBe(204);
    expect(runCollect).toHaveBeenCalledTimes(1);
    expect(runCollect).toHaveBeenCalledWith(expect.objectContaining({ owner: "393331111111" }));
  });

  it("rate-limits each mailbox on its own, so one mailbox's push never delays another's", async () => {
    const forMailbox = (mailbox: string, historyId: number) =>
      JSON.stringify({
        message: {
          data: Buffer.from(JSON.stringify({ emailAddress: mailbox, historyId })).toString(
            "base64",
          ),
        },
      });
    expect(
      await call(JWT_CONFIG, { bearer: jwt(), body: forMailbox("lawyer@example.com", 10) }),
    ).toBe(204);
    expect(
      await call(JWT_CONFIG, { bearer: jwt(), body: forMailbox("lawyer@example.com", 11) }),
    ).toBe(429);
    expect(
      await call(JWT_CONFIG, { bearer: jwt(), body: forMailbox("bruno@example.com", 10) }),
    ).toBe(204);
    expect(runCollect).toHaveBeenCalledTimes(2);
    expect(runCollect.mock.calls.map(([params]) => (params as { owner: string }).owner)).toEqual([
      "393331111111",
      "393332222222",
    ]);
  });

  it("acknowledges a push for a mailbox no number connected without collecting for anyone", async () => {
    const stranger = JSON.stringify({
      message: {
        data: Buffer.from(
          JSON.stringify({ emailAddress: "stranger@example.com", historyId: 5 }),
        ).toString("base64"),
      },
    });
    expect(await call(JWT_CONFIG, { bearer: jwt(), body: stranger })).toBe(204);
    expect(runCollect).not.toHaveBeenCalled();
  });

  it("rejects invalid, expired, wrong-audience, and missing credentials", async () => {
    const body = push(100);
    expect(await call(JWT_CONFIG, { bearer: jwt({ exp: NOW_MS / 1000 - 600 }), body })).toBe(401);
    expect(await call(JWT_CONFIG, { bearer: jwt({ aud: "https://other.example" }), body })).toBe(
      401,
    );
    expect(await call(JWT_CONFIG, { bearer: `${jwt().slice(0, -4)}AAAA`, body })).toBe(401);
    expect(await call(JWT_CONFIG, { body })).toBe(401);
    expect(await call({}, { bearer: jwt(), body })).toBe(401);
    expect(await call(JWT_CONFIG, { method: "GET", bearer: jwt() })).toBe(405);
    expect(runCollect).not.toHaveBeenCalled();
  });

  it("answers 503 when Google's signing keys cannot be fetched", async () => {
    const { GoogleCertsUnavailableError } = await import("./google-push-auth.js");
    certs.getKey.mockRejectedValue(new GoogleCertsUnavailableError("down"));
    expect(await call(JWT_CONFIG, { bearer: jwt(), body: push(100) })).toBe(503);
  });

  it("keeps the static bearer as a constant-time fallback", async () => {
    const config = { ...JWT_CONFIG, googleNotifyToken: STATIC_TOKEN };
    expect(await call(config, { bearer: STATIC_TOKEN, body: push(100) })).toBe(204);
    expect(await call(config, { bearer: `${STATIC_TOKEN}x`, body: push(101) })).toBe(401);
    expect(await call({ googleNotifyToken: "short" }, { bearer: "short", body: push(1) })).toBe(
      401,
    );
    expect(runCollect).toHaveBeenCalledTimes(1);
  });

  it("skips work when the push has no new history", async () => {
    const config = { googleNotifyToken: STATIC_TOKEN };
    const bearer = STATIC_TOKEN;
    expect(await call(config, { bearer, body: push(null) })).toBe(204);
    expect(await call(config, { bearer, body: "not json" })).toBe(204);
    expect(await call(config, { bearer, body: push(200) })).toBe(204);
    expect(runCollect).toHaveBeenCalledTimes(1);
    nowMs += NOTIFY_MIN_INTERVAL_MS + 1;
    expect(await call(config, { bearer, body: push(200) })).toBe(204);
    expect(await call(config, { bearer, body: push(150) })).toBe(204);
    expect(runCollect).toHaveBeenCalledTimes(1);
    expect(await call(config, { bearer, body: push(201) })).toBe(204);
    expect(runCollect).toHaveBeenCalledTimes(2);
  });

  it("rate limits collect passes and lets the same push retry later", async () => {
    const config = { googleNotifyToken: STATIC_TOKEN };
    const bearer = STATIC_TOKEN;
    expect(await call(config, { bearer, body: push(10) })).toBe(204);
    expect(await call(config, { bearer, body: push(11) })).toBe(429);
    nowMs += NOTIFY_MIN_INTERVAL_MS;
    expect(await call(config, { bearer, body: push(11) })).toBe(204);
    expect(runCollect).toHaveBeenCalledTimes(2);
  });

  it("does not record history when the collect pass fails", async () => {
    const config = { googleNotifyToken: STATIC_TOKEN };
    runCollect.mockRejectedValueOnce(new Error("boom"));
    expect(await call(config, { bearer: STATIC_TOKEN, body: push(10) })).toBe(500);
    nowMs += NOTIFY_MIN_INTERVAL_MS;
    expect(await call(config, { bearer: STATIC_TOKEN, body: push(10) })).toBe(204);
    expect(runCollect).toHaveBeenCalledTimes(2);
  });
});
