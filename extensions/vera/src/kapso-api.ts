import { VERA_WHATSAPP_CHANNEL } from "./google-notify.js";

/** Matches the Kapso WhatsApp client default. The proxy path is `/{version}/{phoneNumberId}/messages`. */
const KAPSO_GRAPH_VERSION = "v23.0";
const DEFAULT_KAPSO_BASE_URL = "https://api.kapso.ai/meta/whatsapp";
const PHONE_NUMBER_ID = /^\d{6,24}$/;

export type KapsoAccount = {
  apiKey?: string;
  phoneNumberId?: string;
  baseUrl?: string;
  enabled?: boolean;
  sendReadReceipts?: boolean;
};

export type KapsoEndpoint =
  | { ok: true; url: string; apiKey: string }
  | { ok: false; reason: "missing-credentials" }
  | { ok: false; reason: "invalid"; error: string };

export type KapsoPostResult =
  | { ok: true; response: Response }
  | { ok: false; kind: "http"; status: number }
  | { ok: false; kind: "timeout" | "network" };

/** Resolve the Kapso account for `accountId` from the channel config, falling back to env credentials. */
export function resolveKapsoAccount(
  config: unknown,
  accountId: string | undefined,
  env: NodeJS.ProcessEnv,
): KapsoAccount {
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

/** The Cloud API `/messages` URL for one resolved account. */
export function kapsoMessagesEndpoint(account: KapsoAccount): KapsoEndpoint {
  if (!account.apiKey || !account.phoneNumberId) {
    return { ok: false, reason: "missing-credentials" };
  }
  if (!PHONE_NUMBER_ID.test(account.phoneNumberId)) {
    return { ok: false, reason: "invalid", error: "kapso phoneNumberId is invalid" };
  }
  const baseUrl = normalizeKapsoBaseUrl(account.baseUrl);
  if (!baseUrl) {
    return { ok: false, reason: "invalid", error: "kapso base URL is invalid" };
  }
  return {
    ok: true,
    url: `${baseUrl}/${KAPSO_GRAPH_VERSION}/${account.phoneNumberId}/messages`,
    apiKey: account.apiKey,
  };
}

/** POST one JSON body to Kapso with a hard timeout. Never throws; the API key never appears in a result. */
export async function postKapsoMessage(params: {
  endpoint: Extract<KapsoEndpoint, { ok: true }>;
  body: unknown;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<KapsoPostResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  timeout.unref?.();
  const onAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (params.fetchImpl ?? fetch)(params.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": params.endpoint.apiKey,
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, kind: "http", status: response.status };
    }
    return { ok: true, response };
  } catch {
    const aborted = controller.signal.aborted || params.signal?.aborted === true;
    return { ok: false, kind: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", onAbort);
  }
}

function readChannelSection(config: unknown): Record<string, unknown> | undefined {
  const channels = readRecord(readRecord(config)?.channels);
  return readRecord(channels?.[VERA_WHATSAPP_CHANNEL]);
}

function readAccount(source: Record<string, unknown> | undefined): KapsoAccount {
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

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function firstString(...values: unknown[]): string | undefined {
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
