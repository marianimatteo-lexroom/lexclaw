import type { GoogleAccountRecord } from "./google-account-contract.js";
import { coversConnectScopes, GOOGLE_CONNECT_SCOPES } from "./google-connect.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_LIST_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_WATCH_URL = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
const ACCESS_SKEW_MS = 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

export type InboxMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  /** Gmail still has it as unread; absent otherwise. */
  unread?: true;
};

export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  status: string;
  description?: string;
  /** Only when the caller asks for them: guests are other people's addresses. */
  attendees?: CalendarAttendee[];
};

export type CalendarAttendee = { email: string; name?: string };

export type MessageAttachment = {
  /** "eml" is a forwarded message such as a PEC envelope's postacert.eml. */
  kind: "pdf" | "eml";
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

/** A Gmail message read in full: headers, plain text, and the PDFs attached to it. */
export type MessageContent = InboxMessage & {
  bodyText: string;
  attachments: MessageAttachment[];
};

export type GoogleToken = {
  email: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAtMs: number;
  scopes: string;
};

type FetchLike = typeof fetch;

const GOOGLE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Every Google request ends within the limit, connect to last body byte, even when the caller
 * brings its own signal: that signal can cancel sooner but never lifts the limit.
 */
function withGoogleTimeout(signal: AbortSignal | undefined): AbortSignal {
  const limit = AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, limit]) : limit;
}

type TokenFailure = {
  ok: false;
  reason: "reconnect" | "no_refresh_token" | "denied_scopes" | "google_error";
  /** Google's own error code and `error_description`, clipped. Neither carries a secret. */
  googleError?: string;
  description?: string;
};

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

function googleErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "string" || !/^[a-z0-9_]{1,64}$/iu.test(error)) {
    return null;
  }
  return error;
}

function googleErrorDescription(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const description = (value as { error_description?: unknown }).error_description;
  if (typeof description !== "string") {
    return null;
  }
  const line = clip(description.replace(/[\u0000-\u001f\u007f]+/gu, " "), 200);
  return line.length > 0 ? line : null;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function postToken(
  body: URLSearchParams,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<{ ok: true; value: Record<string, unknown> } | TokenFailure> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: withGoogleTimeout(signal),
    });
  } catch {
    return { ok: false, reason: "google_error" };
  }
  const payload = await readBody(response);
  if (!response.ok) {
    const googleError = googleErrorCode(payload);
    const description = googleErrorDescription(payload);
    return {
      ok: false,
      reason: googleError === "invalid_grant" ? "reconnect" : "google_error",
      ...(googleError ? { googleError } : {}),
      ...(description ? { description } : {}),
    };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "google_error" };
  }
  return { ok: true, value: payload as Record<string, unknown> };
}

async function authorizedGet(
  url: string,
  accessToken: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: withGoogleTimeout(signal),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  const value = await readBody(response);
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  return { ok: true, value };
}

function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) {
    return "";
  }
  for (const header of headers) {
    if (!header || typeof header !== "object") {
      continue;
    }
    const record = header as { name?: unknown; value?: unknown };
    if (
      typeof record.name === "string" &&
      record.name.toLowerCase() === name &&
      typeof record.value === "string"
    ) {
      return clip(record.value, 300);
    }
  }
  return "";
}

export function parseGmailMessage(payload: unknown): InboxMessage | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    id?: unknown;
    snippet?: unknown;
    labelIds?: unknown;
    payload?: { headers?: unknown };
  };
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  return {
    id: record.id,
    from: headerValue(record.payload?.headers, "from"),
    subject: headerValue(record.payload?.headers, "subject"),
    date: headerValue(record.payload?.headers, "date"),
    snippet: typeof record.snippet === "string" ? clip(record.snippet, 240) : "",
    ...(Array.isArray(record.labelIds) && record.labelIds.includes("UNREAD")
      ? { unread: true as const }
      : {}),
  };
}

function eventInstant(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as { dateTime?: unknown; date?: unknown };
  if (typeof record.dateTime === "string") {
    return record.dateTime;
  }
  if (typeof record.date === "string") {
    return record.date;
  }
  return "";
}

/** A guest as Google stores it; the fields that must survive a rewrite of the guest list. */
export type CalendarGuest = {
  email: string;
  displayName?: string;
  optional?: boolean;
  resource?: boolean;
  responseStatus?: string;
};

