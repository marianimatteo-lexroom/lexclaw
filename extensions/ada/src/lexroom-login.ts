import { lexroomBaseUrl, lexroomLogin } from "./lexroom-api.js";
import { auth0PasswordRealmLogin, readAuth0Config } from "./lexroom-auth0.js";
import { accessTokenExpiresAtMs } from "./lexroom-connect.js";
import { createGuard, LexroomTimeoutError } from "./lexroom-guard.js";
import { isProductionHost } from "./lexroom-links.js";
import type { LexroomLog } from "./lexroom-log.js";
import {
  forbidden,
  loggableDetail,
  MFA_ERROR,
  unavailable,
  type LexroomLoginResult,
} from "./lexroom-login-types.js";
import { timeoutFailure } from "./lexroom-timeout.js";
import { createTrace, newCorrelationId, type Trace } from "./lexroom-transport.js";
import { webLogin } from "./lexroom-web-login.js";

export type {
  LexroomLoginFailure,
  LexroomLoginResult,
  LexroomLoginSuccess,
} from "./lexroom-login-types.js";

function firstText(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? "").find((value) => value !== "") ?? "";
}

/** A refusal Lexroom gave on purpose. 408 and 429 only ask to try again later. */
function isRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** What the old email-and-password endpoint said: a result, or "use Auth0 instead". */
async function legacyLogin(params: {
  email: string;
  password: string;
  apiBaseUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  trace: Trace;
}): Promise<LexroomLoginResult | "auth0_required"> {
  let reply: Awaited<ReturnType<typeof lexroomLogin>>;
  try {
    reply = await lexroomLogin(
      {
        baseUrl: params.apiBaseUrl,
        timeoutMs: params.timeoutMs,
        fetchImpl: params.fetchImpl,
        signal: params.signal,
        trace: params.trace,
      },
      { email: params.email, password: params.password },
    );
  } catch (error) {
    if (error instanceof LexroomTimeoutError) {
      throw error;
    }
    return unavailable("Ada could not reach Lexroom.");
  }
  if (reply.kind === "http_error") {
    const { status, code } = reply;
    const detail = loggableDetail(reply.detail, [params.email, params.password]);
    params.trace("login.rejected", { status, code: code.slice(0, 60), detail });
    // Lexroom now signs people in through Auth0 and says so; any other refusal is its own.
    if (reply.detail === "auth0_login_required" || code === "auth0_login_required") {
      return "auth0_required";
    }
    if (reply.detail.startsWith("mfa_") || code.startsWith("mfa_")) {
      return { ok: false, reason: "mfa_required", error: MFA_ERROR };
    }
    if (status === 401 || code === "authentication_failed") {
      return {
        ok: false,
        reason: "wrong_password",
        error: "Those Lexroom credentials were not accepted.",
      };
    }
    if (isRefusal(status)) {
      return forbidden({
        error: `Lexroom refused the sign-in for this account (HTTP ${status})${detail ? `: ${detail}` : ""}`,
        status,
        code,
        detail,
      });
    }
    return unavailable(
      detail ? `Lexroom returned ${status}: ${detail}` : `Lexroom returned ${status}`,
    );
  }
  if (reply.kind === "unexpected_shape") {
    return unavailable("Lexroom login returned an empty body.");
  }
  const body = reply.body;
  const accessToken = firstText(body.access_token, body.token, body.accessToken, body.access);
  if (!accessToken) {
    return unavailable("Lexroom login did not return an access token.");
  }
  return {
    ok: true,
    email: firstText(body.email, body.user_email, body.username) || params.email,
    accessToken,
    refreshToken: firstText(body.refresh_token, body.refresh, body.refreshToken),
    accessExpiresAtMs: accessTokenExpiresAtMs(accessToken),
  };
}

/**
 * Signs in to Lexroom with an email and password and returns a bearer and its expiry. Which way
 * depends on how Lexroom signs people in, tried in this order:
 *
 * 1. With `ADA_LEXROOM_AUTH0_CLIENT_SECRET` set: Auth0's password-realm grant, and nothing else.
 * 2. Lexroom's old `POST /v1/login`, one request that answers `auth0_login_required` once
 *    Lexroom has moved to Auth0 (and still works where it has not).
 * 3. A headless replica of the web app's own Auth0 sign-in, for production Lexroom hosts.
 *
 * The whole sign-in, every step of it, ends within twice `timeoutMs`, and each step within
 * `timeoutMs`. Every step is logged with one correlation id and no secret.
 */
export async function loginLexroomAccount(params: {
  email: string;
  password: string;
  baseUrl?: string;
  /** Hard limit on one step, connect to last body byte. No default: the caller decides. */
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  log?: LexroomLog;
  env?: NodeJS.ProcessEnv;
}): Promise<LexroomLoginResult> {
  const email = params.email.trim();
  const password = params.password;
  if (!email || !password) {
    return { ok: false, reason: "wrong_password", error: "Email and password are required." };
  }
  const apiBaseUrl = lexroomBaseUrl(params.baseUrl);
  const production = isProductionHost(new URL(apiBaseUrl).hostname);
  const trace = createTrace(params.log, newCorrelationId());
  const flowMs = 2 * params.timeoutMs;
  const guard = createGuard({ idleMs: flowMs, totalMs: flowMs, signal: params.signal });
  const common = {
    email,
    password,
    timeoutMs: params.timeoutMs,
    signal: guard.signal,
    fetchImpl: params.fetchImpl,
    trace,
  };
  try {
    const auth0 = production ? readAuth0Config(params.env ?? process.env) : null;
    if (auth0) {
      trace("login.path", { path: "auth0_password_realm" });
      return await auth0PasswordRealmLogin({ ...common, config: auth0, apiBaseUrl });
    }
    const legacy = await legacyLogin({ ...common, apiBaseUrl });
    if (legacy !== "auth0_required") {
      trace("login.path", { path: "legacy" });
      return legacy;
    }
    if (!production) {
      return forbidden({
        error:
          "Lexroom requires an Auth0 sign-in, which Ada only does against Lexroom's production host.",
        status: 403,
        code: "auth0_login_required",
      });
    }
    trace("login.path", { path: "web" });
    return await webLogin(common);
  } catch (error) {
    if (error instanceof LexroomTimeoutError) {
      trace("login.timeout", { limitMs: error.limitMs });
      return timeoutFailure(error.limitMs);
    }
    return unavailable("Ada could not reach Lexroom.");
  } finally {
    guard.dispose();
  }
}
