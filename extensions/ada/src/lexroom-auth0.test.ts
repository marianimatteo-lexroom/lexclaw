import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL,
  html,
  jsonBody,
  jwt,
  lexroomSite,
  PASSWORD,
  PASSWORD_PAGE,
  requests,
  withError,
  type Handlers,
} from "./lexroom-auth0-test-support.js";
import { AUTH0_DEFAULT_CLIENT_ID, AUTH0_DEFAULT_REALM, readAuth0Config } from "./lexroom-auth0.js";
import { loginLexroomAccount } from "./lexroom-login.js";

const SECRET = "auth0-client-secret-0123456789abcdef";
const MFA_TOKEN = "mfa-token-0123456789abcdefghijklmnop";
const ENV = { ADA_LEXROOM_AUTH0_CLIENT_SECRET: SECRET } as NodeJS.ProcessEnv;

type Logged = { event: string; fields: Record<string, string | number | boolean> };

function run(
  handlers: Handlers = {},
  options: { env?: NodeJS.ProcessEnv; baseUrl?: string; timeoutMs?: number } = {},
) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const bearer = jwt(exp);
  const site = lexroomSite({
    "POST auth.lexroom.ai/oauth/token": () =>
      jsonBody({
        access_token: bearer,
        id_token: "id-token-value",
        token_type: "Bearer",
        expires_in: 86400,
      }),
    "GET api.lexroom.ai/v1/credits": () => jsonBody({ credits: 5 }),
    "POST api.lexroom.ai/v1/login": () => jsonBody({ detail: "auth0_login_required" }, 403),
    ...handlers,
  });
  const events: Logged[] = [];
  const login = (overrides: { email?: string; password?: string } = {}) =>
    loginLexroomAccount({
      email: overrides.email ?? EMAIL,
      password: overrides.password ?? PASSWORD,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs ?? 1000,
      fetchImpl: site.fetchImpl,
      log: (event, fields) => events.push({ event, fields }),
      env: options.env ?? ENV,
    });
  return { ...site, events, login, bearer, exp };
}

describe("the Auth0 settings", () => {
  it("are absent without a client secret, so the other paths decide", () => {
    expect(readAuth0Config({})).toBeNull();
    expect(readAuth0Config({ ADA_LEXROOM_AUTH0_CLIENT_SECRET: "  " })).toBeNull();
  });

  it("default to Lexroom's client, its database connection and the access token", () => {
    expect(readAuth0Config(ENV)).toEqual({
      clientSecret: SECRET,
      clientId: AUTH0_DEFAULT_CLIENT_ID,
      realm: AUTH0_DEFAULT_REALM,
      bearer: "access_token",
    });
    expect(AUTH0_DEFAULT_CLIENT_ID).toBe("Mb9ixXPSnvNlbnTlwFLTO6GpyodwM42a");
    expect(AUTH0_DEFAULT_REALM).toBe("lexroom-users");
  });

  it("read the ADA_ names, and the pre-rename VERA_ ones", () => {
    expect(
      readAuth0Config({
        ADA_LEXROOM_AUTH0_CLIENT_SECRET: SECRET,
        ADA_LEXROOM_AUTH0_CLIENT_ID: "other-client",
        ADA_LEXROOM_AUTH0_REALM: "other-realm",
        ADA_LEXROOM_AUTH0_TOKEN: "ID_TOKEN",
      }),
    ).toEqual({
      clientSecret: SECRET,
      clientId: "other-client",
      realm: "other-realm",
      bearer: "id_token",
    });
    expect(
      readAuth0Config({
        VERA_LEXROOM_AUTH0_CLIENT_SECRET: SECRET,
        VERA_LEXROOM_AUTH0_REALM: "old",
      }),
    ).toMatchObject({ clientSecret: SECRET, realm: "old" });
    expect(
      readAuth0Config({
        ADA_LEXROOM_AUTH0_CLIENT_SECRET: SECRET,
        ADA_LEXROOM_AUTH0_TOKEN: "nonsense",
      }),
    ).toMatchObject({ bearer: "access_token" });
  });
});

