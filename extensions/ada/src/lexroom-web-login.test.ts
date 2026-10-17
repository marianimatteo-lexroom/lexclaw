import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL,
  html,
  IDENTIFIER_PAGE,
  jsonBody,
  jwt,
  lexroomSite,
  PASSWORD,
  PASSWORD_PAGE,
  redirect,
  requests,
  STATE,
  withCaptcha,
  withError,
  type Handlers,
} from "./lexroom-auth0-test-support.js";
import { loginLexroomAccount } from "./lexroom-login.js";
import { createTrace } from "./lexroom-transport.js";
import { judgePage, primaryForm, webLogin } from "./lexroom-web-login.js";

type Logged = { event: string; fields: Record<string, string | number | boolean> };

function run(handlers: Handlers = {}, timeoutMs = 1000) {
  const site = lexroomSite(handlers);
  const events: Logged[] = [];
  const trace = createTrace((event, fields) => events.push({ event, fields }), "cid-test");
  const login = () =>
    webLogin({ email: EMAIL, password: PASSWORD, timeoutMs, fetchImpl: site.fetchImpl, trace });
  return { ...site, events, login };
}

describe("the pages Auth0 serves", () => {
  it("reads the primary form as a browser would submit it, selects included", () => {
    expect(primaryForm(IDENTIFIER_PAGE)).toEqual({
      action: undefined,
      fields: [
        ["state", STATE],
        ["language", "it"],
        ["persist", "session"],
        ["username", ""],
        ["js-available", "false"],
        ["webauthn-available", "false"],
        ["is-brave", "false"],
        ["webauthn-platform-available", "false"],
        ["action", "default"],
      ],
    });
    expect(primaryForm(PASSWORD_PAGE)?.fields.map(([name]) => name)).toEqual([
      "state",
      "language",
      "persist",
      "username",
      "password",
      "action",
    ]);
  });

  it("finds no form where there is none, and ignores the secondary social forms", () => {
    expect(primaryForm("<html><form method=post></form></html>")).toBeUndefined();
    const withSocial = IDENTIFIER_PAGE.replace(
      "</body>",
      '<form data-provider="google" data-form-secondary="true"><input type="hidden" name="connection" value="google-oauth2"></form></body>',
    );
    expect(primaryForm(withSocial)?.fields.map(([name]) => name)).not.toContain("connection");
  });

  it("takes a healthy page, with the captcha code in its script, as healthy", () => {
    expect(judgePage(IDENTIFIER_PAGE)).toEqual({ kind: "ok" });
    expect(judgePage(PASSWORD_PAGE)).toEqual({ kind: "ok" });
  });

  it("reads wrong credentials, a block and a captcha from the page itself", () => {
    expect(judgePage(withError(PASSWORD_PAGE, "wrong-credentials"))).toEqual({
      kind: "wrong_password",
      code: "wrong-credentials",
    });
    expect(judgePage(withError(PASSWORD_PAGE, "blocked-user"))).toEqual({
      kind: "refused",
      code: "blocked-user",
    });
    expect(judgePage(withCaptcha(PASSWORD_PAGE))).toEqual({ kind: "captcha" });
    expect(
      judgePage(
        PASSWORD_PAGE.replace("</form>", '<span id="error-element-password"></span></form>'),
      ),
    ).toEqual({ kind: "wrong_password", code: "" });
  });
});

