import { createHash, randomBytes } from "node:crypto";
import { readAdaEnv } from "./ada-env.js";

/**
 * Outlook (Microsoft 365 and Outlook.com) signs people in with the Microsoft identity platform
 * v2: authorization code flow with PKCE, from a confidential client Ada owns. Each person
 * consents in their own browser; Ada keeps their refresh token and Microsoft Graph does the rest.
 */
export const OUTLOOK_SCOPES = [
  "offline_access",
  "openid",
  "email",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
] as const;

/** Without these a connection could read or write nothing useful, so a consent that lacks one is refused. */
const REQUIRED_SCOPES = [
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
] as const;

export const OUTLOOK_DEFAULT_TENANT = "common";
const LOGIN_ORIGIN = "https://login.microsoftonline.com";
const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
const OAUTH_TIMEOUT_MS = 20_000;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

type FetchLike = typeof fetch;

/** The Entra app registration Ada signs in with. */
export type OutlookApp = { clientId: string; clientSecret: string; tenant: string };

/**
 * The feature is on only when the app registration is configured. Unset or blank variables, or a
 * tenant that is not a tenant id, domain or one of common/organizations/consumers, switch it off:
 * Ada then offers nothing and exposes no Outlook tool.
 */
export function readOutlookApp(env: NodeJS.ProcessEnv = process.env): OutlookApp | null {
  const clientId = readAdaEnv(env, "MS_CLIENT_ID")?.trim();
  const clientSecret = readAdaEnv(env, "MS_CLIENT_SECRET")?.trim();
  const tenant = readAdaEnv(env, "MS_TENANT")?.trim() || OUTLOOK_DEFAULT_TENANT;
  if (!clientId || !clientSecret || !TENANT.test(tenant)) {
    return null;
  }
  return { clientId, clientSecret, tenant };
}

export function outlookEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readOutlookApp(env) !== null;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildOutlookAuthorizationUrl(params: {
  app: OutlookApp;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(`${LOGIN_ORIGIN}/${params.app.tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", params.app.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", OUTLOOK_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/**
 * Microsoft says a tenant needs an administrator's approval with AADSTS65001 (no consent for the
 * app), AADSTS90094 (the grant requires admin permission) or a `consent_required` sub-error. The
 * same facts arrive on the redirect (`error`, `error_description`) and in a token response.
 */
export function isAdminConsentError(
  ...facts: Array<string | number[] | null | undefined>
): boolean {
  return facts.some((fact) =>
    Array.isArray(fact)
      ? fact.some((code) => code === 65001 || code === 90094)
      : typeof fact === "string" && /AADSTS65001|AADSTS90094|consent_required/iu.test(fact),
  );
}

export type OutlookTokenFailure = {
  ok: false;
  /**
   * `admin_consent`: the tenant needs an administrator to approve Ada. `invalid_grant`: this
   * person's consent no longer works and only a new sign-in helps. `denied_scopes`: the grant
   * lacks a permission Ada needs. `no_refresh_token`: nothing to keep the connection alive with.
   * `misconfigured`: Microsoft refuses Ada's own client (a wrong or expired secret): the person
   * did nothing wrong, so a saved connection is kept. `transient`: try again later.
   */
  reason:
    | "admin_consent"
    | "invalid_grant"
    | "denied_scopes"
    | "no_refresh_token"
    | "misconfigured"
    | "transient";
  oauthError?: string;
};

export type OutlookTokenSet = {
  accessToken: string;
  /** Microsoft sends a rotated one with every grant; absent only when it did not. */
  refreshToken?: string;
  accessExpiresAtMs: number;
  scope: string | null;
  /** The sign-in's address from the id token, when Microsoft sent one. */
  idEmail: string | null;
};

function timeout(signal?: AbortSignal): AbortSignal {
  const limit = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, limit]) : limit;
}

function text(value: unknown, max = 4096): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** One printable line: control characters become spaces, so a server's text cannot shape a log line. */
function oneLine(value: string | undefined, max: number): string | undefined {
  const printable = Array.from(value ?? "", (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : char;
  }).join("");
  return printable.trim().slice(0, max) || undefined;
}

function idTokenEmail(idToken: unknown): string | null {
  const payload = typeof idToken === "string" ? idToken.split(".")[1] : undefined;
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const claim of [claims.email, claims.preferred_username]) {
      if (typeof claim === "string" && EMAIL.test(claim)) {
        return claim;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function hasScope(granted: string, wanted: string): boolean {
  return granted
    .split(/\s+/u)
    .some(
      (item) =>
        item.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//u, "") ===
        wanted.toLowerCase(),
    );
}

export function coversRequiredScopes(scope: string | null): boolean {
  return scope === null || REQUIRED_SCOPES.every((wanted) => hasScope(scope, wanted));
}

async function postToken(params: {
  app: OutlookApp;
  body: URLSearchParams;
  nowMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; tokens: OutlookTokenSet } | OutlookTokenFailure> {
  params.body.set("client_id", params.app.clientId);
  params.body.set("client_secret", params.app.clientSecret);
  let response: Response;
  try {
    response = await (params.fetchImpl ?? fetch)(
      `${LOGIN_ORIGIN}/${params.app.tenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: params.body,
        signal: timeout(params.signal),
      },
    );
  } catch {
    return { ok: false, reason: "transient" };
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const oauthError = oneLine(text(payload?.error), 64);
    if (response.status >= 500 || response.status === 429) {
      return { ok: false, reason: "transient", oauthError };
    }
    if (
      isAdminConsentError(
        oauthError,
        text(payload?.suberror),
        text(payload?.error_description),
        Array.isArray(payload?.error_codes) ? (payload.error_codes as number[]) : null,
      )
    ) {
      return { ok: false, reason: "admin_consent", oauthError };
    }
    if (oauthError === "invalid_client") {
      return { ok: false, reason: "misconfigured", oauthError };
    }
    // Only Microsoft saying the consent is void ends a connection. Anything else, such as a
    // gateway page or an unexpected status, is a failure of the moment.
    const consentVoid =
      oauthError === "invalid_grant" ||
      oauthError === "interaction_required" ||
      oauthError === "unauthorized_client";
    return { ok: false, reason: consentVoid ? "invalid_grant" : "transient", oauthError };
  }
  const accessToken = text(payload?.access_token, 16_384);
  if (!accessToken) {
    return { ok: false, reason: "transient" };
  }
  const refreshToken = text(payload?.refresh_token, 16_384);
  const scope = oneLine(text(payload?.scope, 2000), 2000) ?? null;
  const expiresIn = Number(payload?.expires_in);
  return {
    ok: true,
    tokens: {
      accessToken,
      ...(refreshToken && refreshToken.length >= 8 ? { refreshToken } : {}),
      accessExpiresAtMs: params.nowMs + (Number.isFinite(expiresIn) ? expiresIn : 0) * 1000,
      scope,
      idEmail: idTokenEmail(payload?.id_token),
    },
  };
}

