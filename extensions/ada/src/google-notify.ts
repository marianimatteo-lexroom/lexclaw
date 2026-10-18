import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { withDeadline } from "./lexroom-timeout.js";
import { resolveLanguage, type Language } from "./research-link-outbound.js";
import {
  ADA_WHATSAPP_CHANNEL,
  normalizeWhatsAppNumber,
  readAdaWhatsAppTarget,
} from "./whatsapp-number.js";

export { ADA_WHATSAPP_CHANNEL, normalizeWhatsAppNumber, readAdaWhatsAppTarget };

type TextSender = (params: {
  cfg: OpenClawPluginApi["config"];
  to: string;
  text: string;
}) => Promise<unknown>;

export type GoogleConnectedNotice = { ok: true } | { ok: false; error: string };

const GOOGLE_CONNECTED: Record<Language, string> = {
  it: "Gmail e Calendar sono collegati. Posso inviare email quando me lo chiedi.",
  en: "Gmail and Calendar are connected. I can send mail when you say so.",
  es: "Gmail y Calendar están conectados. Puedo enviar correos cuando me lo pidas.",
  fr: "Gmail et Google Agenda sont connectés. Je peux envoyer des e-mails quand vous me le demandez.",
  de: "Gmail und Kalender sind verbunden. Ich kann E-Mails senden, wenn Sie es mir sagen.",
};

/**
 * WhatsApp turns a raw email address into a contact card and covers the
 * message, so the confirmation names the products and not the address.
 */
export function googleConnectedText(language: Language): string {
  return GOOGLE_CONNECTED[language];
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
  /** The WhatsApp number that connected the account; the confirmation goes to it alone. */
  owner: string;
  email: string;
  loadAdapter: (channelId: string) => Promise<{ sendText?: TextSender } | null | undefined>;
}): Promise<GoogleConnectedNotice> {
  const to = `+${params.owner}`;
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
      text: googleConnectedText(await resolveLanguage("", undefined, params.owner)),
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
 * One text through the Kapso channel to `to`.
 * Never throws and never waits longer than the limit: a send that hangs is reported as a failure.
 */
export async function sendAdaWhatsAppText(params: {
  api: Pick<OpenClawPluginApi, "config" | "runtime">;
  text: string;
  /** The recipient. There is no default: a send always names the number it is for. */
  to: string;
  timeoutMs?: number;
}): Promise<GoogleConnectedNotice> {
  const { to } = params;
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
