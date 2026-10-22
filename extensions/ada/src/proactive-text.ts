import { whenLabel } from "./digest-text.js";
import type { PrepNotice, Reminder, ThreadWatch } from "./proactive-store.js";
import type { Language } from "./research-link-outbound.js";

/**
 * What Ada writes, in code, when something she was asked to watch for is ready: a reminder, the
 * reply to a mail she sent, the recap before a hearing. The words around the facts are written
 * per language at send time, in the language of the person's latest message; the facts (the
 * reminder text, the subject) stay as the person or the sender wrote them.
 */
type Words = {
  reminder: string;
  /** A reminder delivered late says when it was meant to come. */
  reminderLate: (when: string) => string;
  replied: (from: string, subject: string) => string;
  repliedNext: string;
  prepIntro: (title: string, when: string) => string;
  prepDeadlines: string;
  prepTodos: string;
  prepMails: string;
  hearing: string;
  deadline: string;
};

const WORDS: Record<Language, Words> = {
  it: {
    reminder: "Promemoria",
    reminderLate: (when) => `Promemoria (era per il ${when})`,
    replied: (from, subject) => `${from} ha risposto a «${subject}»`,
    repliedNext: "Vuoi che prepari una risposta?",
    prepIntro: (title, when) => `Tra poco, ${when}: ${title}.`,
    prepDeadlines: "Scadenze e udienze:",
    prepTodos: "Da fare:",
    prepMails: "Ultime email:",
    hearing: "udienza",
    deadline: "scadenza",
  },
  en: {
    reminder: "Reminder",
    reminderLate: (when) => `Reminder (it was for ${when})`,
    replied: (from, subject) => `${from} replied to "${subject}"`,
    repliedNext: "Want me to draft a reply?",
    prepIntro: (title, when) => `Coming up, ${when}: ${title}.`,
    prepDeadlines: "Deadlines and hearings:",
    prepTodos: "To do:",
    prepMails: "Latest emails:",
    hearing: "hearing",
    deadline: "deadline",
  },
  es: {
    reminder: "Recordatorio",
    reminderLate: (when) => `Recordatorio (era para el ${when})`,
    replied: (from, subject) => `${from} ha respondido a «${subject}»`,
    repliedNext: "¿Quieres que prepare una respuesta?",
    prepIntro: (title, when) => `En breve, ${when}: ${title}.`,
    prepDeadlines: "Plazos y audiencias:",
    prepTodos: "Pendiente:",
    prepMails: "Últimos correos:",
    hearing: "audiencia",
    deadline: "plazo",
  },
  fr: {
    reminder: "Rappel",
    reminderLate: (when) => `Rappel (prévu pour le ${when})`,
    replied: (from, subject) => `${from} a répondu à « ${subject} »`,
    repliedNext: "Voulez-vous que je prépare une réponse ?",
    prepIntro: (title, when) => `Bientôt, ${when} : ${title}.`,
    prepDeadlines: "Échéances et audiences :",
    prepTodos: "À faire :",
    prepMails: "Derniers e-mails :",
    hearing: "audience",
    deadline: "échéance",
  },
  de: {
    reminder: "Erinnerung",
    reminderLate: (when) => `Erinnerung (gedacht für ${when})`,
    replied: (from, subject) => `${from} hat auf „${subject}“ geantwortet`,
    repliedNext: "Soll ich eine Antwort vorbereiten?",
    prepIntro: (title, when) => `Gleich, ${when}: ${title}.`,
    prepDeadlines: "Fristen und Termine:",
    prepTodos: "Zu tun:",
    prepMails: "Letzte E-Mails:",
    hearing: "Termin",
    deadline: "Frist",
  },
};

/** A reminder this much later than its time says when it was meant to come. */
const LATE_MS = 30 * 60 * 1000;
const SNIPPET_CHARS = 200;

const flat = (value: string) => value.replace(/\s+/gu, " ").trim();

/** `Name <address>` shows as the name, a bare address as itself. */
function senderName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]*>\s*$/u.exec(from);
  return flat(named?.[1] ?? from) || from;
}

function clip(value: string, max: number): string {
  const text = flat(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function reminderLine(
  reminder: Reminder,
  words: Words,
  language: Language,
  timeZone: string,
  nowMs: number,
) {
  const head =
    nowMs - reminder.dueAtMs > LATE_MS
      ? words.reminderLate(whenLabel(new Date(reminder.dueAtMs).toISOString(), language, timeZone))
      : words.reminder;
  return `${head}: ${reminder.text}`;
}

function replyLine(watch: ThreadWatch, words: Words): string {
  const reply = watch.reply;
  const head = words.replied(
    senderName(reply?.from || watch.to),
    clip(reply?.subject || watch.subject, 80),
  );
  return reply?.snippet ? `${head}: ${clip(reply.snippet, SNIPPET_CHARS)}` : head;
}

function prepBlock(prep: PrepNotice, words: Words, language: Language, timeZone: string): string {
  const lines = [
    words.prepIntro(
      prep.matterLabel ? `${prep.title} (${prep.matterLabel})` : prep.title,
      whenLabel(new Date(prep.startMs).toISOString(), language, timeZone),
    ),
  ];
  const { deadlines, todos, mails } = prep.facts;
  if (deadlines.length > 0) {
    lines.push(
      words.prepDeadlines,
      ...deadlines.map(
        (item) =>
          `• ${item.type === "hearing" ? words.hearing : words.deadline} ${item.due}: ${item.title}`,
      ),
    );
  }
  if (todos.length > 0) {
    lines.push(words.prepTodos, ...todos.map((todo) => `• ${todo}`));
  }
  if (mails.length > 0) {
    lines.push(words.prepMails, ...mails.map((mail) => `• ${mail}`));
  }
  return lines.join("\n");
}

export type ReadyNotices = { reminders: Reminder[]; replies: ThreadWatch[]; preps: PrepNotice[] };

/** One WhatsApp message for everything that is ready for a number: several items are batched. */
export function renderReadyNotices(
  notices: ReadyNotices,
  language: Language,
  timeZone: string,
  nowMs: number,
): string {
  const words = WORDS[language];
  const blocks = notices.preps.map((prep) => prepBlock(prep, words, language, timeZone));
  const reminders = notices.reminders.map((reminder) =>
    reminderLine(reminder, words, language, timeZone, nowMs),
  );
  if (reminders.length > 0) {
    blocks.push(reminders.join("\n"));
  }
  const replies = notices.replies.map((watch) => replyLine(watch, words));
  if (replies.length > 0) {
    blocks.push(replies.join("\n"), words.repliedNext);
  }
  return blocks.join("\n\n");
}
