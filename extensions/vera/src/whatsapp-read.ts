import { VERA_WHATSAPP_CHANNEL } from "./google-notify.js";
import {
  firstString,
  kapsoMessagesEndpoint,
  postKapsoMessage,
  resolveKapsoAccount,
} from "./kapso-api.js";

const READ_RECEIPT_TIMEOUT_MS = 10_000;

/** Cloud API message ids. Kapso also synthesizes `{from}:{timestamp}` when the webhook has no id. */
const WHATSAPP_MESSAGE_ID = /^wamid\.[A-Za-z0-9+/_=-]{8,}$/;

export type KapsoReadReceiptResult =
  | { ok: true; skipped: "not-whatsapp" | "receipts-disabled" | "not-a-whatsapp-id" | "missing-credentials" }
  | { ok: true }
  | { ok: false; error: string };

/**
 * Ask Kapso to mark one inbound WhatsApp message read.
 * The channel plugin does not send this, so the lawyer otherwise stays on gray delivered checks.
 */
export async function markKapsoMessageRead(params: {
  config: unknown;
  channelId?: string;
  accountId?: string;
  messageId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<KapsoReadReceiptResult> {
  if (params.channelId !== VERA_WHATSAPP_CHANNEL) {
    return { ok: true, skipped: "not-whatsapp" };
  }
  const messageId = params.messageId?.trim() ?? "";
  if (!WHATSAPP_MESSAGE_ID.test(messageId)) {
    return { ok: true, skipped: "not-a-whatsapp-id" };
  }

  const account = resolveKapsoAccount(params.config, params.accountId, params.env ?? process.env);
  if (account.enabled === false || account.sendReadReceipts === false) {
    return { ok: true, skipped: "receipts-disabled" };
  }
  const endpoint = kapsoMessagesEndpoint(account);
  if (!endpoint.ok) {
    return endpoint.reason === "missing-credentials"
      ? { ok: true, skipped: "missing-credentials" }
      : { ok: false, error: endpoint.error };
  }

  const posted = await postKapsoMessage({
    endpoint,
    body: { messaging_product: "whatsapp", status: "read", message_id: messageId },
    timeoutMs: READ_RECEIPT_TIMEOUT_MS,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (posted.ok) {
    return { ok: true };
  }
  if (posted.kind === "http") {
    return { ok: false, error: `kapso read receipt returned HTTP ${posted.status}` };
  }
  return {
    ok: false,
    error: posted.kind === "timeout" ? "kapso read receipt timed out" : "kapso read receipt request failed",
  };
}

export function readInboundChannelId(
  event: { channelId?: unknown; channel?: unknown },
  ctx?: { channelId?: unknown },
): string | undefined {
  return firstString(ctx?.channelId, event.channelId, event.channel);
}

export function readInboundMessageId(
  event: { messageId?: unknown },
  ctx?: { messageId?: unknown },
): string | undefined {
  return firstString(ctx?.messageId, event.messageId);
}
