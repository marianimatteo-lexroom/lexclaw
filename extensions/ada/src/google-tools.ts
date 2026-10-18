import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  GoogleAccountRecord,
  GoogleAccountStamp,
  GoogleAccountStore,
  GoogleRefreshedTokens,
} from "./google-account-contract.js";
import { openAdaGoogleAccountFromApi } from "./google-account.js";
import {
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
  sendGmailMessage,
  writeCalendarEvent,
  type CalendarEvent,
  type CalendarEventInput,
  type InboxMessage,
} from "./google-api.js";
import {
  canSendMail,
  canWriteCalendar,
  prepareGoogleConnect,
  readGoogleConnectConfig,
  type GoogleConnectConfig,
  type GoogleConnectResult,
} from "./google-connect.js";
import { maskNumber } from "./inbound-log.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

type ToolFailure = {
  ok: false;
  error: string;
  reason?:
    | "not_connected"
    | "needs_send_scope"
    | "needs_calendar_scope"
    | "confirmation_required"
    | "private_chat_required";
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
        log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
      });
      if (token.ok) {
        await saveRefreshedAccount(store, account, token);
      } else if (token.reason === "reconnect") {
        account = (await store.clearAccountIfStill(account)) ? null : await store.readAccount();
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

/**
 * Keeps a refreshed access token, and a refresh token Google rotated, so the next call need not
 * refresh. Written only while the saved row is still the one that was refreshed: a reconnect or a
 * move to another number during the refresh is never overwritten. Returns the stamp the row has
 * now (the rotated refresh token, when one was saved).
 */
export async function saveRefreshedAccount(
  store: GoogleAccountStore,
  account: GoogleAccountRecord,
  token: GoogleRefreshedTokens,
): Promise<GoogleAccountStamp> {
  const refreshToken = token.refreshToken ?? account.refreshToken;
  if (
    token.accessToken === account.accessToken &&
    token.accessExpiresAtMs === account.accessExpiresAtMs &&
    refreshToken === account.refreshToken
  ) {
    return account;
  }
  const saved = await store.updateTokensIfStill(account, token);
  return saved ? { refreshToken, connectedAtMs: account.connectedAtMs } : account;
}

async function accessForRead(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  now: Date;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<
  { ok: true; accessToken: string; email: string; stamp: GoogleAccountStamp } | ToolFailure
> {
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
      await params.store.clearAccountIfStill(account);
      return {
        ok: false,
        reason: "not_connected",
        error:
          "The Google connection expired. Ask whether they want to reconnect; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
      };
    }
    return { ok: false, error: "Ada could not reach Google. Try again shortly." };
  }
  const stamp = await saveRefreshedAccount(params.store, account, token);
  return { ok: true, accessToken: token.accessToken, email: account.email, stamp };
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
      await params.store.clearAccountIfStill(access.stamp);
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
      await params.store.clearAccountIfStill(access.stamp);
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
      await params.store.clearAccountIfStill(access.stamp);
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

export type CalendarEventArgs = {
  /** Only an update names the event it changes; it comes from `ada_read_calendar`. */
  eventId?: string;
  title?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  confirmed: boolean;
};

const DEFAULT_TIME_ZONE = "Europe/Rome";
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/u;
const MAX_ATTENDEES = 20;

const oneLine = (value: string) => !/[\r\n]/u.test(value);

function validTimeZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/** The event fields as Google takes them, or the reason the call cannot go ahead. */
function readCalendarEventInput(
  args: CalendarEventArgs,
  update: boolean,
): { ok: true; event: CalendarEventInput } | ToolFailure {
  const invalid = (error: string): ToolFailure => ({ ok: false, error });
  const title = args.title?.trim();
  const description = args.description?.replaceAll("\u0000", "").trim();
  const location = args.location?.trim();
  if (title !== undefined && (!title || title.length > 300 || !oneLine(title))) {
    return invalid("The title must be one line of up to 300 characters.");
  }
  if (location !== undefined && (location.length > 300 || !oneLine(location))) {
    return invalid("The location must be one line of up to 300 characters.");
  }
  if (description !== undefined && description.length > 8_000) {
    return invalid("The description is too long.");
  }
  const attendees = args.attendees?.map((email) => email.trim());
  if (
    attendees &&
    (attendees.length > MAX_ATTENDEES ||
      attendees.some((email) => !RECIPIENT.test(email) || email.length > 320 || !oneLine(email)))
  ) {
    return invalid("Attendees must be up to 20 valid email addresses.");
  }
  const { start, end } = args;
  if ((start === undefined) !== (end === undefined)) {
    return invalid("Give both the start and the end.");
  }
  let timeZone = args.timeZone?.trim();
  if (start !== undefined && end !== undefined) {
    const starts = LOCAL_DATE_TIME.exec(start);
    const ends = LOCAL_DATE_TIME.exec(end);
    if (!starts || !ends || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      return invalid("The start and end must be ISO 8601 date-times, such as 2026-10-20T15:00:00.");
    }
    if (Boolean(starts[1]) === Boolean(ends[1]) && Date.parse(end) <= Date.parse(start)) {
      return invalid("The event must end after it starts.");
    }
    timeZone ||= DEFAULT_TIME_ZONE;
  }
  if (timeZone !== undefined && !validTimeZone(timeZone)) {
    return invalid("The time zone must be an IANA name such as Europe/Rome.");
  }
  const event: CalendarEventInput = {
    ...(title !== undefined ? { summary: title } : {}),
    ...(start !== undefined && end !== undefined ? { start, end, timeZone } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(attendees ? { attendees } : {}),
  };
  if (update ? Object.keys(event).length === 0 : !title || !start || !end) {
    return invalid(
      update
        ? "Say what to change: the title, the start and end, the description, the location or the attendees."
        : "A new event needs a title, a start and an end.",
    );
  }
  return { ok: true, event };
}

const NEEDS_CALENDAR_SCOPE =
  "Ada cannot change the calendar with the current Google connection. Tell the person naturally that you need a fresh Google permission to add and change events, and ask whether they want it; call ada_google_connect and send the new link only after they agree (or if they asked to connect).";

export async function changeConnectedCalendarEvent(params: {
  config: GoogleConnectConfig;
  store: GoogleAccountStore;
  args: CalendarEventArgs;
  now?: Date;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{ ok: true; email: string; event: CalendarEvent } | ToolFailure> {
  const { args } = params;
  const eventId = args.eventId?.trim();
  const update = args.eventId !== undefined;
  if (!args.confirmed) {
    return {
      ok: false,
      reason: "confirmation_required",
      error: `Ask the user to confirm the title, the date and time with its time zone, and the location, description and attendees if any${update ? ", and which event changes" : ""}. Call again with confirmed true only after they agree.`,
    };
  }
  if (update && !eventId) {
    return { ok: false, error: "Name the event to change; ada_read_calendar lists their ids." };
  }
  const input = readCalendarEventInput(args, update);
  if (!input.ok) {
    return input;
  }
  const account = await params.store.readAccount();
  if (!account) {
    return {
      ok: false,
      reason: "not_connected",
      error:
        "Google Calendar is not connected. Ask whether they want to connect; call ada_google_connect and send the link only after they agree (or if they asked to connect).",
    };
  }
  if (!canWriteCalendar(account.scopes)) {
    return { ok: false, reason: "needs_calendar_scope", error: NEEDS_CALENDAR_SCOPE };
  }
  const access = await accessForRead({ ...params, now: params.now ?? new Date() });
  if (!access.ok) {
    return access;
  }
  const saved = await writeCalendarEvent({
    accessToken: access.accessToken,
    eventId,
    event: input.event,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  if (!saved.ok) {
    if (saved.status === 401) {
      await params.store.clearAccountIfStill(access.stamp);
      return {
        ok: false,
        reason: "not_connected",
        error:
          "Google rejected the saved connection. Ask whether they want to reconnect; call ada_google_connect and send the new link only after they agree (or if they asked to connect).",
      };
    }
    if (saved.insufficientScope) {
      return { ok: false, reason: "needs_calendar_scope", error: NEEDS_CALENDAR_SCOPE };
    }
    if (saved.status === 404 && update) {
      return { ok: false, error: "Ada could not find that event in the calendar." };
    }
    return {
      ok: false,
      error: `Ada could not ${update ? "update" : "create"} the event. Try again shortly.`,
    };
  }
  return { ok: true, email: access.email, event: saved.event };
}

export async function executeAdaCalendarEvent(
  owner: string,
  config: GoogleConnectConfig,
  api: StoreApi,
  args: CalendarEventArgs,
  signal?: AbortSignal,
): Promise<{ ok: true; email: string; event: CalendarEvent } | ToolFailure> {
  const store = await openStore(api, owner);
  if (isStoreFailure(store)) {
    return store;
  }
  return await changeConnectedCalendarEvent({
    config,
    store,
    args,
    signal,
    log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
  });
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
    log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
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
    log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
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
    log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
  });
}
