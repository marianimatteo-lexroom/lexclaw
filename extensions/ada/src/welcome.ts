import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readAdaEnv } from "./ada-env.js";
import {
  ADA_WHATSAPP_CHANNEL,
  isConfiguredLawyerSender,
  normalizeWhatsAppNumber,
  sendAdaWhatsAppText,
} from "./google-notify.js";
import { logInboundSkip, maskNumber } from "./inbound-log.js";
import { openAdaRegistryFromApi } from "./memory.js";
import { detectLanguage, type Language } from "./research-link-outbound.js";
import { senderNumber } from "./research-push.js";

/**
 * The first time a WhatsApp number writes to Ada she gets one fixed welcome, sent by code before
 * any model turn: the same words every time, and no model cost. A message that is only a
 * greeting ends there; any other message is answered normally right after the welcome.
 *
 * The "already welcomed" marker is a row in Ada's memory database on the state volume, claimed
 * before the send so two messages that arrive together cannot both welcome. A number that
 * already has a conversation with Ada is marked without being welcomed, and the configured
 * lawyer is never welcomed.
 */

/**
 * Each welcome opens with the text of the approved Meta template `ada_welcome` (without its
 * "reply to start" line, since this one is itself a reply), then a few example questions, one line
 * on connecting an account when it is needed, and the standing disclaimer.
 */
const WELCOMES: Record<Language, string> = {
  it: [
    "Ti diamo il benvenuto su Ada, l'assistente legale di Lexroom su WhatsApp. Puoi farle domande giuridiche, chiederle una ricerca su Lexroom e collegare Gmail e Calendar per gestire posta, appuntamenti e scadenze.",
    'Ad esempio, chiedimi:\n• "Entro quanto posso fare opposizione a un decreto ingiuntivo?"\n• "Cerca la giurisprudenza sul recesso dal contratto di locazione"\n• "Cosa ho in calendario domani?"',
    "Per le ricerche su Lexroom serve il tuo account Lexroom: quando mi servirà ti chiederò se vuoi collegarlo e ti manderò il link.",
    "Le mie risposte non sostituiscono quelle di un avvocato. Le chat e i risultati di ogni utente restano privati.",
  ].join("\n\n"),
  en: [
    "Welcome to Ada, Lexroom's legal assistant on WhatsApp. You can ask her legal questions, have her run research on Lexroom, and connect Gmail and Calendar so she can manage your email, meetings and deadlines.",
    'For example, ask me:\n• "How long do I have to oppose an order for payment (decreto ingiuntivo)?"\n• "Find case law on terminating a lease"\n• "What\'s on my calendar tomorrow?"',
    "Research on Lexroom needs your own Lexroom account: when I need it, I'll ask whether you want to connect it and send you the link.",
    "My answers are not a substitute for a lawyer. Each user's chats and results stay private.",
  ].join("\n\n"),
  es: [
    "Te damos la bienvenida a Ada, la asistente legal de Lexroom en WhatsApp. Puedes hacerle preguntas jurídicas, pedirle una investigación en Lexroom y conectar Gmail y Calendar para que gestione tu correo, tus citas y tus plazos.",
    'Por ejemplo, pregúntame:\n• "¿Cuánto tiempo tengo para oponerme a un requerimiento de pago (decreto ingiuntivo)?"\n• "Busca jurisprudencia sobre la resolución de un contrato de alquiler"\n• "¿Qué tengo mañana en el calendario?"',
    "Para la investigación en Lexroom hace falta tu cuenta de Lexroom: cuando la necesite, te preguntaré si quieres conectarla y te enviaré el enlace.",
    "Mis respuestas no sustituyen a un abogado. Los chats y los resultados de cada usuario son privados.",
  ].join("\n\n"),
  fr: [
    "Bienvenue sur Ada, l'assistante juridique de Lexroom sur WhatsApp. Vous pouvez lui poser des questions juridiques, lui demander une recherche sur Lexroom et connecter Gmail et Calendar pour qu'elle gère votre messagerie, vos rendez-vous et vos échéances.",
    'Par exemple, demandez-moi :\n• "De combien de temps dispose-t-on pour faire opposition à une injonction de payer (decreto ingiuntivo) ?"\n• "Cherche la jurisprudence sur la résiliation d\'un bail"\n• "Qu\'ai-je à l\'agenda demain ?"',
    "Pour les recherches sur Lexroom, il faut votre compte Lexroom : quand j'en aurai besoin, je vous demanderai si vous voulez le connecter et je vous enverrai le lien.",
    "Mes réponses ne remplacent pas un avocat. Les conversations et les résultats de chaque utilisateur restent privés.",
  ].join("\n\n"),
  de: [
    "Willkommen bei Ada, der juristischen Assistentin von Lexroom auf WhatsApp. Sie können ihr Rechtsfragen stellen, sie mit einer Recherche in Lexroom beauftragen und Gmail und Calendar verbinden, damit sie Ihre E-Mails, Termine und Fristen verwaltet.",
    'Fragen Sie mich zum Beispiel:\n• "Wie lange kann ich gegen einen Zahlungsbefehl (decreto ingiuntivo) Einspruch einlegen?"\n• "Suche Rechtsprechung zur Kündigung eines Mietvertrags"\n• "Was steht morgen in meinem Kalender?"',
    "Für Recherchen in Lexroom brauche ich Ihr Lexroom-Konto: Wenn es nötig ist, frage ich Sie, ob ich es verbinden soll, und sende Ihnen den Link.",
    "Meine Antworten ersetzen keinen Anwalt. Die Chats und Ergebnisse jedes Nutzers bleiben privat.",
  ].join("\n\n"),
};

