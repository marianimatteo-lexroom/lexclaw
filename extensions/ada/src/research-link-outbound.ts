import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { logInboundSkip } from "./inbound-log.js";
import { lexroomLogger } from "./lexroom-log.js";
import { sessionKeyOwner, toOwner } from "./owner.js";
import { stripTrailingSignature } from "./signature.js";

/**
 * The link to a research in the Lexroom app is added to the reply by code, not by the model: a
 * link the model has to remember is a link that goes missing. A link becomes ready when a
 * research result reaches the model (the finished job read through `ada_research_status`, or a
 * deadline brief), and the next final reply that does not already carry it gets it appended.
 * Links are kept in this process only and expire, so one never lands on an unrelated message
 * later.
 */
const READY_TTL_MS = 30 * 60 * 1000;
const MAX_READY = 20;

/** Links waiting for the next reply, by the WhatsApp number whose research they belong to. */
const ready = new Map<string, Map<string, number>>();

/** A research result with this link has just been handed to the model for `owner`. */
export function markResearchLinkReady(url: string, owner: string, nowMs = Date.now()): void {
  const links = ready.get(owner) ?? new Map<string, number>();
  links.delete(url);
  links.set(url, nowMs);
  if (links.size > MAX_READY) {
    links.delete(links.keys().next().value ?? url);
  }
  ready.set(owner, links);
}

/**
 * The ready links of `owner` that `text` does not carry yet. Every one of that owner's ready links
 * is consumed: one that is already in the text needs nothing, and one that is returned is about
 * to be appended. Another number's links are never touched, so a reply never carries them.
 */
export function takeResearchLinks(text: string, owner: string, nowMs = Date.now()): string[] {
  const links = ready.get(owner);
  if (!links) {
    return [];
  }
  const missing: string[] = [];
  for (const [url, markedAtMs] of links) {
    if (nowMs - markedAtMs <= READY_TTL_MS && !text.includes(url)) {
      missing.push(url);
    }
  }
  ready.delete(owner);
  return missing;
}

export type Language = "it" | "en" | "es" | "fr" | "de";

const LABELS: Record<Language, string> = {
  it: "Continua su Lexroom:",
  en: "Continue in Lexroom:",
  es: "Continúa en Lexroom:",
  fr: "Continuez sur Lexroom :",
  de: "Weiterlesen in Lexroom:",
};

const STOPWORDS: Record<Language, ReadonlySet<string>> = {
  it: new Set(
    "il lo la le gli di che per con non della delle sono è un una nel alla dei del come anche più si ha".split(
      " ",
    ),
  ),
  en: new Set("the and of to is are for with that this in on not be you it as was by".split(" ")),
  es: new Set("el los las de que para con no es una por del se como más lo su".split(" ")),
  fr: new Set("le les des de que pour avec pas est une dans du et sur qui au".split(" ")),
  de: new Set("der die das und nicht ist mit für ein eine den dem von zu auf im".split(" ")),
};

/**
 * Words that settle the language of a short message, where the stopwords above rarely match: a
 * request such as "give me a new link" has none of them. Only words that belong to one of the
 * five languages are listed, so a hit is evidence and an ambiguous word ("no", "me", "ok") is not.
 */
const SHORT_HINTS: Record<Language, ReadonlySet<string>> = {
  it: new Set(
    "e ciao buongiorno buonasera grazie sì voglio vorrei mandami dammi fammi dimmi nuovo nuova nuovi quando domani oggi vai certo perfetto ricerca puoi ti chi ecco avvocato fai controlla prepara scrivi inviami aggiorna ricordami leggi riassumi traduci perché tribunale udienza ufficio arrivo ritardo bocca lupo atto appello prima contratto sentenza giudice fascicolo scadenza ricorso".split(
      " ",
    ),
  ),
  en: new Set(
    "give new run now please thanks thank yes my what how can could would send show want need hello hi again today tomorrow morning your do does when who why where am there have has some about from just get let tell".split(
      " ",
    ),
  ),
  es: new Set(
    "hola gracias quiero dame envía envia enviar nuevo enlace ahora puedes qué cómo mañana hoy sí necesito dime buscar correo usted tengo está estoy".split(
      " ",
    ),
  ),
  fr: new Set(
    "bonjour merci voudrais veux nouveau maintenant peux pouvez demain oui je moi donne envoie plaît vous aujourd hui très être était".split(
      " ",
    ),
  ),
  de: new Set(
    "hallo danke bitte ich mir neu neue neuen neuer jetzt kannst kann gib ja nein heute morgen wie wann möchte brauche schick schicke mein meine mich habe zeig".split(
      " ",
    ),
  ),
};

