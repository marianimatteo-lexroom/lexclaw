import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export const VERA_WHATSAPP_CHANNEL = "kapso-whatsapp";

type TextSender = (params: {
  cfg: OpenClawPluginApi["config"];
  to: string;
  text: string;
}) => Promise<unknown>;

export type GoogleConnectedNotice = { ok: true } | { ok: false; error: string };

export function googleConnectedText(email: string): string {
  const safe = email.replaceAll(/[\r\n]+/g, " ").trim();
  return `Gmail and Google Calendar are connected to Vera for ${safe}.`;
}

export function readVeraWhatsAppTarget(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const channels = (config as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") {
    return null;
  }
  const channel = (channels as Record<string, unknown>)[VERA_WHATSAPP_CHANNEL];
  if (!channel || typeof channel !== "object") {
    return null;
  }
  const defaultTo = (channel as { defaultTo?: unknown }).defaultTo;
  if (typeof defaultTo !== "string") {
    return null;
  }
  const target = defaultTo.trim();
  return target || null;
}

export async function sendGoogleConnectedNotice(params: {
  config: OpenClawPluginApi["config"];
  email: string;
  loadAdapter: (channelId: string) => Promise<{ sendText?: TextSender } | null | undefined>;
}): Promise<GoogleConnectedNotice> {
  const to = readVeraWhatsAppTarget(params.config);
  if (!to) {
    return { ok: false, error: "kapso-whatsapp defaultTo is not set" };
  }
  let adapter: { sendText?: TextSender } | null | undefined;
  try {
    adapter = await params.loadAdapter(VERA_WHATSAPP_CHANNEL);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "whatsapp outbound failed",
    };
  }
  const send = adapter?.sendText;
  if (!send) {
    return { ok: false, error: "kapso-whatsapp outbound is unavailable" };
  }
  try {
    await send({
      cfg: params.config,
      to,
      text: googleConnectedText(params.email),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "whatsapp send failed",
    };
  }
  return { ok: true };
}
