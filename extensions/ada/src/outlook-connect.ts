import { createHmac } from "node:crypto";
import { createConnectState } from "./connect-state.js";
import { isAdaPath } from "./http-paths.js";
import type { OutlookAccountDb } from "./outlook-account-contract.js";
import { bindOutlookOwner } from "./outlook-account.js";
import { buildOutlookAuthorizationUrl, createPkce, readOutlookApp } from "./outlook-oauth.js";
import { loadOutlookAccess } from "./outlook-session.js";
import { mintShortLink, shortLinkUrl } from "./short-links.js";

export const OUTLOOK_CALLBACK_SUFFIX = "/outlook/callback";
export const OUTLOOK_CALLBACK_PATH = `/ada${OUTLOOK_CALLBACK_SUFFIX}`;

/** The slice of plugin config Outlook connect reads: Ada's public origin and the state secret. */
export type OutlookConnectConfig = {
  googleRedirectUri?: string;
  lexroomConnectUri?: string;
  lexroomStateSecret?: string;
  googleStateSecret?: string;
};

export type OutlookConnectSettings = { redirectUri: string; stateSecret: string };

export type OutlookConnectResult =
  | { ok: false; reason?: "not_configured" | "admin_consent_required"; error: string }
  | { ok: true; connected: true; email: string }
  | { ok: true; connected: false; ask: { url: string; message: string } };

const NOT_CONFIGURED =
  "Outlook is not available: Ada has no Microsoft app registration configured, so do not offer it.";
const NOT_READY =
  "Ada Outlook connect needs Ada's public origin (googleRedirectUri or lexroomConnectUri) and a state secret (lexroomStateSecret or googleStateSecret) in plugins.entries.ada.config.";

export function outlookConnectConfigFrom(value: unknown): OutlookConnectConfig {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const read = (key: keyof OutlookConnectConfig) =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  return {
    googleRedirectUri: read("googleRedirectUri"),
    lexroomConnectUri: read("lexroomConnectUri"),
    lexroomStateSecret: read("lexroomStateSecret"),
    googleStateSecret: read("googleStateSecret"),
  };
}

/** Outlook's redirect URI lives on the same public origin as Ada's other connect pages. */
export function readOutlookConnectConfig(
  config: OutlookConnectConfig,
): { ok: true; settings: OutlookConnectSettings } | { ok: false; error: string } {
  const origin = [config.googleRedirectUri, config.lexroomConnectUri]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "");
  const stateSecret = config.lexroomStateSecret?.trim() || config.googleStateSecret?.trim() || "";
  if (!origin || !stateSecret) {
    return { ok: false, error: NOT_READY };
  }
  if (stateSecret.length < 16) {
    return { ok: false, error: "The Outlook connect state secret must be at least 16 characters." };
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
    settings: { redirectUri: `${parsed.origin}${OUTLOOK_CALLBACK_PATH}`, stateSecret },
  };
}

/** True for the callback path under the current or the pre-rename prefix. */
export function isOutlookCallbackPath(pathname: string): boolean {
  return isAdaPath(pathname, OUTLOOK_CALLBACK_SUFFIX);
}

/** The state key is derived per purpose, so a Google, Lexroom or Granola state never opens an Outlook link. */
export function outlookStateKey(stateSecret: string): string {
  return createHmac("sha256", stateSecret).update("ada-outlook-connect-v1").digest("hex");
}

export function outlookConnectMessage(url: string): string {
  return [
    "Connect your Outlook account (Microsoft 365 or Outlook.com) so Ada can read your mail and calendar, prepare your morning brief, and send mail or add calendar events only after you confirm.",
    "Open this link and sign in with Microsoft (it works once and expires in 30 minutes):",
    url,
  ].join("\n");
}

/**
 * A person whose organization needs an administrator's approval gets no second link until they
 * say the approval happened: the same link would only fail the same way. Kept in this process;
 * a restart or `force` lifts it.
 */
const ADMIN_CONSENT_HOLD_MS = 24 * 60 * 60 * 1000;
const MAX_HELD_OWNERS = 1000;
const consentHeld = new Map<string, number>();

export function holdAdminConsent(owner: string, nowMs: number): void {
  consentHeld.delete(owner);
  consentHeld.set(owner, nowMs);
  if (consentHeld.size > MAX_HELD_OWNERS) {
    consentHeld.delete(consentHeld.keys().next().value ?? owner);
  }
}

function adminConsentHeld(owner: string, nowMs: number): boolean {
  const since = consentHeld.get(owner);
  if (since === undefined) {
    return false;
  }
  if (nowMs - since > ADMIN_CONSENT_HOLD_MS) {
    consentHeld.delete(owner);
    return false;
  }
  return true;
}

export function clearAdminConsentHolds(): void {
  consentHeld.clear();
}

export const ADMIN_CONSENT_REQUIRED =
  "This person's organization requires an IT administrator to approve the Ada app in Microsoft before anyone there can connect Outlook. A new link would fail the same way. Tell them plainly, in their language, that their company's IT admin must approve the app, and do not send another link. Only when they say the admin has approved it, call ada_outlook_connect again with force true.";

/**
 * Issues the short link that sends one number to Microsoft's own sign-in. A number that is already
 * connected (its token still works, or renews) gets no link, unless `force` asks for a new one.
 */
export async function prepareOutlookConnect(params: {
  owner: string;
  config: OutlookConnectConfig;
  db: OutlookAccountDb;
  now: Date;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<OutlookConnectResult> {
  const app = readOutlookApp(params.env);
  if (!app) {
    return { ok: false, reason: "not_configured", error: NOT_CONFIGURED };
  }
  const nowMs = params.now.getTime();
  if (params.force !== true) {
    const access = await loadOutlookAccess({
      db: params.db,
      owner: params.owner,
      nowMs,
      env: params.env,
      fetchImpl: params.fetchImpl,
      signal: params.signal,
      log: params.log,
    });
    if (access.ok) {
      return { ok: true, connected: true, email: access.account.email };
    }
    if (adminConsentHeld(params.owner, nowMs)) {
      return { ok: false, reason: "admin_consent_required", error: ADMIN_CONSENT_REQUIRED };
    }
  }
  const config = readOutlookConnectConfig(params.config);
  if (!config.ok) {
    return config;
  }
  const issued = createConnectState(
    outlookStateKey(config.settings.stateSecret),
    params.now,
    params.owner,
  );
  const pkce = createPkce();
  await bindOutlookOwner(params.db, params.owner).replacePending(issued.nonce, issued.expiresAtMs, {
    codeVerifier: pkce.verifier,
  });
  const target = buildOutlookAuthorizationUrl({
    app,
    redirectUri: config.settings.redirectUri,
    state: issued.state,
    challenge: pkce.challenge,
  });
  const url = shortLinkUrl(
    new URL(config.settings.redirectUri).origin,
    "o",
    mintShortLink({
      kind: "o",
      owner: params.owner,
      nonce: issued.nonce,
      target,
      expiresAtMs: issued.expiresAtMs,
      now: params.now,
    }),
  );
  return { ok: true, connected: false, ask: { url, message: outlookConnectMessage(url) } };
}
