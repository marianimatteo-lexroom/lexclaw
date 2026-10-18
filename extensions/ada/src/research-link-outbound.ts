import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { logInboundSkip } from "./inbound-log.js";
import { lexroomLogger } from "./lexroom-log.js";
import { sessionKeyOwner, toOwner } from "./owner.js";

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

/** The language of a reply by its stopwords; undefined when the text is too short to tell. */
export function detectLanguage(text: string): Language | undefined {
  const words =
    text
      .slice(0, 3000)
      .toLowerCase()
      .match(/[\p{L}]+/gu) ?? [];
  const scores = (Object.keys(STOPWORDS) as Language[])
    .map((language) => ({
      language,
      score: words.filter((word) => STOPWORDS[language].has(word)).length,
    }))
    .toSorted((a, b) => b.score - a.score);
  const [best, second] = scores;
  return best && best.score >= 3 && best.score >= (second?.score ?? 0) + 2
    ? best.language
    : undefined;
}

function languageFromProfile(value: string | undefined): Language | undefined {
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

/**
 * The language of a message: its own words when there are enough of them, else the lawyer's
 * profile language, else Italian. A failed profile read never fails the caller.
 */
export async function resolveLanguage(
  text: string,
  readProfileLanguage?: () => Promise<string | undefined>,
): Promise<Language> {
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
  const language = await resolveLanguage(text, options.readProfileLanguage);
  return `${text.trimEnd()}\n\n${urls.map((url) => researchLinkLine(language, url)).join("\n")}`;
}

/**
 * Appends the research link to the final reply. `reply_payload_sending` is the owner; if the
 * host has never run it, `message_sending` takes over, because that one also sees blocks and
 * must not be used once the final payload is available.
 */
export function registerResearchLinkHooks(
  api: Pick<OpenClawPluginApi, "on" | "logger">,
  readProfileLanguage?: (owner: string) => Promise<string | undefined>,
): void {
  const log = lexroomLogger(api.logger);
  let payloadHookRuns = false;
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
    const next = await append(text, ownerOf(ctx), "reply_payload_sending");
    return next === text ? undefined : { payload: { ...event.payload, text: next } };
  });

  api.on("message_sending", async (event, ctx) => {
    if (payloadHookRuns || !event.content.trim() || event.content.trim() === "NO_REPLY") {
      return undefined;
    }
    const next = await append(event.content, ownerOf(ctx, event.to), "message_sending");
    return next === event.content ? undefined : { content: next };
  });
}
