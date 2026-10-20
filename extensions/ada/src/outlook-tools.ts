import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CalendarEvent, CalendarEventInput, InboxMessage } from "./google-api.js";
import {
  clamp,
  readCalendarEventInput,
  RECIPIENT,
  type CalendarEventArgs,
  type CalendarEventResult,
  type ToolFailure,
} from "./google-tools.js";
import { maskNumber } from "./inbound-log.js";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import type { OutlookAccountDb } from "./outlook-account-contract.js";
import { bindOutlookOwner, openAdaOutlookAccountDbFromApi } from "./outlook-account.js";
import { prepareOutlookConnect, type OutlookConnectConfig } from "./outlook-connect.js";
import {
  createOutlookDraft,
  getOutlookEvent,
  listOutlookEvents,
  listOutlookInbox,
  readOutlookMessage,
  replyToOutlookMessage,
  sendOutlookMail,
  writeOutlookEvent,
  type OutlookMessageContent,
} from "./outlook-graph.js";
import { loadOutlookAccess, type OutlookAccess } from "./outlook-session.js";
import { DEFAULT_TIME_ZONE, validTimeZone } from "./schedule.js";

type ToolApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

/** Test seams: a ready store, the fetch every Microsoft request uses, the clock and the environment. */
export type OutlookToolDeps = {
  db?: OutlookAccountDb;
  fetchImpl?: typeof fetch;
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

type Base = {
  api: ToolApi;
  owner: string;
  signal?: AbortSignal;
  deps: OutlookToolDeps;
};

const CONNECT_HINT =
  "call ada_outlook_connect and send the link only after they agree (or if they asked to connect).";

function accessFailure(reason: Extract<OutlookAccess, { ok: false }>["reason"]): ToolFailure {
  switch (reason) {
    case "not_connected":
      return {
        ok: false,
        reason: "not_connected",
        error: `Outlook is not connected. Ask whether they want to connect; ${CONNECT_HINT}`,
      };
    case "reconnect":
      return {
        ok: false,
        reason: "not_connected",
        error: `The Outlook connection expired. Ask whether they want to reconnect; ${CONNECT_HINT}`,
      };
    case "disabled":
      return {
        ok: false,
        error: "Outlook is not available: Ada has no Microsoft app registration configured.",
      };
    default:
      return { ok: false, error: "Ada could not reach Outlook. Try again shortly." };
  }
}

async function openDb(base: Base): Promise<OutlookAccountDb> {
  return base.deps.db ?? (await openAdaOutlookAccountDbFromApi(base.api));
}

async function guarded<T>(
  base: Base,
  label: string,
  run: () => Promise<T>,
): Promise<T | ToolFailure> {
  try {
    return await run();
  } catch (error) {
    base.api.logger.error(
      `ada outlook ${label} failed owner=${maskNumber(base.owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: `Ada could not ${label}. Try again shortly.` };
  }
}

/**
 * Runs one Graph call with the person's access token. A 401 renews the token once and retries;
 * a second 401 means Microsoft no longer accepts this sign-in, so it is dropped (only that row)
 * and the person is offered a new link. Every other status is left to the tool to interpret.
 */
async function viaGraph<R extends { ok: true } | { ok: false; status: number }>(
  base: Base,
  run: (accessToken: string) => Promise<R>,
): Promise<{ failure: ToolFailure } | { email: string; result: R }> {
  const db = await openDb(base);
  const load = (force: boolean) =>
    loadOutlookAccess({
      db,
      owner: base.owner,
      nowMs: (base.deps.now ?? new Date()).getTime(),
      force,
      env: base.deps.env,
      fetchImpl: base.deps.fetchImpl,
      signal: base.signal,
      log: (message) => base.api.logger.warn(`${message} owner=${maskNumber(base.owner)}`),
    });
  const first = await load(false);
  if (!first.ok) {
    return { failure: accessFailure(first.reason) };
  }
  let result = await run(first.accessToken);
  if (!result.ok && result.status === 401) {
    const renewed = await load(true);
    if (!renewed.ok) {
      return { failure: accessFailure(renewed.reason) };
    }
    result = await run(renewed.accessToken);
    if (!result.ok && result.status === 401) {
      await bindOutlookOwner(db, base.owner).clearAccountIfStill(renewed.account);
      return { failure: accessFailure("reconnect") };
    }
  }
  return { email: first.account.email, result };
}

export async function executeAdaOutlookConnect(
  owner: string,
  config: OutlookConnectConfig,
  api: ToolApi,
  args: { force?: boolean },
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
) {
  const base: Base = { api, owner, signal, deps };
  return await guarded(base, "prepare the Outlook connect link", async () =>
    prepareOutlookConnect({
      owner,
      config,
      db: await openDb(base),
      now: deps.now ?? new Date(),
      force: args.force === true,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      signal,
      log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
    }),
  );
}

export async function executeAdaOutlookReadInbox(
  owner: string,
  api: ToolApi,
  args: { max?: number; query?: string },
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
): Promise<{ ok: true; email: string; messages: InboxMessage[] } | ToolFailure> {
  const base: Base = { api, owner, signal, deps };
  return await guarded(base, "read Outlook mail", async () => {
    const now = deps.now ?? new Date();
    const read = await viaGraph(base, (accessToken) =>
      listOutlookInbox({
        accessToken,
        now,
        max: clamp(args.max, 8, 1, 10),
        query: args.query,
        fetchImpl: deps.fetchImpl,
        signal,
      }),
    );
    if ("failure" in read) {
      return read.failure;
    }
    return read.result.ok
      ? { ok: true as const, email: read.email, messages: read.result.messages }
      : { ok: false as const, error: "Ada could not read Outlook mail. Try again shortly." };
  });
}

export async function executeAdaOutlookReadMessage(
  owner: string,
  api: ToolApi,
  args: { id: string },
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
): Promise<{ ok: true; email: string; message: OutlookMessageContent } | ToolFailure> {
  const base: Base = { api, owner, signal, deps };
  return await guarded(base, "read that Outlook message", async () => {
    const read = await viaGraph(base, (accessToken) =>
      readOutlookMessage({ accessToken, id: args.id, fetchImpl: deps.fetchImpl, signal }),
    );
    if ("failure" in read) {
      return read.failure;
    }
    if (read.result.ok) {
      return { ok: true as const, email: read.email, message: read.result.content };
    }
    return {
      ok: false as const,
      error:
        read.result.status === 404
          ? "Ada could not find that message. Its id comes from ada_outlook_read_inbox."
          : "Ada could not read that message. Try again shortly.",
    };
  });
}

type MailInput = { to: string; subject: string; text: string };

function readMailInput(input: MailInput): ({ ok: true } & MailInput) | ToolFailure {
  const to = input.to.trim();
  const subject = input.subject.trim();
  const text = input.text.replaceAll("\u0000", "").trim();
  if (!RECIPIENT.test(to) || to.length > 320 || /[\r\n]/u.test(to)) {
    return { ok: false, error: "The recipient must be one email address." };
  }
  if (!subject || subject.length > 200 || /[\r\n]/u.test(subject)) {
    return { ok: false, error: "The subject must be one line." };
  }
  if (!text || text.length > 20_000) {
    return { ok: false, error: "The message body is empty or too long." };
  }
  return { ok: true, to, subject, text };
}

const SEND_CONFIRMATION =
  "Ask the user to confirm the recipient, subject, and body. Call again with confirmed true only after they agree.";
const REPLY_CONFIRMATION =
  "Ask the user to confirm who the reply goes to and exactly what it says. Call again with confirmed true only after they agree.";
const SEND_REFUSED =
  "Outlook did not allow sending. The person's organization may restrict it; tell them so and do not retry.";

/** Saves a draft in the Drafts folder of the person's mailbox. It sends nothing. */
export async function executeAdaOutlookDraft(
  owner: string,
  api: ToolApi,
  input: MailInput,
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
): Promise<{ ok: true; email: string; id: string } | ToolFailure> {
  const base: Base = { api, owner, signal, deps };
  const mail = readMailInput(input);
  if (!mail.ok) {
    return mail;
  }
  return await guarded(base, "save the Outlook draft", async () => {
    const saved = await viaGraph(base, (accessToken) =>
      createOutlookDraft({ accessToken, ...mail, fetchImpl: deps.fetchImpl, signal }),
    );
    if ("failure" in saved) {
      return saved.failure;
    }
    return saved.result.ok
      ? { ok: true as const, email: saved.email, id: saved.result.id }
      : { ok: false as const, error: "Ada could not save the draft. Try again shortly." };
  });
}

export async function executeAdaOutlookSend(
  owner: string,
  api: ToolApi,
  input: MailInput & { confirmed: boolean },
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
): Promise<{ ok: true; email: string } | ToolFailure> {
  if (input.confirmed !== true) {
    return {
      ok: false,
      reason: "confirmation_required",
      error: SEND_CONFIRMATION,
    };
  }
  const base: Base = { api, owner, signal, deps };
  const mail = readMailInput(input);
  if (!mail.ok) {
    return mail;
  }
  return await guarded(base, "send the email", async () => {
    const sent = await viaGraph(base, (accessToken) =>
      sendOutlookMail({ accessToken, ...mail, fetchImpl: deps.fetchImpl, signal }),
    );
    if ("failure" in sent) {
      return sent.failure;
    }
    if (sent.result.ok) {
      return { ok: true as const, email: sent.email };
    }
    return {
      ok: false as const,
      error:
        sent.result.status === 403
          ? SEND_REFUSED
          : "Ada could not send the email. Try again shortly.",
    };
  });
}

export async function executeAdaOutlookReply(
  owner: string,
  api: ToolApi,
  input: { messageId: string; text: string; replyAll?: boolean; confirmed: boolean },
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
): Promise<{ ok: true; email: string } | ToolFailure> {
  if (input.confirmed !== true) {
    return { ok: false, reason: "confirmation_required", error: REPLY_CONFIRMATION };
  }
  const base: Base = { api, owner, signal, deps };
  const messageId = input.messageId.trim();
  const text = input.text.replaceAll("\u0000", "").trim();
  if (!messageId) {
    return {
      ok: false,
      error: "Name the message to reply to; ada_outlook_read_inbox lists their ids.",
    };
  }
  if (!text || text.length > 20_000) {
    return { ok: false, error: "The reply is empty or too long." };
  }
  return await guarded(base, "send the reply", async () => {
    const sent = await viaGraph(base, (accessToken) =>
      replyToOutlookMessage({
        accessToken,
        messageId,
        text,
        replyAll: input.replyAll === true,
        fetchImpl: deps.fetchImpl,
        signal,
      }),
    );
    if ("failure" in sent) {
      return sent.failure;
    }
    if (sent.result.ok) {
      return { ok: true as const, email: sent.email };
    }
    return {
      ok: false as const,
      error:
        sent.result.status === 404
          ? "Ada could not find that message in the mailbox."
          : sent.result.status === 403
            ? SEND_REFUSED
            : "Ada could not send the reply. Try again shortly.",
    };
  });
}

export async function executeAdaOutlookReadCalendar(
  owner: string,
  api: ToolApi,
  args: { hours?: number },
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
): Promise<{ ok: true; email: string; events: CalendarEvent[] } | ToolFailure> {
  const base: Base = { api, owner, signal, deps };
  return await guarded(base, "read the Outlook calendar", async () => {
    const now = deps.now ?? new Date();
    const read = await viaGraph(base, (accessToken) =>
      listOutlookEvents({
        accessToken,
        now,
        hours: clamp(args.hours, 48, 1, 168),
        includeAttendees: true,
        fetchImpl: deps.fetchImpl,
        signal,
      }),
    );
    if ("failure" in read) {
      return read.failure;
    }
    return read.result.ok
      ? { ok: true as const, email: read.email, events: read.result.events }
      : {
          ok: false as const,
          error: "Ada could not read the Outlook calendar. Try again shortly.",
        };
  });
}

const NO_WRITE_ACCESS =
  "The person has no write access to that calendar or event (for example they are not its organizer), so nothing was changed. Tell them so; a new permission would not help.";

/** Creates an event, or changes the one `args.eventId` names, on the person's default Outlook calendar. */
export async function executeAdaOutlookCalendarEvent(
  owner: string,
  api: ToolApi,
  args: CalendarEventArgs,
  signal?: AbortSignal,
  deps: OutlookToolDeps = {},
): Promise<CalendarEventResult | ToolFailure> {
  const eventId = args.eventId?.trim();
  const update = args.eventId !== undefined;
  if (args.confirmed !== true) {
    return {
      ok: false,
      reason: "confirmation_required",
      error: update
        ? "Ask the user to confirm which event changes and exactly what changes: the title, the date and time with its time zone, the location, the description and any guests to add. Call again with confirmed true only after they agree."
        : "Ask the user to confirm the title, the date and time with its time zone, and the location, description and guests if any. Call again with confirmed true only after they agree.",
    };
  }
  if (update && !eventId) {
    return {
      ok: false,
      error: "Name the event to change; ada_outlook_read_calendar lists their ids.",
    };
  }
  const input = readCalendarEventInput(args, update);
  if (!input.ok) {
    return input;
  }
  const base: Base = { api, owner, signal, deps };
  return await guarded(base, `${update ? "update" : "create"} the event`, async () => {
    let profileTimeZone: string | undefined;
    try {
      const timezone = (await (await openAdaMemoryIfExistsFromApi(api, owner))?.readProfile())
        ?.timezone;
      profileTimeZone = timezone && validTimeZone(timezone) ? timezone : undefined;
    } catch {
      profileTimeZone = undefined;
    }
    const failed = (status: number): ToolFailure => ({
      ok: false,
      error:
        status === 404 && update
          ? "Ada could not find that event in the calendar."
          : `Ada could not ${update ? "update" : "create"} the event. Try again shortly.`,
    });

    const current = update
      ? await viaGraph(base, (accessToken) =>
          getOutlookEvent({
            accessToken,
            eventId: eventId ?? "",
            fetchImpl: deps.fetchImpl,
            signal,
          }),
        )
      : undefined;
    if (current && "failure" in current) {
      return current.failure;
    }
    if (current && !current.result.ok) {
      return failed(current.result.status);
    }
    const existing = current?.result.ok ? current.result : undefined;
    const known = existing?.guests ?? [];
    const have = new Set(known.map((guest) => guest.email.toLowerCase()));
    const added: string[] = [];
    for (const email of input.guests) {
      if (!have.has(email.toLowerCase())) {
        have.add(email.toLowerCase());
        added.push(email);
      }
    }
    const event: CalendarEventInput = { ...input.event };
    if (event.start) {
      event.timeZone =
        input.namedTimeZone ?? existing?.timeZone ?? profileTimeZone ?? DEFAULT_TIME_ZONE;
      if (existing?.wasAllDay) {
        event.wasAllDay = true;
      }
    }
    if (added.length > 0) {
      event.guests = [...known, ...added.map((email) => ({ email }))];
    }
    if (update && Object.keys(event).length === 0) {
      return {
        ok: false as const,
        error: "Those guests are already invited and nothing else changes.",
      };
    }
    const saved = await viaGraph(base, (accessToken) =>
      writeOutlookEvent({ accessToken, eventId, event, fetchImpl: deps.fetchImpl, signal }),
    );
    if ("failure" in saved) {
      return saved.failure;
    }
    if (!saved.result.ok) {
      return "denied" in saved.result && saved.result.denied === "access"
        ? { ok: false as const, error: NO_WRITE_ACCESS }
        : failed(saved.result.status);
    }
    const result: CalendarEventResult = {
      ok: true,
      email: saved.email,
      event: saved.result.event,
    };
    if (update && known.length + added.length > 0) {
      result.guestsNotified = true;
      result.notice =
        "Outlook emailed the guests on this event an update itself. Tell the person, in one sentence.";
    }
    return result;
  });
}
