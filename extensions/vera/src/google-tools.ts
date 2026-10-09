import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { GoogleAccountStore } from "./google-account-contract.js";
import { openVeraGoogleAccountFromApi } from "./google-account.js";
import {
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
  type CalendarEvent,
  type InboxMessage,
} from "./google-api.js";
import {
  prepareGoogleConnect,
  readGoogleConnectConfig,
  type GoogleConnectConfig,
  type GoogleConnectResult,
} from "./google-connect.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger">;

type ToolFailure = { ok: false; error: string; reason?: "not_connected" };

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

async function openStore(api: StoreApi): Promise<GoogleAccountStore | ToolFailure> {
  try {
    return await openVeraGoogleAccountFromApi(api);
  } catch (error) {
    api.logger.error(
      `vera google account store failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Vera could not open the Google account store." };
  }
}

function isStoreFailure(store: GoogleAccountStore | ToolFailure): store is ToolFailure {
  return "ok" in store;
}

export async function executeVeraGoogleConnect(
  config: GoogleConnectConfig,
  api: StoreApi,
  now = new Date(),
): Promise<GoogleConnectResult | ToolFailure> {
  const store = await openStore(api);
  if (isStoreFailure(store)) {
    return store;
  }
  try {
    const account = await store.readAccount();
    return await prepareGoogleConnect({
      config,
      now,
      accountEmail: account?.email ?? null,
      savePending: (nonce, expiresAtMs) => store.replacePending(nonce, expiresAtMs),
    });
  } catch (error) {
    api.logger.error(
      `vera google connect failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Vera could not prepare the Google connect link." };
  }
}

async function accessForRead(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  now: Date;
  signal?: AbortSignal;
}): Promise<{ ok: true; accessToken: string; email: string } | ToolFailure> {
  const account = await params.store.readAccount();
  if (!account) {
    return {
      ok: false,
      reason: "not_connected",
      error:
        "Gmail and Google Calendar are not connected. Call vera_google_connect and send that link.",
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
  });
  if (!token.ok) {
    if (token.reason === "reconnect") {
      await params.store.clearAccount();
      return {
        ok: false,
        reason: "not_connected",
        error: "The Google connection expired. Call vera_google_connect and send the new link.",
      };
    }
    return { ok: false, error: "Vera could not reach Google. Try again shortly." };
  }
  if (
    token.accessToken !== account.accessToken ||
    token.accessExpiresAtMs !== account.accessExpiresAtMs
  ) {
    await params.store.upsertAccount({
      ...account,
      accessToken: token.accessToken,
      accessExpiresAtMs: token.accessExpiresAtMs,
    });
  }
  return { ok: true, accessToken: token.accessToken, email: account.email };
}

export async function readConnectedInbox(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  max?: number;
  now?: Date;
  signal?: AbortSignal;
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
          "Google rejected the saved connection. Call vera_google_connect and send the new link.",
      };
    }
    return { ok: false, error: "Vera could not read Gmail. Try again shortly." };
  }
  return { ok: true, email: access.email, messages: listed.messages };
}

export async function readConnectedCalendar(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  hours?: number;
  now?: Date;
  signal?: AbortSignal;
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
          "Google rejected the saved connection. Call vera_google_connect and send the new link.",
      };
    }
    return { ok: false, error: "Vera could not read Google Calendar. Try again shortly." };
  }
  return { ok: true, email: access.email, events: listed.events };
}

export async function executeVeraReadInbox(
  config: GoogleConnectConfig,
  api: StoreApi,
  max: number | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; email: string; messages: InboxMessage[] } | ToolFailure> {
  const store = await openStore(api);
  if (isStoreFailure(store)) {
    return store;
  }
  return await readConnectedInbox({ config, store, max, signal });
}

export async function executeVeraReadCalendar(
  config: GoogleConnectConfig,
  api: StoreApi,
  hours: number | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; email: string; events: CalendarEvent[] } | ToolFailure> {
  const store = await openStore(api);
  if (isStoreFailure(store)) {
    return store;
  }
  return await readConnectedCalendar({ config, store, hours, signal });
}
