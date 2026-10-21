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

const GOOGLE_CONNECTED: Record<Language, { base: string; firstLook: string }> = {
  it: {
    base: "Gmail e Calendar sono collegati: posso leggerli e, con il tuo ok, inviare email.",
    firstLook: "Vuoi che guardi cosa c'è oggi in agenda e in posta?",
  },
  en: {
    base: "Gmail and Calendar are connected: I can read them and, with your yes, send email.",
    firstLook: "Want me to look at today's calendar and inbox?",
  },
  es: {
    base: "Gmail y Calendar están conectados: puedo leerlos y, con tu visto bueno, enviar correos.",
    firstLook: "¿Quieres que mire qué hay hoy en tu agenda y en tu correo?",
  },
  fr: {
    base: "Gmail et Google Agenda sont connectés : je peux les lire et, avec votre accord, envoyer des e-mails.",
    firstLook:
      "Voulez-vous que je regarde ce qu'il y a aujourd'hui à l'agenda et dans votre messagerie ?",
  },
  de: {
    base: "Gmail und Kalender sind verbunden: Ich kann sie lesen und mit Ihrem Ja E-Mails senden.",
    firstLook: "Soll ich nachsehen, was heute im Kalender und im Posteingang ansteht?",
  },
};

/**
 * WhatsApp turns a raw email address into a contact card and covers the
 * message, so the confirmation names the products and not the address.
 */
export function googleConnectedText(language: Language, firstLook = true): string {
  const text = GOOGLE_CONNECTED[language];
  return firstLook ? `${text.base} ${text.firstLook}` : text.base;
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
  /** False when the connect was for a pending request, which carries on instead of a first look. */
  firstLook?: boolean;
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
      text: googleConnectedText(
        await resolveLanguage("", undefined, params.owner),
        params.firstLook !== false,
      ),
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
