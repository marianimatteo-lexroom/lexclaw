import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginLexroomAccount } from "./lexroom-login.js";

const TEST_TIMEOUT_MS = 5000;

function signIn(params: Omit<Parameters<typeof loginLexroomAccount>[0], "timeoutMs">) {
  return loginLexroomAccount({ ...params, timeoutMs: TEST_TIMEOUT_MS });
}

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
    await signIn({ email: " Lawyer@Lexroom.ai ", password: "pässwörd", fetchImpl });
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
    await signIn({
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
    await expect(signIn({ email: "a@b.it", password: "x", fetchImpl })).resolves.toMatchObject({
      ok: true,
      accessToken: expected,
    });
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
      signIn({ email: "Lawyer@Lexroom.ai", password: "secret", fetchImpl }),
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
      signIn({ email: "lawyer@lexroom.ai", password: "secret", fetchImpl }),
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
    await expect(signIn({ email: "a@b.it", password: "wrong", fetchImpl })).resolves.toEqual({
      ok: false,
      reason: "wrong_password",
      error: "Those Lexroom credentials were not accepted.",
    });
  });

  it("reports an account that needs MFA instead of starting a web-app sign-in", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "mfa_step_up_required" }, 403));
    await expect(signIn({ email: "a@b.it", password: "x", fetchImpl })).resolves.toMatchObject({
      ok: false,
      reason: "mfa_required",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is a Lexroom error for a 5xx, a missing token, an empty body or a network failure", async () => {
    const run = (fetchImpl: typeof fetch) => signIn({ email: "a@b.it", password: "x", fetchImpl });
    await expect(run(vi.fn(async () => jsonResponse({}, 503)))).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      error: "Lexroom returned 503",
    });
    await expect(run(vi.fn(async () => jsonResponse({ ok: true }, 200)))).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
      error: "Lexroom login did not return an access token.",
    });
    await expect(run(vi.fn(async () => new Response("", { status: 200 })))).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(
      run(
        vi.fn(async () => {
          throw new Error("network");
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("does not call Lexroom without an email and password", async () => {
    const fetchImpl = vi.fn();
    await expect(signIn({ email: "", password: "x", fetchImpl })).resolves.toMatchObject({
      ok: false,
      reason: "wrong_password",
    });
    await expect(signIn({ email: "a@b.it", password: "", fetchImpl })).resolves.toMatchObject({
      ok: false,
      reason: "wrong_password",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("loginLexroomAccount timeouts and retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const login = (
    fetchImpl: typeof fetch,
    extra: {
      log?: (event: string, fields: Record<string, string | number | boolean>) => void;
    } = {},
  ) =>
    loginLexroomAccount({
      email: "a@b.it",
      password: "secret-password",
      timeoutMs: 1000,
      fetchImpl,
      ...extra,
    });

  it("returns the structured timeout for a login that never answers, and aborts every attempt", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => {
        // Never settles.
      });
    });
    const pending = login(fetchImpl as unknown as typeof fetch);
    // One step is limited to 1s and the whole sign-in to twice that, so the retry is cut short.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "timeout",
      message: "Lexroom did not respond within 2s; the request was abandoned.",
      error: "Lexroom did not respond within 2s; the request was abandoned.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("covers a login body that never finishes", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () =>
              new Promise<void>(() => {
                // Never settles.
              }),
          }),
          {
            status: 200,
          },
        ),
    );
    const pending = login(fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(1000 + 500 + 1000);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a dropped connection once and then signs in", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok" }, 200));
    const pending = login(fetchImpl);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ ok: true, accessToken: "tok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, { detail: "No active account", code: "authentication_failed" }, "wrong_password"],
    [403, { detail: "You do not have permission to perform this action." }, "forbidden"],
    [500, { detail: "boom" }, "unavailable"],
  ])("answers a %i at once, with no retry", async (status, body, reason) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body, status));
    const result = await login(fetchImpl);
    expect(result).toMatchObject({ ok: false, reason });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tells a refusal from silence: a 403 is forbidden, with what Lexroom said", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          detail: "You do not have permission to perform this action.",
          code: "permission_denied",
        },
        403,
      ),
    );
    await expect(login(fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
      error:
        "Lexroom refused the sign-in for this account (HTTP 403): You do not have permission to perform this action.",
      status: 403,
      code: "permission_denied",
      detail: "You do not have permission to perform this action.",
    });
  });

  it.each([400, 402, 403, 404, 409, 410, 422])(
    "treats a %i as a refusal Lexroom gave on purpose, and never retries it",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, status));
      await expect(login(fetchImpl)).resolves.toMatchObject({
        ok: false,
        reason: "forbidden",
        status,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    "keeps a %i as Lexroom being unavailable, not a refusal",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, status));
      await expect(login(fetchImpl)).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    },
  );

  it("logs login.rejected with Lexroom's code and detail, and no email, password or token", async () => {
    const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          code: "account_blocked",
          detail:
            "User a@b.it blocked\n for secret-password via token abcdefghijklmnopqrstuvwxyz0123456789",
        },
        403,
      ),
    );
    await login(fetchImpl, { log: (event, fields) => events.push({ event, fields }) });
    const rejected = events.find((entry) => entry.event === "login.rejected");
    expect(rejected?.fields).toMatchObject({
      status: 403,
      code: "account_blocked",
      detail: "User [redacted] blocked for [redacted] via token [redacted]",
    });
    expect(rejected?.fields.cid).toBe(events[0]?.fields.cid);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("a@b.it");
    expect(logged).not.toContain("secret-password");
    expect(logged).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("bounds a long detail", async () => {
    const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ detail: "no ".repeat(200) }, 403));
    await login(fetchImpl, { log: (event, fields) => events.push({ event, fields }) });
    const detail = String(events.find((entry) => entry.event === "login.rejected")?.fields.detail);
    expect(detail.length).toBeLessThanOrEqual(160);
    expect(detail.length).toBeGreaterThan(100);
  });

  it("logs the login with a correlation id and endpoint, never the password or the address", async () => {
    const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ access_token: "tok-secret" }, 200));
    await login(fetchImpl, { log: (event, fields) => events.push({ event, fields }) });
    expect(events.map((entry) => entry.event)).toEqual(["login.response", "login.done", "login.path"]);
    const cids = new Set(events.map((entry) => entry.fields.cid));
    expect(cids.size).toBe(1);
    expect(events[1]?.fields).toMatchObject({ endpoint: "POST /v1/login", status: 200 });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("secret-password");
    expect(logged).not.toContain("tok-secret");
    expect(logged).not.toContain("a@b.it");
  });
});
