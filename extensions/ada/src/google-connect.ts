import { createConnectState } from "./connect-state.js";
import { isAdaPath } from "./http-paths.js";
import { mintShortLink, shortLinkUrl } from "./short-links.js";

/**
 * Gmail and Calendar share one Google OAuth consent. Requester-scoped MCP is
 * omitted on the morning cron because that run has no WhatsApp sender, and
 * gog's callback URL must not be texted. Ada keeps the refresh token and
 * reads both APIs directly.
 */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GOOGLE_CONNECT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  GMAIL_SEND_SCOPE,
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const GOOGLE_CONNECT_SERVICES = ["gmail", "google_calendar", "gmail_send"] as const;

const CALLBACK_SUFFIX = "/google/callback";

export type GoogleConnectConfig = {
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
  googleStateSecret?: string;
};

export type GoogleConnectSettings = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
};

export type GoogleConnectAsk = {
  services: typeof GOOGLE_CONNECT_SERVICES;
  url: string;
  message: string;
};

export type GoogleConnectResult =
  | { ok: false; error: string }
  | {
      ok: true;
      connected: true;
      email: string;
      services: typeof GOOGLE_CONNECT_SERVICES;
    }
  | { ok: true; connected: false; ask: GoogleConnectAsk };

const NOT_CONFIGURED =
  "Ada Google connect needs googleClientId, googleClientSecret, googleRedirectUri, and googleStateSecret in plugins.entries.ada.config.";

export function googleConnectConfigFrom(value: unknown): GoogleConnectConfig {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const read = (key: keyof GoogleConnectConfig) => {
    const item = record[key];
    return typeof item === "string" ? item : undefined;
  };
  return {
    googleClientId: read("googleClientId"),
    googleClientSecret: read("googleClientSecret"),
    googleRedirectUri: read("googleRedirectUri"),
    googleStateSecret: read("googleStateSecret"),
  };
}

export function readGoogleConnectConfig(
  config: GoogleConnectConfig,
): { ok: true; settings: GoogleConnectSettings } | { ok: false; error: string } {
  const clientId = config.googleClientId?.trim() ?? "";
  const clientSecret = config.googleClientSecret?.trim() ?? "";
  const redirectUri = config.googleRedirectUri?.trim() ?? "";
  const stateSecret = config.googleStateSecret?.trim() ?? "";
  if (!clientId || !clientSecret || !redirectUri || !stateSecret) {
    return { ok: false, error: NOT_CONFIGURED };
  }
  if (stateSecret.length < 16) {
    return { ok: false, error: "googleStateSecret must be at least 16 characters." };
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return { ok: false, error: "googleRedirectUri must be an absolute URL." };
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    return { ok: false, error: "googleRedirectUri must be https, or http on localhost." };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, error: "googleRedirectUri must be an origin plus /ada/google/callback." };
  }
  if (!isAdaPath(parsed.pathname, CALLBACK_SUFFIX)) {
    return {
      ok: false,
      error: "googleRedirectUri must use the path /ada/google/callback or /vera/google/callback.",
    };
  }
  return {
    ok: true,
    settings: { clientId, clientSecret, redirectUri, stateSecret },
  };
}

export { createConnectState, readConnectState } from "./connect-state.js";

export function buildGoogleConnectUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CONNECT_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export function canSendMail(scopes: string | null | undefined): boolean {
  return typeof scopes === "string" && scopes.split(/\s+/u).includes(GMAIL_SEND_SCOPE);
}

export function coversConnectScopes(scope: unknown): boolean {
  if (typeof scope !== "string" || scope.trim() === "") {
    return true;
  }
  const parts = new Set(scope.split(/\s+/u));
  return GOOGLE_CONNECT_SCOPES.every(
    (item) => item === "openid" || item === "email" || parts.has(item),
  );
}

export function googleConnectMessage(url: string, purpose: "connect" | "send" = "connect"): string {
  if (purpose === "send") {
    return [
      "Ada can read Gmail and Google Calendar, but cannot send mail yet.",
      "Open this link and approve sending:",
      url,
    ].join("\n");
  }
  return [
    "Connect Gmail and Google Calendar so Ada can prepare your morning digest and send mail you confirm.",
    "Open this link to connect your Google account:",
    url,
  ].join("\n");
}

export async function prepareGoogleConnect(params: {
  /** The WhatsApp number that asked; the link, and the account it saves, belong to it. */
  owner: string;
  config: GoogleConnectConfig;
  now: Date;
  account: { email: string; scopes: string | null } | null;
  savePending: (nonce: string, expiresAtMs: number) => Promise<void>;
}): Promise<GoogleConnectResult> {
  if (params.account && canSendMail(params.account.scopes)) {
    return {
      ok: true,
      connected: true,
      email: params.account.email,
      services: GOOGLE_CONNECT_SERVICES,
    };
  }
  const config = readGoogleConnectConfig(params.config);
  if (!config.ok) {
    return config;
  }
  const issued = createConnectState(config.settings.stateSecret, params.now, params.owner);
  await params.savePending(issued.nonce, issued.expiresAtMs);
  const target = buildGoogleConnectUrl({
    clientId: config.settings.clientId,
    redirectUri: config.settings.redirectUri,
    state: issued.state,
  });
  const url = shortLinkUrl(
    new URL(config.settings.redirectUri).origin,
    "g",
    mintShortLink({
      kind: "g",
      owner: params.owner,
      nonce: issued.nonce,
      target,
      expiresAtMs: issued.expiresAtMs,
      now: params.now,
    }),
  );
  return {
    ok: true,
    connected: false,
    ask: {
      services: GOOGLE_CONNECT_SERVICES,
      url,
      message: googleConnectMessage(url, params.account ? "send" : "connect"),
    },
  };
}
