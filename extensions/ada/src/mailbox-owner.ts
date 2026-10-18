import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { noteConnectOffer } from "./connect-offers.js";
import { openAdaGoogleAccountDbFromApi } from "./google-account.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { maskNumber } from "./inbound-log.js";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import { resolveLanguage, type Language } from "./research-link-outbound.js";

const MOVED: Record<Language, string> = {
  it: "Il tuo Gmail e il tuo calendario Google sono stati scollegati: questa casella è stata collegata da un altro numero. Vuoi che ti mandi il link per ricollegarla?",
  en: "Your Gmail and Google Calendar were disconnected: this mailbox was connected from another number. Do you want me to send you the link to connect it again?",
  es: "Tu Gmail y tu Google Calendar se desconectaron: este buzón se conectó desde otro número. ¿Quieres que te envíe el enlace para volver a conectarlo?",
  fr: "Votre Gmail et votre Google Agenda ont été déconnectés : cette boîte a été connectée depuis un autre numéro. Voulez-vous que je vous envoie le lien pour la reconnecter ?",
  de: "Ihr Gmail und Ihr Google Kalender wurden getrennt: Dieses Postfach wurde von einer anderen Nummer verbunden. Soll ich Ihnen den Link zum erneuten Verbinden senden?",
};

/**
 * A mailbox has exactly one owner, so Gmail push notifications always know whose they are: the
 * number that connected it last. When `owner` connects `email`, any other number that had the
 * same mailbox connected loses it and gets one short WhatsApp note saying so.
 */
export async function releaseMailboxFromOtherOwners(
  api: Pick<OpenClawPluginApi, "runtime" | "runtimeSource" | "config" | "logger">,
  owner: string,
  email: string,
): Promise<void> {
  const mailbox = email.trim().toLowerCase();
  const db = await openAdaGoogleAccountDbFromApi(api);
  for (const other of await db.listOwners()) {
    if (other === owner || (await db.readAccount(other))?.email.trim().toLowerCase() !== mailbox) {
      continue;
    }
    await db.clearAccount(other);
    api.logger.info(`ada google mailbox moved from=${maskNumber(other)} to=${maskNumber(owner)}`);
    const profile = await (await openAdaMemoryIfExistsFromApi(api, other))?.readProfile();
    const language = await resolveLanguage("", async () => profile?.language, other);
    const sent = await sendAdaWhatsAppText({ api, to: `+${other}`, text: MOVED[language] });
    if (sent.ok) {
      noteConnectOffer(other, "google");
    } else {
      api.logger.warn(`ada mailbox moved note not sent to=${maskNumber(other)}: ${sent.error}`);
    }
  }
}
