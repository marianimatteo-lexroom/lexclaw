import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarGuest,
  InboxMessage,
} from "./google-api.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 20_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const MAX_BODY_CHARS = 20_000;
const MESSAGE_FIELDS = "id,subject,from,receivedDateTime,bodyPreview,isRead";

type FetchLike = typeof fetch;

/** Every Graph request ends within the limit, even when the caller brings a signal of its own. */
function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const limit = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, limit]) : limit;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Query string with OData's `$` names left as they are: Graph documents them unencoded. */
function queryString(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

type GraphFailure = { ok: false; status: number; code?: string };

type GraphCall = {
  accessToken: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

async function graph(
  call: GraphCall & {
    method?: "GET" | "POST" | "PATCH";
    path: string;
    body?: unknown;
    prefer?: string[];
  },
): Promise<{ ok: true; status: number; value: unknown } | GraphFailure> {
  let response: Response;
  try {
    response = await (call.fetchImpl ?? fetch)(`${GRAPH}${call.path}`, {
      method: call.method ?? "GET",
      headers: {
        authorization: `Bearer ${call.accessToken}`,
        accept: "application/json",
        ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(call.prefer?.length ? { prefer: call.prefer.join(", ") } : {}),
      },
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      signal: withTimeout(call.signal),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (value as { error?: { code?: unknown } } | null)?.error?.code;
    return {
      ok: false,
      status: response.status,
      ...(typeof code === "string" && /^[A-Za-z0-9_]{1,80}$/u.test(code) ? { code } : {}),
    };
  }
  return { ok: true, status: response.status, value };
}

function address(value: unknown): { email: string; name: string } | null {
  const emailAddress = (value as { emailAddress?: { address?: unknown; name?: unknown } } | null)
    ?.emailAddress;
  if (
    !emailAddress ||
    typeof emailAddress.address !== "string" ||
    !EMAIL.test(emailAddress.address)
  ) {
    return null;
  }
  return {
    email: emailAddress.address,
    name: typeof emailAddress.name === "string" ? clip(emailAddress.name, 200) : "",
  };
}

/** A sender the way a mail header shows it: `Name <address>`, or the bare address. */
function formatSender(value: unknown): string {
  const sender = address(value);
  if (!sender) {
    return "";
  }
  return clip(
    sender.name && sender.name !== sender.email ? `${sender.name} <${sender.email}>` : sender.email,
    300,
  );
}

export function parseOutlookMessage(payload: unknown): InboxMessage | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    id?: unknown;
    subject?: unknown;
    from?: unknown;
    receivedDateTime?: unknown;
    bodyPreview?: unknown;
    isRead?: unknown;
  };
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  return {
    id: record.id,
    from: formatSender(record.from),
    subject: typeof record.subject === "string" ? clip(record.subject, 300) : "",
    date: typeof record.receivedDateTime === "string" ? record.receivedDateTime : "",
    snippet: typeof record.bodyPreview === "string" ? clip(record.bodyPreview, 240) : "",
    ...(record.isRead === false ? { unread: true as const } : {}),
  };
}

function parseMessages(value: unknown): InboxMessage[] {
  const items = (value as { value?: unknown } | null)?.value;
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const message = parseOutlookMessage(item);
        return message ? [message] : [];
      })
    : [];
}

