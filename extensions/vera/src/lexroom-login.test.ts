import { describe, expect, it, vi } from "vitest";
import {
  loginLexroomAccount,
  openLexroomMfaTicket,
  sealLexroomMfaTicket,
} from "./lexroom-login.js";

const STATE_SECRET = "0123456789abcdef";

function jsonResponse(
  body: unknown,
  status: number,
  headers?: Record<string, string | string[]>,
): Response {
  const headerInit = new Headers();
  headerInit.set("content-type", "application/json");
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          headerInit.append(name, item);
        }
      } else {
        headerInit.set(name, value);
      }
    }
  }
  return new Response(JSON.stringify(body), { status, headers: headerInit });
}

describe("loginLexroomAccount", () => {
  it("stores access and refresh tokens from a successful login", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ exp })).toString("base64url"),
      "sig",
    ].join(".");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-Client-Type")).toBe("app_lex");
      expect(JSON.parse(String(init?.body))).toEqual({
        email: "lawyer@lexroom.ai",
        password: "secret",
      });
      return jsonResponse({ access, refresh: "refresh-token" }, 200);
    });
    await expect(
      loginLexroomAccount({
        email: "Lawyer@Lexroom.ai",
        password: "secret",
        stateSecret: STATE_SECRET,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      email: "lawyer@lexroom.ai",
      accessToken: access,
      refreshToken: "refresh-token",
      accessExpiresAtMs: exp * 1000,
    });
  });

  it("starts the Lexroom app MFA challenge instead of failing hard", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/login")) {
        return jsonResponse({ detail: "mfa_step_up_required", code: "mfa_step_up_required" }, 403);
      }
      if (url.endsWith("/api/auth/csrf")) {
        return jsonResponse(
          { csrfToken: "csrf-token" },
          200,
          {
            "set-cookie":
              "__Host-next-auth.csrf-token=csrf-token%7Chash; Path=/; HttpOnly; Secure; SameSite=Strict",
          },
        );
      }
      if (url.endsWith("/api/auth/callback/credentials")) {
        return jsonResponse(
          { url: "https://app.lexroom.ai/auth/mfa" },
          200,
          {
            "set-cookie":
              "__Secure-next-auth.session-token=pending-mfa; Path=/; HttpOnly; Secure; SameSite=Lax",
          },
        );
      }
      if (url.endsWith("/api/auth/mfa/start")) {
        expect(JSON.parse(String(init?.body))).toEqual({ method: "totp" });
        expect(new Headers(init?.headers).get("Cookie")).toContain(
          "__Secure-next-auth.session-token=pending-mfa",
        );
        return jsonResponse({ resendAfterSeconds: 0 }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await loginLexroomAccount({
      email: "lawyer@lexroom.ai",
      password: "secret",
      stateSecret: STATE_SECRET,
      fetchImpl,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "mfa_required",
      method: "totp",
    });
    if (!result.ok && result.reason === "mfa_required") {
      const opened = openLexroomMfaTicket(STATE_SECRET, result.mfaTicket);
      expect(opened?.method).toBe("totp");
      expect(opened?.cookies["__Secure-next-auth.session-token"]).toBe("pending-mfa");
    }
    expect(calls.some((call) => call.includes("/api/auth/mfa/start"))).toBe(true);
  });

  it("completes MFA through verify and session exchange", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ exp })).toString("base64url"),
      "sig",
    ].join(".");
    const mfaTicket = sealLexroomMfaTicket(STATE_SECRET, {
      email: "lawyer@lexroom.ai",
      method: "totp",
      cookies: { "__Secure-next-auth.session-token": "pending-mfa" },
      appBaseUrl: "https://app.lexroom.ai",
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/mfa/verify")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          code: "123456",
          rememberDevice: false,
        });
        return jsonResponse({ needsSessionExchange: true }, 200);
      }
      if (url.endsWith("/api/auth/csrf")) {
        return jsonResponse({ csrfToken: "csrf-2" }, 200);
      }
      if (url.endsWith("/api/auth/callback/mfa-session-exchange")) {
        return jsonResponse(
          { url: "https://app.lexroom.ai/" },
          200,
          {
            "set-cookie":
              "__Secure-next-auth.session-token=full-session; Path=/; HttpOnly; Secure; SameSite=Lax",
          },
        );
      }
      if (url.endsWith("/api/auth/session")) {
        return jsonResponse(
          { user: { accessToken: access, email: "lawyer@lexroom.ai" } },
          200,
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(
      loginLexroomAccount({
        email: "lawyer@lexroom.ai",
        password: "",
        otp: "123456",
        mfaTicket,
        stateSecret: STATE_SECRET,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      email: "lawyer@lexroom.ai",
      accessToken: access,
      refreshToken: "",
      accessExpiresAtMs: exp * 1000,
    });
  });

  it("maps authentication failures", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { detail: "No active account found with the given credentials", code: "authentication_failed" },
        401,
      ),
    );
    await expect(
      loginLexroomAccount({
        email: "lawyer@lexroom.ai",
        password: "wrong",
        stateSecret: STATE_SECRET,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_credentials",
      error: "Those Lexroom credentials were not accepted.",
    });
  });

  it("rejects an expired MFA ticket", async () => {
    const mfaTicket = sealLexroomMfaTicket(STATE_SECRET, {
      email: "lawyer@lexroom.ai",
      method: "totp",
      cookies: { session: "x" },
      appBaseUrl: "https://app.lexroom.ai",
      exp: Date.now() - 1_000,
    });
    await expect(
      loginLexroomAccount({
        email: "lawyer@lexroom.ai",
        password: "",
        otp: "123456",
        mfaTicket,
        stateSecret: STATE_SECRET,
        fetchImpl: vi.fn(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_mfa",
    });
  });
});
