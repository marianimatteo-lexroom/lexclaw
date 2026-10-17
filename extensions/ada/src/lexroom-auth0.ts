import { readAdaEnv } from "./ada-env.js";
import { asciiJson, lexroomCreditsProbe } from "./lexroom-api.js";
import { accessTokenExpiresAtMs } from "./lexroom-connect.js";
import { LexroomTimeoutError } from "./lexroom-guard.js";
import {
  forbidden,
  loggableDetail,
  MFA_ERROR,
  unavailable,
  type LexroomLoginResult,
} from "./lexroom-login-types.js";
import { exchange, readJsonGuarded, type Trace } from "./lexroom-transport.js";

export const AUTH0_ISSUER = "https://auth.lexroom.ai";
export const AUTH0_DEFAULT_CLIENT_ID = "Mb9ixXPSnvNlbnTlwFLTO6GpyodwM42a";
/** The database connection behind Lexroom's Universal Login (its password-reset link names it). */
export const AUTH0_DEFAULT_REALM = "lexroom-users";
const AUTH0_AUDIENCE = "urn:lexroom:api:prod";
const AUTH0_SCOPE = "openid profile email";
const PASSWORD_REALM_GRANT = "http://auth0.com/oauth/grant-type/password-realm";

export type Auth0Config = {
  clientId: string;
  clientSecret: string;
  realm: string;
  /** Which Auth0 token Lexroom's API takes as the bearer. */
  bearer: "access_token" | "id_token";
};

/**
 * The Auth0 password-realm settings, or null when no client secret is set, which leaves the
 * sign-in to the other paths. Read from `ADA_LEXROOM_AUTH0_CLIENT_SECRET`, `_CLIENT_ID`, `_REALM`
 * and `_TOKEN` (`access_token`, the default, or `id_token`), each also as `VERA_...`.
 */
export function readAuth0Config(env: NodeJS.ProcessEnv): Auth0Config | null {
  const clientSecret = readAdaEnv(env, "LEXROOM_AUTH0_CLIENT_SECRET")?.trim();
  if (!clientSecret) {
    return null;
  }
  return {
    clientSecret,
    clientId: readAdaEnv(env, "LEXROOM_AUTH0_CLIENT_ID")?.trim() || AUTH0_DEFAULT_CLIENT_ID,
    realm: readAdaEnv(env, "LEXROOM_AUTH0_REALM")?.trim() || AUTH0_DEFAULT_REALM,
    bearer:
      readAdaEnv(env, "LEXROOM_AUTH0_TOKEN")?.trim().toLowerCase() === "id_token"
        ? "id_token"
        : "access_token",
  };
}

type Dict = Record<string, unknown>;

const isRecord = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Auth0's error codes that mean "this client or account may not do this", not "try again". */
const REFUSALS = new Set([
  "unauthorized_client",
  "invalid_client",
  "access_denied",
  "too_many_attempts",
  "unauthorized",
]);

/**
 * Signs in with Auth0's password-realm grant and a confidential client, the way a server
 * would, with no browser flow. The Auth0 token is used as Lexroom's bearer as it is: no
 * Lexroom endpoint that exchanges it is known. It is then checked once against Lexroom's API,
 * because an Auth0 token the API does not take would otherwise be saved and rejected on every call.
 */
export async function auth0PasswordRealmLogin(params: {
  config: Auth0Config;
  email: string;
  password: string;
  apiBaseUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  trace: Trace;
}): Promise<LexroomLoginResult> {
  const { config, trace } = params;
  const secrets = [params.email, params.password, config.clientSecret];
  let sent: { status: number; ok: boolean; value: unknown };
  try {
    sent = await exchange({
      fetchImpl: params.fetchImpl ?? fetch,
      url: `${AUTH0_ISSUER}/oauth/token`,
      init: {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: asciiJson({
          grant_type: PASSWORD_REALM_GRANT,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          username: params.email,
          password: params.password,
          realm: config.realm,
          audience: AUTH0_AUDIENCE,
          scope: AUTH0_SCOPE,
        }),
      },
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      trace,
      step: "auth0.token",
      retry: "none",
      read: (response, guard) => readJsonGuarded(response, guard),
    });
  } catch (error) {
    if (error instanceof LexroomTimeoutError) {
      throw error;
    }
    return unavailable("Ada could not reach Auth0.");
  }
  const body = isRecord(sent.value) ? sent.value : {};
  if (!sent.ok) {
    const code = text(body.error);
    const detail = loggableDetail(text(body.error_description), secrets);
    // The mfa_token in the body is a credential; only the code and description are ever read.
    trace("auth0.rejected", { status: sent.status, code: code.slice(0, 60), detail });
    if (code === "invalid_grant") {
      return {
        ok: false,
        reason: "wrong_password",
        error: "Those Lexroom credentials were not accepted.",
      };
    }
    if (code === "mfa_required") {
      return { ok: false, reason: "mfa_required", error: MFA_ERROR };
    }
    if (sent.status >= 500 || (sent.status === 429 && !REFUSALS.has(code))) {
      return unavailable(`Auth0 returned ${sent.status}`);
    }
    return forbidden({
      error: `Auth0 refused the sign-in (${code || `HTTP ${sent.status}`})${detail ? `: ${detail}` : ""}`,
      status: sent.status,
      code,
      detail,
    });
  }
  const accessToken = text(body[config.bearer]);
  if (!accessToken) {
    return unavailable(`Auth0 did not return an ${config.bearer.replace("_", " ")}.`);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
  const verified = await verifyBearer(params, accessToken);
  if (verified) {
    return verified;
  }
  return {
    ok: true,
    email: params.email,
    accessToken,
    refreshToken: "",
    accessExpiresAtMs:
      accessTokenExpiresAtMs(accessToken) ??
      (expiresIn === undefined ? null : Date.now() + expiresIn * 1000),
  };
}

/** One call to Lexroom's API with the new bearer. Only a 401 proves it does not take the token. */
async function verifyBearer(
  params: {
    apiBaseUrl: string;
    timeoutMs: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    trace: Trace;
  },
  accessToken: string,
): Promise<LexroomLoginResult | undefined> {
  let status = 0;
  try {
    const reply = await lexroomCreditsProbe(
      {
        baseUrl: params.apiBaseUrl,
        timeoutMs: params.timeoutMs,
        fetchImpl: params.fetchImpl,
        signal: params.signal,
        trace: params.trace,
      },
      accessToken,
    );
    status = reply.status;
  } catch (error) {
    if (error instanceof LexroomTimeoutError) {
      throw error;
    }
    params.trace("login.verify", { outcome: "unreachable" });
    return undefined;
  }
  params.trace("login.verify", { status });
  return status === 401
    ? forbidden({
        error:
          "Auth0 signed in, but Lexroom's API rejected the token it issued (HTTP 401). Try ADA_LEXROOM_AUTH0_TOKEN=id_token, or remove the client secret to use the web sign-in.",
        status,
        code: "token_rejected",
      })
    : undefined;
}
