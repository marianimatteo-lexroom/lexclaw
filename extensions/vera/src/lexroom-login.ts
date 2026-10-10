import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { DEFAULT_LEXROOM_BASE_URL, LEXROOM_CLIENT_TYPE } from "./lexroom-client.js";
import { accessTokenExpiresAtMs } from "./lexroom-connect.js";

type FetchLike = typeof fetch;

export const DEFAULT_LEXROOM_APP_BASE_URL = "https://app.lexroom.ai";

const MFA_TICKET_TTL_MS = 10 * 60 * 1000;
const MFA_METHODS = ["totp", "sms"] as const;

export type LexroomLoginSuccess = {
  ok: true;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAtMs: number | null;
};

export type LexroomLoginFailure =
  | { ok: false; reason: "invalid_credentials"; error: string }
  | {
      ok: false;
      reason: "mfa_required";
      error: string;
      mfaTicket: string;
      method?: string;
    }
  | { ok: false; reason: "invalid_mfa"; error: string; mfaTicket?: string }
  | { ok: false; reason: "lexroom_error"; error: string };

export type LexroomLoginResult = LexroomLoginSuccess | LexroomLoginFailure;

type CookieJar = Map<string, string>;

type MfaTicketPayload = {
  v: 2;
  email: string;
  password: string;
  method: string;
  cookies: Record<string, string>;
  appBaseUrl: string;
  exp: number;
};

function apiBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_LEXROOM_BASE_URL).replace(/\/+$/u, "");
}

function appBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_LEXROOM_APP_BASE_URL).replace(/\/+$/u, "");
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

function ticketKey(stateSecret: string): Buffer {
  return createHash("sha256").update(`vera-lexroom-mfa:${stateSecret}`).digest();
}