export async function listOutlookInbox(
  params: GraphCall & { max: number; now: Date; query?: string },
): Promise<{ ok: true; messages: InboxMessage[] } | GraphFailure> {
  // The text goes inside a quoted $search expression: quotes and control characters cannot.
  const query = Array.from(params.query ?? "", (char) =>
    char === '"' || (char.codePointAt(0) ?? 0) < 0x20 ? " " : char,
  )
    .join("")
    .trim();
  const window = { $top: String(params.max), $select: MESSAGE_FIELDS };
  // Graph search covers every folder and cannot be combined with $filter or $orderby.
  const path = query
    ? `/me/messages?${queryString({ ...window, $search: `"${query}"` })}`
    : `/me/mailFolders/inbox/messages?${queryString({
        ...window,
        $filter: `receivedDateTime ge ${new Date(params.now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()}`,
        $orderby: "receivedDateTime desc",
      })}`;
  const listed = await graph({ ...params, path });
  return listed.ok ? { ok: true, messages: parseMessages(listed.value) } : listed;
}

/** A message read in full: headers, plain text, and who it went to. */
export type OutlookMessageContent = InboxMessage & { to: string[]; bodyText: string };

export async function readOutlookMessage(
  params: GraphCall & { id: string },
): Promise<{ ok: true; content: OutlookMessageContent } | GraphFailure> {
  const read = await graph({
    ...params,
    path: `/me/messages/${encodeURIComponent(params.id)}?$select=${MESSAGE_FIELDS},toRecipients,body`,
    prefer: ['outlook.body-content-type="text"'],
  });
  if (!read.ok) {
    return read;
  }
  const message = parseOutlookMessage(read.value);
  if (!message) {
    return { ok: false, status: 0 };
  }
  const record = read.value as { body?: { content?: unknown }; toRecipients?: unknown };
  const content = typeof record.body?.content === "string" ? record.body.content.trim() : "";
  return {
    ok: true,
    content: {
      ...message,
      to: Array.isArray(record.toRecipients)
        ? record.toRecipients.flatMap((item) => {
            const recipient = address(item);
            return recipient ? [recipient.email] : [];
          })
        : [],
      bodyText: content.length > MAX_BODY_CHARS ? content.slice(0, MAX_BODY_CHARS) : content,
    },
  };
}

function plainMessage(params: { to: string; subject: string; text: string }) {
  return {
    subject: params.subject,
    body: { contentType: "Text", content: params.text },
    toRecipients: [{ emailAddress: { address: params.to } }],
  };
}

/** Saves a draft in the Drafts folder. Nothing is sent. */
export async function createOutlookDraft(
  params: GraphCall & { to: string; subject: string; text: string },
): Promise<{ ok: true; id: string } | GraphFailure> {
  const created = await graph({
    ...params,
    method: "POST",
    path: "/me/messages",
    body: plainMessage(params),
  });
  if (!created.ok) {
    return created;
  }
  const id = (created.value as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? { ok: true, id } : { ok: false, status: created.status };
}

export async function sendOutlookMail(
  params: GraphCall & { to: string; subject: string; text: string },
): Promise<{ ok: true } | GraphFailure> {
  const sent = await graph({
    ...params,
    method: "POST",
    path: "/me/sendMail",
    body: { message: plainMessage(params), saveToSentItems: true },
  });
  return sent.ok ? { ok: true } : sent;
}

export async function replyToOutlookMessage(
  params: GraphCall & { messageId: string; text: string; replyAll: boolean },
): Promise<{ ok: true } | GraphFailure> {
  const sent = await graph({
    ...params,
    method: "POST",
    path: `/me/messages/${encodeURIComponent(params.messageId)}/${params.replyAll ? "replyAll" : "reply"}`,
    body: { comment: params.text },
  });
  return sent.ok ? { ok: true } : sent;
}

/** Event times are asked for in UTC, so every start and end is one unambiguous instant. */
const UTC = 'outlook.timezone="UTC"';

function graphInstant(value: unknown, allDay: boolean): string {
  const dateTime = (value as { dateTime?: unknown } | null)?.dateTime;
  if (typeof dateTime !== "string" || !dateTime) {
    return "";
  }
  // An all-day event has no clock time: the date alone, as Google gives it.
  return allDay ? dateTime.slice(0, 10) : `${dateTime.replace(/\.\d+$/u, "")}Z`;
}

type GraphAttendee = { type?: unknown; status?: { response?: unknown }; emailAddress?: unknown };

function parseGuests(value: unknown): CalendarGuest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): CalendarGuest[] => {
    const attendee = item as GraphAttendee | null;
    const who = address(attendee);
    if (!who) {
      return [];
    }
    const response = attendee?.status?.response;
    return [
      {
        email: who.email,
        ...(who.name && who.name !== who.email ? { displayName: who.name } : {}),
        ...(attendee?.type === "optional" ? { optional: true } : {}),
        ...(attendee?.type === "resource" ? { resource: true } : {}),
        ...(typeof response === "string" && response !== "none"
          ? { responseStatus: response }
          : {}),
      },
    ];
  });
}

