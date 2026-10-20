import { createHash, randomBytes } from "node:crypto";
import type {
  GranolaAccountDb,
  GranolaClientRecord,
  GranolaRefreshedTokens,
} from "./granola-account-contract.js";

/**
 * Granola's hosted MCP server signs people in with OAuth 2.0 and has no API key. Ada discovers
 * the endpoints from the server's own metadata, registers itself once as a public client
 * (dynamic client registration), and every person then consents in their own browser with PKCE.
 */
export const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";
export const GRANOLA_SCOPE = "openid email profile offline_access mcp";

const DEFAULT_AUTH_SERVER = "https://mcp-auth.granola.ai";
const DEFAULT_REGISTRATION_URL = "https://mcp-auth.granola.ai/oauth2/register";
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const OAUTH_TIMEOUT_MS = 20_000;

type FetchLike = typeof fetch;

export type GranolaEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
};

const discovered = new Map<string, { endpoints: GranolaEndpoints; atMs: number }>();

export function clearGranolaDiscoveryCache(): void {
  discovered.clear();
}

function timeout(signal?: AbortSignal): AbortSignal {
  const limit = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, limit]) : limit;
}

async function getJson(url: string, fetchImpl: FetchLike, signal?: AbortSignal) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: timeout(signal),
    });
    if (!response.ok) {
      return null;
    }
    const value: unknown = await response.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Endpoints read from metadata are only used when they are https on Granola's own hosts, so a
 * tampered or misrouted metadata answer can never point people's sign-in, or the tokens Ada posts,
 * anywhere else.
 */
function secureUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const granola = host === "granola.ai" || host.endsWith(".granola.ai");
    return url.protocol === "https:" && granola && !url.username && !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** The authorization server's metadata URLs: RFC 8414 first, then OpenID discovery. */
