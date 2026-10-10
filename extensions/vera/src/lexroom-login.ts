import { DEFAULT_LEXROOM_BASE_URL, LEXROOM_CLIENT_TYPE } from "./lexroom-client.js";
import { accessTokenExpiresAtMs } from "./lexroom-connect.js";

type FetchLike = typeof fetch;

export type LexroomLoginSuccess = {
  ok: true;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAtMs: number | null;
};

export type LexroomLoginFailure =
  | { ok: false; reason: "invalid_credentials"; error: string }
  | { ok: false; reason: "mfa_required"; error: string }
  | { ok: false; reason: "lexroom_error"; error: string };

export type LexroomLoginResult = LexroomLoginSuccess | LexroomLoginFailure;

function baseUrl(value: string | undefined): string {
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

export async function loginLexroomAccount(params: {
  email: string;
  password: string;
  otp?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<LexroomLoginResult> {
  const email = params.email.trim().toLowerCase();
  const password = params.password;
  const otp = params.otp?.trim() ?? "";
  if (!email || !password) {
    return {
      ok: false,
      reason: "invalid_credentials",
      error: "Email and password are required.",
    };
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const body: Record<string, string> = { email, password };
  if (otp) {
    body.otp = otp;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl(params.baseUrl)}/v1/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Client-Type": LEXROOM_CLIENT_TYPE,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch {
    return { ok: false, reason: "lexroom_error", error: "Vera could not reach Lexroom." };
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const { detail, code } = detailCode(json);
    if (detail === "mfa_step_up_required" || code === "mfa_step_up_required") {
      return {
        ok: false,
        reason: "mfa_required",
        error: "Lexroom needs a one-time code from your authenticator.",
      };
    }
    if (response.status === 401 || code === "authentication_failed") {
      return {
        ok: false,
        reason: "invalid_credentials",
        error: "Those Lexroom credentials were not accepted.",
      };
    }
    return {
      ok: false,
      reason: "lexroom_error",
      error: detail ? `Lexroom returned ${response.status}: ${detail.slice(0, 160)}` : `Lexroom returned ${response.status}`,
    };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "lexroom_error", error: "Lexroom login returned an empty body." };
  }
  const record = json as Record<string, unknown>;
  const accessToken = readString(record, ["access", "access_token", "accessToken"]);
  if (!accessToken) {
    return {
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom login did not return an access token.",
    };
  }
  const refreshToken = readString(record, ["refresh", "refresh_token", "refreshToken"]);
  const emailFromBody = readString(record, ["email", "user_email", "username"]);
  return {
    ok: true,
    email: emailFromBody || email,
    accessToken,
    refreshToken,
    accessExpiresAtMs: accessTokenExpiresAtMs(accessToken),
  };
}
