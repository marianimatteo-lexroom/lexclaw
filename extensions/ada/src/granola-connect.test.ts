import type { IncomingMessage, ServerResponse } from "node:http";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectState } from "./connect-state.js";
import { handleAdaGranolaCallback } from "./granola-callback.js";
import {
  granolaConnectConfigFrom,
  prepareGranolaConnect,
  readGranolaConnectConfig,
} from "./granola-connect.js";
import {
  ANNA,
  BRUNO,
  GRANOLA_PLUGIN_CONFIG,
  newMockGranola,
  openGranolaTestDb,
  REDIRECT_URI,
  type MockGranola,
} from "./granola-test-support.js";
import { handleAdaShortLink } from "./short-links-http.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = new Date("2026-10-20T09:00:00.000Z");
const CONFIG = granolaConnectConfigFrom(GRANOLA_PLUGIN_CONFIG);

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

function open(shortUrl: string, now: Date): ReturnType<typeof response> {
  const res = response();
  handleAdaShortLink(
    { method: "GET", url: new URL(shortUrl).pathname } as IncomingMessage,
    res as unknown as ServerResponse,
    "gr",
    now,
  );
  return res;
}

function setupConnect() {
  const mock: MockGranola = newMockGranola();
  const store = openGranolaTestDb(tempDirs.make("ada-granola-"));
  const notified: string[] = [];
  const log = { error: vi.fn() };
  const callback = async (url: string, now = NOW) => {
    const res = response();
    await handleAdaGranolaCallback(
      { method: "GET", url } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: CONFIG,
        now: () => now,
        db: async () => store.db,
        fetchImpl: mock.fetch,
        log,
        notifyConnected: async (owner) => {
          notified.push(owner);
          return { ok: true };
        },
      },
    );
    return res;
  };
  const link = async (owner: string, now = NOW, force = false) => {
    const result = await prepareGranolaConnect({
      owner,
      config: CONFIG,
      db: store.db,
      now,
      force,
      fetchImpl: mock.fetch,
    });
    if (!result.ok || result.connected) {
      throw new Error("expected a link");
    }
    return result.ask;
  };
  /** The whole flow a person goes through: link, Granola sign-in, back to Ada. */
  const connect = async (owner: string, user: string) => {
    const ask = await link(owner);
    const redirect = open(ask.url, NOW);
    const back = mock.signIn(redirect.headers.get("location") ?? "", user);
    return { ask, res: await callback(`${back.pathname}${back.search}`) };
  };
  return { mock, store, notified, log, link, connect, callback };
}

