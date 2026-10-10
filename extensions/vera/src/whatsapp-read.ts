import { VERA_WHATSAPP_CHANNEL } from "./google-notify.js";

/** Matches the Kapso WhatsApp client default. The proxy path is `/{version}/{phoneNumberId}/messages`. */
const KAPSO_GRAPH_VERSION = "v23.0";
const DEFAULT_KAPSO_BASE_URL = "https://api.kapso.ai/meta/whatsapp";
const READ_RECEIPT_TIMEOUT_MS = 10_000;

/** Cloud API message ids. Kapso also synthesizes `{from}:{timestamp}` when the webhook has no id. */
const WHATSAPP_MESSAGE_ID = /^wamid\.[A-Za-z0-9+/_=-]{8,}$/;
const PHONE_NUMBER_ID = /^\d{6,24}$/;

export type KapsoReadReceiptResult =
  | { ok: true; skipped: "not-whatsapp" | "receipts-disabled" | "not-a-whatsapp-id" | "missing-credentials" }
  | { ok: true }
  | { ok: false; error: string };

type ReadAccount = {
  apiKey?: string;
  phoneNumberId?: string;
  baseUrl?: string;
  enabled?: boolean;
  sendReadReceipts?: boolean;
};

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

  const account = resolveKapsoReadAccount(params.config, params.accountId, params.env ?? process.env);
  if (account.enabled === false || account.sendReadReceipts === false) {
    return { ok: true, skipped: "receipts-disabled" };
  }
  if (!account.apiKey || !account.phoneNumberId) {
    return { ok: true, skipped: "missing-credentials" };
  }
  if (!PHONE_NUMBER_ID.test(account.phoneNumberId)) {
    return { ok: false, error: "kapso phoneNumberId is invalid" };
  }
  const baseUrl = normalizeKapsoBaseUrl(account.baseUrl);
  if (!baseUrl) {
    return { ok: false, error: "kapso base URL is invalid" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READ_RECEIPT_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (params.fetchImpl ?? fetch)(
      `${baseUrl}/${KAPSO_GRAPH_VERSION}/${account.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": account.apiKey,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return { ok: false, error: `kapso read receipt returned HTTP ${response.status}` };
    }
    return { ok: true };
  } catch {
    const aborted = controller.signal.aborted || params.signal?.aborted === true;
    return {
      ok: false,
      error: aborted ? "kapso read receipt timed out" : "kapso read receipt request failed",
    };
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", onAbort);
  }
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

function resolveKapsoReadAccount(
  config: unknown,
  accountId: string | undefined,
  env: NodeJS.ProcessEnv,
): ReadAccount {
  const section = readChannelSection(config);
  const accounts = readRecord(section?.accounts);
  const selectedId = firstString(accountId, section?.defaultAccountId) ?? "default";
  const account = readRecord(accounts?.[selectedId]);
  const merged = { ...readAccount(section), ...readAccount(account) };
  return {
    enabled: merged.enabled,
    sendReadReceipts: merged.sendReadReceipts,
    apiKey: merged.apiKey ?? firstString(env.KAPSO_API_KEY),
    phoneNumberId: merged.phoneNumberId ?? firstString(env.KAPSO_PHONE_NUMBER_ID),
    baseUrl: merged.baseUrl ?? firstString(env.KAPSO_BASE_URL) ?? DEFAULT_KAPSO_BASE_URL,
  };
}

function readChannelSection(config: unknown): Record<string, unknown> | undefined {
  const channels = readRecord(readRecord(config)?.channels);
  return readRecord(channels?.[VERA_WHATSAPP_CHANNEL]);
}

function readAccount(source: Record<string, unknown> | undefined): ReadAccount {
  if (!source) {
    return {};
  }
  return {
    ...(typeof source.enabled === "boolean" ? { enabled: source.enabled } : {}),
    ...(typeof source.sendReadReceipts === "boolean"
      ? { sendReadReceipts: source.sendReadReceipts }
      : {}),
    apiKey: firstString(source.apiKey, source.kapsoApiKey, source.token),
    phoneNumberId: firstString(source.phoneNumberId),
    baseUrl: firstString(source.baseUrl),
  };
}

function normalizeKapsoBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return value.replace(/\/+$/, "");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : "";
    if (text) {
      return text;
    }
  }
  return undefined;
}
