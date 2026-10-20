import { createHmac } from "node:crypto";
import { createConnectState } from "./connect-state.js";
import type { GranolaAccountDb } from "./granola-account-contract.js";
import { bindGranolaOwner } from "./granola-account.js";
import {
  buildGranolaAuthorizationUrl,
  createPkce,
  discoverGranolaEndpoints,
  ensureGranolaClient,
} from "./granola-oauth.js";
import { loadGranolaAccess } from "./granola-session.js";
import { isAdaPath } from "./http-paths.js";
import { mintShortLink, shortLinkUrl } from "./short-links.js";

export const GRANOLA_CALLBACK_SUFFIX = "/granola/callback";
export const GRANOLA_CALLBACK_PATH = `/ada${GRANOLA_CALLBACK_SUFFIX}`;

/** The slice of plugin config Granola connect reads: Ada's public origin and the state secret. */
export type GranolaConnectConfig = {
  googleRedirectUri?: string;
  lexroomConnectUri?: string;
  lexroomStateSecret?: string;
  googleStateSecret?: string;
};

export type GranolaConnectSettings = { redirectUri: string; stateSecret: string };

export type GranolaConnectResult =
  | { ok: false; error: string }
  | { ok: true; connected: true }
  | { ok: true; connected: false; ask: { url: string; message: string } };

const NOT_CONFIGURED =
  "Ada Granola connect needs Ada's public origin (googleRedirectUri or lexroomConnectUri) and a state secret (lexroomStateSecret or googleStateSecret) in plugins.entries.ada.config.";

export function granolaConnectConfigFrom(value: unknown): GranolaConnectConfig {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const read = (key: keyof GranolaConnectConfig) =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  return {
    googleRedirectUri: read("googleRedirectUri"),
    lexroomConnectUri: read("lexroomConnectUri"),
    lexroomStateSecret: read("lexroomStateSecret"),
    googleStateSecret: read("googleStateSecret"),
  };
}

/** Granola's redirect URI lives on the same public origin as Ada's other connect pages. */
export function readGranolaConnectConfig(
  config: GranolaConnectConfig,
): { ok: true; settings: GranolaConnectSettings } | { ok: false; error: string } {
  const origin = [config.googleRedirectUri, config.lexroomConnectUri]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "");
  const stateSecret = config.lexroomStateSecret?.trim() || config.googleStateSecret?.trim() || "";
  if (!origin || !stateSecret) {
    return { ok: false, error: NOT_CONFIGURED };
  }
  if (stateSecret.length < 16) {
    return { ok: false, error: "The Granola connect state secret must be at least 16 characters." };
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, error: "Ada's public origin must be an absolute URL." };
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    return { ok: false, error: "Ada's public origin must be https, or http on localhost." };
  }
  return {
    ok: true,
    settings: { redirectUri: `${parsed.origin}${GRANOLA_CALLBACK_PATH}`, stateSecret },
  };
}

/** True for the callback path under the current or the pre-rename prefix. */
export function isGranolaCallbackPath(pathname: string): boolean {
  return isAdaPath(pathname, GRANOLA_CALLBACK_SUFFIX);
}

/** The state key is derived per purpose, so a Google or Lexroom state never opens a Granola link. */
export function granolaStateKey(stateSecret: string): string {
  return createHmac("sha256", stateSecret).update("ada-granola-connect-v1").digest("hex");
}

export function granolaConnectMessage(url: string): string {
  return [
    "Connect your Granola account so Ada can read your meeting notes and transcripts. Ada only reads them and never changes anything in Granola.",
    "Open this link and sign in to Granola:",
    url,
  ].join("\n");
}

/**
 * Issues the short link that sends one number to Granola's own sign-in. A number that is already
 * connected (its token still works, or renews) gets no link, unless `force` asks for a new one.
 */
export async function prepareGranolaConnect(params: {
  owner: string;
  config: GranolaConnectConfig;
  db: GranolaAccountDb;
  now: Date;
  force?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<GranolaConnectResult> {
  const nowMs = params.now.getTime();
  if (params.force !== true) {
    const access = await loadGranolaAccess({
      db: params.db,
      owner: params.owner,
      nowMs,
      fetchImpl: params.fetchImpl,
      signal: params.signal,
      log: params.log,
    });
    if (access.ok) {
      return { ok: true, connected: true };
    }
  }
  const config = readGranolaConnectConfig(params.config);
  if (!config.ok) {
    return config;
  }
  const endpoints = await discoverGranolaEndpoints({
    fetchImpl: params.fetchImpl,
    nowMs,
    signal: params.signal,
  });
  const client = endpoints
    ? await ensureGranolaClient({
        db: params.db,
        endpoints,
        redirectUri: config.settings.redirectUri,
        nowMs,
        fetchImpl: params.fetchImpl,
        signal: params.signal,
      })
    : null;
  if (!endpoints || !client) {
    return {
      ok: false,
      error: "Ada could not reach Granola to prepare the link. Try again shortly.",
    };
  }
  const issued = createConnectState(
    granolaStateKey(config.settings.stateSecret),
    params.now,
    params.owner,
  );
  const pkce = createPkce();
  await bindGranolaOwner(params.db, params.owner).replacePending(issued.nonce, issued.expiresAtMs, {
    codeVerifier: pkce.verifier,
    clientId: client.clientId,
  });
  const target = buildGranolaAuthorizationUrl({
    endpoints,
    clientId: client.clientId,
    redirectUri: config.settings.redirectUri,
    state: issued.state,
    challenge: pkce.challenge,
  });
  const url = shortLinkUrl(
    new URL(config.settings.redirectUri).origin,
    "gr",
    mintShortLink({
      kind: "gr",
      owner: params.owner,
      nonce: issued.nonce,
      target,
      expiresAtMs: issued.expiresAtMs,
      now: params.now,
    }),
  );
  return { ok: true, connected: false, ask: { url, message: granolaConnectMessage(url) } };
}
