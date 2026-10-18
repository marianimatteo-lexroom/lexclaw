import {
  ADA_WHATSAPP_CHANNEL,
  normalizeWhatsAppNumber,
  readAdaWhatsAppTarget,
} from "./whatsapp-number.js";

/**
 * Every account, memory and delivery in Ada belongs to one WhatsApp number, written as its
 * digits (E.164 without the plus). It always comes from the host's trusted sender, never from a
 * tool argument or the model, and a number that is not a plain phone number is not an owner.
 */
export type Owner = string;

const OWNER = /^\d{7,15}$/u;

export function isOwner(value: unknown): value is Owner {
  return typeof value === "string" && OWNER.test(value);
}

export function toOwner(value: unknown): Owner | null {
  return normalizeWhatsAppNumber(value);
}

/** The configured lawyer (`channels["kapso-whatsapp"].defaultTo`): the owner of the legacy data. */
export function lawyerOwner(config: unknown): Owner | null {
  return toOwner(readAdaWhatsAppTarget(config));
}

export type OwnerRefusal = "no_sender" | "other_channel" | "group_chat" | "session_mismatch";

export type OwnerResolution = { ok: true; owner: Owner } | { ok: false; reason: OwnerRefusal };

/** What the host says about the turn: set by the runtime, not by tool arguments. */
export type TrustedTurn = {
  requesterSenderId?: string;
  messageChannel?: string;
  nativeChannelId?: string;
  sessionKey?: string;
};

const DIRECT_SESSION_SEGMENT = "direct";

/** The number a direct-chat session key names (`agent:main:kapso-whatsapp:direct:<number>`). */
export function sessionKeyOwner(sessionKey: string | undefined): Owner | null {
  const parts = sessionKey?.split(":") ?? [];
  const at = parts.lastIndexOf(DIRECT_SESSION_SEGMENT);
  return at >= 0 ? toOwner(parts[at + 1]) : null;
}

const GROUP_SESSION_SEGMENTS = new Set(["group", "channel"]);

/**
 * The one owner a tool call may act for: the sender of the current private WhatsApp chat, from the
 * trusted sender id, the session key, or both when they agree. There is no default and no
 * fallback to any other account: a group chat, another channel, a missing sender or a sender that
 * contradicts its own session is refused.
 */
export function resolveTurnOwner(turn: TrustedTurn): OwnerResolution {
  if (turn.messageChannel !== undefined && turn.messageChannel !== ADA_WHATSAPP_CHANNEL) {
    return { ok: false, reason: "other_channel" };
  }
  const parts = turn.sessionKey?.split(":") ?? [];
  if (
    /@g\.us$/iu.test(turn.nativeChannelId?.trim() ?? "") ||
    parts.some((part) => GROUP_SESSION_SEGMENTS.has(part))
  ) {
    return { ok: false, reason: "group_chat" };
  }
  const sender = toOwner(turn.requesterSenderId);
  const fromSession = sessionKeyOwner(turn.sessionKey);
  if (sender && fromSession && sender !== fromSession) {
    return { ok: false, reason: "session_mismatch" };
  }
  const owner = sender ?? fromSession;
  return owner ? { ok: true, owner } : { ok: false, reason: "no_sender" };
}

/** The person-facing text for a refused owner, for tool results the model relays. */
export function ownerRefusalMessage(reason: OwnerRefusal): string {
  return reason === "group_chat"
    ? "Accounts are only used in a private WhatsApp chat with their owner, never in a group. Ask the person to write to Ada directly."
    : "Ada could not tell which WhatsApp number is asking, so no account was used. Ask the person to write to Ada in a private WhatsApp chat.";
}
