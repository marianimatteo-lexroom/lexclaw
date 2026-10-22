import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openAdaGoogleAccountFromApi } from "./google-account.js";
import {
  listUpcomingEvents,
  readGmailThread,
  type CalendarEvent,
  type ThreadMessage,
} from "./google-api.js";
import { googleConnectConfigFrom } from "./google-connect.js";
import { accessForRead } from "./google-tools.js";
import { maskNumber } from "./inbound-log.js";
import type { OutlookAccountDb } from "./outlook-account-contract.js";
import { openAdaOutlookAccountDbFromApi } from "./outlook-account.js";
import {
  findOutlookSentConversation,
  listOutlookEvents,
  readOutlookConversation,
} from "./outlook-graph.js";
import { outlookEnabled } from "./outlook-oauth.js";
import { loadOutlookAccess } from "./outlook-session.js";
import type { ThreadWatch } from "./proactive-store.js";
import { OUTLOOK_LOOKUP_PREFIX, OUTLOOK_SENT_SLACK_MS } from "./thread-watch.js";

type ReaderApi = Pick<
  OpenClawPluginApi,
  "runtimeSource" | "runtime" | "logger" | "config" | "pluginConfig"
>;

/** What the watch needs from the provider to see a thread; injected by tests. */
export type ThreadReader = (
  watch: ThreadWatch,
) => Promise<{ ok: true; messages: ThreadMessage[] } | { ok: false; gone: boolean }>;

/**
 * Reads a thread from the provider that sent it, with the number's own account. Access is loaded
 * on first use and kept for the pass, so a number with nothing to watch costs no provider call.
 */
export function liveThreadReader(
  api: ReaderApi,
  owner: string,
  now: Date,
  seams: { outlookDb?: OutlookAccountDb; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): ThreadReader {
  let google: Promise<{ accessToken: string } | null> | undefined;
  let outlook: Promise<{ accessToken: string; email: string } | null> | undefined;
  const log = (message: string) => api.logger.warn(`${message} owner=${maskNumber(owner)}`);
  const googleAccess = () =>
    (google ??= (async () => {
      const access = await accessForRead({
        config: googleConnectConfigFrom(api.pluginConfig),
        store: await openAdaGoogleAccountFromApi(api, owner),
        now,
        log,
      });
      return access.ok ? { accessToken: access.accessToken } : null;
    })());
  const outlookAccess = () =>
    (outlook ??= (async () => {
      if (!outlookEnabled(seams.env)) {
        return null;
      }
      const access = await loadOutlookAccess({
        db: seams.outlookDb ?? (await openAdaOutlookAccountDbFromApi(api)),
        owner,
        nowMs: now.getTime(),
        env: seams.env,
        fetchImpl: seams.fetchImpl,
        log,
      });
      return access.ok ? { accessToken: access.accessToken, email: access.account.email } : null;
    })());
  return async (watch) => {
    if (watch.provider === "google") {
      const access = await googleAccess();
      if (!access) {
        return { ok: false, gone: false };
      }
      const read = await readGmailThread({
        accessToken: access.accessToken,
        threadId: watch.threadId,
      });
      return read.ok ? read : { ok: false, gone: read.status === 404 };
    }
    const access = await outlookAccess();
    if (!access) {
      return { ok: false, gone: false };
    }
    let conversationId = watch.threadId;
    if (conversationId.startsWith(OUTLOOK_LOOKUP_PREFIX)) {
      const found = await findOutlookSentConversation({
        accessToken: access.accessToken,
        subject: watch.subject,
        to: watch.to,
        sinceMs: watch.sentAtMs - OUTLOOK_SENT_SLACK_MS,
        fetchImpl: seams.fetchImpl,
      });
      if (!found.ok) {
        return { ok: false, gone: false };
      }
      conversationId = found.conversationId;
    }
    const read = await readOutlookConversation({
      accessToken: access.accessToken,
      conversationId,
      selfEmail: access.email,
      fetchImpl: seams.fetchImpl,
    });
    return read.ok ? read : { ok: false, gone: false };
  };
}

/** The upcoming events of every calendar the number connected, read only when a feature asks. */
export type EventReader = (now: Date, hours: number) => Promise<CalendarEvent[]>;

export function liveEventReader(api: ReaderApi, owner: string): EventReader {
  const log = (message: string) => api.logger.warn(`${message} owner=${maskNumber(owner)}`);
  return async (now, hours) => {
    const events: CalendarEvent[] = [];
    const google = await accessForRead({
      config: googleConnectConfigFrom(api.pluginConfig),
      store: await openAdaGoogleAccountFromApi(api, owner),
      now,
      log,
    });
    if (google.ok) {
      const read = await listUpcomingEvents({ accessToken: google.accessToken, now, hours });
      if (read.ok) {
        events.push(...read.events);
      }
    }
    if (outlookEnabled()) {
      const outlook = await loadOutlookAccess({
        db: await openAdaOutlookAccountDbFromApi(api),
        owner,
        nowMs: now.getTime(),
        log,
      });
      if (outlook.ok) {
        const read = await listOutlookEvents({ accessToken: outlook.accessToken, now, hours });
        if (read.ok) {
          events.push(...read.events);
        }
      }
    }
    return events;
  };
}
