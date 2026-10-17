import { lexroomBaseUrl, lexroomLogin } from "./lexroom-api.js";
import { accessTokenExpiresAtMs } from "./lexroom-connect.js";
import { LexroomTimeoutError } from "./lexroom-guard.js";
import type { LexroomLog } from "./lexroom-log.js";
import { timeoutFailure, type LexroomTimeoutFailure } from "./lexroom-timeout.js";
import { createTrace, newCorrelationId } from "./lexroom-transport.js";

export type LexroomLoginSuccess = {
  ok: true;
  email: string;
  accessToken: string;
  /** Empty when Lexroom login did not return a refresh token. */
  refreshToken: string;
  accessExpiresAtMs: number | null;
};

export type LexroomLoginFailure =
  | { ok: false; reason: "invalid_credentials"; error: string }
  | { ok: false; reason: "mfa_required"; error: string }
  | { ok: false; reason: "lexroom_error"; error: string }
  | LexroomTimeoutFailure;

export type LexroomLoginResult = LexroomLoginSuccess | LexroomLoginFailure;

const MFA_ERROR =
  "This Lexroom account requires a one-time code (MFA), which Ada cannot enter. Use a Lexroom account without MFA.";

function firstText(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? "").find((value) => value !== "") ?? "";
}

/**
 * Signs in the way the lexroom-bot client does: one `POST /v1/login` with a JSON email and
 * password, the `X-Client-Type` header and nothing else, no cookies and no web-app session.
 * The bearer comes back in the JSON body. This is both the connect page's sign-in and the
 * silent re-login Ada does when the bearer expires or is rejected.
 */
export async function loginLexroomAccount(params: {
  email: string;
  password: string;
  baseUrl?: string;
  /** Hard limit on one attempt, connect to last body byte. No default: the caller decides. */
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  log?: LexroomLog;
}): Promise<LexroomLoginResult> {
  const email = params.email.trim();
  const password = params.password;
  if (!email || !password) {
    return {
      ok: false,
      reason: "invalid_credentials",
      error: "Email and password are required.",
    };
  }
  let reply: Awaited<ReturnType<typeof lexroomLogin>>;
  try {
    reply = await lexroomLogin(
      {
        baseUrl: lexroomBaseUrl(params.baseUrl),
        timeoutMs: params.timeoutMs,
        fetchImpl: params.fetchImpl,
        signal: params.signal,
        trace: createTrace(params.log, newCorrelationId()),
      },
      { email, password },
    );
  } catch (error) {
    if (error instanceof LexroomTimeoutError) {
      return timeoutFailure(error.limitMs);
    }
    return { ok: false, reason: "lexroom_error", error: "Ada could not reach Lexroom." };
  }
  if (reply.kind === "http_error") {
    const { status, detail, code } = reply;
    if (detail.startsWith("mfa_") || code.startsWith("mfa_")) {
      return { ok: false, reason: "mfa_required", error: MFA_ERROR };
    }
    if (status === 401 || code === "authentication_failed") {
      return {
        ok: false,
        reason: "invalid_credentials",
        error: "Those Lexroom credentials were not accepted.",
      };
    }
    return {
      ok: false,
      reason: "lexroom_error",
      error: detail
        ? `Lexroom returned ${status}: ${detail.slice(0, 160)}`
        : `Lexroom returned ${status}`,
    };
  }
  if (reply.kind === "unexpected_shape") {
    return { ok: false, reason: "lexroom_error", error: "Lexroom login returned an empty body." };
  }
  const body = reply.body;
  const accessToken = firstText(body.access_token, body.token, body.accessToken, body.access);
  if (!accessToken) {
    return {
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom login did not return an access token.",
    };
  }
  return {
    ok: true,
    email: firstText(body.email, body.user_email, body.username) || email,
    accessToken,
    refreshToken: firstText(body.refresh_token, body.refresh, body.refreshToken),
    accessExpiresAtMs: accessTokenExpiresAtMs(accessToken),
  };
}