function parseGuests(value: unknown): CalendarGuest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): CalendarGuest[] => {
    const guest = item as Record<string, unknown> | null;
    if (!guest || typeof guest.email !== "string" || !EMAIL.test(guest.email)) {
      return [];
    }
    return [
      {
        email: guest.email,
        ...(typeof guest.displayName === "string"
          ? { displayName: clip(guest.displayName, 200) }
          : {}),
        ...(guest.optional === true ? { optional: true } : {}),
        ...(guest.resource === true ? { resource: true } : {}),
        ...(typeof guest.responseStatus === "string"
          ? { responseStatus: guest.responseStatus }
          : {}),
      },
    ];
  });
}

export function parseCalendarEvents(
  payload: unknown,
  options: { includeDescription?: boolean; includeAttendees?: boolean } = {},
): CalendarEvent[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }
  const events: CalendarEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as {
      id?: unknown;
      summary?: unknown;
      description?: unknown;
      status?: unknown;
      start?: unknown;
      end?: unknown;
      attendees?: unknown;
    };
    if (typeof record.id !== "string" || record.status === "cancelled") {
      continue;
    }
    const start = eventInstant(record.start);
    if (!start) {
      continue;
    }
    const guests = options.includeAttendees === true ? parseGuests(record.attendees) : [];
    events.push({
      id: record.id,
      summary: typeof record.summary === "string" ? clip(record.summary, 300) : "",
      start,
      end: eventInstant(record.end),
      status: typeof record.status === "string" ? record.status : "confirmed",
      ...(options.includeDescription === true &&
      typeof record.description === "string" &&
      record.description.trim()
        ? { description: clip(record.description, 600) }
        : {}),
      ...(guests.length > 0
        ? {
            attendees: guests.map(({ email, displayName }) =>
              displayName ? { email, name: displayName } : { email },
            ),
          }
        : {}),
    });
  }
  return events;
}

async function readEmail(
  accessToken: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<string | null> {
  const userinfo = await authorizedGet(USERINFO_URL, accessToken, fetchImpl, signal);
  if (userinfo.ok && userinfo.value && typeof userinfo.value === "object") {
    const email = (userinfo.value as { email?: unknown }).email;
    if (typeof email === "string" && EMAIL.test(email)) {
      return email;
    }
  }
  const profile = await authorizedGet(GMAIL_PROFILE_URL, accessToken, fetchImpl, signal);
  if (profile.ok && profile.value && typeof profile.value === "object") {
    const email = (profile.value as { emailAddress?: unknown }).emailAddress;
    if (typeof email === "string" && EMAIL.test(email)) {
      return email;
    }
  }
  return null;
}

export async function exchangeAuthorizationCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  now: Date;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; token: GoogleToken } | TokenFailure> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
  const token = await postToken(body, fetchImpl, params.signal);
  if (!token.ok) {
    return token;
  }
  if (!coversConnectScopes(token.value.scope)) {
    return { ok: false, reason: "denied_scopes" };
  }
  const scopes =
    typeof token.value.scope === "string" && token.value.scope.trim()
      ? token.value.scope
      : GOOGLE_CONNECT_SCOPES.join(" ");
  const accessToken = token.value.access_token;
  const refreshToken = token.value.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { ok: false, reason: "google_error" };
  }
  if (typeof refreshToken !== "string" || refreshToken.length < 8) {
    return { ok: false, reason: "no_refresh_token" };
  }
  const expiresIn = typeof token.value.expires_in === "number" ? token.value.expires_in : 0;
  const email = await readEmail(accessToken, fetchImpl, params.signal);
  if (!email) {
    return { ok: false, reason: "google_error" };
  }
  return {
    ok: true,
    token: {
      email,
      refreshToken,
      accessToken,
      accessExpiresAtMs: params.now.getTime() + expiresIn * 1000,
      scopes,
    },
  };
}

export function buildRawGmailMessage(params: {
  from: string;
  to: string;
  subject: string;
  text: string;
}): string {
  const subject = /^[\t\u0020-\u007e]*$/u.test(params.subject)
    ? params.subject
    : `=?UTF-8?B?${Buffer.from(params.subject, "utf8").toString("base64")}?=`;
  const text = params.text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  const message = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

export async function sendGmailMessage(params: {
  accessToken: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; id: string } | { ok: false; status: number }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        raw: buildRawGmailMessage({
          from: params.from,
          to: params.to,
          subject: params.subject,
          text: params.text,
        }),
      }),
      signal: withGoogleTimeout(params.signal),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  const payload = await readBody(response);
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const id =
    payload && typeof payload === "object" && typeof (payload as { id?: unknown }).id === "string"
      ? (payload as { id: string }).id
      : "";
  if (!id) {
    return { ok: false, status: response.status };
  }
  return { ok: true, id };
}

