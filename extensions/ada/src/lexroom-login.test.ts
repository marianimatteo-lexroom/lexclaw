import { describe, expect, it, vi } from "vitest";
import { loginLexroomAccount } from "./lexroom-login.js";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(exp: number): string {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "sig",
  ].join(".");
}

describe("loginLexroomAccount", () => {
  it("posts one /v1/login with the lexroom-bot headers and an ASCII-only JSON body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ access_token: "tok" }, 200);
    });
    await loginLexroomAccount({ email: " Lawyer@Lexroom.ai ", password: "pässwörd", fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.lexroom.ai/v1/login");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(Object.fromEntries(new Headers(calls[0]?.init?.headers))).toEqual({
      "content-type": "application/json",
      "x-client-type": "app_lex",
    });
    const body = String(calls[0]?.init?.body);
    expect(body).toBe('{"email":"Lawyer@Lexroom.ai","password":"p\\u00e4ssw\\u00f6rd"}');
    expect(JSON.parse(body)).toEqual({ email: "Lawyer@Lexroom.ai", password: "pässwörd" });
  });

  it("honors a configured base URL", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ access_token: "tok" }, 200),
    );
    await loginLexroomAccount({
      email: "a@b.it",
      password: "x",
      baseUrl: "https://staging.lexroom.test/",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://staging.lexroom.test/v1/login");
  });

  it.each([
    ["access_token", { access_token: "a", token: "b", accessToken: "c" }, "a"],
    ["token", { token: "b", accessToken: "c" }, "b"],
    ["accessToken", { accessToken: "c" }, "c"],
    ["access", { access: "d" }, "d"],
  ])("reads the bearer from %s", async (_key, body, expected) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body, 200));
    await expect(
      loginLexroomAccount({ email: "a@b.it", password: "x", fetchImpl }),
    ).resolves.toMatchObject({ ok: true, accessToken: expected });
  });

  it("returns the token, refresh token, expiry and email without cookies or a web session", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = jwt(exp);
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { access_token: access, refresh: "refresh-token", email: "lawyer@lexroom.ai" },
        200,
      ),
    );
    await expect(
      loginLexroomAccount({ email: "Lawyer@Lexroom.ai", password: "secret", fetchImpl }),
    ).resolves.toEqual({
      ok: true,
      email: "lawyer@lexroom.ai",
      accessToken: access,
      refreshToken: "refresh-token",
      accessExpiresAtMs: exp * 1000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the typed email and an empty refresh token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "opaque" }, 200));
    await expect(
      loginLexroomAccount({ email: "lawyer@lexroom.ai", password: "secret", fetchImpl }),
    ).resolves.toEqual({
      ok: true,
      email: "lawyer@lexroom.ai",
      accessToken: "opaque",
      refreshToken: "",
      accessExpiresAtMs: null,
    });
  });

  it("maps a 401 to invalid credentials", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          detail: "No active account found with the given credentials",
          code: "authentication_failed",
        },
        401,
      ),
    );
    await expect(
      loginLexroomAccount({ email: "a@b.it", password: "wrong", fetchImpl }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_credentials",
      error: "Those Lexroom credentials were not accepted.",
    });
  });

  it("reports an account that needs MFA instead of starting a web-app sign-in", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "mfa_step_up_required" }, 403));
    await expect(
      loginLexroomAccount({ email: "a@b.it", password: "x", fetchImpl }),
    ).resolves.toMatchObject({ ok: false, reason: "mfa_required" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is a Lexroom error for a 5xx, a missing token, an empty body or a network failure", async () => {
    const run = (fetchImpl: typeof fetch) =>
      loginLexroomAccount({ email: "a@b.it", password: "x", fetchImpl });
    await expect(run(vi.fn(async () => jsonResponse({}, 503)))).resolves.toEqual({
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom returned 503",
    });
    await expect(run(vi.fn(async () => jsonResponse({ ok: true }, 200)))).resolves.toMatchObject({
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom login did not return an access token.",
    });
    await expect(run(vi.fn(async () => new Response("", { status: 200 })))).resolves.toMatchObject({
      ok: false,
      reason: "lexroom_error",
    });
    await expect(
      run(
        vi.fn(async () => {
          throw new Error("network");
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "lexroom_error" });
  });

  it("does not call Lexroom without an email and password", async () => {
    const fetchImpl = vi.fn();
    await expect(
      loginLexroomAccount({ email: "", password: "x", fetchImpl }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_credentials" });
    await expect(
      loginLexroomAccount({ email: "a@b.it", password: "", fetchImpl }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