describe("Granola OAuth client registration", () => {
  it("registers Ada once, keeps the client on the volume, and reuses it for every number", async () => {
    const { mock, store, link } = setupConnect();
    await link(ANNA);
    await link(BRUNO);
    expect(mock.registrations).toBe(1);
    const registration = mock.requests.find((request) => request.url.endsWith("/oauth2/register"));
    expect(JSON.parse(registration?.body ?? "{}")).toMatchObject({
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "openid email profile offline_access mcp",
      token_endpoint_auth_method: "none",
    });
    expect(await store.db.readClient()).toMatchObject({ redirectUri: REDIRECT_URI });

    // A new process opens the same file and registers nothing.
    store.close();
    const reopened = openGranolaTestDb(store.dir);
    const again = await prepareGranolaConnect({
      owner: ANNA,
      config: CONFIG,
      db: reopened.db,
      now: NOW,
      fetchImpl: mock.fetch,
    });
    expect(again.ok).toBe(true);
    expect(mock.registrations).toBe(1);
    reopened.close();
  });

  it("registers again when Granola forgets the client", async () => {
    const { mock, store, link, callback } = setupConnect();
    const ask = await link(ANNA);
    const back = mock.signIn(open(ask.url, NOW).headers.get("location") ?? "", "anna");
    mock.clients.clear();
    const res = await callback(`${back.pathname}${back.search}`);
    expect(res.statusCode).toBe(400);
    expect(await store.db.readClient()).toBeNull();
    expect(await store.db.readAccount(ANNA)).toBeNull();

    const next = await link(ANNA);
    expect(mock.registrations).toBe(2);
    expect(() =>
      mock.signIn(open(next.url, NOW).headers.get("location") ?? "", "anna"),
    ).not.toThrow();
  });

  it("registers again when Ada's public origin changes", async () => {
    const { mock, store, link } = setupConnect();
    await link(ANNA);
    const moved = await prepareGranolaConnect({
      owner: ANNA,
      config: granolaConnectConfigFrom({
        googleRedirectUri: "https://ada.example.org/ada/google/callback",
        googleStateSecret: "state-secret-test-value",
      }),
      db: store.db,
      now: NOW,
      fetchImpl: mock.fetch,
    });
    expect(moved.ok).toBe(true);
    expect(mock.registrations).toBe(2);
    expect(await store.db.readClient()).toMatchObject({
      redirectUri: "https://ada.example.org/ada/granola/callback",
    });
  });

  it("keeps the redirect URI on Ada's own domain, whichever prefix the Google URI used", () => {
    const settings = readGranolaConnectConfig(
      granolaConnectConfigFrom({
        googleRedirectUri: "https://vera.verus.legal/vera/google/callback",
        googleStateSecret: "state-secret-test-value",
      }),
    );
    expect(settings).toMatchObject({
      ok: true,
      settings: { redirectUri: "https://vera.verus.legal/ada/granola/callback" },
    });
    expect(readGranolaConnectConfig({ googleRedirectUri: "http://ada.example/x" })).toMatchObject({
      ok: false,
    });
  });
});

describe("Granola short connect link", () => {
  it("is a short single-use link on Ada's domain, never the long OAuth URL", async () => {
    const { link } = setupConnect();
    const ask = await link(ANNA);
    expect(ask.url).toMatch(/^https:\/\/vera\.example\/gr\/[A-Za-z0-9_-]{10}$/u);
    expect(ask.message).toContain(ask.url);
    expect(ask.message).not.toContain("oauth2/authorize");
    expect(ask.message).not.toContain("state=");
    expect(ask.message).not.toContain("code_challenge");
  });

  it("redirects to Granola's sign-in with PKCE and Ada's redirect URI", async () => {
    const { link } = setupConnect();
    const ask = await link(ANNA);
    const res = open(ask.url, NOW);
    expect(res.statusCode).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://mcp-auth.granola.ai/oauth2/authorize",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe("openid email profile offline_access mcp");
    expect(location.searchParams.get("state")?.split(".")).toHaveLength(2);
  });

  it("expires after 30 minutes", async () => {
    const { link, callback, mock } = setupConnect();
    const ask = await link(ANNA);
    const redirect = open(ask.url, NOW).headers.get("location") ?? "";
    expect(open(ask.url, new Date(NOW.getTime() + 29 * 60_000)).statusCode).toBe(302);
    const late = new Date(NOW.getTime() + 30 * 60_000 + 1);
    expect(open(ask.url, late).statusCode).toBe(404);

    // The signed state expires with it: a sign-in finished late saves nothing.
    const back = mock.signIn(redirect, "anna");
    const res = await callback(`${back.pathname}${back.search}`, late);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Link expired");
  });

  it("works once: the callback spends it, and a replay or a new link never reuses it", async () => {
    const { connect, store, callback, link, mock } = setupConnect();
    const { ask, res } = await connect(ANNA, "anna");
    expect(res.statusCode).toBe(200);
    expect(open(ask.url, NOW).statusCode).toBe(404);
    const saved = await store.db.readAccount(ANNA);

    const second = await link(ANNA, NOW, true);
    const replayRedirect = open(second.url, NOW).headers.get("location") ?? "";
    const code = mock.signIn(replayRedirect, "anna");
    const first = await callback(`${code.pathname}${code.search}`);
    expect(first.statusCode).toBe(200);
    const replay = await callback(`${code.pathname}${code.search}`);
    expect(replay.statusCode).toBe(400);
    expect((await store.db.readAccount(ANNA))?.connectedAtMs).toBeGreaterThanOrEqual(
      saved?.connectedAtMs ?? 0,
    );

    // A newer link replaces the older one for the same number.
    const older = await link(BRUNO);
    const newer = await link(BRUNO);
    expect(open(older.url, NOW).statusCode).toBe(404);
    expect(open(newer.url, NOW).statusCode).toBe(302);
  });
});

