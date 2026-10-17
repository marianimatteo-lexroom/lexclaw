import type { LexroomTimeoutFailure } from "./lexroom-timeout.js";

export type LexroomLoginSuccess = {
  ok: true;
  email: string;
  accessToken: string;
  /** Empty when the sign-in did not return a refresh token. */
  refreshToken: string;
  accessExpiresAtMs: number | null;
};

/**
 * Why a sign-in failed, in terms of what to do next:
 * - `wrong_password`: the credentials were rejected.
 * - `mfa_required`: a one-time code is needed, which Ada cannot enter.
 * - `captcha_required`: bot detection asked for a captcha, which Ada cannot solve.
 * - `forbidden`: Lexroom or Auth0 answered and refused this account or client.
 * - `unavailable`: no usable answer (network error, 5xx, a page that is not what was expected).
 * - `timeout`: a limit ended it.
 */
export type LexroomLoginFailure =
  | { ok: false; reason: "wrong_password"; error: string }
  | { ok: false; reason: "mfa_required"; error: string }
  | { ok: false; reason: "captcha_required"; error: string }
  | { ok: false; reason: "unavailable"; error: string }
  | {
      ok: false;
      reason: "forbidden";
      error: string;
      /** What was answered, safe to log: no email, password or token. 0 when there was no HTTP status. */
      status: number;
      code: string;
      detail: string;
    }
  | LexroomTimeoutFailure;

export type LexroomLoginResult = LexroomLoginSuccess | LexroomLoginFailure;

export const MFA_ERROR =
  "This Lexroom account requires a one-time code (MFA), which Ada cannot enter. Use a Lexroom account without MFA.";

export const CAPTCHA_ERROR =
  "Lexroom asked for a captcha (bot detection), which Ada cannot solve. Try again later, or sign in on app.lexroom.ai first.";

/** Words from Lexroom or Auth0, bounded and without anything the request carried. */
export function loggableDetail(detail: string, secrets: readonly string[]): string {
  let text = detail;
  for (const secret of secrets) {
    if (secret) {
      text = text.replaceAll(secret, "[redacted]");
    }
  }
  return text
    .replace(/[^\s@]+@[^\s@]+/gu, "[redacted]")
    .replace(/[A-Za-z0-9_.-]{24,}/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

export function unavailable(error: string): LexroomLoginFailure {
  return { ok: false, reason: "unavailable", error };
}

export function forbidden(params: {
  error: string;
  status?: number;
  code?: string;
  detail?: string;
}): LexroomLoginFailure {
  return {
    ok: false,
    reason: "forbidden",
    error: params.error,
    status: params.status ?? 0,
    code: (params.code ?? "").slice(0, 60),
    detail: params.detail ?? "",
  };
}
