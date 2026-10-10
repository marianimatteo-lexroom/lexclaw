import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Lexroom has no public OAuth for research. The lawyer opens a Vera-hosted
 * login page, signs in with Lexroom email/password (and MFA when required),
 * and Vera keeps the bearer in SQLite like the Google connection.
 */
export const LEXROOM_CONNECT_PATH = "/vera/lexroom/connect";

const STATE_TTL_MS = 30 * 60 * 1000;
const ACCESS_SKEW_MS = 60_000;

export type LexroomConnectConfig = {
  accessToken?: string;
  baseUrl?: string;
  /** Public https URL whose path is /vera/lexroom/connect. */
  lexroomConnectUri?: string;
  /** Optional HMAC secret; falls back to googleStateSecret. */
  lexroomStateSecret?: string;
  googleRedirectUri?: string;
  googleStateSecret?: string;
};

export type LexroomConnectSettings = {
  connectUri: string;
  stateSecret: string;
  baseUrl?: string;
};

export type LexroomConnectAsk = {
  url: string;
  message: string;
};

export type LexroomConnectResult =
  | { ok: false; error: string }
  | { ok: true; connected: true; email: string }
  | { ok: true; connected: false; ask: LexroomConnectAsk };

const NOT_CONFIGURED =
  "Vera Lexroom connect needs lexroomConnectUri (or googleRedirectUri) and a state secret (lexroomStateSecret or googleStateSecret) in plugins.entries.vera.config.";

export function lexroomConnectConfigFrom(value: unknown): LexroomConnectConfig {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const read = (key: keyof LexroomConnectConfig) => {
    const item = record[key];
    return typeof item === "string" ? item : undefined;
  };
  return {
    accessToken: read("accessToken"),
    baseUrl: read("baseUrl"),
    lexroomConnectUri: read("lexroomConnectUri"),
    lexroomStateSecret: read("lexroomStateSecret"),
    googleRedirectUri: read("googleRedirectUri"),
    googleStateSecret: read("googleStateSecret"),
  };
}

function deriveConnectUri(config: LexroomConnectConfig): string | null {
  const explicit = config.lexroomConnectUri?.trim() ?? "";
  if (explicit) {
    return explicit;
  }
  const googleRedirect = config.googleRedirectUri?.trim() ?? "";
  if (!googleRedirect) {
    return null;
  }
  try {
    const url = new URL(googleRedirect);
    url.pathname = LEXROOM_CONNECT_PATH;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function readLexroomConnectConfig(
  config: LexroomConnectConfig,
): { ok: true; settings: LexroomConnectSettings } | { ok: false; error: string } {
  const connectUri = deriveConnectUri(config);
  const stateSecret =
    config.lexroomStateSecret?.trim() || config.googleStateSecret?.trim() || "";
  if (!connectUri || !stateSecret) {
    return { ok: false, error: NOT_CONFIGURED };
  }
  if (stateSecret.length < 16) {
    return { ok: false, error: "Lexroom connect state secret must be at least 16 characters." };
  }
  let parsed: URL;
  try {
    parsed = new URL(connectUri);
  } catch {
    return { ok: false, error: "lexroomConnectUri must be an absolute URL." };
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    return { ok: false, error: "lexroomConnectUri must be https, or http on localhost." };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return {
      ok: false,
      error: "lexroomConnectUri must be an origin plus /vera/lexroom/connect.",
    };
  }
  if (parsed.pathname !== LEXROOM_CONNECT_PATH) {
    return { ok: false, error: "lexroomConnectUri must use the path /vera/lexroom/connect." };
  }
  return {
    ok: true,
    settings: {
      connectUri,
      stateSecret,
      baseUrl: config.baseUrl?.trim() || undefined,
    },
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

export function buildLexroomConnectUrl(params: { connectUri: string; state: string }): string {
  const url = new URL(params.connectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

export function lexroomConnectMessage(url: string): string {
  return [
    "Connect your Lexroom account so Vera can run legal research and drafts for you.",
    "Open this link and sign in with Lexroom:",
    url,
  ].join("\n");
}

export function accessTokenExpiresAtMs(accessToken: string): number | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2 || !parts[1]) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function isLexroomAccessLive(params: {
  accessToken: string;
  accessExpiresAtMs: number | null;
  now: Date;
}): boolean {
  if (!params.accessToken.trim()) {
    return false;
  }
  const expiresAtMs =
    params.accessExpiresAtMs ?? accessTokenExpiresAtMs(params.accessToken) ?? null;
  if (expiresAtMs === null) {
    // Opaque tokens without exp are treated as live until Lexroom rejects them.
    return true;
  }
  return expiresAtMs > params.now.getTime() + ACCESS_SKEW_MS;
}

export async function prepareLexroomConnect(params: {
  config: LexroomConnectConfig;
  now: Date;
  account: { email: string; accessToken: string; accessExpiresAtMs: number | null } | null;
  savePending: (nonce: string, expiresAtMs: number) => Promise<void>;
}): Promise<LexroomConnectResult> {
  if (
    params.account &&
    isLexroomAccessLive({
      accessToken: params.account.accessToken,
      accessExpiresAtMs: params.account.accessExpiresAtMs,
      now: params.now,
    })
  ) {
    return { ok: true, connected: true, email: params.account.email };
  }
  const config = readLexroomConnectConfig(params.config);
  if (!config.ok) {
    return config;
  }
  const issued = createConnectState(config.settings.stateSecret, params.now);
  await params.savePending(issued.nonce, issued.expiresAtMs);
  const url = buildLexroomConnectUrl({
    connectUri: config.settings.connectUri,
    state: issued.state,
  });
  return {
    ok: true,
    connected: false,
    ask: {
      url,
      message: lexroomConnectMessage(url),
    },
  };
}