/**
 * Everyday words of each language that are not evidence of it but exist in it ("in", "do" and "il"
 * are Italian, "has" is Spanish, "on" is French, "am" is German). They are never counted, and they
 * make any stopword or hint of another language that spells the same ambiguous.
 */
const EVERYDAY_WORDS: Record<Language, ReadonlySet<string>> = {
  it: new Set(
    "in do a da su ma se mi ci vi lo la le gli un uno al del nel col dal sul tra fra no si ho hai ha è me te ne so corte".split(
      " ",
    ),
  ),
  en: new Set(
    "a an in on at do me we he so no to be by it is as or if my us am go up of".split(" "),
  ),
  es: new Set(
    "a de en el la lo me mi no se si te un una y o es su al del con por para he has ha cerca corte causa decreto cosa cliente prima".split(
      " ",
    ),
  ),
  fr: new Set("a de en le la un une me ne ni on ou se si te tu y du et est il elle au".split(" ")),
  de: new Set("in im am an da so ob wo zu es er du die der das was".split(" ")),
};

const LANGUAGES = Object.keys(STOPWORDS) as Language[];

const wordsOf = (language: Language): string[] => [
  ...STOPWORDS[language],
  ...SHORT_HINTS[language],
  ...EVERYDAY_WORDS[language],
];

/** Words that belong to more than one supported language, so say nothing about a short message. */
const AMBIGUOUS_WORDS: ReadonlySet<string> = (() => {
  const seen = new Map<string, number>();
  for (const language of LANGUAGES) {
    for (const word of new Set(wordsOf(language))) {
      seen.set(word, (seen.get(word) ?? 0) + 1);
    }
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([word]) => word));
})();

const SHORT_MESSAGE_WORDS = 10;

/**
 * The language of a text; undefined when it is too short or too neutral to tell ("ok", a link, an
 * emoji, a case citation). A long text is told by its stopwords. A short message has too few of
 * them, so its hint words count as well, but only those no other supported language also uses.
 */
