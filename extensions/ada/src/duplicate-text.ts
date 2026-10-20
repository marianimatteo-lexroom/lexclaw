import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { logInboundSkip } from "./inbound-log.js";
import { sessionKeyOwner, toOwner } from "./owner.js";
import { ADA_WHATSAPP_CHANNEL } from "./whatsapp-number.js";

/** The same text again inside this window is the same request sent twice, not a new one. */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
/**
 * Short texts ("ok", "sì", "grazie") are legitimate answers to two different questions in a row,
 * and they never start a full answer, so only texts of a real request's length can be repeats.
 */
const MIN_DUPLICATE_CHARS = 12;
const MAX_PER_SENDER = 8;
const MAX_SENDERS = 1000;
const FORGET_AFTER_MS = 10 * 60 * 1000;
/** A message timestamp further from the clock than this is not in milliseconds; use the clock. */
const TRUSTED_SKEW_MS = 24 * 60 * 60 * 1000;

export type InboundTextVerdict = "first" | "duplicate" | "ignored";

type Seen = {
  messageId: string;
  text: string;
  atMs: number;
  seenAtMs: number;
  verdict: "first" | "duplicate";
};

export function normalizeInboundText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Remembers, per number and in this process only, the texts it received lately. The verdict for
 * one message id never changes, so the hooks that look at the same message agree whichever runs
 * first, and a redelivery of the first message is never mistaken for a repeat of itself.
 */
export function createInboundTextGuard(nowMs: () => number = Date.now) {
  const bySender = new Map<string, Seen[]>();

  return {
    verdict(params: {
      channelId?: string;
      senders: unknown[];
      messageId?: string;
      text: unknown;
      timestampMs?: unknown;
    }): InboundTextVerdict {
      const sender = params.senders.map(toOwner).find((value) => value !== null);
      // Without an id the two hooks cannot tell one message from a repeat of it.
      if (
        (params.channelId !== undefined && params.channelId !== ADA_WHATSAPP_CHANNEL) ||
        !sender ||
        !params.messageId ||
        typeof params.text !== "string"
      ) {
        return "ignored";
      }
      const now = nowMs();
      const claimed = typeof params.timestampMs === "number" ? params.timestampMs : Number.NaN;
      const atMs = Math.abs(claimed - now) <= TRUSTED_SKEW_MS ? claimed : now;
      const text = normalizeInboundText(params.text);
      const recent = (bySender.get(sender) ?? []).filter(
        (entry) => now - entry.seenAtMs <= FORGET_AFTER_MS,
      );
      const known = recent.find((entry) => entry.messageId === params.messageId);
      if (known) {
        return known.verdict;
      }
      if (text.length < MIN_DUPLICATE_CHARS) {
        return "first";
      }
      const original = recent.find(
        (entry) =>
          entry.verdict === "first" &&
          entry.text === text &&
          Math.abs(atMs - entry.atMs) <= DUPLICATE_WINDOW_MS,
      );
      const verdict = original ? "duplicate" : "first";
      recent.push({ messageId: params.messageId, text, atMs, seenAtMs: now, verdict });
      bySender.delete(sender);
      bySender.set(sender, recent.slice(-MAX_PER_SENDER));
      if (bySender.size > MAX_SENDERS) {
        bySender.delete(bySender.keys().next().value ?? sender);
      }
      return verdict;
    },

    /** The run for this number's message failed without an answer, so a repeat must be answered. */
    release(sender: unknown): void {
      const owner = toOwner(sender);
      const recent = owner ? bySender.get(owner) : undefined;
      if (owner && recent) {
        bySender.set(
          owner,
          recent.filter((entry) => entry.verdict !== "first"),
        );
      }
    },
  };
}

export type InboundTextGuard = ReturnType<typeof createInboundTextGuard>;

/**
 * Claims a repeated text before the model dispatch, which is also before the host queues a
 * message behind a run that is still answering the first copy. Nothing is sent: the person
 * already has, or is about to get, the one answer.
 */
export function registerInboundDuplicateHooks(
  api: Pick<OpenClawPluginApi, "on" | "logger">,
  guard: InboundTextGuard,
): void {
  api.on("before_dispatch", (event, ctx) => {
    const verdict = guard.verdict({
      channelId: ctx.channelId ?? event.channel,
      senders: [ctx.senderId, event.senderId],
      messageId: ctx.messageId ?? event.messageId,
      text: event.content,
      timestampMs: event.timestamp,
    });
    if (verdict !== "duplicate") {
      return undefined;
    }
    logInboundSkip(api.logger, {
      stage: "dispatch",
      reason: "duplicate_text",
      sender: [ctx.senderId, event.senderId],
      messageId: ctx.messageId ?? event.messageId,
    });
    return { handled: true };
  });
  api.on("agent_end", (event, ctx) => {
    if (!event.success && (!ctx.trigger || ctx.trigger === "user")) {
      guard.release(ctx.senderId ?? sessionKeyOwner(ctx.sessionKey));
    }
  });
}