export function parseOutlookEvents(
  payload: unknown,
  options: { includeDescription?: boolean; includeAttendees?: boolean } = {},
): CalendarEvent[] {
  const items = (payload as { value?: unknown } | null)?.value;
  if (!Array.isArray(items)) {
    return [];
  }
  const events: CalendarEvent[] = [];
  for (const item of items) {
    const record = item as {
      id?: unknown;
      subject?: unknown;
      bodyPreview?: unknown;
      isAllDay?: unknown;
      isCancelled?: unknown;
      start?: unknown;
      end?: unknown;
      attendees?: unknown;
    } | null;
    if (!record || typeof record.id !== "string" || record.isCancelled === true) {
      continue;
    }
    const allDay = record.isAllDay === true;
    const start = graphInstant(record.start, allDay);
    if (!start) {
      continue;
    }
    const guests = options.includeAttendees === true ? parseGuests(record.attendees) : [];
    events.push({
      id: record.id,
      summary: typeof record.subject === "string" ? clip(record.subject, 300) : "",
      start,
      end: graphInstant(record.end, allDay),
      status: "confirmed",
      ...(options.includeDescription === true &&
      typeof record.bodyPreview === "string" &&
      record.bodyPreview.trim()
        ? { description: clip(record.bodyPreview, 600) }
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

const EVENT_FIELDS =
  "id,subject,start,end,isAllDay,isCancelled,bodyPreview,attendees,originalStartTimeZone";

export async function listOutlookEvents(
  params: GraphCall & {
    now: Date;
    hours: number;
    maxResults?: number;
    includeDescription?: boolean;
    includeAttendees?: boolean;
  },
): Promise<{ ok: true; events: CalendarEvent[] } | GraphFailure> {
  const query = queryString({
    startDateTime: params.now.toISOString(),
    endDateTime: new Date(params.now.getTime() + params.hours * 60 * 60 * 1000).toISOString(),
    $orderby: "start/dateTime",
    $top: String(Math.min(250, Math.max(1, params.maxResults ?? 20))),
    $select: EVENT_FIELDS,
  });
  const listed = await graph({ ...params, path: `/me/calendarView?${query}`, prefer: [UTC] });
  return listed.ok
    ? {
        ok: true,
        events: parseOutlookEvents(listed.value, {
          includeDescription: params.includeDescription,
          includeAttendees: params.includeAttendees,
        }),
      }
    : listed;
}

/** An event as Outlook has it now, with what a safe edit needs to know about it. */
export type CurrentOutlookEvent = {
  event: CalendarEvent;
  timeZone?: string;
  guests: CalendarGuest[];
  wasAllDay: boolean;
};

export async function getOutlookEvent(
  params: GraphCall & { eventId: string },
): Promise<({ ok: true } & CurrentOutlookEvent) | GraphFailure> {
  const got = await graph({
    ...params,
    path: `/me/events/${encodeURIComponent(params.eventId)}?$select=${EVENT_FIELDS}`,
    prefer: [UTC],
  });
  if (!got.ok) {
    return got;
  }
  const [event] = parseOutlookEvents({ value: [got.value] }, { includeAttendees: true });
  if (!event) {
    return { ok: false, status: 404 };
  }
  const record = got.value as {
    attendees?: unknown;
    isAllDay?: unknown;
    originalStartTimeZone?: unknown;
  };
  const zone = record.originalStartTimeZone;
  return {
    ok: true,
    event,
    guests: parseGuests(record.attendees),
    wasAllDay: record.isAllDay === true,
    ...(typeof zone === "string" && /^[A-Za-z][A-Za-z0-9 _/+().-]{0,80}$/u.test(zone)
      ? { timeZone: zone }
      : {}),
  };
}

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/u;

/** A local date-time in the named zone, or an instant converted to UTC when the input carries an offset. */
function graphDateTime(value: string, timeZone: string | undefined) {
  if (OFFSET.test(value)) {
    return { dateTime: new Date(value).toISOString().replace(/Z$/u, ""), timeZone: "UTC" };
  }
  return { dateTime: value, timeZone: timeZone ?? "UTC" };
}

function graphAttendee(guest: CalendarGuest) {
  return {
    emailAddress: {
      address: guest.email,
      ...(guest.displayName ? { name: guest.displayName } : {}),
    },
    type: guest.resource ? "resource" : guest.optional ? "optional" : "required",
  };
}

/**
 * Creates an event on the default calendar, or patches the one named by `eventId`. Only the
 * fields given are sent, so an update never blanks what it does not mention. Outlook emails the
 * guests an invitation or an update itself; there is no switch for it.
 */
export async function writeOutlookEvent(
  params: GraphCall & { eventId?: string; event: CalendarEventInput },
): Promise<{ ok: true; event: CalendarEvent } | (GraphFailure & { denied?: "access" })> {
  const { event } = params;
  const body = {
    ...(event.summary !== undefined ? { subject: event.summary } : {}),
    ...(event.description !== undefined
      ? { body: { contentType: "Text", content: event.description } }
      : {}),
    ...(event.location !== undefined ? { location: { displayName: event.location } } : {}),
    ...(event.start ? { start: graphDateTime(event.start, event.timeZone) } : {}),
    ...(event.end ? { end: graphDateTime(event.end, event.timeZone) } : {}),
    ...(event.start && event.wasAllDay ? { isAllDay: false } : {}),
    ...(event.guests ? { attendees: event.guests.map(graphAttendee) } : {}),
  };
  const saved = await graph({
    ...params,
    method: params.eventId ? "PATCH" : "POST",
    path: params.eventId ? `/me/events/${encodeURIComponent(params.eventId)}` : "/me/events",
    body,
    prefer: [UTC],
  });
  if (!saved.ok) {
    return {
      ...saved,
      ...(saved.status === 403 && saved.code === "ErrorAccessDenied"
        ? { denied: "access" as const }
        : {}),
    };
  }
  const [parsed] = parseOutlookEvents({ value: [saved.value] }, { includeAttendees: true });
  return parsed ? { ok: true, event: parsed } : { ok: false, status: saved.status };
}