describe("webLogin", () => {
  it("signs in through the same steps as the web app, and returns the session's token and expiry", async () => {
    const { login, calls, accessToken } = run();
    const result = await login();
    expect(result).toEqual({
      ok: true,
      email: EMAIL,
      accessToken,
      refreshToken: "",
      accessExpiresAtMs: expect.any(Number),
    });
    expect(result.ok && result.accessExpiresAtMs).toBeGreaterThan(Date.now());
    expect(requests(calls)).toEqual([
      "GET app.lexroom.ai/api/auth/login",
      "GET auth.lexroom.ai/authorize",
      "GET auth.lexroom.ai/u/login/identifier",
      "POST auth.lexroom.ai/u/login/identifier",
      "GET auth.lexroom.ai/u/login/password",
      "POST auth.lexroom.ai/u/login/password",
      "GET auth.lexroom.ai/authorize/resume",
      "GET app.lexroom.ai/api/auth/callback/auth0",
      "GET app.lexroom.ai/",
      "GET app.lexroom.ai/api/auth/session",
    ]);
  });

  it("posts the identifier form exactly as the page defines it, then the password form", async () => {
    const { login, calls } = run();
    await login();
    const identifier = calls.find(
      (call) => call.method === "POST" && call.path.endsWith("identifier"),
    );
    expect(identifier?.search).toBe(`?state=${STATE}&ui_locales=it`);
    expect(identifier?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(identifier?.headers.get("origin")).toBe("https://auth.lexroom.ai");
    expect(identifier?.headers.get("referer")).toContain("/u/login/identifier");
    expect(identifier?.body).toBe(
      `state=${STATE}&language=it&persist=session&username=${encodeURIComponent(EMAIL)}&js-available=false&webauthn-available=false&is-brave=false&webauthn-platform-available=false&action=default`,
    );
    const password = calls.find((call) => call.method === "POST" && call.path.endsWith("password"));
    expect(password?.search).toBe(`?state=${STATE}&ui_locales=it`);
    expect(Object.fromEntries(new URLSearchParams(password?.body))).toEqual({
      state: STATE,
      language: "it",
      persist: "session",
      username: EMAIL,
      password: PASSWORD,
      action: "default",
    });
  });

  it("keeps each host's cookies to that host, and the password to Auth0", async () => {
    const { login, calls } = run();
    await login();
    for (const call of calls) {
      const cookie = call.headers.get("cookie") ?? "";
      if (call.host === "auth.lexroom.ai") {
        expect(cookie).not.toContain("PKCE-VERIFIER");
        expect(cookie).not.toContain("SESSION-COOKIE");
      } else {
        expect(cookie).not.toContain("AUTH0-SESSION");
        expect(call.body).not.toContain(PASSWORD);
      }
    }
    const callback = calls.find((call) => call.path === "/api/auth/callback/auth0");
    expect(callback?.headers.get("cookie")).toBe("authjs.pkce.code_verifier=PKCE-VERIFIER");
    const identifier = calls.find(
      (call) => call.method === "POST" && call.path.endsWith("identifier"),
    );
    expect(identifier?.headers.get("cookie")).toBe("auth0=AUTH0-SESSION");
    const session = calls.find((call) => call.path === "/api/auth/session");
    expect(session?.headers.get("cookie")).toContain("authjs.session-token=SESSION-COOKIE");
  });

  it("logs every step under one correlation id, and no secret", async () => {
    const { login, events, accessToken } = run();
    await login();
    const done = events.filter((entry) => entry.event.endsWith(".done"));
    expect(done.map((entry) => entry.event)).toEqual([
      "web.authorize.done",
      "web.authorize.done",
      "web.authorize.done",
      "web.identifier.done",
      "web.identifier.done",
      "web.password.done",
      "web.password.done",
      "web.password.done",
      "web.password.done",
      "web.session.done",
    ]);
    expect(new Set(events.map((entry) => entry.fields.cid))).toEqual(new Set(["cid-test"]));
    expect(done[3]?.fields).toMatchObject({
      endpoint: "POST /u/login/identifier",
      status: 302,
      ms: expect.any(Number),
    });
    const logged = JSON.stringify(events);
    for (const secret of [
      EMAIL,
      PASSWORD,
      STATE,
      "AUTH-CODE",
      "APP-STATE",
      accessToken,
      "CHALLENGE",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("is wrong_password when Auth0 shows the password page again with its error", async () => {
    const { login, calls, events } = run({
      "POST auth.lexroom.ai/u/login/password": () =>
        html(withError(PASSWORD_PAGE, "wrong-credentials"), 400),
    });
    await expect(login()).resolves.toEqual({
      ok: false,
      reason: "wrong_password",
      error: "Those Lexroom credentials were not accepted.",
    });
    expect(requests(calls).at(-1)).toBe("POST auth.lexroom.ai/u/login/password");
    expect(events.find((entry) => entry.event === "web.rejected")?.fields).toMatchObject({
      phase: "web.password",
      kind: "wrong_password",
      code: "wrong-credentials",
    });
  });

  it("is mfa_required when Auth0 sends the browser to a one-time-code step, without opening it", async () => {
    const { login, calls } = run({
      "POST auth.lexroom.ai/u/login/password": () =>
        redirect(`/u/mfa-otp-challenge?state=${STATE}`),
    });
    await expect(login()).resolves.toMatchObject({ ok: false, reason: "mfa_required" });
    expect(requests(calls).some((entry) => entry.includes("mfa"))).toBe(false);
  });

  it("is captcha_required when bot detection puts a captcha on the page", async () => {
    const afterPost = run({
      "POST auth.lexroom.ai/u/login/password": () => html(withCaptcha(PASSWORD_PAGE), 400),
    });
    await expect(afterPost.login()).resolves.toMatchObject({
      ok: false,
      reason: "captcha_required",
    });
    const beforePost = run({
      "GET auth.lexroom.ai/u/login/password": () => html(withCaptcha(PASSWORD_PAGE)),
    });
    await expect(beforePost.login()).resolves.toMatchObject({
      ok: false,
      reason: "captcha_required",
    });
    expect(requests(beforePost.calls)).not.toContain("POST auth.lexroom.ai/u/login/password");
  });

  it("is forbidden for a blocked account, and for an error Auth.js reports", async () => {
    const blocked = run({
      "POST auth.lexroom.ai/u/login/password": () =>
        html(withError(PASSWORD_PAGE, "blocked-user"), 400),
    });
    await expect(blocked.login()).resolves.toMatchObject({
      ok: false,
      reason: "forbidden",
      code: "blocked-user",
    });
    const denied = run({
      "GET app.lexroom.ai/api/auth/callback/auth0": () =>
        redirect("/auth/sign-in?error=AccessDenied"),
    });
    await expect(denied.login()).resolves.toMatchObject({
      ok: false,
      reason: "forbidden",
      code: "AccessDenied",
    });
    expect(requests(denied.calls)).not.toContain("GET app.lexroom.ai/auth/sign-in");
  });

  it("is unavailable when the session has no access token, however it says so", async () => {
    for (const session of [{ user: { email: EMAIL } }, {}, null]) {
      const { login } = run({ "GET app.lexroom.ai/api/auth/session": () => jsonBody(session) });
      await expect(login()).resolves.toEqual({
        ok: false,
        reason: "unavailable",
        error: "Lexroom signed in, but its session has no access token.",
      });
    }
    const notJson = run({ "GET app.lexroom.ai/api/auth/session": () => html("<html>") });
    await expect(notJson.login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("reads the expiry from the session when the token is opaque", async () => {
    const at = Math.floor(Date.now() / 1000) + 600;
    const { login } = run({
      "GET app.lexroom.ai/api/auth/session": () =>
        jsonBody({ user: { email: EMAIL, accessToken: "opaque", accessTokenExpires: at } }),
    });
    await expect(login()).resolves.toMatchObject({ ok: true, accessExpiresAtMs: at * 1000 });
    const unknown = run({
      "GET app.lexroom.ai/api/auth/session": () => jsonBody({ user: { accessToken: "opaque" } }),
    });
    await expect(unknown.login()).resolves.toMatchObject({
      ok: true,
      email: EMAIL,
      accessExpiresAtMs: null,
    });
  });

  it("prefers the token's own expiry", async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const { login } = run({
      "GET app.lexroom.ai/api/auth/session": () =>
        jsonBody({ user: { accessToken: jwt(exp), accessTokenExpires: 1 } }),
    });
    await expect(login()).resolves.toMatchObject({ ok: true, accessExpiresAtMs: exp * 1000 });
  });

  it.each([
    ["Lexroom's web app erroring", { "GET app.lexroom.ai/api/auth/login": () => html("", 503) }],
    [
      "a sign-in page without a form",
      { "GET auth.lexroom.ai/u/login/identifier": () => html("<html>maintenance</html>") },
    ],
    [
      "an identifier step that lands somewhere else",
      {
        "POST auth.lexroom.ai/u/login/identifier": () => redirect("/u/signup?state=x"),
        "GET auth.lexroom.ai/u/signup": () => html("<html>signup</html>"),
      },
    ],
    [
      "a password step that stops on an unrecognized page",
      { "POST auth.lexroom.ai/u/login/password": () => html(PASSWORD_PAGE, 200) },
    ],
  ])("is unavailable, not a verdict on the password, for %s", async (_label, handlers) => {
    const { login } = run(handlers);
    await expect(login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("never follows a redirect off the two Lexroom hosts, nor loops forever", async () => {
    const off = run({
      "GET auth.lexroom.ai/authorize": () => redirect("https://evil.example/collect?x=1"),
    });
    await expect(off.login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    expect(off.calls.some((call) => call.host === "evil.example")).toBe(false);

    const insecure = run({
      "GET auth.lexroom.ai/authorize": () => redirect("http://auth.lexroom.ai/authorize"),
    });
    await expect(insecure.login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });

    const loop = run({
      "GET auth.lexroom.ai/authorize": () => redirect("/authorize"),
    });
    await expect(loop.login()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    expect(loop.calls.length).toBeLessThanOrEqual(16);
  });
});

describe("webLogin timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a step that never answers as a timeout, and leaves no timer behind", async () => {
    const { login, calls } = run({
      "POST auth.lexroom.ai/u/login/identifier": () =>
        new Promise<Response>(() => {
          // Never settles.
        }),
    });
    const pending = login().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ name: "LexroomTimeoutError", limitMs: 1000 });
    expect(requests(calls).at(-1)).toBe("POST auth.lexroom.ai/u/login/identifier");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a sign-in whose every step is within the limit but which as a whole is not", async () => {
    const site = lexroomSite();
    const events: Logged[] = [];
    // The old endpoint answers at once that Auth0 is required; every other step takes 600ms.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/v1/login") {
        return jsonBody({ detail: "auth0_login_required" }, 403);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 600);
      });
      return await site.fetchImpl(input, init);
    }) as typeof fetch;
    const pending = loginLexroomAccount({
      email: EMAIL,
      password: PASSWORD,
      timeoutMs: 1000,
      fetchImpl,
      log: (event, fields) => events.push({ event, fields }),
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "timeout",
      message: "Lexroom did not respond within 2s; the request was abandoned.",
      error: "Lexroom did not respond within 2s; the request was abandoned.",
    });
    expect(site.calls.length).toBeGreaterThan(1);
    expect(site.calls.length).toBeLessThan(10);
    expect(events.find((entry) => entry.event === "login.timeout")?.fields).toMatchObject({
      limitMs: 2000,
    });
    // Only the fake's own delay is still pending; nothing of the sign-in is.
    await vi.advanceTimersByTimeAsync(600);
    expect(vi.getTimerCount()).toBe(0);
  });
});
