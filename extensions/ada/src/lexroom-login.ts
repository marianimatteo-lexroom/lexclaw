import {
  asciiJson,
  DEFAULT_LEXROOM_BASE_URL,
  LEXROOM_CLIENT_TYPE,
  type LexroomLog,
} from "./lexroom-client.js";
import { accessTokenExpiresAtMs } from "./lexroom-connect.js";
import { LexroomTimeoutError } from "./lexroom-guard.js";
import { lexroomTimeoutMs, timeoutFailure, type LexroomTimeoutFailure } from "./lexroom-timeout.js";
import { createTrace, exchange, newCorrelationId, readJsonGuarded } from "./lexroom-transport.js";

type FetchLike = typeof fetch;

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

function apiBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_LEXROOM_BASE_URL).replace(/\/+$/u, "");
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function detailCode(body: unknown): { detail: string; code: string } {
  if (!body || typeof body !== "object") {
    return { detail: "", code: "" };
  }
  const record = body as Record<string, unknown>;
  return {
    detail: typeof record.detail === "string" ? record.detail : "",
    code: typeof record.code === "string" ? record.code : "",
  };
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
  /** Hard limit on one attempt, connect to last body byte. Defaults to the Lexroom request limit. */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
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
  const trace = createTrace(params.log, newCorrelationId());
  let sent: { status: number; ok: boolean; value: unknown };
  try {
    sent = await exchange({
      fetchImpl: params.fetchImpl ?? fetch,
      url: `${apiBaseUrl(params.baseUrl)}/v1/login`,
      init: {
        method: "POST",
        headers: new Headers({
          "Content-Type": "application/json",
          "X-Client-Type": LEXROOM_CLIENT_TYPE,
        }),
        body: asciiJson({ email, password }),
      },
      timeoutMs: params.timeoutMs ?? lexroomTimeoutMs(),
      signal: params.signal,
      trace,
      step: "login",
      // A login can be repeated safely, so a dropped connection or a silent server gets one more try.
      retry: "any",
      retryTimeout: true,
      read: (response, guard) => readJsonGuarded(response, guard),
    });
  } catch (error) {
    if (error instanceof LexroomTimeoutError) {
      return timeoutFailure(error.limitMs);
    }
    return { ok: false, reason: "lexroom_error", error: "Ada could not reach Lexroom." };
  }
  const json = sent.value;
  if (!sent.ok) {
    const { detail, code } = detailCode(json);
    if (detail.startsWith("mfa_") || code.startsWith("mfa_")) {
      return { ok: false, reason: "mfa_required", error: MFA_ERROR };
    }
    if (sent.status === 401 || code === "authentication_failed") {
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
        ? `Lexroom returned ${sent.status}: ${detail.slice(0, 160)}`
        : `Lexroom returned ${sent.status}`,
    };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "lexroom_error", error: "Lexroom login returned an empty body." };
  }
  const record = json as Record<string, unknown>;
  const accessToken = readString(record, ["access_token", "token", "accessToken", "access"]);
  if (!accessToken) {
    return {
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom login did not return an access token.",
    };
  }
  return {
    ok: true,
    email: readString(record, ["email", "user_email", "username"]) || email,
    accessToken,
    refreshToken: readString(record, ["refresh_token", "refresh", "refreshToken"]),
    accessExpiresAtMs: accessTokenExpiresAtMs(accessToken),
  };
}
