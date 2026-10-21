import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomAccountRecord, LexroomAccountStore } from "./lexroom-account-contract.js";

const openAdaLexroomAccountFromApi = vi.hoisted(() => vi.fn());

vi.mock("./lexroom-account.js", () => ({ openAdaLexroomAccountFromApi }));

import { readResearchJob } from "./lexroom-jobs.js";
import {
  executeAdaDraft,
  executeAdaLexroomConnect,
  executeAdaResearch,
  lexroomConnectedText,
  resolveLexroomConfig,
  sendLexroomConnectedNotice,
  startAdaResearch,
} from "./lexroom-tools.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { expandShortLink } from "./short-link-test-support.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const OWNER = "390000000000";
const OTHER = "393331111111";
const api = {
  logger,
  runtimeSource: "/fake/index.ts",
  runtime: {},
  config: { channels: { "kapso-whatsapp": { defaultTo: `+${OWNER}` } } },
} as never;

const CONNECT_CONFIG = {
  lexroomConnectUri: "https://gateway.example/ada/lexroom/connect",
  lexroomStateSecret: "0123456789abcdef",
};

/** The push to the asking number, captured: research results never go anywhere else. */
const pushed: string[] = [];
const pushFor = (recipient: string) => ({
  recipient,
  send: async (text: string) => {
    pushed.push(text);
    return { ok: true as const };
  },
  windowOpen: async () => true,
  nudge: async () => "sent" as const,
  log: vi.fn(),
  retryDelayMs: 0,
});

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
  const calls: Array<{ path: string; method: string; headers: Headers; body: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === "/v1/user/modules" && !routes[url.pathname]) {
      return json(["Civile"]);
    }
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
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

function liveJwtFor(now: Date): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(now.getTime() / 1000) + 3600 }));
  return `header.${payload.toString("base64url")}.signature`;
}

function expiredJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(NOW.getTime() / 1000) - 10 }));
  return `header.${payload.toString("base64url")}.signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
  pushed.length = 0;
});

describe("resolveLexroomConfig", () => {
  it("uses the linked account token and keeps only base URL and timeout from config", async () => {
    useStore(async () => account());
    const resolved = await resolveLexroomConfig({
      owner: OWNER,
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
      owner: OWNER,
      config: { accessToken: "test-config-token" },
      api,
      now: NOW,
    });
    expect(resolved).toEqual({
      ok: false,
      reason: "not_connected",
      error:
        "The Lexroom connection expired. Ask whether they want to reconnect; call ada_lexroom_connect and send the link only after they agree (or if they asked to connect).",
    });
  });

  it("falls back to the static config token when no account is linked", async () => {
    useStore(async () => null);
    const resolved = await resolveLexroomConfig({
      owner: OWNER,
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
      error:
        "Lexroom is not connected. Ask whether they want to connect; call ada_lexroom_connect and send the link only after they agree (or if they asked to connect).",
    };
    expect(await resolveLexroomConfig({ owner: OWNER, config: {}, api, now: NOW })).toEqual(
      expected,
    );
    expect(
      await resolveLexroomConfig({ owner: OWNER, config: { accessToken: "   " }, api, now: NOW }),
    ).toEqual(expected);
    expect(
      await resolveLexroomConfig({
        owner: OWNER,
        config: { accessToken: expiredJwt() },
        api,
        now: NOW,
      }),
    ).toEqual(expected);
  });

  it("logs and falls back to the config token when the store cannot open", async () => {
    openAdaLexroomAccountFromApi.mockRejectedValue(new Error("disk full"));
    const resolved = await resolveLexroomConfig({
      owner: OWNER,
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
      owner: OWNER,
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
      OWNER,
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
    expect(server.calls[0]?.headers.get("X-Client-Type")).toBe("app_lex");
  });

  it("clears a bearer Lexroom rejects with 401 and issues a new link", async () => {
    const { store } = useLiveStore(account());
    const server = lexroom({ "/v1/credits": () => json({ detail: "expired" }, 401) });
    const result = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW, {
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
      const result = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW, {
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
    const result = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW, {
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
    const result = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW, {
      fetchImpl: server.fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  it("saves a pending nonce and returns a signed link when not connected", async () => {
    const store = useStore(async () => null);
    const result = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW);
    expect(result).toMatchObject({ ok: true, connected: false });
    const ask = (result as { ask: { url: string; message: string } }).ask;
    expect(ask.url).toMatch(/^https:\/\/gateway\.example\/l\/[\w-]{10}$/u);
    expect(expandShortLink(ask.url).origin + expandShortLink(ask.url).pathname).toBe(
      "https://gateway.example/ada/lexroom/connect",
    );
    expect(ask.message).toContain(ask.url);
    expect(store.replacePending).toHaveBeenCalledTimes(1);
    expect(store.replacePending).toHaveBeenCalledWith(
      expect.any(String),
      NOW.getTime() + 30 * 60 * 1000,
    );
  });

  it("returns the config error and saves nothing when connect is not configured", async () => {
    const store = useStore(async () => null);
    const result = await executeAdaLexroomConnect(OWNER, {}, api, NOW);
    expect(result).toMatchObject({ ok: false });
    expect(store.replacePending).not.toHaveBeenCalled();
  });

  it("returns a generic failure when the store cannot open", async () => {
    openAdaLexroomAccountFromApi.mockRejectedValue(new Error("boom"));
    expect(await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW)).toEqual({
      ok: false,
      error: "Ada could not open the Lexroom account store.",
    });
  });

  it("returns a generic failure when saving the pending nonce throws", async () => {
    const store = useStore(async () => null);
    vi.mocked(store.replacePending).mockRejectedValue(new Error("write failed"));
    expect(await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW)).toEqual({
      ok: false,
      error: "Ada could not prepare the Lexroom connect link.",
    });
    expect(logger.error).toHaveBeenCalledWith("ada lexroom connect failed: write failed");
  });
});

describe("Lexroom accounts belong to one number each", () => {
  const research = { matterId: "m", query: "Termini" };
  /** One store per number, as the real store hands them out. */
  function useStoresByOwner(accounts: Record<string, LexroomAccountRecord | null>) {
    const stores = new Map<string, LexroomAccountStore>();
    openAdaLexroomAccountFromApi.mockImplementation(async (_api: unknown, owner: string) => {
      let store = stores.get(owner);
      if (!store) {
        store = {
          replacePending: vi.fn(async () => {}),
          hasPending: vi.fn(async () => false),
          consumePending: vi.fn(async () => false),
          upsertAccount: vi.fn(async () => {}),
          readAccount: vi.fn(async () => accounts[owner] ?? null),
          clearAccount: vi.fn(async () => {}),
        };
        stores.set(owner, store);
      }
      return store;
    });
    return stores;
  }

  it("does not let another number use a connected account, whatever is in the arguments", async () => {
    useStoresByOwner({
      [OWNER]: account({ accessToken: "anna-token", accessExpiresAtMs: Date.now() + 3_600_000 }),
    });
    const server = lexroom({ "/v1/ask_me_anything": () => doneStream() });
    const asOther = await executeAdaResearch({
      owner: OTHER,
      args: { ...research, number: OWNER, owner: OWNER } as never,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(asOther).toMatchObject({ ok: false, reason: "not_connected" });
    expect(server.calls).toEqual([]);
    expect(openAdaLexroomAccountFromApi).toHaveBeenCalledWith(api, OTHER);
    expect(openAdaLexroomAccountFromApi).not.toHaveBeenCalledWith(api, OWNER);

    const asOwner = await executeAdaResearch({
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(asOwner).toMatchObject({ ok: true });
    expect(server.calls.at(-1)?.headers.get("authorization")).toBe("Bearer anna-token");
  });

  it("uses the static config token for the configured lawyer only", async () => {
    useStoresByOwner({});
    const config = { accessToken: liveJwtFor(NOW) };
    expect(await resolveLexroomConfig({ owner: OWNER, config, api, now: NOW })).toMatchObject({
      ok: true,
      source: "config",
    });
    expect(await resolveLexroomConfig({ owner: OTHER, config, api, now: NOW })).toEqual({
      ok: false,
      reason: "not_connected",
      error:
        "Lexroom is not connected. Ask whether they want to connect; call ada_lexroom_connect and send the link only after they agree (or if they asked to connect).",
    });
  });

  it("saves a connect link's pending state in the requesting number's store only", async () => {
    const stores = useStoresByOwner({});
    const result = await executeAdaLexroomConnect(OTHER, CONNECT_CONFIG, api, NOW);
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(stores.get(OTHER)?.replacePending).toHaveBeenCalledTimes(1);
    expect(stores.has(OWNER)).toBe(false);
    if (result.ok && !result.connected) {
      const state = expandShortLink(result.ask.url).searchParams.get("state") ?? "";
      const payload = JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString());
      expect(payload.owner).toBe(OTHER);
    }
  });

  it("starts a research for the asking number and pushes the result to that number alone", async () => {
    useStoresByOwner({
      [OTHER]: account({ accessToken: "bruno-token", accessExpiresAtMs: Date.now() + 3_600_000 }),
    });
    const server = lexroom({ "/v1/ask_me_anything": () => doneStream() });
    const recipients: string[] = [];
    const started = await startAdaResearch({
      owner: OTHER,
      pushDepsFor: (recipient) => {
        recipients.push(recipient);
        return pushFor(recipient);
      },
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) {
      throw new Error("expected a job");
    }
    await readResearchJob({ requester: OTHER, jobId: started.jobId, waitSeconds: 5 });
    expect(recipients).toEqual([OTHER]);
    expect(server.calls.at(-1)?.headers.get("authorization")).toBe("Bearer bruno-token");
    expect(
      await readResearchJob({ requester: OWNER, jobId: started.jobId, waitSeconds: 0 }),
    ).toMatchObject({ ok: false, reason: "unknown_job" });
  });
});

describe("sendLexroomConnectedNotice", () => {
  const config = { channels: { "kapso-whatsapp": { defaultTo: "+10000000000" } } } as never;

  beforeEach(() => {
    clearInboundLanguages();
  });

  async function sentText(owner: string): Promise<string> {
    const sendText = vi.fn(async (_params: { text: string }) => ({}));
    const result = await sendLexroomConnectedNotice({
      config,
      owner,
      email: "anna@example.com",
      loadAdapter: async () => ({ sendText }),
    });
    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledExactlyOnceWith({
      cfg: config,
      to: `+${owner}`,
      text: expect.any(String),
    });
    return sendText.mock.calls[0]?.[0].text ?? "";
  }

  it("sends the connected text to the number that connected, never to the configured lawyer", async () => {
    const loadAdapter = vi.fn(async () => ({ sendText: vi.fn(async () => ({})) }));
    await sendLexroomConnectedNotice({
      config,
      owner: OTHER,
      email: "anna@example.com",
      loadAdapter,
    });
    expect(loadAdapter).toHaveBeenCalledWith("kapso-whatsapp");
    expect(await sentText(OTHER)).not.toContain("anna@example.com");
  });

  it("confirms in English after an English message and in Italian after an Italian one", async () => {
    recordInboundLanguage(OTHER, "Give me a new link");
    expect(await sentText(OTHER)).toBe(
      "Lexroom is connected. I can run research and drafts. What should I start with?",
    );
    recordInboundLanguage(OTHER, "Ok e Google?");
    expect(await sentText(OTHER)).toBe(lexroomConnectedText("it"));
  });

  it("keeps the previous language through an ambiguous message, and defaults to Italian when none is known", async () => {
    expect(await sentText(OTHER)).toBe(lexroomConnectedText("it"));
    recordInboundLanguage(OTHER, "Run a digest for me now");
    recordInboundLanguage(OTHER, "ok");
    expect(await sentText(OTHER)).toBe(lexroomConnectedText("en"));
  });

  it("has a variant in every language", () => {
    const texts = (["it", "en", "es", "fr", "de"] as const).map(lexroomConnectedText);
    expect(new Set(texts).size).toBe(5);
  });

  it("reports an unavailable outbound adapter", async () => {
    expect(
      await sendLexroomConnectedNotice({
        config,
        owner: OTHER,
        email: "x@example.com",
        loadAdapter: async () => null,
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
    expect(
      await sendLexroomConnectedNotice({
        config,
        owner: OTHER,
        email: "x@example.com",
        loadAdapter: async () => ({}),
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
  });

  it("returns adapter load and send failures instead of throwing", async () => {
    expect(
      await sendLexroomConnectedNotice({
        config,
        owner: OTHER,
        email: "x@example.com",
        loadAdapter: async () => {
          throw new Error("adapter missing");
        },
      }),
    ).toEqual({ ok: false, error: "adapter missing" });
    expect(
      await sendLexroomConnectedNotice({
        config,
        owner: OTHER,
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
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "not_connected" });
    expect(store.clearAccount).toHaveBeenCalledTimes(1);

    const status = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW, {
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
      owner: OWNER,
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
    await executeAdaResearch({
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(live.store.clearAccount).not.toHaveBeenCalled();
  });

  it("does not clear anything for a static config token", async () => {
    const { store } = useLiveStore(null);
    const server = lexroom({ "/v1/ask_me_anything": () => json({ detail: "expired" }, 401) });
    const outcome = await executeAdaResearch({
      owner: OWNER,
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
      owner: OWNER,
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

    const status = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, NOW, {
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
    await executeAdaResearch({
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
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
      owner: OWNER,
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

  function lexroomLogin(
    outcome: "ok" | "wrong_password" | "mfa" | "down",
    seen: { posts: string[] } = { posts: [] },
  ) {
    return {
      seen,
      routes: {
        "/v1/login": (_url: URL, init: RequestInit | undefined) => {
          seen.posts.push(String(init?.body));
          if (outcome === "wrong_password") {
            return json({ detail: "No active account found", code: "authentication_failed" }, 401);
          }
          if (outcome === "mfa") {
            return json({ detail: "mfa_step_up_required" }, 403);
          }
          if (outcome === "down") {
            return json({}, 503);
          }
          return json({ access_token: RENEWED });
        },
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
    const auth = lexroomLogin("ok");
    const server = lexroom({
      ...auth.routes,
      "/v1/ask_me_anything": (_url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${RENEWED}`);
        return doneStream();
      },
    });
    const outcome = await executeAdaResearch({
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: true, answer: "Ok" });
    expect(server.calls.map((call) => call.path)).toEqual(["/v1/login", "/v1/ask_me_anything"]);
    const login = server.calls[0];
    expect(login?.method).toBe("POST");
    expect(Object.fromEntries(login?.headers ?? [])).toEqual({
      "content-type": "application/json",
      "x-client-type": "app_lex",
    });
    expect(JSON.parse(login?.body ?? "")).toEqual({
      email: "expired@example.com",
      password: PASSWORD,
    });
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
    const auth = lexroomLogin("ok");
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
      owner: OWNER,
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
    const auth = lexroomLogin("ok");
    let asked = 0;
    const server = lexroom({
      ...auth.routes,
      "/v1/ask_me_anything": () => {
        asked += 1;
        return json({ detail: "expired" }, 401);
      },
    });
    const outcome = await executeAdaResearch({
      owner: OWNER,
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
    const auth = lexroomLogin("wrong_password");
    const server = lexroom({
      ...auth.routes,
      "/v1/ask_me_anything": () => json({ detail: "expired" }, 401),
    });
    const outcome = await executeAdaResearch({
      owner: OWNER,
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
    expect(loggedText()).toContain("relogin.failed why=rejected reason=wrong_password");
    expect(loggedText()).not.toContain(PASSWORD);
  });

  it("falls back to reconnecting, and says why, for an account that requires MFA", async () => {
    const live = useLiveStore(
      saved("mfa@example.com", {
        accessToken: "stale-token-bbbbbbbb",
        accessExpiresAtMs: Date.now() - 10_000,
      }),
    );
    const auth = lexroomLogin("mfa");
    const server = lexroom(auth.routes);
    const outcome = await executeAdaResearch({
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "not_connected",
      error: expect.stringContaining("requires a one-time code (MFA)"),
    });
    expect(server.calls.map((call) => call.path)).toEqual(["/v1/login"]);

    const status = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, new Date(), {
      fetchImpl: server.fetchImpl,
    });
    expect(status).toMatchObject({
      ok: true,
      connected: false,
      ask: { message: expect.stringContaining("does not use MFA") },
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
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "not_connected",
      error:
        "The Lexroom connection expired. Ask whether they want to reconnect; call ada_lexroom_connect and send the link only after they agree (or if they asked to connect).",
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
    const auth = lexroomLogin("down");
    const server = lexroom(auth.routes);
    const outcome = await executeAdaResearch({
      owner: OWNER,
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
    const auth = lexroomLogin("ok");
    const server = lexroom({ ...auth.routes, "/v1/ask_me_anything": () => doneStream() });
    const run = () =>
      executeAdaResearch({
        owner: OWNER,
        args: research,
        config: {},
        api,
        fetchImpl: server.fetchImpl,
      });
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
    const auth = lexroomLogin("ok");
    const server = lexroom({ ...auth.routes, "/v1/credits": () => json({ credits: 1 }) });
    const status = await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, new Date(), {
      fetchImpl: server.fetchImpl,
    });
    expect(status).toEqual({ ok: true, connected: true, email: "status@example.com" });
    expect(auth.seen.posts).toHaveLength(1);
  });

  it("signs in again at the configured Lexroom base URL", async () => {
    useLiveStore(
      saved("custom@example.com", {
        accessToken: "stale-token-ffffffff",
        accessExpiresAtMs: Date.now() - 10_000,
      }),
    );
    const auth = lexroomLogin("ok");
    const server = lexroom({ ...auth.routes, "/v1/ask_me_anything": () => doneStream() });
    const outcome = await executeAdaResearch({
      owner: OWNER,
      args: research,
      config: { baseUrl: "https://lexroom.example" },
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(outcome).toMatchObject({ ok: true });
    const urls = vi.mocked(server.fetchImpl).mock.calls.map(([input]) => String(input));
    expect(urls[0]).toBe("https://lexroom.example/v1/login");
  });

  it("renews after a 401 from the status check, and clears for a wrong password", async () => {
    const live = useLiveStore(saved("probe@example.com"));
    const auth = lexroomLogin("ok");
    const server = lexroom({
      ...auth.routes,
      "/v1/credits": (_url, init) =>
        new Headers(init?.headers).get("Authorization") === `Bearer ${RENEWED}`
          ? json({})
          : json({ detail: "expired" }, 401),
    });
    expect(
      await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, new Date(), {
        fetchImpl: server.fetchImpl,
      }),
    ).toMatchObject({ ok: true, connected: true });

    const bad = lexroomLogin("wrong_password");
    const second = lexroom({
      ...bad.routes,
      "/v1/credits": () => json({ detail: "expired" }, 401),
    });
    expect(
      await executeAdaLexroomConnect(OWNER, CONNECT_CONFIG, api, new Date(), {
        fetchImpl: second.fetchImpl,
      }),
    ).toMatchObject({ ok: true, connected: false });
    expect(live.store.clearAccount).toHaveBeenCalledTimes(1);
  });
});

describe("a Lexroom that goes silent", () => {
  const research = { matterId: "m", query: "Termini" };
  const never = () =>
    new Promise<Response>(() => {
      // Never settles.
    });
  const timedOut = (limit: string) => {
    const message = `Lexroom did not respond within ${limit}; the request was abandoned.`;
    return { ok: false, reason: "timeout", message, error: message };
  };
  const saved = (overrides: Partial<LexroomAccountRecord> = {}) =>
    account({
      password: "correct horse battery staple 9",
      accessExpiresAtMs: Date.now() + 3_600_000,
      ...overrides,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("ADA_LEXROOM_TIMEOUT_MS", "1000");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("ends a re-login that never answers as a timeout, without clearing or rewriting the account", async () => {
    const live = useLiveStore(
      saved({ accessToken: "stale-silent-login", accessExpiresAtMs: Date.now() - 10_000 }),
    );
    const server = lexroom({ "/v1/login": never });
    const pending = executeAdaResearch({
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(1000 + 500 + 1000);
    await expect(pending).resolves.toEqual(timedOut("2s"));
    expect(server.calls.map((call) => call.path)).toEqual(["/v1/login", "/v1/login"]);
    expect(live.store.clearAccount).not.toHaveBeenCalled();
    expect(live.store.upsertAccount).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave later calls joined to the dead sign-in", async () => {
    useLiveStore(
      saved({ accessToken: "stale-shared-hang", accessExpiresAtMs: Date.now() - 10_000 }),
    );
    const server = lexroom({ "/v1/login": never });
    const run = () =>
      executeAdaResearch({
        owner: OWNER,
        args: research,
        config: {},
        api,
        fetchImpl: server.fetchImpl,
      });
    const first = run();
    await vi.advanceTimersByTimeAsync(2600);
    await expect(first).resolves.toMatchObject({ ok: false, reason: "timeout" });
    const second = run();
    await vi.advanceTimersByTimeAsync(2600);
    await expect(second).resolves.toMatchObject({ ok: false, reason: "timeout" });
    expect(server.calls.filter((call) => call.path === "/v1/login")).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a timeout, and keeps the account, when the re-login after a 401 never answers", async () => {
    const live = useLiveStore(saved({ accessToken: "rejected-silent-login" }));
    const server = lexroom({
      "/v1/ask_me_anything": () => json({ detail: "expired" }, 401),
      "/v1/login": never,
    });
    const pending = executeAdaResearch({
      owner: OWNER,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(2600);
    await expect(pending).resolves.toEqual(timedOut("2s"));
    expect(live.store.clearAccount).not.toHaveBeenCalled();
  });

  it("says so when the draft's Lexroom call never answers", async () => {
    useLiveStore(saved({ accessToken: "draft-silent" }));
    const server = lexroom({ "/v2/ai/drafting/selectors": never });
    const pending = executeAdaDraft({
      owner: OWNER,
      args: { matterId: "m", prompt: "Diffida", confirmed: true },
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(timedOut("1s"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets ada_research acknowledge at once, then reports the timeout through the job", async () => {
    useLiveStore(saved({ accessToken: "job-silent" }));
    const server = lexroom({ "/v1/ask_me_anything": never });
    const started = await startAdaResearch({
      owner: OWNER,
      pushDepsFor: pushFor,
      args: research,
      config: {},
      api,
      fetchImpl: server.fetchImpl,
    });
    expect(started).toMatchObject({ ok: true, state: "running" });
    if (!started.ok) {
      throw new Error("expected a job");
    }
    const waiting = readResearchJob({ requester: OWNER, jobId: started.jobId, waitSeconds: 30 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(waiting).resolves.toMatchObject({ ok: true, state: "delivered" });
    expect(pushed.at(-1)).toContain("Lexroom non ha risposto in tempo");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a blank matter or query before starting anything", async () => {
    expect(
      await startAdaResearch({
        owner: OWNER,
        pushDepsFor: pushFor,
        args: { matterId: " ", query: "Q" },
        config: {},
        api,
      }),
    ).toEqual({
      ok: false,
      error: "matterId is required",
    });
    expect(
      await startAdaResearch({
        owner: OWNER,
        pushDepsFor: pushFor,
        args: { matterId: "m", query: " " },
        config: {},
        api,
      }),
    ).toEqual({
      ok: false,
      error: "query is required",
    });
  });
});
