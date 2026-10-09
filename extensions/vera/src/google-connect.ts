import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Gmail and Calendar share one Google OAuth consent. Requester-scoped MCP is
 * omitted on the morning cron because that run has no WhatsApp sender, and
 * gog's callback URL must not be texted. Vera keeps the refresh token and
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

const STATE_TTL_MS = 30 * 60 * 1000;
const CALLBACK_PATH = "/vera/google/callback";

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
  "Vera Google connect needs googleClientId, googleClientSecret, googleRedirectUri, and googleStateSecret in plugins.entries.vera.config.";

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
    return { ok: false, error: "googleRedirectUri must be an origin plus /vera/google/callback." };
  }
  if (parsed.pathname !== CALLBACK_PATH) {
    return { ok: false, error: "googleRedirectUri must use the path /vera/google/callback." };
  }
  return {
    ok: true,
    settings: { clientId, clientSecret, redirectUri, stateSecret },
  };
}

export function createConnectState(
  stateSecret: string,
  now: Date,
): { state: string; nonce: string; expiresAtMs: number } {
  const nonce = randomBytes(32).toString("base64url");
  const expiresAtMs = now.getTime() + STATE_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ nonce, exp: expiresAtMs })).toString("base64url");
  const signature = createHmac("sha256", stateSecret).update(payload).digest("base64url");
  return { state: `${payload}.${signature}`, nonce, expiresAtMs };
}

export function readConnectState(
  stateSecret: string,
  state: string,
  now: Date,
): { nonce: string } | null {
  const parts = state.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }
  const expected = createHmac("sha256", stateSecret).update(payload).digest("base64url");
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  let parsed: { nonce?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      nonce?: unknown;
      exp?: unknown;
    };
  } catch {
    return null;
  }
  if (typeof parsed.nonce !== "string" || typeof parsed.exp !== "number") {
    return null;
  }
  if (parsed.exp <= now.getTime()) {
    return null;
  }
  return { nonce: parsed.nonce };
}

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
      "Vera can read Gmail and Google Calendar, but cannot send mail yet.",
      "Open this link and approve sending:",
      url,
    ].join("\n");
  }
  return [
    "Connect Gmail and Google Calendar so Vera can prepare your morning digest and send mail you confirm.",
    "Open this link to connect your Google account:",
    url,
  ].join("\n");
}

export async function prepareGoogleConnect(params: {
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
  const issued = createConnectState(config.settings.stateSecret, params.now);
  await params.savePending(issued.nonce, issued.expiresAtMs);
  const url = buildGoogleConnectUrl({
    clientId: config.settings.clientId,
    redirectUri: config.settings.redirectUri,
    state: issued.state,
  });
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
