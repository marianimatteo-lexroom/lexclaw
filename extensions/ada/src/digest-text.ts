import type { DigestDeadlineLine, DigestPlan, RankedDigestItem } from "./digest.js";
import type { QuietBrief } from "./quiet-brief.js";
import type { Language } from "./research-link-outbound.js";

type DeliverablePlan = Extract<DigestPlan, { deliver: true }>;

/**
 * The digest and the Google connect ask are written by code, not by a model, because they go to
 * one specific WhatsApp number: a model turn can only be delivered to "the last chat", which
 * with many people writing to Ada is not necessarily the person the digest is for. The plan is
 * already ranked and worded by the collector, so this only lays it out, in the person's language.
 */
type Words = {
  intro: string;
  deadlines: string;
  hearing: string;
  deadline: string;
  by: (when: string) => string;
  inDays: (days: number) => string;
  today: string;
  tomorrow: string;
  passed: string;
  moved: string;
  unsure: string;
  /** Short tags on a deadline line. */
  toConfirm: string;
  researchReady: string;
  movedTag: string;
  /** Said once, after the question, when more than one item is open. */
  orPick: string;
  /** The one closing question: what Ada proposes to do first. */
  askResearch: (label: string) => string;
  askBrief: (label: string) => string;
  calendarMoved: (title: string) => string;
  calendarDue: (title: string) => string;
  newEmail: string;
  connect: (url: string) => string;
  connectSend: (url: string) => string;
  connectExpired: (url: string) => string;
  quietIntro: string;
  quietIntroAfterAlert: string;
  quietAgenda: string;
  quietNoEvents: string;
  allDay: string;
  untitled: string;
  more: (count: number) => string;
  unreadMail: (count: number, capped: boolean) => string;
};