export async function loadAccessToken(params: {
  account: GoogleAccountRecord;
  clientId: string;
  clientSecret: string;
  now: Date;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  /** Told why a refresh failed, with Google's description when it gave one. */
  log?: (message: string) => void;
}): Promise<
  { ok: true; accessToken: string; accessExpiresAtMs: number; refreshToken?: string } | TokenFailure
> {
  if (
    params.account.accessToken &&
    params.account.accessExpiresAtMs !== null &&
    params.account.accessExpiresAtMs - ACCESS_SKEW_MS > params.now.getTime()
  ) {
    return {
      ok: true,
      accessToken: params.account.accessToken,
      accessExpiresAtMs: params.account.accessExpiresAtMs,
    };
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.account.refreshToken,
    grant_type: "refresh_token",
  });
  const token = await postToken(body, fetchImpl, params.signal);
  if (!token.ok) {
    params.log?.(
      `ada google token refresh failed reason=${token.reason}${token.googleError ? ` google_error=${token.googleError}` : ""}${token.description ? ` description="${token.description}"` : ""}`,
    );
    return token;
  }
  const accessToken = token.value.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { ok: false, reason: "google_error" };
  }
  const expiresIn = typeof token.value.expires_in === "number" ? token.value.expires_in : 0;
  const rotated = token.value.refresh_token;
  return {
    ok: true,
    accessToken,
    accessExpiresAtMs: params.now.getTime() + expiresIn * 1000,
    ...(typeof rotated === "string" && rotated.length >= 8 && rotated.length <= 4096
      ? { refreshToken: rotated }
      : {}),
  };
}

export async function listInboxMessages(params: {
  accessToken: string;
  max: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; messages: InboxMessage[] } | { ok: false; status: number }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const listUrl = new URL(GMAIL_LIST_URL);
  listUrl.searchParams.set("q", "in:inbox newer_than:2d -in:spam -in:trash");
  listUrl.searchParams.set("maxResults", String(params.max));
  const list = await authorizedGet(
    listUrl.toString(),
    params.accessToken,
    fetchImpl,
    params.signal,
  );
  if (!list.ok) {
    return list;
  }
  const ids = Array.isArray((list.value as { messages?: unknown } | null)?.messages)
    ? ((list.value as { messages: unknown[] }).messages ?? [])
    : [];
  const messages: InboxMessage[] = [];
  for (const item of ids) {
    if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") {
      continue;
    }
    const id = (item as { id: string }).id;
    const detailUrl = new URL(`${GMAIL_LIST_URL}/${encodeURIComponent(id)}`);
    detailUrl.searchParams.set("format", "metadata");
    detailUrl.searchParams.append("metadataHeaders", "From");
    detailUrl.searchParams.append("metadataHeaders", "Subject");
    detailUrl.searchParams.append("metadataHeaders", "Date");
    const detail = await authorizedGet(
      detailUrl.toString(),
      params.accessToken,
      fetchImpl,
      params.signal,
    );
    if (!detail.ok) {
      return detail;
    }
    const message = parseGmailMessage(detail.value);
    if (message) {
      messages.push(message);
    }
  }
  return { ok: true, messages };
}

export async function listUpcomingEvents(params: {
  accessToken: string;
  now: Date;
  hours: number;
  /** Defaults to 20. Google caps one page at 250. */
  maxResults?: number;
  /** Only deadline intake reads descriptions; other callers never see them. */
  includeDescription?: boolean;
  /** Only the person reading their own calendar sees who is invited. */
  includeAttendees?: boolean;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; events: CalendarEvent[] } | { ok: false; status: number }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = new URL(CALENDAR_EVENTS_URL);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(Math.min(250, Math.max(1, params.maxResults ?? 20))));
  url.searchParams.set("timeMin", params.now.toISOString());
  url.searchParams.set(
    "timeMax",
    new Date(params.now.getTime() + params.hours * 60 * 60 * 1000).toISOString(),
  );
  const listed = await authorizedGet(url.toString(), params.accessToken, fetchImpl, params.signal);
  if (!listed.ok) {
    return listed;
  }
  return {
    ok: true,
    events: parseCalendarEvents(listed.value, {
      includeDescription: params.includeDescription,
      includeAttendees: params.includeAttendees,
    }),
  };
}

export type CalendarEventInput = {
  summary?: string;
  /** ISO 8601 date-time. */
  start?: string;
  end?: string;
  timeZone?: string;
  description?: string;
  location?: string;
  /** The complete guest list to save. Leave out to keep the event's guests as they are. */
  guests?: CalendarGuest[];
  /** The event being moved is all-day: its `date` fields give way to the new date-times. */
  wasAllDay?: boolean;
};

