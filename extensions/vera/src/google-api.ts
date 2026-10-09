import type { GoogleAccountRecord } from "./google-account-contract.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_LIST_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const ACCESS_SKEW_MS = 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

export type InboxMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
};

export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  status: string;
};

export type GoogleToken = {
  email: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAtMs: number;
};

type FetchLike = typeof fetch;

type TokenFailure = {
  ok: false;
  reason: "reconnect" | "no_refresh_token" | "denied_scopes" | "google_error";
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

function hasReadonlyScopes(scope: unknown): boolean {
  if (typeof scope !== "string" || scope.trim() === "") {
    return true;
  }
  const parts = new Set(scope.split(/\s+/u));
  return (
    parts.has("https://www.googleapis.com/auth/gmail.readonly") &&
    parts.has("https://www.googleapis.com/auth/calendar.readonly")
  );
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
      signal: signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, reason: "google_error" };
  }
  const payload = await readBody(response);
  if (!response.ok) {
    return {
      ok: false,
      reason: googleErrorCode(payload) === "invalid_grant" ? "reconnect" : "google_error",
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
      signal: signal ?? AbortSignal.timeout(20_000),
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

export function parseCalendarEvents(payload: unknown): CalendarEvent[] {
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
      status?: unknown;
      start?: unknown;
      end?: unknown;
    };
    if (typeof record.id !== "string" || record.status === "cancelled") {
      continue;
    }
    const start = eventInstant(record.start);
    if (!start) {
      continue;
    }
    events.push({
      id: record.id,
      summary: typeof record.summary === "string" ? clip(record.summary, 300) : "",
      start,
      end: eventInstant(record.end),
      status: typeof record.status === "string" ? record.status : "confirmed",
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
  if (!hasReadonlyScopes(token.value.scope)) {
    return { ok: false, reason: "denied_scopes" };
  }
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
    },
  };
}

export async function loadAccessToken(params: {
  account: GoogleAccountRecord;
  clientId: string;
  clientSecret: string;
  now: Date;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; accessToken: string; accessExpiresAtMs: number } | TokenFailure> {
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
    return token;
  }
  const accessToken = token.value.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { ok: false, reason: "google_error" };
  }
  const expiresIn = typeof token.value.expires_in === "number" ? token.value.expires_in : 0;
  return {
    ok: true,
    accessToken,
    accessExpiresAtMs: params.now.getTime() + expiresIn * 1000,
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
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ ok: true; events: CalendarEvent[] } | { ok: false; status: number }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = new URL(CALENDAR_EVENTS_URL);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "20");
  url.searchParams.set("timeMin", params.now.toISOString());
  url.searchParams.set(
    "timeMax",
    new Date(params.now.getTime() + params.hours * 60 * 60 * 1000).toISOString(),
  );
  const listed = await authorizedGet(url.toString(), params.accessToken, fetchImpl, params.signal);
  if (!listed.ok) {
    return listed;
  }
  return { ok: true, events: parseCalendarEvents(listed.value) };
}