const WORDS: Record<Language, Words> = {
  it: {
    intro: "Buongiorno. Questo non può aspettare:",
    deadlines: "Udienze e scadenze:",
    hearing: "udienza",
    deadline: "scadenza",
    by: (when) => `entro ${when}`,
    inDays: (days) => `tra ${days} giorni`,
    today: "oggi",
    tomorrow: "domani",
    passed: "già passata",
    moved: "La data è cambiata.",
    unsure: "Non sono sicura della data: controlla l'atto.",
    toConfirm: "da confermare",
    researchReady: "ricerca già pronta",
    movedTag: "data cambiata",
    askResearch: (label) => `Partirei dalla ricerca su Lexroom per ${label}: la avvio?`,
    askBrief: (label) => `Ti rimando la ricerca già pronta per ${label}?`,
    orPick: "Se preferisci un'altra voce, o saltarla, dimmelo.",
    calendarMoved: (title) => `${title}: anticipato`,
    calendarDue: (title) => `${title}: in scadenza`,
    newEmail: "Nuova email",
    connect: (url) =>
      `Collega Gmail e Google Calendar così posso prepararti il riepilogo del mattino e inviare le email che mi confermi.\nApri questo link per collegare il tuo account Google:\n${url}`,
    connectSend: (url) =>
      `Posso leggere Gmail e Google Calendar, ma non ancora inviare email.\nApri questo link e consenti l'invio:\n${url}`,
    connectExpired: (url) =>
      `Il collegamento al tuo Gmail è scaduto: ecco il link per ricollegarlo (vale 30 minuti)\n${url}`,
    quietIntro: "Buongiorno. Niente di urgente per oggi.",
    quietIntroAfterAlert: "Buongiorno. Nient'altro di nuovo da segnalare.",
    quietAgenda: "Agenda di oggi:",
    quietNoEvents: "Agenda di oggi: nessun impegno.",
    allDay: "tutto il giorno",
    untitled: "(senza titolo)",
    more: (count) => `…e altri ${count}`,
    unreadMail: (count, capped) =>
      `Posta: ${count}${capped ? "+" : ""} ${count === 1 && !capped ? "email non letta" : "email non lette"}.`,
  },
  en: {
    intro: "Good morning. This one should not wait:",
    deadlines: "Hearings and deadlines:",
    hearing: "hearing",
    deadline: "deadline",
    by: (when) => `by ${when}`,
    inDays: (days) => `in ${days} days`,
    today: "today",
    tomorrow: "tomorrow",
    passed: "already passed",
    moved: "The date moved.",
    unsure: "I am not sure of the date: please check the notice.",
    toConfirm: "to be confirmed",
    researchReady: "research already done",
    movedTag: "date changed",
    askResearch: (label) => `I'd start with the Lexroom research for ${label}. Shall I run it?`,
    askBrief: (label) => `Shall I send you the research already done for ${label}?`,
    orPick: "Tell me if you would rather take another item, or skip it.",
    calendarMoved: (title) => `${title}: moved earlier`,
    calendarDue: (title) => `${title}: due`,
    newEmail: "New email",
    connect: (url) =>
      `Connect Gmail and Google Calendar so I can prepare your morning digest and send the emails you confirm.\nOpen this link to connect your Google account:\n${url}`,
    connectSend: (url) =>
      `I can read Gmail and Google Calendar, but I cannot send email yet.\nOpen this link and approve sending:\n${url}`,
    connectExpired: (url) =>
      `The connection to your Gmail has expired: here is the link to connect it again (it is valid for 30 minutes)\n${url}`,
    quietIntro: "Good morning. Nothing urgent today.",
    quietIntroAfterAlert: "Good morning. Nothing else new to report.",
    quietAgenda: "Today's agenda:",
    quietNoEvents: "Today's agenda: nothing scheduled.",
    allDay: "all day",
    untitled: "(untitled)",
    more: (count) => `…and ${count} more`,
    unreadMail: (count, capped) =>
      `Mail: ${count}${capped ? "+" : ""} unread ${count === 1 && !capped ? "email" : "emails"}.`,
  },
  es: {
    intro: "Buenos días. Esto no puede esperar:",
    deadlines: "Audiencias y plazos:",
    hearing: "audiencia",
    deadline: "plazo",
    by: (when) => `hasta el ${when}`,
    inDays: (days) => `en ${days} días`,
    today: "hoy",
    tomorrow: "mañana",
    passed: "ya pasó",
    moved: "La fecha cambió.",
    unsure: "No estoy segura de la fecha: revisa la notificación.",
    toConfirm: "por confirmar",
    researchReady: "investigación ya lista",
    movedTag: "fecha cambiada",
    askResearch: (label) => `Empezaría por la investigación en Lexroom para ${label}: ¿la inicio?`,
    askBrief: (label) => `¿Te reenvío la investigación que ya está lista para ${label}?`,
    orPick: "Si prefieres otro punto, o omitirlo, dímelo.",
    calendarMoved: (title) => `${title}: adelantado`,
    calendarDue: (title) => `${title}: vence`,
    newEmail: "Correo nuevo",
    connect: (url) =>
      `Conecta Gmail y Google Calendar para que pueda preparar tu resumen de la mañana y enviar los correos que me confirmes.\nAbre este enlace para conectar tu cuenta de Google:\n${url}`,
    connectSend: (url) =>
      `Puedo leer Gmail y Google Calendar, pero todavía no puedo enviar correos.\nAbre este enlace y autoriza el envío:\n${url}`,
    connectExpired: (url) =>
      `La conexión con tu Gmail ha caducado: aquí tienes el enlace para volver a conectarlo (vale 30 minutos)\n${url}`,
    quietIntro: "Buenos días. Nada urgente para hoy.",
    quietIntroAfterAlert: "Buenos días. Nada más nuevo que señalar.",
    quietAgenda: "Agenda de hoy:",
    quietNoEvents: "Agenda de hoy: ningún compromiso.",
    allDay: "todo el día",
    untitled: "(sin título)",
    more: (count) => `…y ${count} más`,
    unreadMail: (count, capped) =>
      `Correo: ${count}${capped ? "+" : ""} ${count === 1 && !capped ? "correo sin leer" : "correos sin leer"}.`,
  },
  fr: {
    intro: "Bonjour. Ceci ne peut pas attendre :",
    deadlines: "Audiences et échéances :",
    hearing: "audience",
    deadline: "échéance",
    by: (when) => `d'ici le ${when}`,
    inDays: (days) => `dans ${days} jours`,
    today: "aujourd'hui",
    tomorrow: "demain",
    passed: "déjà passée",
    moved: "La date a changé.",
    unsure: "Je ne suis pas sûre de la date : vérifiez l'acte.",
    toConfirm: "à confirmer",
    researchReady: "recherche déjà prête",
    movedTag: "date modifiée",
    askResearch: (label) =>
      `Je commencerais par la recherche sur Lexroom pour ${label} : je la lance ?`,
    askBrief: (label) => `Je vous renvoie la recherche déjà prête pour ${label} ?`,
    orPick: "Si vous préférez un autre point, ou l'écarter, dites-le-moi.",
    calendarMoved: (title) => `${title} : avancé`,
    calendarDue: (title) => `${title} : échéance`,
    newEmail: "Nouvel e-mail",
    connect: (url) =>
      `Connectez Gmail et Google Agenda pour que je puisse préparer votre résumé du matin et envoyer les e-mails que vous confirmez.\nOuvrez ce lien pour connecter votre compte Google :\n${url}`,
    connectSend: (url) =>
      `Je peux lire Gmail et Google Agenda, mais pas encore envoyer d'e-mails.\nOuvrez ce lien et autorisez l'envoi :\n${url}`,
    connectExpired: (url) =>
      `La connexion à votre Gmail a expiré : voici le lien pour la reconnecter (valable 30 minutes)\n${url}`,
    quietIntro: "Bonjour. Rien d'urgent aujourd'hui.",
    quietIntroAfterAlert: "Bonjour. Rien d'autre de nouveau à signaler.",
    quietAgenda: "Agenda du jour :",
    quietNoEvents: "Agenda du jour : aucun rendez-vous.",
    allDay: "toute la journée",
    untitled: "(sans titre)",
    more: (count) => `…et ${count} autres`,
    unreadMail: (count, capped) =>
      `Courrier : ${count}${capped ? "+" : ""} ${count === 1 && !capped ? "e-mail non lu" : "e-mails non lus"}.`,
  },
  de: {
    intro: "Guten Morgen. Das kann nicht warten:",
    deadlines: "Termine und Fristen:",
    hearing: "Termin",
    deadline: "Frist",
    by: (when) => `bis ${when}`,
    inDays: (days) => `in ${days} Tagen`,
    today: "heute",
    tomorrow: "morgen",
    passed: "bereits vorbei",
    moved: "Das Datum hat sich geändert.",
    unsure: "Ich bin mir beim Datum nicht sicher: Bitte prüfen Sie die Mitteilung.",
    toConfirm: "noch zu bestätigen",
    researchReady: "Recherche liegt vor",
    movedTag: "Datum geändert",
    askResearch: (label) =>
      `Ich würde mit der Lexroom-Recherche zu ${label} beginnen: Soll ich sie starten?`,
    askBrief: (label) =>
      `Soll ich Ihnen die bereits fertige Recherche zu ${label} noch einmal senden?`,
    orPick:
      "Wenn Sie lieber einen anderen Punkt nehmen oder ihn überspringen möchten, sagen Sie es mir.",
    calendarMoved: (title) => `${title}: vorverlegt`,
    calendarDue: (title) => `${title}: fällig`,
    newEmail: "Neue E-Mail",
    connect: (url) =>
      `Verbinden Sie Gmail und Google Kalender, damit ich Ihre Morgenübersicht vorbereiten und E-Mails senden kann, die Sie bestätigen.\nÖffnen Sie diesen Link, um Ihr Google-Konto zu verbinden:\n${url}`,
    connectSend: (url) =>
      `Ich kann Gmail und Google Kalender lesen, aber noch keine E-Mails senden.\nÖffnen Sie diesen Link und erlauben Sie das Senden:\n${url}`,
    connectExpired: (url) =>
      `Die Verbindung zu Ihrem Gmail ist abgelaufen: Hier ist der Link zum erneuten Verbinden (30 Minuten gültig)\n${url}`,
    quietIntro: "Guten Morgen. Heute nichts Dringendes.",
    quietIntroAfterAlert: "Guten Morgen. Sonst nichts Neues zu melden.",
    quietAgenda: "Termine heute:",
    quietNoEvents: "Termine heute: keine.",
    allDay: "ganztägig",
    untitled: "(ohne Titel)",
    more: (count) => `…und ${count} weitere`,
    unreadMail: (count, capped) =>
      `Post: ${count}${capped ? "+" : ""} ungelesene ${count === 1 && !capped ? "E-Mail" : "E-Mails"}.`,
  },
};