function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const tail = url.pathname.replace(/\/+$/u, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${tail}`,
    `${url.origin}${tail}/.well-known/openid-configuration`,
  ];
}

/**
 * The endpoints of Granola's authorization server, read from the MCP server's protected-resource
 * metadata and the server's own metadata, and kept for an hour.
 */
export async function discoverGranolaEndpoints(
  params: { fetchImpl?: FetchLike; mcpUrl?: string; nowMs?: number; signal?: AbortSignal } = {},
): Promise<GranolaEndpoints | null> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const mcpUrl = params.mcpUrl ?? GRANOLA_MCP_URL;
  const nowMs = params.nowMs ?? Date.now();
  const cached = discovered.get(mcpUrl);
  if (cached && nowMs - cached.atMs < DISCOVERY_TTL_MS) {
    return cached.endpoints;
  }
  const resource = new URL(mcpUrl);
  let issuer = DEFAULT_AUTH_SERVER;
  for (const candidate of [
    `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`,
    `${resource.origin}/.well-known/oauth-protected-resource`,
  ]) {
    const metadata = await getJson(candidate, fetchImpl, params.signal);
    const servers = metadata?.authorization_servers;
    const first = Array.isArray(servers) ? text(servers[0]) : undefined;
    if (secureUrl(first)) {
      issuer = first as string;
      break;
    }
  }
  for (const candidate of authServerMetadataUrls(issuer)) {
    const metadata = await getJson(candidate, fetchImpl, params.signal);
    const authorizationEndpoint = secureUrl(text(metadata?.authorization_endpoint));
    const tokenEndpoint = secureUrl(text(metadata?.token_endpoint));
    if (!authorizationEndpoint || !tokenEndpoint) {
      continue;
    }
    const endpoints: GranolaEndpoints = {
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint:
        secureUrl(text(metadata?.registration_endpoint)) ?? DEFAULT_REGISTRATION_URL,
      revocationEndpoint: secureUrl(text(metadata?.revocation_endpoint)),
    };
    discovered.set(mcpUrl, { endpoints, atMs: nowMs });
    return endpoints;
  }
  return null;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildGranolaAuthorizationUrl(params: {
  endpoints: GranolaEndpoints;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  mcpUrl?: string;
}): string {
  const url = new URL(params.endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", GRANOLA_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", params.mcpUrl ?? GRANOLA_MCP_URL);
  return url.toString();
}

function clientExpired(client: GranolaClientRecord, nowMs: number): boolean {
  return client.secretExpiresAtMs !== null && client.secretExpiresAtMs <= nowMs;
}

let registering: Promise<GranolaClientRecord | null> | null = null;

/**
 * The one OAuth client Ada uses for new links. It is registered with Granola once, kept on the
 * volume, and registered again only when none is saved, it was made for another redirect URI, or
 * its secret expired. Earlier registrations are kept, because the tokens issued to them are
 * renewed with them; a registration Granola rejects is dropped with `db.clearClient`.
 */
export function ensureGranolaClient(params: {
  db: GranolaAccountDb;
  endpoints: GranolaEndpoints;
  redirectUri: string;
  nowMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<GranolaClientRecord | null> {
  registering ??= (async () => {
    const existing = await params.db.readClient();
    if (
      existing &&
      existing.redirectUri === params.redirectUri &&
      !clientExpired(existing, params.nowMs)
    ) {
      return existing;
    }
    let response: Response;
    try {
      response = await (params.fetchImpl ?? fetch)(params.endpoints.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Ada",
          redirect_uris: [params.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: GRANOLA_SCOPE,
        }),
        signal: timeout(params.signal),
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const clientId = text(body?.client_id);
    if (!clientId) {
      return null;
    }
    const expires =
      typeof body?.client_secret_expires_at === "number" ? body.client_secret_expires_at : 0;
    const client: GranolaClientRecord = {
      clientId,
      clientSecret: text(body?.client_secret) ?? null,
      redirectUri: params.redirectUri,
      registeredAtMs: params.nowMs,
      // RFC 7591: zero means the secret never expires; otherwise seconds since the epoch.
      secretExpiresAtMs: expires > 0 ? expires * 1000 : null,
    };
    await params.db.saveClient(client);
    return client;
  })().finally(() => {
    registering = null;
  });
  return registering;
}

export type GranolaTokenFailure = {
  ok: false;
  /**
   * `invalid_client`: Granola no longer knows Ada's client, so it must register again.
   * `invalid_grant`: this person's consent is no longer valid. `transient`: try again later.
   */
  reason: "invalid_client" | "invalid_grant" | "transient";
  oauthError?: string;
};

export type GranolaTokenSet = GranolaRefreshedTokens & {
  scope: string | null;
};

async function postToken(params: {
  endpoints: GranolaEndpoints;
  client: GranolaClientRecord;
  body: URLSearchParams;
  nowMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<
  { ok: true; tokens: GranolaTokenSet & { refreshToken?: string } } | GranolaTokenFailure
> {
  params.body.set("client_id", params.client.clientId);
  if (params.client.clientSecret) {
    params.body.set("client_secret", params.client.clientSecret);
  }
  params.body.set("resource", GRANOLA_MCP_URL);
  let response: Response;
  try {
    response = await (params.fetchImpl ?? fetch)(params.endpoints.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params.body,
      signal: timeout(params.signal),
    });
  } catch {
    return { ok: false, reason: "transient" };
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const oauthError = text(payload?.error)?.slice(0, 64);
    if (response.status >= 500 || response.status === 429) {
      return { ok: false, reason: "transient", oauthError };
    }
    if (oauthError === "invalid_client") {
      return { ok: false, reason: "invalid_client", oauthError };
    }
    // Only Granola saying the consent is void ends a connection. Anything else, such as a
    // gateway page or an unexpected status, is treated as a failure of the moment.
    return {
      ok: false,
      reason:
        oauthError === "invalid_grant" || oauthError === "unauthorized_client"
          ? "invalid_grant"
          : "transient",
      oauthError,
    };
  }
  const accessToken = text(payload?.access_token);
  if (!accessToken) {
    return { ok: false, reason: "transient" };
  }
  const expiresIn = Number(payload?.expires_in);
  return {
    ok: true,
    tokens: {
      accessToken,
      refreshToken: text(payload?.refresh_token),
      accessExpiresAtMs:
        Number.isFinite(expiresIn) && expiresIn > 0 ? params.nowMs + expiresIn * 1000 : null,
      scope: text(payload?.scope) ?? null,
    },
  };
}

export function exchangeGranolaCode(params: {
  endpoints: GranolaEndpoints;
  client: GranolaClientRecord;
  code: string;
  verifier: string;
  nowMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  return postToken({
    ...params,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.client.redirectUri,
    }),
  });
}

export function refreshGranolaTokens(params: {
  endpoints: GranolaEndpoints;
  client: GranolaClientRecord;
  refreshToken: string;
  nowMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}) {
  return postToken({
    ...params,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: params.refreshToken }),
  });
}

/** Asks Granola to revoke a token when it publishes a revocation endpoint. Never throws. */
export async function revokeGranolaToken(params: {
  endpoints: GranolaEndpoints;
  client: GranolaClientRecord;
  token: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!params.endpoints.revocationEndpoint) {
    return false;
  }
  const body = new URLSearchParams({ token: params.token, client_id: params.client.clientId });
  if (params.client.clientSecret) {
    body.set("client_secret", params.client.clientSecret);
  }
  try {
    const response = await (params.fetchImpl ?? fetch)(params.endpoints.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: timeout(params.signal),
    });
    return response.ok;
  } catch {
    return false;
  }
}
