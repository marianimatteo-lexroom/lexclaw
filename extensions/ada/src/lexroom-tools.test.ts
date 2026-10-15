import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomAccountRecord, LexroomAccountStore } from "./lexroom-account-contract.js";

const openAdaLexroomAccountFromApi = vi.hoisted(() => vi.fn());

vi.mock("./lexroom-account.js", () => ({ openAdaLexroomAccountFromApi }));

import {
  executeAdaDraft,
  executeAdaLexroomConnect,
  executeAdaResearch,
  lexroomConnectedText,
  resolveLexroomConfig,
  sendLexroomConnectedNotice,
} from "./lexroom-tools.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const api = { logger, runtimeSource: "/fake/index.ts", runtime: {} } as never;

const CONNECT_CONFIG = {
  lexroomConnectUri: "https://gateway.example/ada/lexroom/connect",
  lexroomStateSecret: "0123456789abcdef",
};

function account(overrides: Partial<LexroomAccountRecord> = {}): LexroomAccountRecord {
  return {
    email: "lawyer@example.com",
    accessToken: "test-account-token",
    password: "",
    refreshToken: "",
    accessExpiresAtMs: NOW.getTime() + 3_600_000,
    connectedAtMs: 1,
    ...overrides,
  };
}

function useStore(readAccount: LexroomAccountStore["readAccount"]) {
  const store: LexroomAccountStore = {
    replacePending: vi.fn(async () => {}),
    hasPending: vi.fn(async () => false),
    consumePending: vi.fn(async () => false),
    upsertAccount: vi.fn(async () => {}),
    readAccount,
    clearAccount: vi.fn(async () => {}),
  };
  openAdaLexroomAccountFromApi.mockResolvedValue(store);
  return store;
}

