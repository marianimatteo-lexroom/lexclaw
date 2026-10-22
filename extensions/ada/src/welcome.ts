import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readAdaEnv } from "./ada-env.js";
import { noteConnectOffer } from "./connect-offers.js";
import { readDeadlineIntakeConfig } from "./deadline-intake.js";
import {
  ADA_WHATSAPP_CHANNEL,
  isConfiguredLawyerSender,
  sendAdaWhatsAppText,
} from "./google-notify.js";
import { logInboundSkip, maskNumber } from "./inbound-log.js";
import { openAdaRegistryFromApi } from "./memory.js";
import { outlookEnabled } from "./outlook-oauth.js";
import { detectLanguage, type Language } from "./research-link-outbound.js";
import { senderNumber } from "./research-push.js";
import { mirrorToSessionKey } from "./transcript-mirror.js";
import { normalizeWhatsAppNumber } from "./whatsapp-number.js";

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

type WelcomeCopy = {
  intro: string;
  legal: string;
  /** The mail and calendar bullet, with the provider list as its argument. */
  mail: (providers: string) => string;
  providers: { gmail: string; gmailOutlook: string };
  notes: string;
  reminders: string;
  privacy: string;
  question: string;
};

/**
 * Each welcome is short and in the first person: who Ada is, what she can do in a few bullets
 * (legal questions and Lexroom research, mail and calendar, Granola notes, and deadline reminders
 * when deadline intake is on), one line on accounts and the standing disclaimer, and one closing
 * question that starts the conversation. Outlook is named only when it is available.
 */
const WELCOMES: Record<Language, WelcomeCopy> = {
  it: {
    intro: "Sono Ada, l'assistente legale di Lexroom su WhatsApp. Posso:",
    legal: "rispondere a domande giuridiche e fare ricerche su Lexroom",
    mail: (providers) => `leggere la tua posta (${providers}) e il calendario`,
    providers: { gmail: "Gmail", gmailOutlook: "Gmail o Outlook" },
    notes: "consultare le note delle tue riunioni su Granola",
    reminders: "ricordarti udienze e scadenze",
    privacy:
      "I tuoi account li collego solo quando serve, e le mie risposte non sostituiscono quelle di un avvocato. Le chat di ognuno restano private.",
    question: "Su cosa stai lavorando adesso?",
  },
  en: {
    intro: "I'm Ada, Lexroom's legal assistant on WhatsApp. I can:",
    legal: "answer legal questions and run research on Lexroom",
    mail: (providers) => `read your email (${providers}) and calendar`,
    providers: { gmail: "Gmail", gmailOutlook: "Gmail or Outlook" },
    notes: "look through your meeting notes in Granola",
    reminders: "remind you of hearings and deadlines",
    privacy:
      "I only connect your accounts when it's needed, and my answers don't replace a lawyer. Everyone's chats stay private.",
    question: "What's on your plate right now?",
  },
  es: {
    intro: "Soy Ada, la asistente legal de Lexroom en WhatsApp. Puedo:",
    legal: "responder preguntas jurídicas y hacer investigaciones en Lexroom",
    mail: (providers) => `leer tu correo (${providers}) y tu calendario`,
    providers: { gmail: "Gmail", gmailOutlook: "Gmail u Outlook" },
    notes: "consultar las notas de tus reuniones en Granola",
    reminders: "recordarte audiencias y plazos",
    privacy:
      "Solo conecto tus cuentas cuando hace falta, y mis respuestas no sustituyen a un abogado. Los chats de cada usuario son privados.",
    question: "¿En qué estás trabajando ahora mismo?",
  },
  fr: {
    intro: "Je suis Ada, l'assistante juridique de Lexroom sur WhatsApp. Je peux :",
    legal: "répondre à des questions juridiques et faire des recherches sur Lexroom",
    mail: (providers) => `lire votre messagerie (${providers}) et votre agenda`,
    providers: { gmail: "Gmail", gmailOutlook: "Gmail ou Outlook" },
    notes: "consulter les notes de vos réunions dans Granola",
    reminders: "vous rappeler audiences et échéances",
    privacy:
      "Je ne connecte vos comptes que lorsque c'est nécessaire, et mes réponses ne remplacent pas un avocat. Les conversations de chaque utilisateur restent privées.",
    question: "Sur quoi travaillez-vous en ce moment ?",
  },
  de: {
    intro: "Ich bin Ada, die juristische Assistentin von Lexroom auf WhatsApp. Ich kann:",
    legal: "Rechtsfragen beantworten und Recherchen in Lexroom durchführen",
    mail: (providers) => `Ihre E-Mails (${providers}) und Ihren Kalender lesen`,
    providers: { gmail: "Gmail", gmailOutlook: "Gmail oder Outlook" },
    notes: "Ihre Besprechungsnotizen in Granola durchsehen",
    reminders: "Sie an Termine und Fristen erinnern",
    privacy:
      "Ihre Konten verbinde ich nur, wenn es nötig ist, und meine Antworten ersetzen keinen Anwalt. Die Chats jedes Nutzers bleiben privat.",
    question: "Woran arbeiten Sie gerade?",
  },
};

/** What this deployment can actually do, so the welcome promises nothing Ada cannot deliver. */
export type WelcomeFeatures = {
  /** Outlook can be connected (`outlookEnabled`). */
  outlook: boolean;
  /** Deadline intake, and with it the hearing and deadline reminders, is on. */
  reminders: boolean;
  /** End with the closing question: only when the welcome is the whole answer to a bare greeting. */
  question: boolean;
};

export function welcomeText(language: Language, features: WelcomeFeatures): string {
  const copy = WELCOMES[language];
  const bullets = [
    copy.legal,
    copy.mail(features.outlook ? copy.providers.gmailOutlook : copy.providers.gmail),
    copy.notes,
    ...(features.reminders ? [copy.reminders] : []),
  ];
  return [
    `${copy.intro}\n${bullets.map((bullet) => `• ${bullet}`).join("\n")}`,
    copy.privacy,
    ...(features.question ? [copy.question] : []),
  ].join("\n\n");
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
      const welcome = welcomeText(language, {
        outlook: outlookEnabled(),
        reminders: readDeadlineIntakeConfig(api.pluginConfig).enabled,
        question: greeting !== undefined,
      });
      const sent = await sendAdaWhatsAppText({ api, to: `+${number}`, text: welcome });
      if (!sent.ok) {
        await memory.releaseWelcome(number);
        api.logger.warn(`ada welcome not sent sender=${maskNumber(number)}: ${sent.error}`);
        return undefined;
      }
      api.logger.info(
        `ada welcome sent sender=${maskNumber(number)} language=${language} greeting=${greeting !== undefined}`,
      );
      const sessionKey = ctx.sessionKey ?? event.sessionKey;
      if (sessionKey) {
        // A first message may not have a session yet; then there is nothing to write into.
        await mirrorToSessionKey(api, sessionKey, welcome, `ada-welcome:${number}`).catch(
          () => false,
        );
      }
      if (greeting === undefined) {
        return undefined;
      }
      noteConnectOffer(number, "welcome_question");
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
