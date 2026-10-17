import { afterEach, describe, expect, it, vi } from "vitest";
import type { LexroomAccountRecord, LexroomAccountStore } from "./lexroom-account-contract.js";
import {
  html,
  jsonBody,
  jwt,
  lexroomSite,
  PASSWORD_PAGE,
  withCaptcha,
} from "./lexroom-auth0-test-support.js";
import { needsReconnect, renewLexroomAccount } from "./lexroom-session.js";

const NOW = new Date("2026-10-17T06:00:00.000Z");
const PASSWORD = "correct horse battery staple 9";

const account = (overrides: Partial<LexroomAccountRecord> = {}): LexroomAccountRecord => ({
  email: "lawyer@example.com",
  accessToken: "stale-token-aaaaaaaa",
  password: PASSWORD,
  refreshToken: "",
  accessExpiresAtMs: NOW.getTime() - 1000,
  connectedAtMs: 1,
  ...overrides,
});

function harness(
  respond: () => Response | Promise<Response>,
  overrides: Partial<LexroomAccountRecord> = {},
) {
  const store: LexroomAccountStore = {
    replacePending: vi.fn(async () => {}),
    hasPending: vi.fn(async () => false),
    consumePending: vi.fn(async () => false),
    upsertAccount: vi.fn(async () => {}),
    readAccount: vi.fn(async () => account(overrides)),
    clearAccount: vi.fn(async () => {}),
  };
  const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
  const fetchImpl = vi.fn(async () => await respond()) as unknown as typeof fetch;
  const renew = () =>
    renewLexroomAccount(account(overrides), {
      store,
      fetchImpl,
      log: (event, fields) => events.push({ event, fields }),
      now: NOW,
      why: "expired",
    });
  return { store, events, fetchImpl, renew };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("a refused re-login", () => {
  it("is forbidden, not 'did not answer', and keeps the saved sign-in", async () => {
    const { store, renew } = harness(() =>
      json({ detail: "You do not have permission to perform this action." }, 403),
    );
    const result = await renew();
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    if (result.ok) {
      throw new Error("expected a failure");
    }
    expect(result.error).toContain("answered and refused");
    expect(result.error).not.toContain("did not answer");
    expect(result.error).toContain("ada_lexroom_connect");
    expect(needsReconnect(result)).toBe(false);
    expect(store.clearAccount).not.toHaveBeenCalled();
    expect(store.upsertAccount).not.toHaveBeenCalled();
  });

  it("does not retry a refusal", async () => {
    const { fetchImpl, renew } = harness(() => json({ detail: "no" }, 403));
    await renew();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("logs relogin.failed with the status, code and detail Lexroom gave, and no secret", async () => {
    const { events, renew } = harness(() =>
      json(
        {
          code: "account_blocked",
          detail: `User lawyer@example.com blocked, password ${PASSWORD}, token stale-token-aaaaaaaa-0123456789`,
        },
        403,
      ),
    );
    await renew();
    const failed = events.find((entry) => entry.event === "relogin.failed");
    expect(failed?.fields).toMatchObject({
      why: "expired",
      reason: "forbidden",
      status: 403,
      code: "account_blocked",
      detail: "User [redacted] blocked, password [redacted], token [redacted]",
    });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("lawyer@example.com");
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain("stale-token-aaaaaaaa");
  });

  it("is the same for any other refusal such as a 404 or a 422", async () => {
    for (const status of [400, 404, 422]) {
      const { renew } = harness(() => json({}, status));
      await expect(renew()).resolves.toMatchObject({ ok: false, reason: "forbidden" });
    }
  });
});

describe("a re-login Lexroom never answered", () => {
  it.each([
    ["a 503", () => json({}, 503)],
    ["a 502", () => json({}, 502)],
    ["a 429", () => json({}, 429)],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("stays unavailable for %s, and says Lexroom did not answer", async (_label, respond) => {
    const { store, events, renew } = harness(respond);
    const result = await renew();
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result).toMatchObject({ error: expect.stringContaining("did not answer") });
    expect(needsReconnect(result as never)).toBe(false);
    expect(store.clearAccount).not.toHaveBeenCalled();
    const failed = events.find((entry) => entry.event === "relogin.failed");
    expect(failed?.fields).not.toHaveProperty("detail");
  });
});

describe("the other reasons are unchanged", () => {
  it("clears the account for a wrong password, and asks to reconnect", async () => {
    const { store, renew } = harness(() =>
      json({ detail: "No active account", code: "authentication_failed" }, 401),
    );
    const result = await renew();
    expect(result).toMatchObject({ ok: false, reason: "wrong_password" });
    expect(needsReconnect(result as never)).toBe(true);
    expect(store.clearAccount).toHaveBeenCalledTimes(1);
  });
});

describe("re-login through Auth0", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const renewWith = (site: ReturnType<typeof lexroomSite>) => {
    const store: LexroomAccountStore = {
      replacePending: vi.fn(async () => {}),
      hasPending: vi.fn(async () => false),
      consumePending: vi.fn(async () => false),
      upsertAccount: vi.fn(async () => {}),
      readAccount: vi.fn(async () => account()),
      clearAccount: vi.fn(async () => {}),
    };
    const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
    return {
      store,
      events,
      renew: () =>
        renewLexroomAccount(account(), {
          store,
          fetchImpl: site.fetchImpl,
          log: (event, fields) => events.push({ event, fields }),
          now: NOW,
          why: "expired",
        }),
    };
  };

  it("renews the saved sign-in through the web flow when Lexroom wants Auth0", async () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 3600;
    const token = jwt(exp);
    const site = lexroomSite({
      "POST api.lexroom.ai/v1/login": () => jsonBody({ detail: "auth0_login_required" }, 403),
      "GET app.lexroom.ai/api/auth/session": () =>
        jsonBody({ user: { email: "lawyer@example.com", accessToken: token } }),
    });
    const { store, renew } = renewWith(site);
    await expect(renew()).resolves.toMatchObject({
      ok: true,
      account: { accessToken: token, accessExpiresAtMs: exp * 1000, password: PASSWORD },
    });
    expect(store.upsertAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: token, password: PASSWORD }),
    );
    expect(store.clearAccount).not.toHaveBeenCalled();
  });

  it("renews through Auth0's password-realm grant when the client secret is set", async () => {
    vi.stubEnv("ADA_LEXROOM_AUTH0_CLIENT_SECRET", "auth0-client-secret-0123456789abcdef");
    const token = jwt(Math.floor(NOW.getTime() / 1000) + 3600);
    const site = lexroomSite({
      "POST auth.lexroom.ai/oauth/token": () => jsonBody({ access_token: token, expires_in: 3600 }),
      "GET api.lexroom.ai/v1/credits": () => jsonBody({ credits: 1 }),
    });
    const { store, renew } = renewWith(site);
    await expect(renew()).resolves.toMatchObject({ ok: true, account: { accessToken: token } });
    expect(site.calls.map((call) => call.path)).toEqual(["/oauth/token", "/v1/credits"]);
    expect(store.upsertAccount).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved sign-in and says why when Lexroom asks for a captcha", async () => {
    const site = lexroomSite({
      "POST api.lexroom.ai/v1/login": () => jsonBody({ detail: "auth0_login_required" }, 403),
      "POST auth.lexroom.ai/u/login/password": () => html(withCaptcha(PASSWORD_PAGE), 400),
    });
    const { store, events, renew } = renewWith(site);
    const result = await renew();
    expect(result).toMatchObject({ ok: false, reason: "captcha_required" });
    if (result.ok) {
      throw new Error("expected a failure");
    }
    expect(result.error).toContain("captcha");
    expect(needsReconnect(result)).toBe(false);
    expect(store.clearAccount).not.toHaveBeenCalled();
    expect(events.find((entry) => entry.event === "relogin.failed")?.fields).toMatchObject({
      reason: "captcha_required",
    });
  });

  it("clears the account for a wrong password from Auth0, and keeps it for one-time codes and blocks", async () => {
    vi.stubEnv("ADA_LEXROOM_AUTH0_CLIENT_SECRET", "auth0-client-secret-0123456789abcdef");
    const wrong = renewWith(
      lexroomSite({
        "POST auth.lexroom.ai/oauth/token": () =>
          jsonBody({ error: "invalid_grant", error_description: "Wrong email or password." }, 403),
      }),
    );
    const result = await wrong.renew();
    expect(result).toMatchObject({ ok: false, reason: "wrong_password" });
    expect(wrong.store.clearAccount).toHaveBeenCalledTimes(1);

    const blocked = renewWith(
      lexroomSite({
        "POST auth.lexroom.ai/oauth/token": () =>
          jsonBody({ error: "unauthorized_client", error_description: "not allowed" }, 403),
      }),
    );
    const refused = await blocked.renew();
    expect(refused).toMatchObject({ ok: false, reason: "forbidden" });
    expect(blocked.store.clearAccount).not.toHaveBeenCalled();
    expect(blocked.events.find((entry) => entry.event === "relogin.failed")?.fields).toMatchObject({
      status: 403,
      code: "unauthorized_client",
      detail: "not allowed",
    });
  });
});