describe("the Auth0 password-realm sign-in", () => {
  it("posts the grant Auth0 defines and uses its access token as the bearer", async () => {
    const { login, calls, bearer, exp } = run();
    await expect(login({ email: ` ${EMAIL} ` })).resolves.toEqual({
      ok: true,
      email: EMAIL,
      accessToken: bearer,
      refreshToken: "",
      accessExpiresAtMs: exp * 1000,
    });
    const token = calls.find((call) => call.path === "/oauth/token");
    expect(token?.method).toBe("POST");
    expect(token?.host).toBe("auth.lexroom.ai");
    expect(token?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(token?.body ?? "")).toEqual({
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      client_id: "Mb9ixXPSnvNlbnTlwFLTO6GpyodwM42a",
      client_secret: SECRET,
      username: EMAIL,
      password: PASSWORD,
      realm: "lexroom-users",
      audience: "urn:lexroom:api:prod",
      scope: "openid profile email",
    });
  });

  it("is the only path tried: no old login and no web flow", async () => {
    const { login, calls, events } = run();
    await login();
    expect(requests(calls)).toEqual([
      "POST auth.lexroom.ai/oauth/token",
      "GET api.lexroom.ai/v1/credits",
    ]);
    expect(events.find((entry) => entry.event === "login.path")?.fields.path).toBe(
      "auth0_password_realm",
    );
  });

  it("uses the configured client id and realm, and the id token when asked", async () => {
    const { login, calls } = run(
      {},
      {
        env: {
          ADA_LEXROOM_AUTH0_CLIENT_SECRET: SECRET,
          ADA_LEXROOM_AUTH0_CLIENT_ID: "staging-client",
          ADA_LEXROOM_AUTH0_REALM: "Username-Password-Authentication",
          ADA_LEXROOM_AUTH0_TOKEN: "id_token",
        },
      },
    );
    await expect(login()).resolves.toMatchObject({ ok: true, accessToken: "id-token-value" });
    const body = JSON.parse(calls.find((call) => call.path === "/oauth/token")?.body ?? "");
    expect(body).toMatchObject({
      client_id: "staging-client",
      realm: "Username-Password-Authentication",
    });
    expect(calls.find((call) => call.path === "/v1/credits")?.headers.get("authorization")).toBe(
      "Bearer id-token-value",
    );
  });

  it("checks the token against Lexroom's API with the headers the web app sends", async () => {
    const { login, calls, bearer } = run();
    await login();
    const probe = calls.find((call) => call.path === "/v1/credits");
    expect(probe?.headers.get("authorization")).toBe(`Bearer ${bearer}`);
    expect(probe?.headers.get("x-client-type")).toBe("app_lex");
  });

  it("falls back to expires_in for a token that carries no expiry", async () => {
    const { login } = run({
      "POST auth.lexroom.ai/oauth/token": () =>
        jsonBody({ access_token: "opaque", expires_in: 600 }),
    });
    const result = await login();
    expect(result).toMatchObject({ ok: true, accessToken: "opaque" });
    const at = result.ok ? (result.accessExpiresAtMs ?? 0) : 0;
    expect(at).toBeGreaterThan(Date.now() + 590_000);
    expect(at).toBeLessThan(Date.now() + 610_000);
    const none = run({
      "POST auth.lexroom.ai/oauth/token": () => jsonBody({ access_token: "opaque" }),
    });
    await expect(none.login()).resolves.toMatchObject({ ok: true, accessExpiresAtMs: null });
  });

  it.each([
    [
      "a wrong password",
      403,
      { error: "invalid_grant", error_description: "Wrong email or password." },
      "wrong_password",
    ],
    [
      "a one-time code requirement",
      403,
      {
        error: "mfa_required",
        error_description: "Multifactor authentication required",
        mfa_token: MFA_TOKEN,
      },
      "mfa_required",
    ],
    [
      "a client that may not use the grant",
      403,
      {
        error: "unauthorized_client",
        error_description: "Grant type 'password-realm' not allowed for the client.",
      },
      "forbidden",
    ],
    [
      "a refused client secret",
      401,
      { error: "invalid_client", error_description: "Unauthorized" },
      "forbidden",
    ],
    [
      "a blocked account",
      403,
      { error: "access_denied", error_description: "user is blocked" },
      "forbidden",
    ],
    [
      "a lockout after repeated attempts",
      429,
      { error: "too_many_attempts", error_description: "blocked" },
      "forbidden",
    ],
    ["a rate limit", 429, { error: "too_many_requests" }, "unavailable"],
    ["an Auth0 outage", 503, {}, "unavailable"],
  ])("maps %s to %s", async (_label, status, body, reason) => {
    const { login, calls } = run({
      "POST auth.lexroom.ai/oauth/token": () => jsonBody(body, status),
    });
    await expect(login()).resolves.toMatchObject({ ok: false, reason });
    expect(requests(calls)).toEqual(["POST auth.lexroom.ai/oauth/token"]);
  });

  it("carries Auth0's code and description on a refusal, for the log and the message", async () => {
    const { login, events } = run({
      "POST auth.lexroom.ai/oauth/token": () =>
        jsonBody(
          {
            error: "unauthorized_client",
            error_description: "Grant type 'password-realm' not allowed.",
          },
          403,
        ),
    });
    await expect(login()).resolves.toEqual({
      ok: false,
      reason: "forbidden",
      error:
        "Auth0 refused the sign-in (unauthorized_client): Grant type 'password-realm' not allowed.",
      status: 403,
      code: "unauthorized_client",
      detail: "Grant type 'password-realm' not allowed.",
    });
    expect(events.find((entry) => entry.event === "auth0.rejected")?.fields).toMatchObject({
      status: 403,
      code: "unauthorized_client",
      detail: "Grant type 'password-realm' not allowed.",
    });
  });

  it("is unavailable for a network error and for a 200 without the token it was asked for", async () => {
    const down = run({
      "POST auth.lexroom.ai/oauth/token": () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    const bare = run({
      "POST auth.lexroom.ai/oauth/token": () => jsonBody({ token_type: "Bearer" }),
    });
    await expect(bare.login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    const onlyAccess = run(
      { "POST auth.lexroom.ai/oauth/token": () => jsonBody({ access_token: "a" }) },
      { env: { ...ENV, ADA_LEXROOM_AUTH0_TOKEN: "id_token" } },
    );
    await expect(onlyAccess.login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("never logs the secret, the password, the address, a token or Auth0's mfa_token", async () => {
    const ok = run();
    await ok.login();
    const refused = run({
      "POST auth.lexroom.ai/oauth/token": () =>
        jsonBody(
          {
            error: "mfa_required",
            error_description: `user ${EMAIL} used ${PASSWORD} with ${SECRET}`,
            mfa_token: MFA_TOKEN,
          },
          403,
        ),
    });
    await refused.login();
    const logged = JSON.stringify([...ok.events, ...refused.events]);
    for (const secret of [SECRET, PASSWORD, EMAIL, MFA_TOKEN, ok.bearer, "id-token-value"]) {
      expect(logged).not.toContain(secret);
    }
    expect(new Set(ok.events.map((entry) => entry.fields.cid)).size).toBe(1);
  });

  it("is a refusal when Auth0 signed in but Lexroom's API rejects the token", async () => {
    const { login, events } = run({
      "GET api.lexroom.ai/v1/credits": () =>
        jsonBody({ detail: "Token is invalid or expired" }, 401),
    });
    const result = await login();
    expect(result).toMatchObject({
      ok: false,
      reason: "forbidden",
      status: 401,
      code: "token_rejected",
      error: expect.stringContaining("ADA_LEXROOM_AUTH0_TOKEN=id_token"),
    });
    expect(events.find((entry) => entry.event === "login.verify")?.fields).toMatchObject({
      status: 401,
    });
  });

  it.each([
    ["a 403", () => jsonBody({ detail: "permission" }, 403)],
    ["a 500", () => jsonBody({}, 500)],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "keeps the token when the check gets %s, which does not show it is rejected",
    async (_label, probe) => {
      const { login } = run({ "GET api.lexroom.ai/v1/credits": probe });
      await expect(login()).resolves.toMatchObject({ ok: true });
    },
  );

  it("ignores the secret for a host that is not Lexroom's production", async () => {
    const { login, calls } = run(
      { "POST staging.example/v1/login": () => jsonBody({ access_token: "tok" }) } as Handlers,
      { baseUrl: "https://staging.example" },
    );
    await login().catch(() => undefined);
    expect(calls.some((call) => call.path === "/oauth/token")).toBe(false);
  });
});

describe("the Auth0 password-realm sign-in's limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a token endpoint that never answers as a timeout, without a retry", async () => {
    const { login, calls } = run({
      "POST auth.lexroom.ai/oauth/token": () =>
        new Promise<Response>(() => {
          // Never settles.
        }),
    });
    const pending = login();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "timeout",
      message: "Lexroom did not respond within 1s; the request was abandoned.",
      error: "Lexroom did not respond within 1s; the request was abandoned.",
    });
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a check that never answers as a timeout too", async () => {
    const { login } = run({
      "GET api.lexroom.ai/v1/credits": () =>
        new Promise<Response>(() => {
          // Never settles.
        }),
    });
    const pending = login();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("choosing the path when there is no client secret", () => {
  const NO_SECRET = {} as NodeJS.ProcessEnv;

  it("tries the old endpoint once, and on auth0_login_required signs in through the web flow", async () => {
    const { login, calls, events, accessToken } = run({}, { env: NO_SECRET });
    await expect(login()).resolves.toMatchObject({ ok: true, accessToken });
    expect(requests(calls).slice(0, 3)).toEqual([
      "POST api.lexroom.ai/v1/login",
      "GET app.lexroom.ai/api/auth/login",
      "GET auth.lexroom.ai/authorize",
    ]);
    expect(requests(calls)).not.toContain("POST auth.lexroom.ai/oauth/token");
    expect(events.find((entry) => entry.event === "login.rejected")?.fields).toMatchObject({
      status: 403,
      detail: "auth0_login_required",
    });
    expect(events.find((entry) => entry.event === "login.path")?.fields.path).toBe("web");
    expect(new Set(events.map((entry) => entry.fields.cid)).size).toBe(1);
  });

  it("stops at the old endpoint where it still works, and where it says the password is wrong", async () => {
    const works = run(
      { "POST api.lexroom.ai/v1/login": () => jsonBody({ access_token: "legacy-token" }) },
      { env: NO_SECRET },
    );
    await expect(works.login()).resolves.toMatchObject({ ok: true, accessToken: "legacy-token" });
    expect(requests(works.calls)).toEqual(["POST api.lexroom.ai/v1/login"]);

    const wrong = run(
      {
        "POST api.lexroom.ai/v1/login": () =>
          jsonBody({ detail: "No active account", code: "authentication_failed" }, 401),
      },
      { env: NO_SECRET },
    );
    await expect(wrong.login()).resolves.toMatchObject({ ok: false, reason: "wrong_password" });
    expect(requests(wrong.calls)).toEqual(["POST api.lexroom.ai/v1/login"]);
  });

  it("does not start the web flow for a refusal that is not about Auth0", async () => {
    const { login, calls } = run(
      { "POST api.lexroom.ai/v1/login": () => jsonBody({ detail: "account_disabled" }, 403) },
      { env: NO_SECRET },
    );
    await expect(login()).resolves.toMatchObject({ ok: false, reason: "forbidden" });
    expect(requests(calls)).toEqual(["POST api.lexroom.ai/v1/login"]);
  });

  it("does not run the web flow against a host that is not Lexroom's production", async () => {
    const { login, calls } = run(
      {
        "POST staging.example/v1/login": () => jsonBody({ detail: "auth0_login_required" }, 403),
      } as Handlers,
      { env: NO_SECRET, baseUrl: "https://staging.example" },
    );
    await expect(login()).resolves.toMatchObject({
      ok: false,
      reason: "forbidden",
      code: "auth0_login_required",
    });
    expect(calls.every((call) => call.host === "staging.example")).toBe(true);
  });

  it("reports a wrong password from the web flow as wrong_password", async () => {
    const { login } = run(
      {
        "POST auth.lexroom.ai/u/login/password": () =>
          html(withError(PASSWORD_PAGE, "wrong-credentials"), 400),
      },
      { env: NO_SECRET },
    );
    await expect(login()).resolves.toMatchObject({ ok: false, reason: "wrong_password" });
  });
});
