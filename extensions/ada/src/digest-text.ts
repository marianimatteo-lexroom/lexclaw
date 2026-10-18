import type { DigestDeadlineLine, DigestPlan, RankedDigestItem } from "./digest.js";
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
  steps: string;
  hearing: string;
  deadline: string;
  by: (when: string) => string;
  inDays: (days: number) => string;
  today: string;
  tomorrow: string;
  passed: string;
  reply: (no: number) => string;
  briefReady: (no: number) => string;
  watched: string;
  moved: string;
  unsure: string;
  research: (label: string, summary: string) => string;
  draft: (label: string) => string;
  connect: (url: string) => string;
  connectSend: (url: string) => string;
};

const WORDS: Record<Language, Words> = {
  it: {
    intro: "Buongiorno. Questo non può aspettare:",
    deadlines: "Udienze e scadenze:",
    steps: "Posso fare subito:",
    hearing: "udienza",
    deadline: "scadenza",
    by: (when) => `entro ${when}`,
    inDays: (days) => `tra ${days} giorni`,
    today: "oggi",
    tomorrow: "domani",
    passed: "già passata",
    reply: (no) =>
      `Rispondi ${no} per avviare la ricerca su Lexroom, oppure "salta ${no}" per ignorarla.`,
    briefReady: (no) => `La ricerca è pronta: scrivi "brief ${no}" e te la rimando.`,
    watched: "È nella tua lista di controllo.",
    moved: "La data è cambiata.",
    unsure: "Non sono sicura della data: controlla l'atto.",
    research: (label, summary) =>
      `1. Una ricerca su Lexroom per ${label}: ${summary}. Dimmi di sì e la avvio.`,
    draft: (label) => `2. Una bozza per ${label}, solo dopo la ricerca e con il tuo ok.`,
    connect: (url) =>
      `Collega Gmail e Google Calendar così posso prepararti il riepilogo del mattino e inviare le email che mi confermi.\nApri questo link per collegare il tuo account Google:\n${url}`,
    connectSend: (url) =>
      `Posso leggere Gmail e Google Calendar, ma non ancora inviare email.\nApri questo link e consenti l'invio:\n${url}`,
  },
  en: {
    intro: "Good morning. This one should not wait:",
    deadlines: "Hearings and deadlines:",
    steps: "I can do right now:",
    hearing: "hearing",
    deadline: "deadline",
    by: (when) => `by ${when}`,
    inDays: (days) => `in ${days} days`,
    today: "today",
    tomorrow: "tomorrow",
    passed: "already passed",
    reply: (no) => `Reply ${no} to run the Lexroom research, or "skip ${no}" to dismiss it.`,
    briefReady: (no) => `The research is ready: write "brief ${no}" and I will send it again.`,
    watched: "It is on your watch list.",
    moved: "The date moved.",
    unsure: "I am not sure of the date: please check the notice.",
    research: (label, summary) =>
      `1. Lexroom research for ${label}: ${summary}. Say yes and I will start it.`,
    draft: (label) => `2. A draft for ${label}, only after the research and with your yes.`,
    connect: (url) =>
      `Connect Gmail and Google Calendar so I can prepare your morning digest and send the emails you confirm.\nOpen this link to connect your Google account:\n${url}`,
    connectSend: (url) =>
      `I can read Gmail and Google Calendar, but I cannot send email yet.\nOpen this link and approve sending:\n${url}`,
  },
  es: {
    intro: "Buenos días. Esto no puede esperar:",
    deadlines: "Audiencias y plazos:",
    steps: "Puedo hacer ahora:",
    hearing: "audiencia",
    deadline: "plazo",
    by: (when) => `hasta el ${when}`,
    inDays: (days) => `en ${days} días`,
    today: "hoy",
    tomorrow: "mañana",
    passed: "ya pasó",
    reply: (no) =>
      `Responde ${no} para iniciar la investigación en Lexroom, o "omitir ${no}" para descartarla.`,
    briefReady: (no) => `La investigación está lista: escribe "brief ${no}" y te la reenvío.`,
    watched: "Está en tu lista de seguimiento.",
    moved: "La fecha cambió.",
    unsure: "No estoy segura de la fecha: revisa la notificación.",
    research: (label, summary) =>
      `1. Una investigación en Lexroom para ${label}: ${summary}. Dime que sí y la inicio.`,
    draft: (label) =>
      `2. Un borrador para ${label}, solo después de la investigación y con tu visto bueno.`,
    connect: (url) =>
      `Conecta Gmail y Google Calendar para que pueda preparar tu resumen de la mañana y enviar los correos que me confirmes.\nAbre este enlace para conectar tu cuenta de Google:\n${url}`,
    connectSend: (url) =>
      `Puedo leer Gmail y Google Calendar, pero todavía no puedo enviar correos.\nAbre este enlace y autoriza el envío:\n${url}`,
  },
  fr: {
    intro: "Bonjour. Ceci ne peut pas attendre :",
    deadlines: "Audiences et échéances :",
    steps: "Je peux faire tout de suite :",
    hearing: "audience",
    deadline: "échéance",
    by: (when) => `d'ici le ${when}`,
    inDays: (days) => `dans ${days} jours`,
    today: "aujourd'hui",
    tomorrow: "demain",
    passed: "déjà passée",
    reply: (no) =>
      `Répondez ${no} pour lancer la recherche sur Lexroom, ou "ignorer ${no}" pour l'écarter.`,
    briefReady: (no) => `La recherche est prête : écrivez "brief ${no}" et je vous la renvoie.`,
    watched: "Elle est dans votre liste de suivi.",
    moved: "La date a changé.",
    unsure: "Je ne suis pas sûre de la date : vérifiez l'acte.",
    research: (label, summary) =>
      `1. Une recherche sur Lexroom pour ${label} : ${summary}. Dites oui et je la lance.`,
    draft: (label) =>
      `2. Un projet pour ${label}, seulement après la recherche et avec votre accord.`,
    connect: (url) =>
      `Connectez Gmail et Google Agenda pour que je puisse préparer votre résumé du matin et envoyer les e-mails que vous confirmez.\nOuvrez ce lien pour connecter votre compte Google :\n${url}`,
    connectSend: (url) =>
      `Je peux lire Gmail et Google Agenda, mais pas encore envoyer d'e-mails.\nOuvrez ce lien et autorisez l'envoi :\n${url}`,
  },
  de: {
    intro: "Guten Morgen. Das kann nicht warten:",
    deadlines: "Termine und Fristen:",
    steps: "Ich kann sofort:",
    hearing: "Termin",
    deadline: "Frist",
    by: (when) => `bis ${when}`,
    inDays: (days) => `in ${days} Tagen`,
    today: "heute",
    tomorrow: "morgen",
    passed: "bereits vorbei",
    reply: (no) =>
      `Antworten Sie ${no}, um die Lexroom-Recherche zu starten, oder "überspringen ${no}", um sie zu verwerfen.`,
    briefReady: (no) =>
      `Die Recherche ist fertig: Schreiben Sie "brief ${no}", dann sende ich sie erneut.`,
    watched: "Sie steht auf Ihrer Beobachtungsliste.",
    moved: "Das Datum hat sich geändert.",
    unsure: "Ich bin mir beim Datum nicht sicher: Bitte prüfen Sie die Mitteilung.",
    research: (label, summary) =>
      `1. Eine Lexroom-Recherche für ${label}: ${summary}. Sagen Sie ja, dann starte ich sie.`,
    draft: (label) => `2. Ein Entwurf für ${label}, erst nach der Recherche und mit Ihrem Ja.`,
    connect: (url) =>
      `Verbinden Sie Gmail und Google Kalender, damit ich Ihre Morgenübersicht vorbereiten und E-Mails senden kann, die Sie bestätigen.\nÖffnen Sie diesen Link, um Ihr Google-Konto zu verbinden:\n${url}`,
    connectSend: (url) =>
      `Ich kann Gmail und Google Kalender lesen, aber noch keine E-Mails senden.\nÖffnen Sie diesen Link und erlauben Sie das Senden:\n${url}`,
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

function itemLine(
  item: RankedDigestItem,
  words: Words,
  language: Language,
  timeZone: string,
): string {
  const due = item.dueAt ? ` (${words.by(whenLabel(item.dueAt, language, timeZone))})` : "";
  return `• ${item.matterLabel}: ${item.summary}${due}`;
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
    parts.push(words.reply(line.no));
  } else {
    parts.push(words.watched);
    parts.push(line.briefReady ? words.briefReady(line.no) : words.reply(line.no));
  }
  return parts.join(" ");
}

/** The one WhatsApp message for a ranked plan: items, deadline lines, then the two next steps. */
export function renderDigestText(
  plan: DeliverablePlan,
  language: Language,
  timeZone: string,
): string {
  const words = WORDS[language];
  const [research, draft] = plan.nextSteps;
  const blocks = [
    `${words.intro}\n${plan.items.map((item) => itemLine(item, words, language, timeZone)).join("\n")}`,
  ];
  if (plan.deadlines?.length) {
    blocks.push(
      `${words.deadlines}\n${plan.deadlines.map((line) => deadlineLine(line, words)).join("\n")}`,
    );
  }
  blocks.push(
    `${words.steps}\n${words.research(research.matterLabel, plan.items.find((item) => item.matterId === research.matterId)?.summary ?? research.instruction)}\n${words.draft(draft.matterLabel)}`,
  );
  return blocks.join("\n\n");
}

/** The Google connect ask: the link that connects this person's account, in their language. */
export function renderGoogleConnectText(
  language: Language,
  url: string,
  purpose: "connect" | "send" = "connect",
): string {
  const words = WORDS[language];
  return purpose === "send" ? words.connectSend(url) : words.connect(url);
}
