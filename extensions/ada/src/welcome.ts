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

const WELCOMES: Record<Language, string> = {
  it: [
    "Ciao, sono Ada, l'assistente legale di Lexroom su WhatsApp. 👋",
    "Cosa posso fare:\n• rispondere alle tue domande di diritto;\n• fare ricerche giuridiche su Lexroom in background e scriverti appena sono pronte, con il link a Lexroom e un PDF di una pagina. Collega il tuo account Lexroom: scrivimi «collega Lexroom» e ti mando il link;\n• leggere la tua posta Gmail e il tuo calendario Google, e inviare email solo dopo la tua conferma. Collega il tuo Gmail: scrivimi «collega Gmail».",
    'Ad esempio, chiedimi:\n• "Entro quanto posso fare opposizione a un decreto ingiuntivo?"\n• "Cerca la giurisprudenza sul recesso dal contratto di locazione"\n• "Cosa ho in calendario domani?"',
    "Le mie risposte non sostituiscono quelle di un avvocato. Le chat e i risultati di ogni utente restano privati.",
  ].join("\n\n"),
  en: [
    "Hi, I'm Ada, Lexroom's legal assistant on WhatsApp. 👋",
    'What I can do:\n• answer your legal questions;\n• run legal research on Lexroom in the background and message you as soon as it\'s ready, with a link to Lexroom and a one-page PDF. Connect your own Lexroom account: write "connect Lexroom" and I\'ll send you the link;\n• read your Gmail and Google Calendar, and send email only after you confirm. Connect your Gmail: write "connect Gmail".',
    'For example, ask me:\n• "How long do I have to oppose an order for payment (decreto ingiuntivo)?"\n• "Find case law on terminating a lease"\n• "What\'s on my calendar tomorrow?"',
    "My answers are not a substitute for a lawyer. Each user's chats and results stay private.",
  ].join("\n\n"),
  es: [
    "Hola, soy Ada, la asistente legal de Lexroom en WhatsApp. 👋",
    'Qué puedo hacer:\n• responder a tus preguntas jurídicas;\n• hacer investigación jurídica en Lexroom en segundo plano y escribirte en cuanto esté lista, con el enlace a Lexroom y un PDF de una página. Conecta tu cuenta de Lexroom: escríbeme "conecta Lexroom" y te mando el enlace;\n• leer tu Gmail y tu Google Calendar, y enviar correos solo después de tu confirmación. Conecta tu Gmail: escríbeme "conecta Gmail".',
    'Por ejemplo, pregúntame:\n• "¿Cuánto tiempo tengo para oponerme a un requerimiento de pago (decreto ingiuntivo)?"\n• "Busca jurisprudencia sobre la resolución de un contrato de alquiler"\n• "¿Qué tengo mañana en el calendario?"',
    "Mis respuestas no sustituyen a un abogado. Los chats y los resultados de cada usuario son privados.",
  ].join("\n\n"),
  fr: [
    "Bonjour, je suis Ada, l'assistante juridique de Lexroom sur WhatsApp. 👋",
    'Ce que je peux faire :\n• répondre à vos questions de droit ;\n• faire des recherches juridiques sur Lexroom en arrière-plan et vous écrire dès qu\'elles sont prêtes, avec le lien vers Lexroom et un PDF d\'une page. Connectez votre compte Lexroom : écrivez-moi "connecte Lexroom" et je vous envoie le lien ;\n• lire votre Gmail et votre Google Agenda, et envoyer des e-mails seulement après votre confirmation. Connectez votre Gmail : écrivez-moi "connecte Gmail".',
    'Par exemple, demandez-moi :\n• "De combien de temps dispose-t-on pour faire opposition à une injonction de payer (decreto ingiuntivo) ?"\n• "Cherche la jurisprudence sur la résiliation d\'un bail"\n• "Qu\'ai-je à l\'agenda demain ?"',
    "Mes réponses ne remplacent pas un avocat. Les conversations et les résultats de chaque utilisateur restent privés.",
  ].join("\n\n"),
  de: [
    "Hallo, ich bin Ada, die juristische Assistentin von Lexroom auf WhatsApp. 👋",
    'Was ich kann:\n• Ihre Rechtsfragen beantworten;\n• im Hintergrund juristische Recherchen in Lexroom durchführen und Ihnen schreiben, sobald sie fertig sind, mit dem Link zu Lexroom und einem einseitigen PDF. Verbinden Sie Ihr eigenes Lexroom-Konto: Schreiben Sie mir "Lexroom verbinden", dann sende ich Ihnen den Link;\n• Ihr Gmail und Ihren Google Kalender lesen und E-Mails erst nach Ihrer Bestätigung senden. Verbinden Sie Ihr Gmail: Schreiben Sie mir "Gmail verbinden".',
    'Fragen Sie mich zum Beispiel:\n• "Wie lange kann ich gegen einen Zahlungsbefehl (decreto ingiuntivo) Einspruch einlegen?"\n• "Suche Rechtsprechung zur Kündigung eines Mietvertrags"\n• "Was steht morgen in meinem Kalender?"',
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