describe("Granola OAuth callback", () => {
  it("saves the tokens for the number that asked for the link, and confirms to that number", async () => {
    const { connect, store, notified, mock } = setupConnect();
    const anna = await connect(ANNA, "anna");
    const bruno = await connect(BRUNO, "bruno");
    expect(anna.res.statusCode).toBe(200);
    expect(anna.res.body).toContain("Connected");
    expect(anna.res.body).not.toContain("Gmail");
    expect(bruno.res.statusCode).toBe(200);
    expect(notified).toEqual([ANNA, BRUNO]);

    const annaAccount = await store.db.readAccount(ANNA);
    const brunoAccount = await store.db.readAccount(BRUNO);
    expect(mock.userOf(annaAccount?.accessToken ?? "")).toBe("anna");
    expect(mock.userOf(brunoAccount?.accessToken ?? "")).toBe("bruno");
    expect(annaAccount?.refreshToken).toMatch(/^rt-anna-/u);
    expect(annaAccount?.accessExpiresAtMs).toBe(NOW.getTime() + 3_600_000);
    expect(annaAccount?.clientId).toBe(brunoAccount?.clientId);
    expect(await store.db.listOwners()).toEqual([ANNA, BRUNO]);
  });

  it("refuses a state signed for another purpose or another number, and a denied sign-in", async () => {
    const { link, callback, store, mock } = setupConnect();
    const ask = await link(ANNA);
    const redirect = open(ask.url, NOW).headers.get("location") ?? "";
    const back = mock.signIn(redirect, "anna");

    const forged = createConnectState("state-secret-test-value", NOW, BRUNO).state;
    const forgedBack = new URL(back);
    forgedBack.searchParams.set("state", forged);
    const refused = await callback(`${forgedBack.pathname}${forgedBack.search}`);
    expect(refused.statusCode).toBe(400);
    expect(await store.db.readAccount(BRUNO)).toBeNull();
    expect(await store.db.readAccount(ANNA)).toBeNull();

    const denied = await callback("/ada/granola/callback?error=access_denied");
    expect(denied.statusCode).toBe(200);
    expect(denied.body).toContain("Not connected");
    expect(await store.db.readAccount(ANNA)).toBeNull();
  });

  it("answers a failed token exchange without saving anything", async () => {
    const { link, callback, store, mock, log } = setupConnect();
    const ask = await link(ANNA);
    const redirect = open(ask.url, NOW).headers.get("location") ?? "";
    const back = mock.signIn(redirect, "anna");
    back.searchParams.set("code", "not-the-code");
    const res = await callback(`${back.pathname}${back.search}`);
    expect(res.statusCode).toBe(400);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("invalid_grant"));
    expect(await store.db.readAccount(ANNA)).toBeNull();
  });
});