export function detectLanguage(text: string): Language | undefined {
  const words =
    text
      .slice(0, 3000)
      .toLowerCase()
      .replace(/\be-?mail/gu, "email")
      .match(/[\p{L}]+/gu) ?? [];
  const short = words.length <= SHORT_MESSAGE_WORDS;
  const scores = LANGUAGES.map((language) => ({
    language,
    score: words.filter((word) =>
      short
        ? !AMBIGUOUS_WORDS.has(word) &&
          (STOPWORDS[language].has(word) || SHORT_HINTS[language].has(word))
        : STOPWORDS[language].has(word),
    ).length,
  })).toSorted((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (!best) {
    return undefined;
  }
  const margin = best.score - (second?.score ?? 0);
  return (short ? best.score >= 1 && margin >= 1 : best.score >= 3 && margin >= 2)
    ? best.language
    : undefined;
}

export function languageFromProfile(value: string | undefined): Language | undefined {
  const text = value?.trim().toLowerCase() ?? "";
  if (/^(it|ital)/u.test(text)) {
    return "it";
  }
  if (/^(en|engl)/u.test(text)) {
    return "en";
  }
  if (/^(es|spa|espa)/u.test(text)) {
    return "es";
  }
  if (/^(fr|fran)/u.test(text)) {
    return "fr";
  }
  if (/^(de|ger|deu)/u.test(text)) {
    return "de";
  }
  return undefined;
}

/** `<label> <url>` in `language`, the line the lawyer taps to keep reading in the Lexroom app. */
export function researchLinkLine(language: Language, url: string): string {
  return `${LABELS[language]} ${url}`;
}

const MAX_TRACKED_LANGUAGES = 1000;

/** The language of each number's latest message that carried one. In memory, like the other per-number state. */
const inboundLanguages = new Map<string, Language>();

/**
 * A number wrote `text`. Its language becomes the one every code-sent message to that number uses,
 * until a later message says otherwise. A message that does not carry a language ("ok", a link,
 * an emoji) leaves the previous one in place instead of flipping it.
 */
export function recordInboundLanguage(owner: string, text: string): void {
  const language = detectLanguage(text.replace(/https?:\/\/\S+/giu, " "));
  if (!language) {
    return;
  }
  inboundLanguages.delete(owner);
  inboundLanguages.set(owner, language);
  if (inboundLanguages.size > MAX_TRACKED_LANGUAGES) {
    inboundLanguages.delete(inboundLanguages.keys().next().value ?? owner);
  }
}

/** The language `owner` last wrote in, if this process saw it. */
export function inboundLanguage(owner: string): Language | undefined {
  return inboundLanguages.get(owner);
}

/** Forgets every tracked language. For tests: this state is shared by the whole process. */
export function clearInboundLanguages(): void {
  inboundLanguages.clear();
}

/**
 * The language a message to `owner` is written in: the language of their latest message when
 * known, else (a restart, or a number that never wrote) the words of `text`, then the saved
 * profile language, then Italian. A failed profile read never fails the caller.
 */
export async function resolveLanguage(
  text: string,
  readProfileLanguage?: () => Promise<string | undefined>,
  owner?: string,
): Promise<Language> {
  const known = owner ? inboundLanguage(owner) : undefined;
  if (known) {
    return known;
  }
  const detected = detectLanguage(text);
  if (detected) {
    return detected;
  }
  try {
    return languageFromProfile(await readProfileLanguage?.()) ?? "it";
  } catch {
    return "it";
  }
}

/**
 * `text` with one link line per missing research link, in the language of the reply. The text is
 * returned unchanged when there is nothing to add.
 */
export async function withResearchLinks(
  text: string,
  options: {
    /** The number the reply goes to; without one nothing is appended. */
    owner: string | null;
    readProfileLanguage?: () => Promise<string | undefined>;
    nowMs?: number;
  },
): Promise<string> {
  const urls = options.owner ? takeResearchLinks(text, options.owner, options.nowMs) : [];
  if (urls.length === 0) {
    return text;
  }
  const language = await resolveLanguage(
    text,
    options.readProfileLanguage,
    options.owner ?? undefined,
  );
  return `${text.trimEnd()}\n\n${urls.map((url) => researchLinkLine(language, url)).join("\n")}`;
}

/**
 * The host's own words for a tool-only turn that ended with no text, in English only. They are
 * about the run, not the person's question, so they are never sent as they are.
 */
export function isInternalFallbackText(text: string): boolean {
  return /^\s*the tool run finished, but no final summary was produced\b/iu.test(text);
}

const NO_SUMMARY: Record<Language, string> = {
  it: "Ho completato l'operazione ma non ho un riepilogo da mostrarti. Scrivimi se vuoi i dettagli.",
  en: "I finished the task but have no summary to show. Write to me if you want the details.",
  es: "Terminé la tarea pero no tengo un resumen que mostrarte. Escríbeme si quieres los detalles.",
  fr: "J'ai terminé la tâche mais je n'ai pas de résumé à te montrer. Écris-moi si tu veux les détails.",
  de: "Ich habe die Aufgabe abgeschlossen, habe aber keine Zusammenfassung. Schreib mir, wenn du Details möchtest.",
};

const MAX_ANSWERED_RUNS = 500;

/**
 * Appends the research link to the final reply. `reply_payload_sending` is the owner; if the
 * host has never run it, `message_sending` takes over, because that one also sees blocks and
 * must not be used once the final payload is available.
 */
export function registerResearchLinkHooks(
  api: Pick<OpenClawPluginApi, "on" | "logger">,
  readProfileLanguage?: (owner: string) => Promise<string | undefined>,
  /** True while a Lexroom research for the number will deliver its answer itself. */
  researchActive?: (owner: string) => boolean,
): void {
  const log = lexroomLogger(api.logger);
  let payloadHookRuns = false;
  /** Runs that already sent the person some text, so an empty ending adds nothing. */
  const answeredRuns = new Set<string>();
  const noteAnswered = (runId: string | undefined) => {
    if (runId) {
      answeredRuns.delete(runId);
      answeredRuns.add(runId);
      if (answeredRuns.size > MAX_ANSWERED_RUNS) {
        answeredRuns.delete(answeredRuns.values().next().value ?? runId);
      }
    }
  };
  /**
   * What replaces the host's no-summary text: nothing when the answer already went out or a
   * research will deliver it, otherwise a short line in the person's language.
   */
  const internalFallback = async (
    owner: string | null,
    runId: string | undefined,
  ): Promise<string | null> => {
    if ((runId && answeredRuns.has(runId)) || (owner && researchActive?.(owner))) {
      return null;
    }
    const language = await resolveLanguage(
      "",
      owner && readProfileLanguage ? () => readProfileLanguage(owner) : undefined,
      owner ?? undefined,
    );
    return NO_SUMMARY[language];
  };
  /** The number a reply goes to: its own session, else the conversation or recipient. */
  const ownerOf = (
    ctx: { sessionKey?: string; conversationId?: string } | undefined,
    to?: string,
  ) => sessionKeyOwner(ctx?.sessionKey) ?? toOwner(ctx?.conversationId) ?? toOwner(to);
  const append = async (text: string, owner: string | null, via: string): Promise<string> => {
    const next = await withResearchLinks(text, {
      owner,
      readProfileLanguage:
        owner && readProfileLanguage ? () => readProfileLanguage(owner) : undefined,
    });
    if (next !== text) {
      log("link.appended", { via });
    }
    return next;
  };

  api.on("reply_payload_sending", async (event, ctx) => {
    payloadHookRuns = true;
    const text = event.payload.text;
    if (typeof text === "string" && isInternalFallbackText(text)) {
      const owner = ownerOf(ctx);
      logInboundSkip(api.logger, {
        stage: "reply",
        reason: "internal_fallback_text",
        sender: ctx?.sessionKey ? ctx.sessionKey.split(":") : undefined,
      });
      const fallback = await internalFallback(owner, event.runId ?? ctx?.runId);
      return fallback === null
        ? { cancel: true, reason: "internal_fallback_text" }
        : { payload: { ...event.payload, text: fallback } };
    }
    if (typeof text === "string" && text.trim() && text.trim() !== "NO_REPLY") {
      noteAnswered(event.runId ?? ctx?.runId);
    }
    if (event.kind === "final" && typeof text === "string" && text.trim() === "NO_REPLY") {
      logInboundSkip(api.logger, {
        stage: "reply",
        reason: "model_answered_no_reply",
        sender: ctx?.sessionKey ? ctx.sessionKey.split(":") : undefined,
      });
    }
    if (
      event.kind !== "final" ||
      typeof text !== "string" ||
      !text.trim() ||
      text.trim() === "NO_REPLY"
    ) {
      return undefined;
    }
    const next = await append(stripTrailingSignature(text), ownerOf(ctx), "reply_payload_sending");
    return next === text ? undefined : { payload: { ...event.payload, text: next } };
  });

  api.on("message_sending", async (event, ctx) => {
    if (isInternalFallbackText(event.content)) {
      const fallback = await internalFallback(ownerOf(ctx, event.to), ctx?.runId);
      return fallback === null ? { cancel: true } : { content: fallback };
    }
    if (payloadHookRuns || !event.content.trim() || event.content.trim() === "NO_REPLY") {
      return undefined;
    }
    const next = await append(
      stripTrailingSignature(event.content),
      ownerOf(ctx, event.to),
      "message_sending",
    );
    return next === event.content ? undefined : { content: next };
  });
}