export function welcomeText(language: Language): string {
  return WELCOMES[language];
}

/** `ADA_WELCOME_ENABLED=false` (or 0, off, no) turns the welcome off; it is on by default. */
export function welcomeEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(false|0|off|no)$/iu.test(readAdaEnv(env, "WELCOME_ENABLED")?.trim() ?? "");
}

/** Words that open a greeting, each with the language it is in. */
const GREETING_HEADS: Record<string, Language> = {
  ciao: "it",
  salve: "it",
  buongiorno: "it",
  buonasera: "it",
  buondi: "it",
  buon: "it",
  hi: "en",
  hello: "en",
  hey: "en",
  hiya: "en",
  good: "en",
  greetings: "en",
  hola: "es",
  buenas: "es",
  buenos: "es",
  bonjour: "fr",
  bonsoir: "fr",
  salut: "fr",
  coucou: "fr",
  hallo: "de",
  guten: "de",
  servus: "de",
  moin: "de",
};

/** Words that may follow a greeting head without making the message a question. */
const GREETING_TAILS = new Set(
  "ada giorno pomeriggio sera dias tardes noches morning afternoon evening tag morgen abend".split(
    " ",
  ),
);

const MAX_GREETING_WORDS = 5;

/**
 * The language of a message that is only a greeting ("Ciao Ada", "buongiorno!", "hey ada"), and
 * undefined for anything that carries more than that. Case, accents, punctuation and emoji do
 * not matter.
 */
export function greetingLanguage(text: string): Language | undefined {
  const words =
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0 || words.length > MAX_GREETING_WORDS) {
    return undefined;
  }
  const head = words.find((word) => GREETING_HEADS[word]);
  const onlyGreeting = words.every((word) => GREETING_HEADS[word] || GREETING_TAILS.has(word));
  return head && onlyGreeting ? GREETING_HEADS[head] : undefined;
}

/**
 * A session that existed before this message is earlier conversation. The host may already have
 * created the session for the message being handled, so a very recent one does not count.
 */
const SESSION_GRACE_MS = 60_000;

function sessionKeyNamesNumber(sessionKey: string, number: string): boolean {
  return sessionKey.split(":").some((part) => normalizeWhatsAppNumber(part) === number);
}

/**
 * Whether this number already talked to Ada. Only a session of its own can say so, which the
 * deployment's `session.dmScope: "per-channel-peer"` provides: with the host default `main`
 * every DM shares one session that names nobody, so it proves nothing about a single number.
 */
async function hasEarlierConversation(
  api: Pick<OpenClawPluginApi, "runtime">,
  number: string,
  sessionKey: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!sessionKey || !sessionKeyNamesNumber(sessionKey, number)) {
    return false;
  }
  const { session } = api.runtime.agent;
  const entry = await (
    session.getSessionEntryAsync ?? ((params) => session.getSessionEntry(params))
  )({ sessionKey });
  const startedAtMs = entry?.createdAt ?? entry?.sessionStartedAt ?? entry?.updatedAt;
  return startedAtMs !== undefined && startedAtMs < nowMs - SESSION_GRACE_MS;
}

export function registerWelcomeHook(
  api: OpenClawPluginApi,
  options: {
    /** The message was a greeting and the welcome answered it, so no model turn will follow. */
    onGreetingAnswered?: (sessionKey: string | undefined) => void;
  } = {},
): void {
  api.on("before_dispatch", async (event, ctx) => {
    const channelId = ctx.channelId ?? event.channel;
    const skip = (reason: string) => {
      logInboundSkip(api.logger, {
        stage: "welcome",
        reason,
        sender: [ctx.senderId, event.senderId],
        messageId: event.messageId ?? ctx.messageId,
      });
      return undefined;
    };
    if (channelId !== ADA_WHATSAPP_CHANNEL) {
      return skip("not_whatsapp_channel");
    }
    if (event.isGroup) {
      return skip("group_chat");
    }
    if (!welcomeEnabled(process.env)) {
      return skip("welcome_disabled");
    }
    const number = senderNumber(ctx.senderId, event.senderId);
    if (!number) {
      return skip("sender_not_a_phone_number");
    }
    if (isConfiguredLawyerSender(api.config, number)) {
      return skip("configured_lawyer");
    }
    const nowMs = Date.now();
    try {
      const memory = await openAdaRegistryFromApi(api);
      if (await hasEarlierConversation(api, number, ctx.sessionKey ?? event.sessionKey, nowMs)) {
        await memory.claimWelcome(number, nowMs);
        return skip("earlier_conversation");
      }
      if (!(await memory.claimWelcome(number, nowMs))) {
        return skip("already_welcomed");
      }
      const text = event.content ?? event.body ?? "";
      const greeting = greetingLanguage(text);
      const language = greeting ?? detectLanguage(text) ?? "it";
      const sent = await sendAdaWhatsAppText({
        api,
        to: `+${number}`,
        text: welcomeText(language),
      });
      if (!sent.ok) {
        await memory.releaseWelcome(number);
        api.logger.warn(`ada welcome not sent sender=${maskNumber(number)}: ${sent.error}`);
        return undefined;
      }
      api.logger.info(
        `ada welcome sent sender=${maskNumber(number)} language=${language} greeting=${greeting !== undefined}`,
      );
      if (greeting === undefined) {
        return undefined;
      }
      options.onGreetingAnswered?.(ctx.sessionKey ?? event.sessionKey);
      return { handled: true };
    } catch (error) {
      api.logger.error(
        `ada welcome failed sender=${maskNumber(number)}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return undefined;
    }
  });
}