export function sealLexroomMfaTicket(
  stateSecret: string,
  payload: Omit<MfaTicketPayload, "v" | "exp"> & { exp?: number },
  nowMs = Date.now(),
): string {
  const body: MfaTicketPayload = {
    v: 2,
    email: payload.email,
    password: payload.password,
    method: payload.method,
    cookies: payload.cookies,
    appBaseUrl: payload.appBaseUrl,
    exp: payload.exp ?? nowMs + MFA_TICKET_TTL_MS,
  };
  const key = ticketKey(stateSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(body), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function openLexroomMfaTicket(
  stateSecret: string,
  ticket: string,
  nowMs = Date.now(),
): MfaTicketPayload | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(ticket, "base64url");
  } catch {
    return null;
  }
  if (raw.length < 12 + 16 + 1) {
    return null;
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", ticketKey(stateSecret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      "utf8",
    );
    const parsed = JSON.parse(plaintext) as Partial<MfaTicketPayload> & { v?: number };
    if (
      (parsed.v !== 1 && parsed.v !== 2) ||
      typeof parsed.email !== "string" ||
      typeof parsed.method !== "string" ||
      typeof parsed.appBaseUrl !== "string" ||
      typeof parsed.exp !== "number" ||
      !parsed.cookies ||
      typeof parsed.cookies !== "object"
    ) {
      return null;
    }
    if (parsed.exp <= nowMs) {
      return null;
    }
    return {
      v: 2,
      email: parsed.email,
      password: typeof parsed.password === "string" ? parsed.password : "",
      method: parsed.method,
      cookies: parsed.cookies as Record<string, string>,
      appBaseUrl: parsed.appBaseUrl,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

function storeSetCookies(jar: CookieJar, response: Response): void {
  const headers =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const header of headers) {
    const segments = header.split(";").map((part) => part.trim());
    const pair = segments[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (!name) {
      continue;
    }
    const maxAge = segments.find((part) => part.toLowerCase().startsWith("max-age="));
    if (maxAge && Number.parseInt(maxAge.slice(8), 10) === 0) {
      jar.delete(name);
      continue;
    }
    if (segments.some((part) => part.toLowerCase().startsWith("expires=") && part.includes("1970"))) {
      jar.delete(name);
      continue;
    }
    if (!value) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function hasSessionCookie(jar: CookieJar): boolean {
  for (const name of jar.keys()) {
    if (name.includes("session-token") || name.includes("sessionToken")) {
      return true;
    }
  }
  return false;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchCsrf(
  fetchImpl: FetchLike,
  appBase: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(`${appBase}/api/auth/csrf`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
    },
    signal,
  });
  storeSetCookies(jar, response);
  const json = await readJson(response);
  const token =
    json && typeof json === "object" && typeof (json as { csrfToken?: unknown }).csrfToken === "string"
      ? (json as { csrfToken: string }).csrfToken.trim()
      : "";
  if (!response.ok || !token) {
    throw new Error("csrf");
  }
  return token;
}

async function fetchFollow(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<Response> {
  let current = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let hop = 0; hop < 8; hop += 1) {
    if (jar.size > 0) {
      headers.set("Cookie", cookieHeader(jar));
    } else {
      headers.delete("Cookie");
    }
    const response = await fetchImpl(current, {
      method,
      headers,
      body,
      signal,
      redirect: "manual",
    });
    storeSetCookies(jar, response);
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    // Drain the body so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    current = new URL(location, current).toString();
    method = "GET";
    body = undefined;
    headers = new Headers({ Accept: headers.get("Accept") || "*/*" });
  }
  throw new Error("redirect");
}

async function postNextAuthCredentials(params: {
  fetchImpl: FetchLike;
  appBase: string;
  jar: CookieJar;
  provider: "credentials" | "mfa-session-exchange";
  fields: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; url: string }> {
  const csrfToken = await fetchCsrf(params.fetchImpl, params.appBase, params.jar, params.signal);
  const body = new URLSearchParams({
    csrfToken,
    json: "true",
    callbackUrl: `${params.appBase}/`,
    ...params.fields,
  });
  const response = await fetchFollow(
    params.fetchImpl,
    `${params.appBase}/api/auth/callback/${params.provider}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
    params.jar,
    params.signal,
  );
  const json = await readJson(response);
  const url =
    json && typeof json === "object" && typeof (json as { url?: unknown }).url === "string"
      ? (json as { url: string }).url
      : response.headers.get("location") ?? response.url ?? "";
  return { ok: response.ok, status: response.status, url };
}

async function postAppJson(params: {
  fetchImpl: FetchLike;
  appBase: string;
  jar: CookieJar;
  path: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ status: number; json: unknown }> {
  const response = await fetchFollow(
    params.fetchImpl,
    `${params.appBase}${params.path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: params.appBase,
        Referer: `${params.appBase}/auth/mfa`,
      },
      body: JSON.stringify(params.body),
    },
    params.jar,
    params.signal,
  );
  return { status: response.status, json: await readJson(response) };
}

async function readAppSession(params: {
  fetchImpl: FetchLike;
  appBase: string;
  jar: CookieJar;
  signal?: AbortSignal;
}): Promise<{ accessToken: string; email: string }> {
  const response = await fetchFollow(
    params.fetchImpl,
    `${params.appBase}/api/auth/session`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
    params.jar,
    params.signal,
  );
  const json = await readJson(response);
  if (!response.ok || !json || typeof json !== "object") {
    return { accessToken: "", email: "" };
  }
  const user = (json as { user?: unknown }).user;
  if (!user || typeof user !== "object") {
    return { accessToken: "", email: "" };
  }
  const record = user as Record<string, unknown>;
  return {
    accessToken: readString(record, ["accessToken", "access_token", "access"]),
    email: readString(record, ["email", "user_email", "username"]).toLowerCase(),
  };
}

function mfaSetupUrl(url: string): boolean {
  try {
    const path = new URL(url, DEFAULT_LEXROOM_APP_BASE_URL).pathname;
    return path === "/auth/mfa/setup" || path.startsWith("/auth/mfa/setup/");
  } catch {
    return false;
  }
}

function mfaStepUpUrl(url: string): boolean {
  try {
    const path = new URL(url, DEFAULT_LEXROOM_APP_BASE_URL).pathname;
    return path === "/auth/mfa";
  } catch {
    return false;
  }
}

const MFA_SETUP_ERROR =
  "This Lexroom account still needs MFA setup in Lexroom. Open app.lexroom.ai, finish authenticator setup, then try this Vera link again.";

function authErrorStatus(url: string): number | null {
  try {
    const value = new URL(url, DEFAULT_LEXROOM_APP_BASE_URL).searchParams.get("authError");
    if (!value) {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function startMfaChallenge(params: {
  fetchImpl: FetchLike;
  appBase: string;
  jar: CookieJar;
  preferredMethod?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; method: string } | { ok: false; status: number }> {
  const methods = [
    ...(params.preferredMethod ? [params.preferredMethod] : []),
    ...MFA_METHODS,
  ].filter((method, index, all) => all.indexOf(method) === index);
  let lastStatus = 0;
  for (const method of methods) {
    const started = await postAppJson({
      fetchImpl: params.fetchImpl,
      appBase: params.appBase,
      jar: params.jar,
      path: "/api/auth/mfa/start",
      body: { method, purpose: "step_up" },
      signal: params.signal,
    });
    lastStatus = started.status;
    if (started.status >= 200 && started.status < 300) {
      return { ok: true, method };
    }
    // Some Lexroom builds already have an active challenge; treat as ready.
    if (started.status === 409) {
      return { ok: true, method };
    }
  }
  // Empty body fallback (lets Lexroom pick the default method).
  const fallback = await postAppJson({
    fetchImpl: params.fetchImpl,
    appBase: params.appBase,
    jar: params.jar,
    path: "/api/auth/mfa/start",
    body: {},
    signal: params.signal,
  });
  if (fallback.status >= 200 && fallback.status < 300) {
    return { ok: true, method: params.preferredMethod || "totp" };
  }
  return { ok: false, status: lastStatus || fallback.status };
}

async function establishMfaSession(params: {
  email: string;
  password: string;
  appBase: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; kind: "mfa"; jar: CookieJar; method: string }
  | { ok: true; kind: "session"; email: string; accessToken: string }
  | { ok: false; reason: "invalid_credentials" | "lexroom_error"; error: string }
> {
  const jar: CookieJar = new Map();
  const signedIn = await postNextAuthCredentials({
    fetchImpl: params.fetchImpl,
    appBase: params.appBase,
    jar,
    provider: "credentials",
    fields: {
      email: params.email,
      password: params.password,
    },
    signal: params.signal,
  });
  const errorStatus = authErrorStatus(signedIn.url);
  if (errorStatus === 401 || errorStatus === 403) {
    return {
      ok: false,
      reason: "invalid_credentials",
      error: "Those Lexroom credentials were not accepted.",
    };
  }
  // Lexroom asks unfinished accounts to enroll MFA before any OTP challenge.
  if (mfaSetupUrl(signedIn.url)) {
    return {
      ok: false,
      reason: "lexroom_error",
      error: MFA_SETUP_ERROR,
    };
  }
  if (!mfaStepUpUrl(signedIn.url)) {
    const session = await readAppSession({
      fetchImpl: params.fetchImpl,
      appBase: params.appBase,
      jar,
      signal: params.signal,
    });
    if (session.accessToken) {
      return {
        ok: true,
        kind: "session",
        email: session.email || params.email,
        accessToken: session.accessToken,
      };
    }
    return {
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom did not start the MFA challenge for this account.",
    };
  }
  // Touch the MFA page so any server-set challenge cookies land in the jar.
  await fetchFollow(
    params.fetchImpl,
    `${params.appBase}/auth/mfa`,
    {
      method: "GET",
      headers: { Accept: "text/html,application/json" },
    },
    jar,
    params.signal,
  ).then(async (response) => {
    await response.arrayBuffer().catch(() => undefined);
  });
  const started = await startMfaChallenge({
    fetchImpl: params.fetchImpl,
    appBase: params.appBase,
    jar,
    signal: params.signal,
  });
  if (started.ok) {
    return { ok: true, kind: "mfa", jar, method: started.method };
  }
  // Keep going when Lexroom already established a pending MFA session cookie.
  if (hasSessionCookie(jar)) {
    return { ok: true, kind: "mfa", jar, method: "totp" };
  }
  return {
    ok: false,
    reason: "lexroom_error",
    error: `Lexroom MFA challenge failed (${started.status || "no-session"}). Try again shortly.`,
  };
}

async function beginMfaViaApp(params: {
  email: string;
  password: string;
  stateSecret: string;
  appBaseUrl?: string;
  signal?: AbortSignal;
  fetchImpl: FetchLike;
}): Promise<LexroomLoginResult> {
  const appBase = appBaseUrl(params.appBaseUrl);
  try {
    const established = await establishMfaSession({
      email: params.email,
      password: params.password,
      appBase,
      fetchImpl: params.fetchImpl,
      signal: params.signal,
    });
    if (!established.ok) {
      return established;
    }
    if (established.kind === "session") {
      return {
        ok: true,
        email: established.email,
        accessToken: established.accessToken,
        refreshToken: "",
        accessExpiresAtMs: accessTokenExpiresAtMs(established.accessToken),
      };
    }
    const mfaTicket = sealLexroomMfaTicket(params.stateSecret, {
      email: params.email,
      password: params.password,
      method: established.method,
      cookies: Object.fromEntries(established.jar.entries()),
      appBaseUrl: appBase,
    });
    return {
      ok: false,
      reason: "mfa_required",
      mfaTicket,
      method: established.method,
      error:
        established.method === "sms"
          ? "Lexroom sent a one-time code by SMS. Enter it below."
          : "Lexroom needs a one-time code from your authenticator.",
    };
  } catch {
    return { ok: false, reason: "lexroom_error", error: "Vera could not reach Lexroom." };
  }
}

async function completeMfaViaApp(params: {
  otp: string;
  mfaTicket: string;
  stateSecret: string;
  signal?: AbortSignal;
  fetchImpl: FetchLike;
}): Promise<LexroomLoginResult> {
  const opened = openLexroomMfaTicket(params.stateSecret, params.mfaTicket);
  if (!opened) {
    return {
      ok: false,
      reason: "invalid_mfa",
      error: "The MFA step expired. Enter your Lexroom password again.",
    };
  }
  const appBase = opened.appBaseUrl;
  try {
    let jar: CookieJar = new Map(Object.entries(opened.cookies));
    if (!hasSessionCookie(jar) && opened.password) {
      const refreshed = await establishMfaSession({
        email: opened.email,
        password: opened.password,
        appBase,
        fetchImpl: params.fetchImpl,
        signal: params.signal,
      });
      if (!refreshed.ok) {
        return refreshed.reason === "invalid_credentials"
          ? {
              ok: false,
              reason: "invalid_mfa",
              error: "The MFA step expired. Enter your Lexroom password again.",
            }
          : refreshed;
      }
      if (refreshed.kind === "session") {
        return {
          ok: true,
          email: refreshed.email,
          accessToken: refreshed.accessToken,
          refreshToken: "",
          accessExpiresAtMs: accessTokenExpiresAtMs(refreshed.accessToken),
        };
      }
      jar = refreshed.jar;
    } else {
      await startMfaChallenge({
        fetchImpl: params.fetchImpl,
        appBase,
        jar,
        preferredMethod: opened.method,
        signal: params.signal,
      });
    }

    const verified = await postAppJson({
      fetchImpl: params.fetchImpl,
      appBase,
      jar,
      path: "/api/auth/mfa/verify",
      body: {
        code: params.otp,
        rememberDevice: false,
      },
      signal: params.signal,
    });
    if (verified.status === 403 && opened.password) {
      const refreshed = await establishMfaSession({
        email: opened.email,
        password: opened.password,
        appBase,
        fetchImpl: params.fetchImpl,
        signal: params.signal,
      });
      if (refreshed.ok && refreshed.kind === "session") {
        return {
          ok: true,
          email: refreshed.email,
          accessToken: refreshed.accessToken,
          refreshToken: "",
          accessExpiresAtMs: accessTokenExpiresAtMs(refreshed.accessToken),
        };
      }
      if (refreshed.ok && refreshed.kind === "mfa") {
        jar = refreshed.jar;
        const retry = await postAppJson({
          fetchImpl: params.fetchImpl,
          appBase,
          jar,
          path: "/api/auth/mfa/verify",
          body: {
            code: params.otp,
            rememberDevice: false,
          },
          signal: params.signal,
        });
        return finishVerifiedMfa({
          verified: retry,
          jar,
          opened,
          mfaTicket: params.mfaTicket,
          fetchImpl: params.fetchImpl,
          signal: params.signal,
        });
      }
    }
    return finishVerifiedMfa({
      verified,
      jar,
      opened,
      mfaTicket: params.mfaTicket,
      fetchImpl: params.fetchImpl,
      signal: params.signal,
    });
  } catch {
    return { ok: false, reason: "lexroom_error", error: "Vera could not reach Lexroom." };
  }
}

async function finishVerifiedMfa(params: {
  verified: { status: number; json: unknown };
  jar: CookieJar;
  opened: MfaTicketPayload;
  mfaTicket: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}): Promise<LexroomLoginResult> {
  const { verified, jar, opened } = params;
  if (verified.status === 400 || verified.status === 401 || verified.status === 422) {
    return {
      ok: false,
      reason: "invalid_mfa",
      mfaTicket: params.mfaTicket,
      error: "That one-time code was not accepted. Try again.",
    };
  }
  if (verified.status === 409 || verified.status === 410) {
    return {
      ok: false,
      reason: "invalid_mfa",
      error: "The MFA step expired. Enter your Lexroom password again.",
    };
  }
  if (verified.status === 403) {
    return {
      ok: false,
      reason: "invalid_mfa",
      error: "The MFA step expired. Enter your Lexroom password again.",
    };
  }
  if (verified.status < 200 || verified.status >= 300) {
    return {
      ok: false,
      reason: "lexroom_error",
      error: `Lexroom returned ${verified.status} while verifying MFA.`,
    };
  }
  const needsExchange =
    !verified.json ||
    typeof verified.json !== "object" ||
    (verified.json as { needsSessionExchange?: unknown }).needsSessionExchange !== false;
  if (needsExchange) {
    const exchanged = await postNextAuthCredentials({
      fetchImpl: params.fetchImpl,
      appBase: opened.appBaseUrl,
      jar,
      provider: "mfa-session-exchange",
      fields: {},
      signal: params.signal,
    });
    if (authErrorStatus(exchanged.url) != null || !exchanged.ok) {
      return {
        ok: false,
        reason: "lexroom_error",
        error: "Lexroom verified MFA but did not finish the sign-in session.",
      };
    }
  }
  const session = await readAppSession({
    fetchImpl: params.fetchImpl,
    appBase: opened.appBaseUrl,
    jar,
    signal: params.signal,
  });
  if (!session.accessToken) {
    return {
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom MFA finished without an access token.",
    };
  }
  return {
    ok: true,
    email: session.email || opened.email,
    accessToken: session.accessToken,
    refreshToken: "",
    accessExpiresAtMs: accessTokenExpiresAtMs(session.accessToken),
  };
}

async function loginViaApi(params: {
  email: string;
  password: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl: FetchLike;
}): Promise<LexroomLoginResult | { ok: false; reason: "mfa_step_up" }> {
  let response: Response;
  try {
    response = await params.fetchImpl(`${apiBaseUrl(params.baseUrl)}/v1/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Client-Type": LEXROOM_CLIENT_TYPE,
      },
      body: JSON.stringify({ email: params.email, password: params.password }),
      signal: params.signal,
    });
  } catch {
    return { ok: false, reason: "lexroom_error", error: "Vera could not reach Lexroom." };
  }
  const json = await readJson(response);
  if (!response.ok) {
    const { detail, code } = detailCode(json);
    if (detail === "mfa_enrollment_required" || code === "mfa_enrollment_required") {
      return {
        ok: false,
        reason: "lexroom_error",
        error: MFA_SETUP_ERROR,
      };
    }
    if (detail === "mfa_step_up_required" || code === "mfa_step_up_required") {
      return { ok: false, reason: "mfa_step_up" };
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
      error: detail
        ? `Lexroom returned ${response.status}: ${detail.slice(0, 160)}`
        : `Lexroom returned ${response.status}`,
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
    email: emailFromBody || params.email,
    accessToken,
    refreshToken,
    accessExpiresAtMs: accessTokenExpiresAtMs(accessToken),
  };
}

export async function loginLexroomAccount(params: {
  email: string;
  password: string;
  otp?: string;
  mfaTicket?: string;
  /** Required to seal/open the Lexroom app MFA cookie ticket. */
  stateSecret?: string;
  baseUrl?: string;
  appBaseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<LexroomLoginResult> {
  const email = params.email.trim().toLowerCase();
  const password = params.password;
  const otp = params.otp?.trim() ?? "";
  const mfaTicket = params.mfaTicket?.trim() ?? "";
  const stateSecret = params.stateSecret?.trim() ?? "";
  const fetchImpl = params.fetchImpl ?? fetch;

  if (otp && mfaTicket) {
    if (!stateSecret) {
      return {
        ok: false,
        reason: "lexroom_error",
        error: "Vera Lexroom MFA is not configured.",
      };
    }
    return completeMfaViaApp({
      otp,
      mfaTicket,
      stateSecret,
      signal: params.signal,
      fetchImpl,
    });
  }

  if (!email || !password) {
    return {
      ok: false,
      reason: "invalid_credentials",
      error: "Email and password are required.",
    };
  }

  const apiResult = await loginViaApi({
    email,
    password,
    baseUrl: params.baseUrl,
    signal: params.signal,
    fetchImpl,
  });
  if (!("reason" in apiResult) || apiResult.reason !== "mfa_step_up") {
    return apiResult;
  }
  if (!stateSecret) {
    return {
      ok: false,
      reason: "lexroom_error",
      error: "Lexroom needs MFA, but Vera could not start the challenge.",
    };
  }
  return beginMfaViaApp({
    email,
    password,
    stateSecret,
    appBaseUrl: params.appBaseUrl,
    signal: params.signal,
    fetchImpl,
  });
}
