import { describe, expect, it, vi } from "vitest";
import { loginLexroomAccount } from "./lexroom-login.js";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

  it("asks for MFA without treating it as a hard failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ detail: "mfa_step_up_required", code: "mfa_step_up_required" }, 403),
    );
    await expect(
      loginLexroomAccount({
        email: "lawyer@lexroom.ai",
        password: "secret",
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "mfa_required",
      error: "Lexroom needs a one-time code from your authenticator.",
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
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_credentials",
      error: "Those Lexroom credentials were not accepted.",
    });
  });
});
