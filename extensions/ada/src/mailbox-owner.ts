import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openAdaGoogleAccountDbFromApi } from "./google-account.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { maskNumber } from "./inbound-log.js";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import { resolveLanguage, type Language } from "./research-link-outbound.js";

const MOVED: Record<Language, string> = {
  it: "Il tuo Gmail e il tuo calendario Google sono stati scollegati: questa casella è stata collegata da un altro numero. Per ricollegarla scrivimi «collega Gmail».",
  en: 'Your Gmail and Google Calendar were disconnected: this mailbox was connected from another number. To connect it again write "connect Gmail".',
  es: 'Tu Gmail y tu Google Calendar se desconectaron: este buzón se conectó desde otro número. Para volver a conectarlo escríbeme "conecta Gmail".',
  fr: 'Votre Gmail et votre Google Agenda ont été déconnectés : cette boîte a été connectée depuis un autre numéro. Pour la reconnecter, écrivez-moi "connecte Gmail".',
  de: 'Ihr Gmail und Ihr Google Kalender wurden getrennt: Dieses Postfach wurde von einer anderen Nummer verbunden. Zum erneuten Verbinden schreiben Sie mir "Gmail verbinden".',
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
    const language = await resolveLanguage("", async () => profile?.language);
    const sent = await sendAdaWhatsAppText({ api, to: `+${other}`, text: MOVED[language] });
    if (!sent.ok) {
      api.logger.warn(`ada mailbox moved note not sent to=${maskNumber(other)}: ${sent.error}`);
    }
  }
}
