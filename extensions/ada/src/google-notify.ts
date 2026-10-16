import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { withDeadline } from "./lexroom-timeout.js";

export const ADA_WHATSAPP_CHANNEL = "kapso-whatsapp";

type TextSender = (params: {
  cfg: OpenClawPluginApi["config"];
  to: string;
  text: string;
}) => Promise<unknown>;

export type GoogleConnectedNotice = { ok: true } | { ok: false; error: string };

/**
 * WhatsApp turns a raw email address into a contact card and covers the
 * message, so the confirmation names the products and not the address.
 */
export function googleConnectedText(_email: string): string {
  return "Gmail and Calendar are connected. I can send mail when you say so.";
}

export function readAdaWhatsAppTarget(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const channels = (config as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") {
    return null;
  }
  const channel = (channels as Record<string, unknown>)[ADA_WHATSAPP_CHANNEL];
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

/**
 * Reduces a WhatsApp sender or `defaultTo` to its digits so `+39 333 0000000`,
 * `390000000000`, `whatsapp:+390000000000`, and `390000000000@s.whatsapp.net` compare
 * equal. Returns null for anything that is not a phone number (group ids, names).
 */
export function normalizeWhatsAppNumber(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const bare = value
    .trim()
    .replace(/^[A-Za-z][\w-]*:/u, "")
    .replace(/@(?:s\.whatsapp\.net|c\.us)$/iu, "")
    .trim();
  if (!/^\+?[\d\s().-]+$/u.test(bare)) {
    return null;
  }
  const digits = bare.replace(/\D/gu, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** True only when a sender is the lawyer configured as `kapso-whatsapp.defaultTo`. */
export function isConfiguredLawyerSender(config: unknown, ...senders: unknown[]): boolean {
  const lawyer = normalizeWhatsAppNumber(readAdaWhatsAppTarget(config));
  if (!lawyer) {
    return false;
  }
  return senders.some((sender) => normalizeWhatsAppNumber(sender) === lawyer);
}

export async function sendGoogleConnectedNotice(params: {
  config: OpenClawPluginApi["config"];
  email: string;
  loadAdapter: (channelId: string) => Promise<{ sendText?: TextSender } | null | undefined>;
}): Promise<GoogleConnectedNotice> {
  const to = readAdaWhatsAppTarget(params.config);
  if (!to) {
    return { ok: false, error: "kapso-whatsapp defaultTo is not set" };
  }
  let adapter: { sendText?: TextSender } | null | undefined;
  try {
    adapter = await params.loadAdapter(ADA_WHATSAPP_CHANNEL);
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

const WHATSAPP_SEND_TIMEOUT_MS = 20_000;

/**
 * One text to the configured lawyer through the Kapso channel. Never throws and never waits
 * longer than the limit: a send that hangs is reported as a failure.
 */
export async function sendAdaWhatsAppText(params: {
  api: Pick<OpenClawPluginApi, "config" | "runtime">;
  text: string;
  timeoutMs?: number;
}): Promise<GoogleConnectedNotice> {
  const to = readAdaWhatsAppTarget(params.api.config);
  if (!to) {
    return { ok: false, error: "kapso-whatsapp defaultTo is not set" };
  }
  const limitMs = params.timeoutMs ?? WHATSAPP_SEND_TIMEOUT_MS;
  try {
    return await withDeadline(
      (async (): Promise<GoogleConnectedNotice> => {
        const adapter = await params.api.runtime.channel.outbound.loadAdapter(ADA_WHATSAPP_CHANNEL);
        if (!adapter?.sendText) {
          return { ok: false, error: "kapso-whatsapp outbound is unavailable" };
        }
        await adapter.sendText({ cfg: params.api.config, to, text: params.text });
        return { ok: true };
      })(),
      limitMs,
      (): GoogleConnectedNotice => ({
        ok: false,
        error: `whatsapp send did not finish within ${Math.round(limitMs / 1000)}s`,
      }),
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "whatsapp send failed" };
  }
}
