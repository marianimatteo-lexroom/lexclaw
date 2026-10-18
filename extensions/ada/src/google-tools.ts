import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { GoogleAccountRecord, GoogleAccountStore } from "./google-account-contract.js";
import { openAdaGoogleAccountFromApi } from "./google-account.js";
import {
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
  sendGmailMessage,
  type CalendarEvent,
  type InboxMessage,
} from "./google-api.js";
import {
  canSendMail,
  prepareGoogleConnect,
  readGoogleConnectConfig,
  type GoogleConnectConfig,
  type GoogleConnectResult,
} from "./google-connect.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

type ToolFailure = {
  ok: false;
  error: string;
  reason?: "not_connected" | "needs_send_scope" | "confirmation_required" | "private_chat_required";
};

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

async function openStore(api: StoreApi, owner: string): Promise<GoogleAccountStore | ToolFailure> {
  try {
    return await openAdaGoogleAccountFromApi(api, owner);
  } catch (error) {
    api.logger.error(
      `ada google account store failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Ada could not open the Google account store." };
  }
}

function isStoreFailure(store: GoogleAccountStore | ToolFailure): store is ToolFailure {
  return "ok" in store;
}

export async function executeAdaGoogleConnect(
  owner: string,
  config: GoogleConnectConfig,
  api: StoreApi,
  now = new Date(),
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GoogleConnectResult | ToolFailure> {
  const store = await openStore(api, owner);
  if (isStoreFailure(store)) {
    return store;
  }
  try {
    let account = await store.readAccount();
    const settings = readGoogleConnectConfig(config);
    if (account && settings.ok) {
      // A saved account Google no longer accepts is not a connection: drop it and issue a link.
      const token = await loadAccessToken({
        account,
        clientId: settings.settings.clientId,
        clientSecret: settings.settings.clientSecret,
        now,
        fetchImpl: options.fetchImpl,
        log: (message) => api.logger.warn(message),
      });
      if (token.ok) {
        await saveRefreshedAccount(store, account, token);
      } else if (token.reason === "reconnect") {
        await store.clearAccount();
        account = null;
      }
    }
    return await prepareGoogleConnect({
      owner,
      config,
      now,
      account: account ? { email: account.email, scopes: account.scopes } : null,
      savePending: (nonce, expiresAtMs) => store.replacePending(nonce, expiresAtMs),
    });
  } catch (error) {
    api.logger.error(
      `ada google connect failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Ada could not prepare the Google connect link." };
  }
}

/** Keeps a refreshed access token, and a refresh token Google rotated, so the next call need not refresh. */
export async function saveRefreshedAccount(
  store: GoogleAccountStore,
  account: GoogleAccountRecord,
  token: { accessToken: string; accessExpiresAtMs: number; refreshToken?: string },
): Promise<void> {
  const refreshToken = token.refreshToken ?? account.refreshToken;
  if (
    token.accessToken !== account.accessToken ||
    token.accessExpiresAtMs !== account.accessExpiresAtMs ||
    refreshToken !== account.refreshToken
  ) {
    await store.upsertAccount({
      ...account,
      refreshToken,
      accessToken: token.accessToken,
      accessExpiresAtMs: token.accessExpiresAtMs,
    });
  }
}

async function accessForRead(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  now: Date;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{ ok: true; accessToken: string; email: string } | ToolFailure> {
  const account = await params.store.readAccount();
  if (!account) {
    return {
      ok: false,
      reason: "not_connected",
      error:
        "Gmail and Google Calendar are not connected. Ask whether they want to connect; call ada_google_connect and send the link only after they agree (or if they asked to connect).",
    };
  }
  const config = readGoogleConnectConfig(params.config);
  if (!config.ok) {
    return { ok: false, error: config.error };
  }
  const token = await loadAccessToken({
    account,
    clientId: config.settings.clientId,
    clientSecret: config.settings.clientSecret,
    now: params.now,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
    log: params.log,
  });
  if (!token.ok) {
    if (token.reason === "reconnect") {
      await params.store.clearAccount();
      return {
        ok: false,
        reason: "not_connected",
        error:
          "The Google connection expired. Ask whether they want to reconnect; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
      };
    }
    return { ok: false, error: "Ada could not reach Google. Try again shortly." };
  }
  await saveRefreshedAccount(params.store, account, token);
  return { ok: true, accessToken: token.accessToken, email: account.email };
}

export async function readConnectedInbox(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  max?: number;
  now?: Date;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<{ ok: true; email: string; messages: InboxMessage[] } | ToolFailure> {
  const now = params.now ?? new Date();
  const access = await accessForRead({ ...params, now });
  if (!access.ok) {
    return access;
  }
  const listed = await listInboxMessages({
    accessToken: access.accessToken,
    max: clamp(params.max, 8, 1, 10),
    signal: params.signal,
  });
  if (!listed.ok) {
    if (listed.status === 401) {
      await params.store.clearAccount();
      return {
        ok: false,
        reason: "not_connected",
        error:
          "Google rejected the saved connection. Ask whether they want to reconnect; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
      };
    }
    return { ok: false, error: "Ada could not read Gmail. Try again shortly." };
  }
  return { ok: true, email: access.email, messages: listed.messages };
}

export async function readConnectedCalendar(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  hours?: number;
  now?: Date;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<{ ok: true; email: string; events: CalendarEvent[] } | ToolFailure> {
  const now = params.now ?? new Date();
  const access = await accessForRead({ ...params, now });
  if (!access.ok) {
    return access;
  }
  const listed = await listUpcomingEvents({
    accessToken: access.accessToken,
    now,
    hours: clamp(params.hours, 48, 1, 168),
    signal: params.signal,
  });
  if (!listed.ok) {
    if (listed.status === 401) {
      await params.store.clearAccount();
      return {
        ok: false,
        reason: "not_connected",
        error:
          "Google rejected the saved connection. Ask whether they want to reconnect; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
      };
    }
    return { ok: false, error: "Ada could not read Google Calendar. Try again shortly." };
  }
  return { ok: true, email: access.email, events: listed.events };
}

const RECIPIENT = /^[^\s@]+@[^\s@]+$/u;

export async function sendConnectedEmail(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  to: string;
  subject: string;
  text: string;
  confirmed: boolean;
  now?: Date;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{ ok: true; email: string; id: string } | ToolFailure> {
  if (!params.confirmed) {
    return {
      ok: false,
      reason: "confirmation_required",
      error:
        "Ask the user to confirm the recipient, subject, and body. Call again with confirmed true only after they agree.",
    };
  }
  const to = params.to.trim();
  const subject = params.subject.trim();
  const text = params.text.replaceAll("\u0000", "").trim();
  if (!RECIPIENT.test(to) || to.length > 320 || /[\r\n]/u.test(to)) {
    return { ok: false, error: "The recipient must be one email address." };
  }
  if (!subject || subject.length > 200 || /[\r\n]/u.test(subject)) {
    return { ok: false, error: "The subject must be one line." };
  }
  if (!text || text.length > 20_000) {
    return { ok: false, error: "The message body is empty or too long." };
  }
  const account = await params.store.readAccount();
  if (!account) {
    return {
      ok: false,
      reason: "not_connected",
      error:
        "Gmail is not connected. Ask whether they want to connect; call ada_google_connect and send the link only after they agree (or if they asked to connect).",
    };
  }
  if (!canSendMail(account.scopes)) {
    return {
      ok: false,
      reason: "needs_send_scope",
      error:
        "Ada cannot send mail with the current Google connection. Ask whether they want to allow sending; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
    };
  }
  const now = params.now ?? new Date();
  const access = await accessForRead({ ...params, now });
  if (!access.ok) {
    return access;
  }
  const sent = await sendGmailMessage({
    accessToken: access.accessToken,
    from: access.email,
    to,
    subject,
    text,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  if (!sent.ok) {
    if (sent.status === 401) {
      await params.store.clearAccount();
      return {
        ok: false,
        reason: "not_connected",
        error:
          "Google rejected the saved connection. Ask whether they want to reconnect; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
      };
    }
    if (sent.status === 403) {
      return {
        ok: false,
        reason: "needs_send_scope",
        error:
          "Google did not allow sending. Ask whether they want to allow it; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
      };
    }
    return { ok: false, error: "Ada could not send the email. Try again shortly." };
  }
  return { ok: true, email: access.email, id: sent.id };
}

export async function executeAdaSendEmail(
  owner: string,
  config: GoogleConnectConfig,
  api: StoreApi,
  input: { to: string; subject: string; text: string; confirmed: boolean },
  signal?: AbortSignal,
): Promise<{ ok: true; email: string; id: string } | ToolFailure> {
  const store = await openStore(api, owner);
  if (isStoreFailure(store)) {
    return store;
  }
  return await sendConnectedEmail({
    config,
    store,
    ...input,
    signal,
    log: (message) => api.logger.warn(message),
  });
}

export async function executeAdaReadInbox(
  owner: string,
  config: GoogleConnectConfig,
  api: StoreApi,
  max: number | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; email: string; messages: InboxMessage[] } | ToolFailure> {
  const store = await openStore(api, owner);
  if (isStoreFailure(store)) {
    return store;
  }
  return await readConnectedInbox({
    config,
    store,
    max,
    signal,
    log: (message) => api.logger.warn(message),
  });
}

export async function executeAdaReadCalendar(
  owner: string,
  config: GoogleConnectConfig,
  api: StoreApi,
  hours: number | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; email: string; events: CalendarEvent[] } | ToolFailure> {
  const store = await openStore(api, owner);
  if (isStoreFailure(store)) {
    return store;
  }
  return await readConnectedCalendar({
    config,
    store,
    hours,
    signal,
    log: (message) => api.logger.warn(message),
  });
}