describe("Granola scope without mcp", () => {
  const WITHOUT_MCP = "openid email profile offline_access";

  /** Follows what the browser does after a callback answered with a redirect. */
  async function follow(
    ctx: ReturnType<typeof setupConnect>,
    res: ReturnType<typeof response>,
    user: string,
  ) {
    expect(res.statusCode).toBe(302);
    const toAuthorize = open(res.headers.get("location") ?? "", NOW);
    expect(toAuthorize.statusCode).toBe(302);
    const back = ctx.mock.signIn(toAuthorize.headers.get("location") ?? "", user);
    return back;
  }

  it("asks for mcp first", async () => {
    const ctx = setupConnect();
    await ctx.connect(ANNA, "anna");
    expect(ctx.mock.scopesSeen).toContain(`authorize:${WITHOUT_MCP} mcp`);
    expect((await ctx.store.db.readAccount(ANNA))?.scope).toContain("mcp");
  });

  it("asks again without mcp when the sign-in answers invalid_scope, and the person sees no failure", async () => {
    const ctx = setupConnect();
    ctx.mock.rejectMcp = "authorize";
    const ask = await ctx.link(ANNA);
    const refused = ctx.mock.signIn(open(ask.url, NOW).headers.get("location") ?? "", "anna");
    expect(refused.searchParams.get("error")).toBe("invalid_scope");

    const retry = await ctx.callback(`${refused.pathname}${refused.search}`);
    const back = await follow(ctx, retry, "anna");
    expect(ctx.mock.scopesSeen.filter((entry) => entry.startsWith("authorize:"))).toEqual([
      `authorize:${WITHOUT_MCP} mcp`,
      `authorize:${WITHOUT_MCP}`,
    ]);
    const done = await ctx.callback(`${back.pathname}${back.search}`);
    expect(done.statusCode).toBe(200);
    expect(ctx.mock.userOf((await ctx.store.db.readAccount(ANNA))?.accessToken ?? "")).toBe("anna");

    // The next number goes straight to the scope that works.
    await ctx.link(BRUNO);
    expect(ctx.mock.scopesSeen.filter((entry) => entry.startsWith("authorize:"))).toHaveLength(2);
    const next = await ctx.link(BRUNO);
    const location = new URL(open(next.url, NOW).headers.get("location") ?? "");
    expect(location.searchParams.get("scope")).toBe(WITHOUT_MCP);
  });

  it("asks again without mcp when the token step answers invalid_scope", async () => {
    const ctx = setupConnect();
    ctx.mock.rejectMcp = "token";
    const ask = await ctx.link(ANNA);
    const back = ctx.mock.signIn(open(ask.url, NOW).headers.get("location") ?? "", "anna");
    const retry = await ctx.callback(`${back.pathname}${back.search}`);
    const again = await follow(ctx, retry, "anna");
    const done = await ctx.callback(`${again.pathname}${again.search}`);
    expect(done.statusCode).toBe(200);
    expect(await ctx.store.db.readAccount(ANNA)).not.toBeNull();
  });

  it("registers without mcp when registration rejects the scope", async () => {
    const ctx = setupConnect();
    ctx.mock.rejectMcp = "register";
    const ask = await ctx.link(ANNA);
    expect(ctx.mock.scopesSeen.filter((entry) => entry.startsWith("register:"))).toEqual([
      `register:${WITHOUT_MCP} mcp`,
      `register:${WITHOUT_MCP}`,
    ]);
    expect(ctx.mock.registrations).toBe(1);
    const location = new URL(open(ask.url, NOW).headers.get("location") ?? "");
    expect(location.searchParams.get("scope")).toBe(WITHOUT_MCP);
  });

  it("does not loop: a refusal of a scope that already left mcp out is final", async () => {
    const ctx = setupConnect();
    ctx.mock.rejectMcp = "authorize";
    const ask = await ctx.link(ANNA);
    const refused = ctx.mock.signIn(open(ask.url, NOW).headers.get("location") ?? "", "anna");
    const retry = await ctx.callback(`${refused.pathname}${refused.search}`);
    const second = open(retry.headers.get("location") ?? "", NOW).headers.get("location") ?? "";
    const again = new URL(refused);
    again.searchParams.set("state", new URL(second).searchParams.get("state") ?? "");
    const final = await ctx.callback(`${again.pathname}${again.search}`);
    expect(final.statusCode).toBe(200);
    expect(final.body).toContain("Not connected");
    expect(await ctx.store.db.readAccount(ANNA)).toBeNull();
  });
});