const LOCALES: Record<Language, string> = {
  it: "it-IT",
  en: "en-GB",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
};

function whenLabel(iso: string, language: Language, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(LOCALES[language], {
    timeZone,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

function capitalized(text: string): string {
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`;
}

/** What an item says, in the person's language: a stored plan without `phrase` keeps its summary. */
function itemText(item: RankedDigestItem, words: Words): { text: string; tags: string[] } {
  const phrase = item.phrase;
  if (!phrase) {
    return { text: item.summary, tags: [] };
  }
  switch (phrase.id) {
    case "calendar_moved":
      return { text: words.calendarMoved(phrase.text), tags: [] };
    case "calendar_due":
      return { text: words.calendarDue(phrase.text), tags: [] };
    case "new_email":
      return { text: words.newEmail, tags: [] };
    case "tracked_deadline": {
      const kind = phrase.type === "hearing" ? words.hearing : words.deadline;
      return {
        text: `${kind} ${phrase.due}: ${phrase.title}`,
        tags: [
          ...(phrase.confirm ? [words.toConfirm] : []),
          ...(phrase.moved ? [words.movedTag] : []),
        ],
      };
    }
  }
}

function itemLine(
  item: RankedDigestItem,
  words: Words,
  language: Language,
  timeZone: string,
): string {
  const { text, tags } = itemText(item, words);
  const details = [
    ...tags,
    ...(item.dueAt ? [words.by(whenLabel(item.dueAt, language, timeZone))] : []),
  ];
  return `• ${item.matterLabel}: ${text}${details.length ? ` (${details.join(", ")})` : ""}`;
}

function daysLabel(days: number, words: Words): string {
  if (days < 0) {
    return words.passed;
  }
  if (days === 0) {
    return words.today;
  }
  return days === 1 ? words.tomorrow : words.inDays(days);
}

function deadlineLine(line: DigestDeadlineLine, words: Words): string {
  const kind = line.type === "hearing" ? words.hearing : words.deadline;
  const parts = [
    `${line.no}. ${line.matterLabel}: ${kind} ${line.due} (${daysLabel(line.daysLeft, words)}).`,
  ];
  if (line.moved) {
    parts.push(words.moved);
  }
  if (line.confidence < 0.75) {
    parts.push(words.unsure);
  }
  if (line.status === "candidate") {
    parts.push(`${capitalized(words.toConfirm)}.`);
  } else if (line.briefReady) {
    parts.push(`${capitalized(words.researchReady)}.`);
  }
  return parts.join(" ");
}

/** The deadline line of the top research target when its brief is already stored: the closing question resends it. */
function storedBriefLine(plan: DeliverablePlan): DigestDeadlineLine | undefined {
  const [research] = plan.nextSteps;
  return plan.deadlines?.find(
    (line) => line.matterId === research.matterId && line.status === "tracked" && line.briefReady,
  );
}

/**
 * The one WhatsApp message for a ranked plan: the items, the numbered deadlines, then a single
 * closing question that proposes the first step. How to answer is not spelled out per line: the
 * model reads a natural reply against the note `digestOfferDetail` leaves for it.
 */
export function renderDigestText(
  plan: DeliverablePlan,
  language: Language,
  timeZone: string,
): string {
  const words = WORDS[language];
  const [research] = plan.nextSteps;
  const blocks = [
    `${words.intro}\n${plan.items.map((item) => itemLine(item, words, language, timeZone)).join("\n")}`,
  ];
  if (plan.deadlines?.length) {
    blocks.push(
      `${words.deadlines}\n${plan.deadlines.map((line) => deadlineLine(line, words)).join("\n")}`,
    );
  }
  const stored = storedBriefLine(plan);
  const open = new Set([
    ...plan.items.map((item) => item.matterId),
    ...(plan.deadlines ?? []).map((line) => line.matterId),
  ]);
  const ask = stored
    ? words.askBrief(research.matterLabel)
    : words.askResearch(research.matterLabel);
  blocks.push(open.size > 1 ? `${ask} ${words.orPick}` : ask);
  return blocks.join("\n\n");
}

const QUIET_EVENTS_MAX = 6;

/**
 * The morning brief for a quiet day: one short message with the agenda, unread mail and the
 * hearings and deadlines coming up, and no offers to reply to.
 */
export function renderQuietBriefText(brief: QuietBrief, language: Language): string {
  const words = WORDS[language];
  const blocks = [brief.alertedToday ? words.quietIntroAfterAlert : words.quietIntro];
  if (brief.events.length === 0) {
    blocks.push(words.quietNoEvents);
  } else {
    const shown = brief.events.slice(0, QUIET_EVENTS_MAX).map((event) => {
      const when = event.time ?? words.allDay;
      return `• ${when} ${event.summary || words.untitled}`;
    });
    if (brief.events.length > QUIET_EVENTS_MAX) {
      shown.push(`• ${words.more(brief.events.length - QUIET_EVENTS_MAX)}`);
    }
    blocks.push(`${words.quietAgenda}\n${shown.join("\n")}`);
  }
  if (brief.unreadMail > 0) {
    blocks.push(
      [
        words.unreadMail(brief.unreadMail, brief.unreadMailCapped),
        ...brief.mailHighlights.map((mail) => `• ${mail.matter}: ${mail.subject}`),
      ].join("\n"),
    );
  }
  if (brief.deadlines.length > 0) {
    const lines = brief.deadlines.map((line) => {
      const kind = line.type === "hearing" ? words.hearing : words.deadline;
      return `• ${line.matter}: ${kind} ${line.due} (${daysLabel(line.daysLeft, words)})`;
    });
    blocks.push(`${words.deadlines}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

const OFFER_LABEL_MAX = 80;
const OFFER_DEADLINES_MAX = 10;

/**
 * What the digest above offered, for the note the model reads when the person answers it, since
 * the model never sees the digest itself: the research the closing question proposed, the draft
 * that may follow it, and every numbered item with the action it can take.
 */
export function digestOfferDetail(plan: DeliverablePlan): string {
  const label = (text: string) => text.trim().slice(0, OFFER_LABEL_MAX);
  const [research, draft] = plan.nextSteps;
  const stored = storedBriefLine(plan);
  const lines = [
    stored
      ? `  - the closing question: sending the stored brief of ${label(research.matterLabel)} again; a bare yes means ada_deadline_reply with brief for item ${stored.no}, not a new research`
      : `  - the closing question: a Lexroom research for ${label(research.matterLabel)}; a bare yes starts it`,
    `  - not offered in the message: after a research, a draft for ${label(draft.matterLabel)}, only with their ok`,
  ];
  for (const line of (plan.deadlines ?? []).slice(0, OFFER_DEADLINES_MAX)) {
    const offered =
      line.status === "candidate"
        ? "marked to be confirmed: confirming it means ada_deadline_reply with track (confirm tracking only, no research); research only when they ask for it"
        : line.briefReady
          ? "send the stored brief again (ada_deadline_reply with brief)"
          : "start the Lexroom research (ada_deadline_reply with research)";
    lines.push(
      `  - item ${line.no}: ${label(line.matterLabel)}, ${line.type} ${line.due}; offered: ${offered}, or skip it`,
    );
  }
  return lines.join("\n");
}

/** The Google connect ask: the link that connects this person's account, in their language. */
export function renderGoogleConnectText(
  language: Language,
  url: string,
  purpose: "connect" | "send" | "expired" = "connect",
): string {
  const words = WORDS[language];
  return purpose === "send"
    ? words.connectSend(url)
    : purpose === "expired"
      ? words.connectExpired(url)
      : words.connect(url);
}
