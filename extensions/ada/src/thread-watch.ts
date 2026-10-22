import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ThreadMessage } from "./google-api.js";
import { maskNumber } from "./inbound-log.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { findOutlookSentConversation, readOutlookConversationId } from "./outlook-graph.js";
import {
  listWatches,
  MAX_WATCHES,
  removeWatch,
  saveWatch,
  type ThreadWatch,
  type WatchReply,
} from "./proactive-store.js";

/**
 * Sent-thread watch. When Ada sends or replies to a mail because the person asked her to, the
 * thread is recorded under that number; the 15-minute poll looks at it and, when someone else
 * writes into it, the reply is told once (see `proactive.ts`). Only threads Ada sent are watched,
 * and nothing about any other mail is read or kept.
 */
/** An Outlook watch whose conversation was not in Sent Items yet is `lookup:<sent time>` until the poll finds it. */
export const OUTLOOK_LOOKUP_PREFIX = "lookup:";
/** Sent Items stamps a mail a moment before or after the clock Ada read when sending. */
export const OUTLOOK_SENT_SLACK_MS = 60_000;

type WatchApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

/** The newest message in the thread that someone else wrote after the mail went out, if any. */
export function findReply(
  watch: ThreadWatch,
  messages: readonly ThreadMessage[],
): WatchReply | null {
  const seen = new Set(watch.seenIds);
  const reply = messages
    .filter((message) => !message.own && !seen.has(message.id) && message.atMs >= watch.sentAtMs)
    .toSorted((a, b) => b.atMs - a.atMs)[0];
  return reply
    ? { from: reply.from, subject: reply.subject, snippet: reply.snippet, atMs: reply.atMs }
    : null;
}

/**
 * Starts watching one sent mail and says whether it did. Never throws: a mail that went out is
 * not undone by a failed note, and only a watch that was saved may be promised to the person.
 */
export async function recordSentThread(
  api: WatchApi,
  owner: string,
  sent: {
    provider: "google" | "outlook";
    threadId: string;
    subject: string;
    to: string;
    atMs: number;
    /** The message just sent, so it never counts as a reply. */
    ownId?: string;
  },
): Promise<boolean> {
  try {
    const memory = await openAdaMemoryFromApi(api, owner);
    const watches = await listWatches(memory);
    const id = `${sent.provider}:${sent.threadId}`;
    const open = watches.filter((watch) => watch.id !== id);
    // The oldest watches give way: a person who sends more than the cap never fills the store.
    for (const stale of open
      .toSorted((a, b) => a.sentAtMs - b.sentAtMs)
      .slice(0, Math.max(0, open.length - (MAX_WATCHES - 1)))) {
      await removeWatch(memory, stale.id);
    }
    await saveWatch(
      memory,
      {
        id,
        provider: sent.provider,
        threadId: sent.threadId,
        subject: sent.subject.slice(0, 200),
        to: sent.to.slice(0, 320),
        sentAtMs: sent.atMs,
        seenIds: sent.ownId ? [sent.ownId] : [],
        reply: null,
        state: "pending",
      },
      sent.atMs,
    );
    return true;
  } catch (error) {
    api.logger.warn(
      `ada thread watch not recorded owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}

/** Looks up the Outlook conversation of a mail Ada just sent or replied to, then watches it. */
export async function recordOutlookThread(
  api: WatchApi,
  owner: string,
  sent: {
    accessToken: string;
    subject: string;
    to: string;
    atMs: number;
    /** A reply names the message it answers; a new mail is found in Sent Items. */
    repliedTo?: { conversationId: string; subject: string };
    fetchImpl?: typeof fetch;
  },
): Promise<boolean> {
  const found = sent.repliedTo
    ? null
    : await findOutlookSentConversation({
        accessToken: sent.accessToken,
        subject: sent.subject,
        to: sent.to,
        sinceMs: sent.atMs - OUTLOOK_SENT_SLACK_MS,
        fetchImpl: sent.fetchImpl,
      });
  return await recordSentThread(api, owner, {
    provider: "outlook",
    // Sent Items can lag behind `sendMail`: the poll then finds the conversation itself.
    threadId:
      sent.repliedTo?.conversationId ??
      (found?.ok ? found.conversationId : `${OUTLOOK_LOOKUP_PREFIX}${sent.atMs}`),
    subject: sent.repliedTo?.subject ?? sent.subject,
    to: sent.to,
    atMs: sent.atMs,
  });
}

/** The conversation a message belongs to, read before Ada replies to it. */
export async function readReplyTarget(
  accessToken: string,
  messageId: string,
  fetchImpl?: typeof fetch,
): Promise<{ conversationId: string; subject: string } | null> {
  const read = await readOutlookConversationId({ accessToken, messageId, fetchImpl });
  return read.ok ? { conversationId: read.conversationId, subject: read.subject } : null;
}