/** A store whose account really disappears on clearAccount, so status can be re-read. */
function useLiveStore(initial: LexroomAccountRecord | null) {
  let current = initial;
  const store = useStore(async () => current);
  vi.mocked(store.clearAccount).mockImplementation(async () => {
    current = null;
  });
  return {
    store,
    replaceAccount(next: LexroomAccountRecord) {
      current = next;
    },
  };
}

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function lexroom(routes: Record<string, Route>) {
  const calls: Array<{ path: string; method: string; headers: Headers }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    const route = routes[url.pathname];
    if (!route) {
      throw new Error(`unexpected request ${url.pathname}`);
    }
    return await route(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const DENIED = { detail: "You do not have permission to perform this action." };
const doneStream = () =>
  new Response(
    `${JSON.stringify({ research: { id: "r1", status: "DONE", answer: { text: "Ok" } } })}\n`,
  );

function expiredJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(NOW.getTime() / 1000) - 10 }));
  return `header.${payload.toString("base64url")}.signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveLexroomConfig", () => {
  it("uses the linked account token and keeps only base URL and timeout from config", async () => {
    useStore(async () => account());
    const resolved = await resolveLexroomConfig({
      config: {
        accessToken: "test-config-token",
        baseUrl: "https://lexroom.example",
        timeoutMs: 5000,
      },
      api,
      now: NOW,
    });
    expect(resolved).toEqual({
      ok: true,
      source: "account",
      email: "lawyer@example.com",
      config: {
        accessToken: "test-account-token",
        baseUrl: "https://lexroom.example",
        timeoutMs: 5000,
      },
    });
  });

  it("asks to reconnect, and ignores the static token, when the linked account expired", async () => {
    useStore(async () =>
      account({ accessExpiresAtMs: NOW.getTime() - 1000, accessToken: "test-stale-token" }),
    );
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "test-config-token" },
      api,
      now: NOW,
    });
    expect(resolved).toEqual({
      ok: false,
      reason: "not_connected",
      error: "The Lexroom connection expired. Call ada_lexroom_connect and send that link.",
    });
  });

  it("falls back to the static config token when no account is linked", async () => {
    useStore(async () => null);
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "  test-config-token  ", baseUrl: "https://lexroom.example" },
      api,
      now: NOW,
    });
    expect(resolved).toEqual({
      ok: true,
      source: "config",
      config: {
        accessToken: "test-config-token",
        baseUrl: "https://lexroom.example",
        timeoutMs: undefined,
      },
    });
  });

  it("reports not connected when there is no account and no usable config token", async () => {
    useStore(async () => null);
    const expected = {
      ok: false,
      reason: "not_connected",
      error: "Lexroom is not connected. Call ada_lexroom_connect and send that link.",
    };
    expect(await resolveLexroomConfig({ config: {}, api, now: NOW })).toEqual(expected);
    expect(await resolveLexroomConfig({ config: { accessToken: "   " }, api, now: NOW })).toEqual(
      expected,
    );
    expect(
      await resolveLexroomConfig({ config: { accessToken: expiredJwt() }, api, now: NOW }),
    ).toEqual(expected);
  });

  it("logs and falls back to the config token when the store cannot open", async () => {
    openAdaLexroomAccountFromApi.mockRejectedValue(new Error("disk full"));
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "test-config-token" },
      api,
      now: NOW,
    });
    expect(resolved).toMatchObject({ ok: true, source: "config" });
    expect(logger.error).toHaveBeenCalledWith("ada lexroom account store failed: disk full");
  });

  it("logs and falls back to the config token when reading the account throws", async () => {
    useStore(async () => {
      throw new Error("read failed");
    });
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "test-config-token" },
      api,
      now: NOW,
    });
    expect(resolved).toMatchObject({ ok: true, source: "config" });
    expect(logger.error).toHaveBeenCalledWith("ada lexroom resolve failed: read failed");
  });
});

describe("executeAdaLexroomConnect", () => {
  it("reports connected only after a live authenticated call accepts the saved bearer", async () => {
    const store = useStore(async () => account());
    const server = lexroom({ "/v1/credits": () => json({ credits: 3 }) });
    const result = await executeAdaLexroomConnect(
      { ...CONNECT_CONFIG, baseUrl: "https://lexroom.example" },
      api,
      NOW,
      { fetchImpl: server.fetchImpl },
    );
    expect(result).toEqual({ ok: true, connected: true, email: "lawyer@example.com" });
    expect(store.replacePending).not.toHaveBeenCalled();
    expect(store.clearAccount).not.toHaveBeenCalled();
    expect(vi.mocked(server.fetchImpl).mock.calls[0]?.[0]).toBe(
      "https://lexroom.example/v1/credits",
    );
    expect(server.calls[0]?.method).toBe("GET");
    expect(server.calls[0]?.headers.get("Authorization")).toBe("Bearer test-account-token");
    expect(server.calls[0]?.headers.get("Accept-Encoding")).toBe("identity");
  });

  it("clears a bearer Lexroom rejects with 401 and issues a new link", async () => {
    const { store } = useLiveStore(account());
    const server = lexroom({ "/v1/credits": () => json({ detail: "expired" }, 401) });
    const result = await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW, {
      fetchImpl: server.fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(store.clearAccount).toHaveBeenCalledTimes(1);
    expect(store.replacePending).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["403", () => json(DENIED, 403)],
    ["503", () => json({}, 503)],
    ["404", () => json({}, 404)],
    ["a network failure", () => Promise.reject(new Error("socket hang up"))],
  ])(
    "keeps the sign-in and reports connected when the live check gets %s",
    async (_label, respond) => {
      const { store } = useLiveStore(account());
      const server = lexroom({ "/v1/credits": respond });
      const result = await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW, {
        fetchImpl: server.fetchImpl,
      });
      expect(result).toEqual({ ok: true, connected: true, email: "lawyer@example.com" });
      expect(store.clearAccount).not.toHaveBeenCalled();
      expect(store.replacePending).not.toHaveBeenCalled();
    },
  );

  it("force drops a saved sign-in without asking Lexroom and always issues a link", async () => {
    const { store } = useLiveStore(account());
    const server = lexroom({});
    const result = await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW, {
      force: true,
      fetchImpl: server.fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(server.fetchImpl).not.toHaveBeenCalled();
    expect(store.clearAccount).toHaveBeenCalledTimes(1);
    expect(store.replacePending).toHaveBeenCalledTimes(1);
  });

  it("issues a link for an expired bearer without a live call", async () => {
    useStore(async () => account({ accessToken: expiredJwt(), accessExpiresAtMs: null }));
    const server = lexroom({});
    const result = await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW, {
      fetchImpl: server.fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  it("saves a pending nonce and returns a signed link when not connected", async () => {
    const store = useStore(async () => null);
    const result = await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW);
    expect(result).toMatchObject({ ok: true, connected: false });
    const ask = (result as { ask: { url: string; message: string } }).ask;
    expect(ask.url.startsWith("https://gateway.example/ada/lexroom/connect?state=")).toBe(true);
    expect(ask.message).toContain(ask.url);
    expect(store.replacePending).toHaveBeenCalledTimes(1);
    expect(store.replacePending).toHaveBeenCalledWith(
      expect.any(String),
      NOW.getTime() + 30 * 60 * 1000,
    );
  });

  it("returns the config error and saves nothing when connect is not configured", async () => {
    const store = useStore(async () => null);
    const result = await executeAdaLexroomConnect({}, api, NOW);
    expect(result).toMatchObject({ ok: false });
    expect(store.replacePending).not.toHaveBeenCalled();
  });

  it("returns a generic failure when the store cannot open", async () => {
    openAdaLexroomAccountFromApi.mockRejectedValue(new Error("boom"));
    expect(await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW)).toEqual({
      ok: false,
      error: "Ada could not open the Lexroom account store.",
    });
  });

  it("returns a generic failure when saving the pending nonce throws", async () => {
    const store = useStore(async () => null);
    vi.mocked(store.replacePending).mockRejectedValue(new Error("write failed"));
    expect(await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW)).toEqual({
      ok: false,
      error: "Ada could not prepare the Lexroom connect link.",
    });
    expect(logger.error).toHaveBeenCalledWith("ada lexroom connect failed: write failed");
  });
});

describe("sendLexroomConnectedNotice", () => {
  const config = { channels: { "kapso-whatsapp": { defaultTo: "+10000000000" } } } as never;

  it("sends the connected text to the configured WhatsApp target", async () => {
    const sendText = vi.fn(async () => ({}));
    const loadAdapter = vi.fn(async () => ({ sendText }));
    const result = await sendLexroomConnectedNotice({
      config,
      email: "lawyer@example.com",
      loadAdapter,
    });
    expect(result).toEqual({ ok: true });
    expect(loadAdapter).toHaveBeenCalledWith("kapso-whatsapp");
    expect(sendText).toHaveBeenCalledWith({
      cfg: config,
      to: "+10000000000",
      text: lexroomConnectedText("lawyer@example.com"),
    });
    expect(lexroomConnectedText("lawyer@example.com")).not.toContain("lawyer@example.com");
  });

  it("does not load an adapter when no target is configured", async () => {
    const loadAdapter = vi.fn();
    expect(
      await sendLexroomConnectedNotice({
        config: {} as never,
        email: "x@example.com",
        loadAdapter,
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp defaultTo is not set" });
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it("reports an unavailable outbound adapter", async () => {
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => null,
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => ({}),
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
  });

  it("returns adapter load and send failures instead of throwing", async () => {
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => {
          throw new Error("adapter missing");
        },
      }),
    ).toEqual({ ok: false, error: "adapter missing" });
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => ({
          sendText: async () => {
            throw new Error("send rejected");
          },
        }),
      }),
    ).toEqual({ ok: false, error: "send rejected" });
  });
});

describe("a rejected Lexroom sign-in", () => {
  /** The tool entry points read the real clock, so the fixture bearer must outlive it. */
  const liveAccount = (overrides: Partial<LexroomAccountRecord> = {}) =>
    account({ accessExpiresAtMs: Date.now() + 3_600_000, ...overrides });
  const research = { matterId: "m", query: "Termini" };

  it("is cleared by a 401, so status reports not connected and a new link is issued", async () => {
    const { store } = useLiveStore(liveAccount());
    const server = lexroom({
      "/v1/ask_me_anything": () => json({ detail: "expired" }, 401),
      "/v1/credits": () => json({ detail: "expired" }, 401),
    });
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "not_connected" });
    expect(store.clearAccount).toHaveBeenCalledTimes(1);

    const status = await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW, {
      fetchImpl: server.fetchImpl,
    });
    expect(status).toMatchObject({ ok: true, connected: false });
    expect(store.replacePending).toHaveBeenCalledTimes(1);
    expect(server.calls.map((call) => call.path)).toEqual(["/v1/ask_me_anything"]);
  });

  it("is cleared by a rejected drafting call too", async () => {
    const { store } = useLiveStore(liveAccount());
    const server = lexroom({ "/v2/ai/drafting/selectors": () => json({ detail: "expired" }, 401) });
    const outcome = await executeAdaDraft({
      args: { matterId: "m", prompt: "Diffida", confirmed: true },
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "not_connected" });
    expect(store.clearAccount).toHaveBeenCalledTimes(1);
  });

  it("keeps a sign-in that was replaced while the call was running", async () => {
    const live = useLiveStore(liveAccount());
    const server = lexroom({
      "/v1/ask_me_anything": () => {
        live.replaceAccount(liveAccount({ accessToken: "newer-token" }));
        return json({ detail: "expired" }, 401);
      },
    });
    await executeAdaResearch({ args: research, config: {}, api, fetchImpl: server.fetchImpl });
    expect(live.store.clearAccount).not.toHaveBeenCalled();
  });

  it("does not clear anything for a static config token", async () => {
    const { store } = useLiveStore(null);
    const server = lexroom({ "/v1/ask_me_anything": () => json({ detail: "expired" }, 401) });
    const outcome = await executeAdaResearch({
      args: research,
      config: { accessToken: "static-config-token" },
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "not_connected" });
    expect(store.clearAccount).not.toHaveBeenCalled();
  });

  it("survives a 403: kept, still connected on the next status check, detail shown", async () => {
    const { store } = useLiveStore(liveAccount());
    const server = lexroom({
      "/v1/ask_me_anything": () =>
        json({ detail: "User not authorized to search on the specified modules" }, 403),
      "/v1/credits": () => json({ credits: 3 }),
    });
    const outcome = await executeAdaResearch({
      args: { ...research, modules: ["Civile"] },
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("User not authorized to search on the specified modules"),
    });
    expect(outcome).not.toHaveProperty("reason");
    expect(store.clearAccount).not.toHaveBeenCalled();

    const status = await executeAdaLexroomConnect(CONNECT_CONFIG, api, NOW, {
      fetchImpl: server.fetchImpl,
    });
    expect(status).toEqual({ ok: true, connected: true, email: "lawyer@example.com" });
    expect(store.replacePending).not.toHaveBeenCalled();
  });

  it("logs the failed call's HTTP status and sanitized detail, never the token", async () => {
    useLiveStore(liveAccount({ accessToken: "test-account-token-0123456789abcdef" }));
    const server = lexroom({
      "/v1/ask_me_anything": () =>
        json({ detail: "Module Civile denied for test-account-token-0123456789abcdef" }, 403),
    });
    await executeAdaResearch({ args: research, config: {}, api, fetchImpl: server.fetchImpl });
    const warned = logger.warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warned).toContain("ada lexroom research.failed");
    expect(warned).toContain("httpStatus=403");
    expect(warned).toContain("detail=Module Civile denied for [redacted]");
    expect(warned).not.toContain("test-account-token");
  });

  it("still succeeds and keeps the account when the call works", async () => {
    const { store } = useLiveStore(liveAccount());
    const server = lexroom({ "/v1/ask_me_anything": () => doneStream() });
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: true, answer: "Ok" });
    expect(store.clearAccount).not.toHaveBeenCalled();
  });
});

describe("silent sign-in with the saved email and password", () => {
  const PASSWORD = "correct horse battery staple 9";
  const research = { matterId: "m", query: "Termini" };
  const RENEWED = "renewed-access-token-0001";

  /** An account whose password is saved; the tool entry points read the real clock. */
  const saved = (email: string, overrides: Partial<LexroomAccountRecord> = {}) =>
    account({
      email,
      password: PASSWORD,
      accessExpiresAtMs: Date.now() + 3_600_000,
      ...overrides,
    });

  function nextAuth(
    outcome: "ok" | "wrong_password" | "mfa",
    seen: { posts: string[] } = { posts: [] },
  ) {
    const redirect =
      outcome === "wrong_password"
        ? "https://app.lexroom.ai/auth/signin?authError=401"
        : outcome === "mfa"
          ? "https://app.lexroom.ai/auth/mfa"
          : "https://app.lexroom.ai/";
    return {
      seen,
      routes: {
        "/api/auth/csrf": () => json({ csrfToken: "csrf-token" }),
        "/api/auth/callback/credentials": (_url: URL, init: RequestInit | undefined) => {
          seen.posts.push(String(init?.body));
          return json({ url: redirect });
        },
        "/api/auth/session": () => json({ user: { accessToken: RENEWED, email: "x@example.com" } }),
        "/api/auth/mfa/start": () => json({}, 200),
      } satisfies Record<string, Route>,
    };
  }

  function loggedText(): string {
    return [logger.info, logger.warn, logger.error, logger.debug]
      .flatMap((fn) => fn.mock.calls.map((call) => String(call[0])))
      .join("\n");
  }

  it("renews an expired token before the call, saves it, and never logs the password", async () => {
    const live = useLiveStore(
      saved("expired@example.com", {
        accessToken: "stale-token-aaaaaaaa",
        accessExpiresAtMs: Date.now() - 10_000,
      }),
    );
    const auth = nextAuth("ok");
    const server = lexroom({
      ...auth.routes,
      "/v1/ask_me_anything": (_url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${RENEWED}`);
        return doneStream();
      },
    });
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: true, answer: "Ok" });
    expect(server.calls.map((call) => call.path)).toEqual([
      "/api/auth/csrf",
      "/api/auth/callback/credentials",
      "/api/auth/session",
      "/v1/ask_me_anything",
    ]);
    expect(auth.seen.posts[0]).toContain(`email=expired%40example.com`);
    expect(live.store.upsertAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: RENEWED, password: PASSWORD }),
    );
    expect(live.store.clearAccount).not.toHaveBeenCalled();
    const logged = loggedText();
    expect(logged).toContain("ada lexroom relogin.start why=expired");
    expect(logged).toContain("ada lexroom relogin.ok");
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(RENEWED);
  });

  it("renews once and retries once when Lexroom answers 401", async () => {
    const live = useLiveStore(saved("rejected@example.com"));
    const auth = nextAuth("ok");
    let asked = 0;
    const server = lexroom({
      ...auth.routes,
      "/v1/ask_me_anything": (_url, init) => {
        asked += 1;
        const bearer = new Headers(init?.headers).get("Authorization");
        return bearer === `Bearer ${RENEWED}` ? doneStream() : json({ detail: "expired" }, 401);
      },
    });
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: true, answer: "Ok" });
    expect(asked).toBe(2);
    expect(auth.seen.posts).toHaveLength(1);
    expect(live.store.clearAccount).not.toHaveBeenCalled();
    expect(loggedText()).toContain("relogin.start why=rejected");
  });

  it("does not loop when a freshly renewed token is rejected too, and keeps the account", async () => {
    const live = useLiveStore(saved("loop@example.com"));
    const auth = nextAuth("ok");
    let asked = 0;
    const server = lexroom({
      ...auth.routes,
      "/v1/ask_me_anything": () => {
        asked += 1;
        return json({ detail: "expired" }, 401);
      },
    });
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(asked).toBe(2);
    expect(auth.seen.posts).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("just renewed") });
    expect(outcome).not.toHaveProperty("reason");
    expect(live.store.clearAccount).not.toHaveBeenCalled();
  });

  it("clears the account and asks to reconnect when the saved password is wrong", async () => {
    const live = useLiveStore(saved("wrongpw@example.com"));
    const auth = nextAuth("wrong_password");
    const server = lexroom({
      ...auth.routes,
      "/v1/ask_me_anything": () => json({ detail: "expired" }, 401),
    });
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "not_connected",
      error: expect.stringContaining("no longer accepts the saved email and password"),
    });
    expect(live.store.clearAccount).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain("relogin.failed why=rejected reason=invalid_credentials");
    expect(loggedText()).not.toContain(PASSWORD);
  });

  it("falls back to reconnecting, and says why, for an account that needs a one-time code", async () => {
    const live = useLiveStore(
      saved("mfa@example.com", {
        accessToken: "stale-token-bbbbbbbb",
        accessExpiresAtMs: Date.now() - 10_000,
      }),
    );
    const auth = nextAuth("mfa");
    const server = lexroom(auth.routes);
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "not_connected",
      error: expect.stringContaining("needs a one-time code at every sign-in"),
    });
    expect(server.calls.map((call) => call.path)).not.toContain("/api/auth/mfa/start");
    expect(server.calls.map((call) => call.path)).not.toContain("/v1/ask_me_anything");

    const status = await executeAdaLexroomConnect(CONNECT_CONFIG, api, new Date(), {
      fetchImpl: server.fetchImpl,
    });
    expect(status).toMatchObject({
      ok: true,
      connected: false,
      ask: { message: expect.stringContaining("one-time code at every sign-in") },
    });
    expect(auth.seen.posts).toHaveLength(1);
    expect(live.store.clearAccount).not.toHaveBeenCalled();
  });

  it("asks to reconnect, without a sign-in attempt, when no password was saved", async () => {
    useLiveStore(
      saved("nopw@example.com", { password: "", accessExpiresAtMs: Date.now() - 10_000 }),
    );
    const server = lexroom({});
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "not_connected",
      error: "The Lexroom connection expired. Call ada_lexroom_connect and send that link.",
    });
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not clear anything when Lexroom cannot be reached to renew", async () => {
    const live = useLiveStore(
      saved("down@example.com", {
        accessToken: "stale-token-cccccccc",
        accessExpiresAtMs: Date.now() - 10_000,
      }),
    );
    const server = lexroom({ "/api/auth/csrf": () => json({}, 503) });
    const outcome = await executeAdaResearch({
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("did not answer") });
    expect(outcome).not.toHaveProperty("reason");
    expect(live.store.clearAccount).not.toHaveBeenCalled();
  });

  it("shares one sign-in between calls that start with the same stale token", async () => {
    useLiveStore(
      saved("shared@example.com", {
        accessToken: "stale-token-dddddddd",
        accessExpiresAtMs: Date.now() - 10_000,
      }),
    );
    const auth = nextAuth("ok");
    const server = lexroom({ ...auth.routes, "/v1/ask_me_anything": () => doneStream() });
    const run = () =>
      executeAdaResearch({ args: research, config: {}, api, fetchImpl: server.fetchImpl });
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(auth.seen.posts).toHaveLength(1);
  });

  it("renews inside the status check when the token is about to expire", async () => {
    useLiveStore(
      saved("status@example.com", {
        accessToken: "stale-token-eeeeeeee",
        accessExpiresAtMs: Date.now() + 30_000,
      }),
    );
    const auth = nextAuth("ok");
    const server = lexroom({ ...auth.routes, "/v1/credits": () => json({ credits: 1 }) });
    const status = await executeAdaLexroomConnect(CONNECT_CONFIG, api, new Date(), {
      fetchImpl: server.fetchImpl,
    });
    expect(status).toEqual({ ok: true, connected: true, email: "status@example.com" });
    expect(auth.seen.posts).toHaveLength(1);
  });

  it("renews after a 401 from the status check, and clears for a wrong password", async () => {
    const live = useLiveStore(saved("probe@example.com"));
    const auth = nextAuth("ok");
    const server = lexroom({
      ...auth.routes,
      "/v1/credits": (_url, init) =>
        new Headers(init?.headers).get("Authorization") === `Bearer ${RENEWED}`
          ? json({})
          : json({ detail: "expired" }, 401),
    });
    expect(
      await executeAdaLexroomConnect(CONNECT_CONFIG, api, new Date(), {
        fetchImpl: server.fetchImpl,
      }),
    ).toMatchObject({ ok: true, connected: true });

    const bad = nextAuth("wrong_password");
    const second = lexroom({
      ...bad.routes,
      "/v1/credits": () => json({ detail: "expired" }, 401),
    });
    expect(
      await executeAdaLexroomConnect(CONNECT_CONFIG, api, new Date(), {
        fetchImpl: second.fetchImpl,
      }),
    ).toMatchObject({ ok: true, connected: false });
    expect(live.store.clearAccount).toHaveBeenCalledTimes(1);
  });
});