/** Where Graph says the signed-in person's mailbox is: `mail`, else the user principal name. */
async function readMailbox(
  accessToken: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchImpl(GRAPH_ME_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: timeout(signal),
    });
    if (!response.ok) {
      return null;
    }
    const me = (await response.json()) as { mail?: unknown; userPrincipalName?: unknown };
    for (const candidate of [me.mail, me.userPrincipalName]) {
      if (typeof candidate === "string" && EMAIL.test(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export type OutlookExchange =
  | { ok: true; tokens: OutlookTokenSet & { refreshToken: string; email: string } }
  | OutlookTokenFailure;

export async function exchangeOutlookCode(params: {
  app: OutlookApp;
  redirectUri: string;
  code: string;
  verifier: string;
  nowMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<OutlookExchange> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const exchanged = await postToken({
    app: params.app,
    nowMs: params.nowMs,
    fetchImpl,
    signal: params.signal,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
      scope: OUTLOOK_SCOPES.join(" "),
    }),
  });
  if (!exchanged.ok) {
    return exchanged;
  }
  const { refreshToken } = exchanged.tokens;
  if (!refreshToken) {
    return { ok: false, reason: "no_refresh_token" };
  }
  if (!coversRequiredScopes(exchanged.tokens.scope)) {
    return { ok: false, reason: "denied_scopes" };
  }
  const email =
    (await readMailbox(exchanged.tokens.accessToken, fetchImpl, params.signal)) ??
    exchanged.tokens.idEmail;
  if (!email) {
    return { ok: false, reason: "transient" };
  }
  return { ok: true, tokens: { ...exchanged.tokens, refreshToken, email } };
}

export function refreshOutlookTokens(params: {
  app: OutlookApp;
  refreshToken: string;
  nowMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  return postToken({
    app: params.app,
    nowMs: params.nowMs,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      scope: OUTLOOK_SCOPES.join(" "),
    }),
  });
}