/** An event as Google has it now, with what a safe edit needs to know about it. */
export type CurrentCalendarEvent = {
  event: CalendarEvent;
  timeZone?: string;
  guests: CalendarGuest[];
};

export async function getCalendarEvent(params: {
  accessToken: string;
  eventId: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<
  ({ ok: true } & CurrentCalendarEvent & { wasAllDay: boolean }) | { ok: false; status: number }
> {
  const got = await authorizedGet(
    `${CALENDAR_EVENTS_URL}/${encodeURIComponent(params.eventId)}`,
    params.accessToken,
    params.fetchImpl ?? fetch,
    params.signal,
  );
  if (!got.ok) {
    return got;
  }
  const [event] = parseCalendarEvents({ items: [got.value] }, { includeAttendees: true });
  if (!event) {
    return { ok: false, status: 404 };
  }
  const record = got.value as {
    start?: { timeZone?: unknown; dateTime?: unknown };
    attendees?: unknown;
  };
  return {
    ok: true,
    event,
    guests: parseGuests(record.attendees),
    ...(typeof record.start?.timeZone === "string" ? { timeZone: record.start.timeZone } : {}),
    wasAllDay: typeof record.start?.dateTime !== "string",
  };
}

/**
 * Why Google refused a write with 403: the saved grant lacks the calendar scope (a fresh
 * permission fixes it), or the calendar does not let this person write (nothing does).
 */
function denialOf(payload: unknown): "scope" | "access" | undefined {
  const text = JSON.stringify(payload) ?? "";
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/iu.test(text)) {
    return "scope";
  }
  return /rateLimitExceeded|quotaExceeded|dailyLimitExceeded|backendError/iu.test(text)
    ? undefined
    : "access";
}

/**
 * Creates an event on the primary calendar, or patches the one named by `eventId`. Only the
 * fields given are sent, so an update never blanks what it does not mention. `sendUpdates` is
 * Google's all-or-nothing choice of whether guests get an email about this call.
 */
export async function writeCalendarEvent(params: {
  accessToken: string;
  eventId?: string;
  event: CalendarEventInput;
  sendUpdates: "all" | "none";
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<
  { ok: true; event: CalendarEvent } | { ok: false; status: number; denied?: "scope" | "access" }
> {
  const { event } = params;
  const instant = (dateTime: string | undefined) =>
    dateTime
      ? {
          dateTime,
          ...(event.timeZone ? { timeZone: event.timeZone } : {}),
          ...(event.wasAllDay ? { date: null } : {}),
        }
      : undefined;
  const body = {
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    ...(event.start ? { start: instant(event.start) } : {}),
    ...(event.end ? { end: instant(event.end) } : {}),
    ...(event.guests ? { attendees: event.guests } : {}),
  };
  const url = new URL(
    params.eventId
      ? `${CALENDAR_EVENTS_URL}/${encodeURIComponent(params.eventId)}`
      : CALENDAR_EVENTS_URL,
  );
  url.searchParams.set("sendUpdates", params.sendUpdates);
  let response: Response;
  try {
    response = await (params.fetchImpl ?? fetch)(url.toString(), {
      method: params.eventId ? "PATCH" : "POST",
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: withGoogleTimeout(params.signal),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  const payload = await readBody(response);
  if (!response.ok) {
    const denied = response.status === 403 ? denialOf(payload) : undefined;
    return { ok: false, status: response.status, ...(denied ? { denied } : {}) };
  }
  const [saved] = parseCalendarEvents({ items: [payload] }, { includeAttendees: true });
  return saved ? { ok: true, event: saved } : { ok: false, status: response.status };
}

/** Renew Gmail push to a Pub/Sub topic. Calendar still uses the 15-minute poll. */
export async function watchGmailInbox(params: {
  accessToken: string;
  topicName: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; expirationMs: number | null } | { ok: false; status: number }> {
  const topicName = params.topicName.trim();
  if (!topicName.startsWith("projects/") || !topicName.includes("/topics/")) {
    return { ok: false, status: 400 };
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(GMAIL_WATCH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ topicName, labelIds: ["INBOX"] }),
      signal: withGoogleTimeout(params.signal),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  const value = await readBody(response);
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const expiration =
    value && typeof value === "object" && "expiration" in value
      ? (value as { expiration?: unknown }).expiration
      : undefined;
  const expirationMs =
    typeof expiration === "string" && /^\d+$/u.test(expiration)
      ? Number(expiration)
      : typeof expiration === "number"
        ? expiration
        : null;
  return { ok: true, expirationMs };
}

const MAX_BODY_CHARS = 20_000;

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function htmlToText(html: string): string {
  return html
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/giu, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n\s*\n+/gu, "\n");
}

type MessagePart = {
  mimeType?: unknown;
  filename?: unknown;
  body?: { data?: unknown; attachmentId?: unknown; size?: unknown };
  parts?: unknown;
};

function walkParts(
  part: MessagePart,
  out: { plain: string[]; html: string[]; attachments: MessageAttachment[] },
  depth: number,
): void {
  if (depth > 8) {
    return;
  }
  const mimeType = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
  const filename = typeof part.filename === "string" ? part.filename : "";
  const data = typeof part.body?.data === "string" ? part.body.data : "";
  const attachmentId = typeof part.body?.attachmentId === "string" ? part.body.attachmentId : "";
  const isPdf = mimeType === "application/pdf" || /\.pdf$/iu.test(filename);
  const isEml = mimeType === "message/rfc822" || /\.eml$/iu.test(filename);
  if ((isPdf || isEml) && attachmentId) {
    out.attachments.push({
      kind: isPdf ? "pdf" : "eml",
      attachmentId,
      filename: filename || (isPdf ? "attachment.pdf" : "message.eml"),
      mimeType: mimeType || (isPdf ? "application/pdf" : "message/rfc822"),
      size: typeof part.body?.size === "number" ? part.body.size : 0,
    });
  } else if (!filename && data) {
    if (mimeType === "text/plain") {
      out.plain.push(decodeBase64Url(data));
    } else if (mimeType === "text/html") {
      out.html.push(htmlToText(decodeBase64Url(data)));
    }
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      if (child && typeof child === "object") {
        walkParts(child as MessagePart, out, depth + 1);
      }
    }
  }
}

/** Plain text and PDF attachment pointers from a `format=full` Gmail message. */
export function parseMessageContent(payload: unknown): MessageContent | null {
  const message = parseGmailMessage(payload);
  if (!message || !payload || typeof payload !== "object") {
    return null;
  }
  const root = (payload as { payload?: unknown }).payload;
  const out = {
    plain: [] as string[],
    html: [] as string[],
    attachments: [] as MessageAttachment[],
  };
  if (root && typeof root === "object") {
    walkParts(root as MessagePart, out, 0);
  }
  const text = (out.plain.length > 0 ? out.plain : out.html).join("\n").trim();
  return {
    ...message,
    bodyText: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
    attachments: out.attachments,
  };
}

/** Message ids for a Gmail search query. One call, no message bodies. */
export async function listMessageIds(params: {
  accessToken: string;
  query: string;
  max: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; ids: string[] } | { ok: false; status: number }> {
  const url = new URL(GMAIL_LIST_URL);
  url.searchParams.set("q", params.query);
  url.searchParams.set("maxResults", String(params.max));
  const listed = await authorizedGet(
    url.toString(),
    params.accessToken,
    params.fetchImpl ?? fetch,
    params.signal,
  );
  if (!listed.ok) {
    return listed;
  }
  const messages = (listed.value as { messages?: unknown } | null)?.messages;
  const ids = Array.isArray(messages)
    ? messages.flatMap((item) =>
        item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? [(item as { id: string }).id]
          : [],
      )
    : [];
  return { ok: true, ids };
}

export async function readMessageContent(params: {
  accessToken: string;
  id: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; content: MessageContent } | { ok: false; status: number }> {
  const url = new URL(`${GMAIL_LIST_URL}/${encodeURIComponent(params.id)}`);
  url.searchParams.set("format", "full");
  const detail = await authorizedGet(
    url.toString(),
    params.accessToken,
    params.fetchImpl ?? fetch,
    params.signal,
  );
  if (!detail.ok) {
    return detail;
  }
  const content = parseMessageContent(detail.value);
  return content ? { ok: true, content } : { ok: false, status: 0 };
}

export async function readAttachmentBytes(params: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; bytes: Buffer } | { ok: false; status: number }> {
  const url = `${GMAIL_LIST_URL}/${encodeURIComponent(params.messageId)}/attachments/${encodeURIComponent(params.attachmentId)}`;
  const fetched = await authorizedGet(
    url,
    params.accessToken,
    params.fetchImpl ?? fetch,
    params.signal,
  );
  if (!fetched.ok) {
    return fetched;
  }
  const data = (fetched.value as { data?: unknown } | null)?.data;
  if (typeof data !== "string") {
    return { ok: false, status: 0 };
  }
  return { ok: true, bytes: Buffer.from(data, "base64url") };
}
