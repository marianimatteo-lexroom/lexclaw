import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CalendarEvent, InboxMessage } from "./google-api.js";
import { maskNumber } from "./inbound-log.js";
import type { OutlookAccountDb } from "./outlook-account-contract.js";
import { openAdaOutlookAccountDbFromApi } from "./outlook-account.js";
import { listOutlookEvents, listOutlookInbox } from "./outlook-graph.js";
import { loadOutlookAccess } from "./outlook-session.js";

/**
 * What the morning brief and the urgent-item polls read from one person's Outlook. Ids are
 * prefixed, so the shared mail and calendar snapshots tell Outlook rows from Gmail and Google
 * Calendar rows, and a provider that cannot be read for a moment keeps its rows for the next pass.
 */
const OUTLOOK_PREFIX = "outlook:";
/** The snapshot tables take ids of up to 256 characters without whitespace. */
const MAX_SNAPSHOT_ID = 256;

export function outlookSnapshotId(id: string): string {
  const prefixed = `${OUTLOOK_PREFIX}${id}`;
  return prefixed.length <= MAX_SNAPSHOT_ID && !/\s/u.test(prefixed)
    ? prefixed
    : `${OUTLOOK_PREFIX}h:${createHash("sha256").update(id).digest("base64url")}`;
}

export function isOutlookSnapshotId(id: string): boolean {
  return id.startsWith(OUTLOOK_PREFIX);
}

export type OutlookReads =
  | { ok: true; email: string; messages: InboxMessage[]; events: CalendarEvent[] }
  | {
      ok: false;
      /** `reconnect`: the saved sign-in was just dropped. `disabled` and `not_connected` are not failures. */
      error: "disabled" | "not_connected" | "reconnect" | "unavailable" | string;
    };

type ReadsApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger">;

export async function loadOutlookReads(
  api: ReadsApi,
  owner: string,
  now: Date,
  options: {
    inboxWindow: number;
    hours: number;
    db?: OutlookAccountDb;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  },
): Promise<OutlookReads> {
  const db = options.db ?? (await openAdaOutlookAccountDbFromApi(api));
  const load = (force: boolean) =>
    loadOutlookAccess({
      db,
      owner,
      nowMs: now.getTime(),
      force,
      env: options.env,
      fetchImpl: options.fetchImpl,
      log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
    });
  const readAll = async (accessToken: string) => {
    const inbox = await listOutlookInbox({
      accessToken,
      now,
      max: options.inboxWindow,
      fetchImpl: options.fetchImpl,
    });
    if (!inbox.ok) {
      return { ok: false as const, status: inbox.status, error: `outlook_mail_${inbox.status}` };
    }
    const events = await listOutlookEvents({
      accessToken,
      now,
      hours: options.hours,
      fetchImpl: options.fetchImpl,
    });
    return events.ok
      ? { ok: true as const, messages: inbox.messages, events: events.events }
      : { ok: false as const, status: events.status, error: `outlook_calendar_${events.status}` };
  };
  let access = await load(false);
  if (!access.ok) {
    return { ok: false, error: access.reason };
  }
  let read = await readAll(access.accessToken);
  if (!read.ok && read.status === 401) {
    // Microsoft refused a token that looked live: renew it once, whatever its expiry says.
    access = await load(true);
    if (!access.ok) {
      return { ok: false, error: access.reason };
    }
    read = await readAll(access.accessToken);
  }
  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  return {
    ok: true,
    email: access.account.email,
    messages: read.messages.map((message) =>
      Object.assign({}, message, { id: outlookSnapshotId(message.id) }),
    ),
    events: read.events.map((event) =>
      Object.assign({}, event, { id: outlookSnapshotId(event.id) }),
    ),
  };
}
