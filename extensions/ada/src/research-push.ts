import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runCollectExclusive } from "./collect-lock.js";
import { whatsappWindowOpen } from "./collector.js";
import {
  noteConnectOffer,
  noteResearchResult,
  type ConnectOfferKind,
  type ResearchResultNote,
} from "./connect-offers.js";
import { ADA_WHATSAPP_CHANNEL, sendAdaWhatsAppText } from "./google-notify.js";
import { logInboundSkip } from "./inbound-log.js";
import { sendKapsoPdf } from "./kapso-document.js";
import { formatSources } from "./lexroom-citations.js";
import type { LexroomFailure, ResearchOutcome } from "./lexroom-client.js";
import { lexroomLogger, type LexroomLog } from "./lexroom-log.js";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import { claimRequestTemplate } from "./proactive-store.js";
import { researchLinkLine, resolveLanguage, type Language } from "./research-link-outbound.js";
import { buildResearchPdf, type ResearchPdf } from "./research-pdf.js";
import { mirrorSentText } from "./transcript-mirror.js";
import { normalizeWhatsAppNumber } from "./whatsapp-number.js";
import { sendRequestReadyNotice } from "./whatsapp-template.js";

/**
 * A research takes a minute or two, so Ada does not hold the chat turn for it. When the lawyer
 * asks for one, code tells them at once that it runs in the background, and when it ends code
 * sends the answer as a new WhatsApp message, with the sources and the link to the Lexroom app.
 * Nothing here depends on the model remembering to do either.
 *
 * Every message goes to the WhatsApp number that asked, and to no one else. A free-text message
 * only reaches someone inside WhatsApp's 24-hour window, which is tracked per number from their
 * last inbound message. When their window is known to be closed, or a send fails twice, the
 * result is held in this process under their number, the pre-approved template asks them to
 * write, and their next message releases it.
 *
 * A finished research also gets a one-page PDF, sent as a WhatsApp document right after the text
 * and only to the same number. It is an extra: if it cannot be built or sent, the text has
 * already gone out, a warning is logged, and the delivery is unaffected.
 */
/**
 * WhatsApp's text body holds at most 4096 characters. Counting is by UTF-16 code unit, which is
 * never fewer than WhatsApp's own count of characters, so an emoji (two units) is counted at its
 * widest; the margin covers anything the Kapso layer adds.
 */
export const RESEARCH_TEXT_LIMIT = 4096 - 96;
const RETRY_DELAY_MS = 2000;
const MAX_HELD = 5;
const HELD_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_FAILURE_CHARS = 300;

type SendResult = { ok: true } | { ok: false; error: string };

export type PushDeps = {
  /** The digits of the number every message goes to. */
  recipient: string;
  send: (text: string) => Promise<SendResult>;
  /** Sends a PDF as a WhatsApp document; absent when the recipient cannot be sent documents. */
  sendDocument?: (document: ResearchPdf) => Promise<SendResult>;
  /** Whether the recipient's 24-hour window is open; null when Ada has no inbound from them. */
  windowOpen: () => Promise<boolean | null>;
  /** The ready-template nudge that asks the recipient to write, or why it was not sent. */
  nudge: () => Promise<"sent" | "unset" | "failed" | "skipped">;
  readProfileLanguage?: () => Promise<string | undefined>;
  /** The delivered message asked the person whether to (re)connect Lexroom; remember it for their next turn. */
  offerConnect?: (kind: ConnectOfferKind) => void;
  /** A finished research reached the person with a next-step question; remember what it answered. */
  noteResult?: (note: ResearchResultNote) => void;
  /** Writes a delivered result into the person's conversation, so a follow-up reaches a model that has read it. */
  mirror?: (text: string, jobId: string) => Promise<unknown>;
  log: LexroomLog;
  now?: () => number;
  retryDelayMs?: number;
};

type Strings = {
  ack: string;
  sources: string;
  /** The one closing question of a finished research. */
  next: string;
  failed: string;
  timeout: string;
  notConnected: string;
  refused: string;
  captcha: string;
  retry: string;
};

const STRINGS: Record<Language, Strings> = {
  it: {
    ack: "Ho avviato la ricerca su Lexroom. Va avanti in background e ci vorrà circa un minuto o due: ti scrivo io appena è pronta.",
    sources: "Fonti",
    next: "Vuoi che ne tragga una bozza?",
    failed: "La ricerca su Lexroom non è andata a buon fine.",
    timeout: "Lexroom non ha risposto in tempo e la richiesta è stata interrotta.",
    notConnected:
      "Lexroom non è ancora collegato al tuo numero: vuoi che ti mandi il link per collegarlo?",
    refused:
      "Lexroom ha rifiutato l'accesso per questo account. Vuoi che ti mandi un nuovo link per ricollegarlo?",
    captcha:
      "Lexroom ha chiesto un captcha (controllo anti-bot) che non posso risolvere. Riprova più tardi, oppure accedi prima su app.lexroom.ai.",
    retry: "Dimmi se vuoi che riprovi.",
  },
  en: {
    ack: "I've started the research on Lexroom. It runs in the background and takes a minute or two: I'll message you as soon as it's ready.",
    sources: "Sources",
    next: "Want me to turn this into a draft?",
    failed: "The Lexroom research did not complete.",
    timeout: "Lexroom did not respond in time and the request was abandoned.",
    notConnected:
      "Lexroom is not connected to your number yet: do you want me to send you the link to connect it?",
    refused:
      "Lexroom refused the sign-in for this account. Do you want me to send you a new link to reconnect it?",
    captcha:
      "Lexroom asked for a captcha (bot check) that I cannot solve. Try again later, or sign in on app.lexroom.ai first.",
    retry: "Tell me if you want me to try again.",
  },
  es: {
    ack: "He iniciado la investigación en Lexroom. Sigue en segundo plano y tarda uno o dos minutos: te escribo en cuanto esté lista.",
    sources: "Fuentes",
    next: "¿Quieres que prepare un borrador a partir de esto?",
    failed: "La investigación en Lexroom no se completó.",
    timeout: "Lexroom no respondió a tiempo y la solicitud se interrumpió.",
    notConnected:
      "Lexroom todavía no está conectado a tu número: ¿quieres que te envíe el enlace para conectarlo?",
    refused:
      "Lexroom rechazó el inicio de sesión de esta cuenta. ¿Quieres que te envíe un enlace nuevo para reconectarlo?",
    captcha:
      "Lexroom pidió un captcha (control anti-bot) que no puedo resolver. Inténtalo más tarde, o inicia sesión antes en app.lexroom.ai.",
    retry: "Dime si quieres que lo intente de nuevo.",
  },
  fr: {
    ack: "J'ai lancé la recherche sur Lexroom. Elle tourne en arrière-plan et prend une à deux minutes : je vous écris dès qu'elle est prête.",
    sources: "Sources",
    next: "Voulez-vous que j'en tire un brouillon ?",
    failed: "La recherche sur Lexroom n'a pas abouti.",
    timeout: "Lexroom n'a pas répondu à temps et la demande a été interrompue.",
    notConnected:
      "Lexroom n'est pas encore connecté à votre numéro : voulez-vous que je vous envoie le lien pour le connecter ?",
    refused:
      "Lexroom a refusé la connexion pour ce compte. Voulez-vous que je vous envoie un nouveau lien pour le reconnecter ?",
    captcha:
      "Lexroom a demandé un captcha (contrôle anti-bot) que je ne peux pas résoudre. Réessayez plus tard, ou connectez-vous d'abord sur app.lexroom.ai.",
    retry: "Dites-moi si vous voulez que je réessaie.",
  },
  de: {
    ack: "Ich habe die Recherche in Lexroom gestartet. Sie läuft im Hintergrund und dauert ein bis zwei Minuten: Ich melde mich, sobald sie fertig ist.",
    sources: "Quellen",
    next: "Soll ich daraus einen Entwurf erstellen?",
    failed: "Die Lexroom-Recherche ist nicht abgeschlossen worden.",
    timeout: "Lexroom hat nicht rechtzeitig geantwortet und die Anfrage wurde abgebrochen.",
    notConnected:
      "Lexroom ist noch nicht mit Ihrer Nummer verbunden: Soll ich Ihnen den Link zum Verbinden senden?",
    refused:
      "Lexroom hat die Anmeldung für dieses Konto abgelehnt. Soll ich Ihnen einen neuen Link zum erneuten Verbinden senden?",
    captcha:
      "Lexroom hat ein Captcha (Bot-Prüfung) verlangt, das ich nicht lösen kann. Versuchen Sie es später noch einmal oder melden Sie sich zuerst auf app.lexroom.ai an.",
    retry: "Sagen Sie mir, wenn ich es noch einmal versuchen soll.",
  },
};

export function researchAckText(language: Language): string {
  return STRINGS[language].ack;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * `text` cut to at most `max` characters, ending in an ellipsis: at a paragraph, else a sentence,
 * else a word boundary, and never between the two halves of an emoji.
 */
function cutAtBoundary(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const budget = Math.max(0, max - 1);
  const head = text.slice(0, isHighSurrogate(text.charCodeAt(budget - 1)) ? budget - 1 : budget);
  const paragraph = head.lastIndexOf("\n\n");
  let sentence = -1;
  for (let i = head.length - 1; i > 0 && sentence < 0; i -= 1) {
    if (".!?".includes(head.charAt(i)) && /\s/u.test(text.charAt(i + 1))) {
      sentence = i + 1;
    }
  }
  const word = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  const at =
    paragraph >= head.length * 0.4
      ? paragraph
      : sentence >= head.length * 0.4
        ? sentence
        : word > 0
          ? word
          : head.length;
  return `${head.slice(0, at).trimEnd()}…`;
}

/**
 * The one message that carries a research answer: the answer, the cited sources, the closing
 * next-step question, then the link line, always last. The question and the link are always
 * whole. When it does not fit in `limit`, the answer is cut to make room; the sources stay only
 * if they take up to half of what is left, since the PDF lists them.
 */
export function fitResearchText(
  parts: { answer: string; sources: string; nextStep?: string; link: string },
  limit = RESEARCH_TEXT_LIMIT,
): string {
  const join = (...texts: string[]) => texts.filter(Boolean).join("\n\n");
  const closing = join(parts.nextStep ?? "", parts.link);
  const whole = join(parts.answer, parts.sources, closing);
  if (whole.length <= limit) {
    return whole;
  }
  const room = limit - (closing ? closing.length + 2 : 0);
  const keepSources = parts.sources.length + 2 <= room / 2;
  const answerRoom = keepSources ? room - parts.sources.length - 2 : room;
  return join(cutAtBoundary(parts.answer, answerRoom), keepSources ? parts.sources : "", closing);
}

/**
 * The message that carries a finished research, always one message: see `fitResearchText`. A
 * failed research becomes one short message in the lawyer's language.
 */
/** A failure whose message asks the person whether to connect or reconnect Lexroom. */
function connectOffer(result: ResearchOutcome | LexroomFailure): ConnectOfferKind | undefined {
  if (result.ok) {
    return undefined;
  }
  // "forbidden" keeps the saved sign-in, so only a forced link actually reconnects.
  return result.reason === "not_connected"
    ? "lexroom"
    : result.reason === "forbidden"
      ? "lexroom_reconnect"
      : undefined;
}

export async function researchMessage(
  result: ResearchOutcome | LexroomFailure,
  deps: Pick<PushDeps, "readProfileLanguage"> & Partial<Pick<PushDeps, "recipient">>,
): Promise<string> {
  if (result.ok) {
    const language = await resolveLanguage(result.answer, deps.readProfileLanguage, deps.recipient);
    return fitResearchText({
      answer: result.answer,
      sources: result.sources.length
        ? `*${STRINGS[language].sources}*\n${formatSources(result.sources)}`
        : "",
      nextStep: STRINGS[language].next,
      link: result.researchUrl ? researchLinkLine(language, result.researchUrl) : "",
    });
  }
  const language = await resolveLanguage("", deps.readProfileLanguage, deps.recipient);
  const strings = STRINGS[language];
  const reason =
    result.reason === "timeout"
      ? strings.timeout
      : result.reason === "not_connected"
        ? strings.notConnected
        : result.reason === "forbidden"
          ? strings.refused
          : result.reason === "captcha_required"
            ? strings.captcha
            : result.error.slice(0, MAX_FAILURE_CHARS);
  // A connection to offer is a question of its own; "try again" would not answer it.
  return connectOffer(result)
    ? `${strings.failed}\n${reason}`
    : `${strings.failed}\n${reason}\n${strings.retry}`;
}

type Held = {
  jobId: string;
  text: string;
  document?: ResearchPdf;
  heldAtMs: number;
  offer?: ConnectOfferKind;
  /** What a finished research was about, so its delivery can be noted. */
  resultNote?: ResearchResultNote;
};

/** Held results by recipient number, oldest first. */
const held = new Map<string, Held[]>();

const MAX_RECIPIENTS = 200;
const MAX_TRACKED_INBOUND = 1000;

/** When each number last wrote to Ada. In memory: after a restart a window is simply unknown. */
const lastInboundAtMs = new Map<string, number>();

/** A number wrote, so its 24-hour window is open from `atMs`. */
export function recordSenderInbound(recipient: string, atMs: number): void {
  lastInboundAtMs.delete(recipient);
  lastInboundAtMs.set(recipient, atMs);
  if (lastInboundAtMs.size > MAX_TRACKED_INBOUND) {
    lastInboundAtMs.delete(lastInboundAtMs.keys().next().value ?? recipient);
  }
}

/** When `recipient` last wrote to Ada, if this process saw it. */
export function lastSenderInboundAt(recipient: string): number | undefined {
  return lastInboundAtMs.get(recipient);
}

function pruneHeld(nowMs: number): void {
  for (const [recipient, list] of held) {
    const fresh = list.filter((entry) => nowMs - entry.heldAtMs <= HELD_TTL_MS);
    if (fresh.length === 0) {
      held.delete(recipient);
    } else if (fresh.length !== list.length) {
      held.set(recipient, fresh);
    }
  }
}

/** Forgets every held result and window. For tests: this state is shared by the whole process. */
export function clearHeldResearch(): void {
  held.clear();
  lastInboundAtMs.clear();
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Writes a delivered result into the conversation; a failure there never undoes the delivery. */
async function mirror(deps: PushDeps, text: string, jobId: string): Promise<void> {
  await deps.mirror?.(text, jobId)?.catch(() => undefined);
}

/** Sends the text, retrying once after a failure. */
async function sendText(text: string, deps: PushDeps): Promise<SendResult> {
  const first = await deps.send(text);
  if (first.ok) {
    return first;
  }
  await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
  return await deps.send(text);
}

/** Builds the research PDF, or returns undefined and logs a warning. Never throws. */
async function prepareResearchPdf(
  params: { jobId: string; query: string; result: ResearchOutcome | LexroomFailure },
  deps: Pick<PushDeps, "readProfileLanguage" | "recipient" | "log" | "sendDocument">,
): Promise<ResearchPdf | undefined> {
  const { result } = params;
  if (!deps.sendDocument || !result.ok || !result.answer.trim()) {
    return undefined;
  }
  try {
    const language = await resolveLanguage(result.answer, deps.readProfileLanguage, deps.recipient);
    return await buildResearchPdf({
      query: params.query,
      answer: result.answer,
      sources: result.sources,
      researchUrl: result.researchUrl,
      language,
    });
  } catch (error) {
    deps.log("result.pdf_failed", {
      job: params.jobId,
      step: "build",
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

/** Sends the PDF once, after the text. A failure is logged and never reaches the caller. */
async function sendResearchPdf(
  jobId: string,
  document: ResearchPdf | undefined,
  deps: PushDeps,
): Promise<void> {
  if (!document || !deps.sendDocument) {
    return;
  }
  const startedAt = (deps.now ?? Date.now)();
  const result = await deps
    .sendDocument(document)
    .catch((): SendResult => ({ ok: false, error: "document send threw" }));
  if (result.ok) {
    deps.log("result.pdf_sent", {
      job: jobId,
      bytes: document.bytes.byteLength,
      ms: (deps.now ?? Date.now)() - startedAt,
    });
  } else {
    deps.log("result.pdf_failed", {
      job: jobId,
      step: "send",
      bytes: document.bytes.byteLength,
      error: result.error.slice(0, 120),
    });
  }
}

/** Tells the lawyer the research runs in the background. Never throws. */
export async function sendResearchAck(
  params: { jobId: string; query: string },
  deps: PushDeps,
): Promise<boolean> {
  const startedAt = (deps.now ?? Date.now)();
  const language = await resolveLanguage(params.query, deps.readProfileLanguage, deps.recipient);
  const result = await deps.send(researchAckText(language));
  if (result.ok) {
    deps.log("ack.sent", { job: params.jobId, language, ms: (deps.now ?? Date.now)() - startedAt });
  } else {
    deps.log("ack.failed", { job: params.jobId, error: result.error.slice(0, 120) });
  }
  return result.ok;
}

function resultNote(params: {
  query: string;
  matterId?: string;
  result: ResearchOutcome | LexroomFailure;
}): ResearchResultNote {
  return {
    query: params.query,
    ...(params.matterId ? { matterId: params.matterId } : {}),
    ...(params.result.ok && params.result.researchId
      ? { researchId: params.result.researchId }
      : {}),
  };
}

/**
 * Sends the result, or holds it. Returns what became of it so the job can tell a later
 * `ada_research_status` that the lawyer already has (or will get) the answer.
 */
export async function pushResearchResult(
  params: {
    jobId: string;
    startedAtMs: number;
    result: ResearchOutcome | LexroomFailure;
    /** The question asked; the title of the PDF. */
    query: string;
    matterId?: string;
  },
  deps: PushDeps,
): Promise<"sent" | "held"> {
  const now = deps.now ?? Date.now;
  const text = await researchMessage(params.result, deps);
  const offer = connectOffer(params.result);
  const document = await prepareResearchPdf(params, deps);
  const open = await deps.windowOpen().catch(() => null);
  const outcome = params.result.ok ? "done" : (params.result.reason ?? "failed");
  let reason = "window_closed";
  if (open !== false) {
    const sent = await sendText(text, deps);
    if (sent.ok) {
      await mirror(deps, text, params.jobId);
      if (offer) {
        deps.offerConnect?.(offer);
      }
      if (params.result.ok) {
        deps.noteResult?.(resultNote(params));
      }
      deps.log("result.pushed", {
        job: params.jobId,
        outcome,
        chars: text.length,
        via: "live",
        ms: now() - params.startedAtMs,
      });
      await sendResearchPdf(params.jobId, document, deps);
      return "sent";
    }
    reason = "send_failed";
    deps.log("result.push_failed", {
      job: params.jobId,
      error: sent.error.slice(0, 120),
    });
  }
  pruneHeld(now());
  const queue = held.get(deps.recipient) ?? [];
  queue.push({
    jobId: params.jobId,
    text,
    ...(document ? { document } : {}),
    ...(offer ? { offer } : {}),
    ...(params.result.ok ? { resultNote: resultNote(params) } : {}),
    heldAtMs: now(),
  });
  while (queue.length > MAX_HELD) {
    queue.shift();
  }
  held.delete(deps.recipient);
  held.set(deps.recipient, queue);
  while (held.size > MAX_RECIPIENTS) {
    held.delete(held.keys().next().value ?? deps.recipient);
  }
  const nudge = await deps.nudge().catch(() => "failed" as const);
  deps.log("result.held", { job: params.jobId, reason, outcome, nudge });
  return "held";
}

/**
 * Sends the results held for `deps.recipient`. Called when that number writes, which reopens
 * their window. A result that still cannot be sent stays held for their next message.
 */
export async function releaseHeldResearch(deps: PushDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  pruneHeld(now());
  const queue = held.get(deps.recipient) ?? [];
  let released = 0;
  while (queue.length > 0) {
    const next = queue[0];
    if (!next) {
      break;
    }
    const sent = await sendText(next.text, deps);
    if (!sent.ok) {
      deps.log("result.push_failed", {
        job: next.jobId,
        error: sent.error.slice(0, 120),
        via: "release",
      });
      break;
    }
    queue.shift();
    released += 1;
    await mirror(deps, next.text, next.jobId);
    if (next.offer) {
      deps.offerConnect?.(next.offer);
    }
    if (next.resultNote) {
      deps.noteResult?.(next.resultNote);
    }
    deps.log("result.pushed", {
      job: next.jobId,
      chars: next.text.length,
      via: "released",
      heldMs: now() - next.heldAtMs,
    });
    await sendResearchPdf(next.jobId, next.document, deps);
  }
  if (queue.length === 0) {
    held.delete(deps.recipient);
  }
  return released;
}

/**
 * The sender, window check and nudge of a running Ada for one WhatsApp number. The window and the
 * profile language come from that number's own memory, when it has one.
 */
export function livePushDeps(
  api: Pick<OpenClawPluginApi, "config" | "runtime" | "runtimeSource" | "logger" | "pluginConfig">,
  log: LexroomLog,
  recipient: string,
): PushDeps {
  const memory = () => openAdaMemoryIfExistsFromApi(api, recipient);
  const to = `+${recipient}`;
  return {
    recipient,
    send: (text) => sendAdaWhatsAppText({ api, to, text }),
    sendDocument: (document) =>
      sendKapsoPdf({
        config: api.config,
        to,
        filename: document.filename,
        bytes: document.bytes,
      }),
    windowOpen: async () => {
      let seen = lastInboundAtMs.get(recipient) ?? null;
      if (seen === null) {
        try {
          seen = (await (await memory())?.readWake())?.lastLawyerInboundAtMs ?? null;
        } catch {
          seen = null;
        }
      }
      return seen === null ? null : whatsappWindowOpen(seen, Date.now());
    },
    nudge: () =>
      // One request-ready template per closed window, shared with the reminders and watched
      // replies held for the same number, so the claim and the send run under their lock.
      runCollectExclusive(
        async () => {
          const store = await memory().catch(() => null);
          const lastInbound = store
            ? (await store.readWake()).lastLawyerInboundAtMs
            : (lastInboundAtMs.get(recipient) ?? null);
          // A template only reopens a closed window: with it open the result waits for a retry
          // or the next message, with no nudge.
          if (whatsappWindowOpen(lastInbound, Date.now())) {
            return "skipped";
          }
          if (store && !(await claimRequestTemplate(store, lastInbound, Date.now()))) {
            return "skipped";
          }
          const result = await sendRequestReadyNotice({ api, to });
          return result === null ? "unset" : result.ok ? "sent" : "failed";
        },
        { key: `proactive:${recipient}` },
      ),
    readProfileLanguage: async () => (await (await memory())?.readProfile())?.language,
    offerConnect: (kind) => noteConnectOffer(recipient, kind),
    noteResult: (note) => noteResearchResult(recipient, note),
    mirror: (text, jobId) => mirrorSentText(api, recipient, text, `ada-research:${jobId}`),
    log,
  };
}

/** The WhatsApp number a Kapso sender id stands for, or null when it is not a phone number. */
export function senderNumber(...senders: unknown[]): string | null {
  for (const sender of senders) {
    const number = normalizeWhatsAppNumber(sender);
    if (number) {
      return number;
    }
  }
  return null;
}

/**
 * Called for every inbound Kapso message: the sender's 24-hour window is open from now, so any
 * research held back for that number is sent. Runs in the background and never throws.
 */
export function onSenderInbound(params: {
  api: Parameters<typeof livePushDeps>[0];
  channelId: string | undefined;
  senders: unknown[];
  atMs: number;
}): void {
  const { api } = params;
  const recipient = senderNumber(...params.senders);
  if (params.channelId !== undefined && params.channelId !== ADA_WHATSAPP_CHANNEL) {
    logInboundSkip(api.logger, {
      stage: "held_research",
      reason: "not_whatsapp_channel",
      sender: params.senders,
    });
    return;
  }
  if (!recipient) {
    logInboundSkip(api.logger, {
      stage: "held_research",
      reason: "sender_not_a_phone_number",
      sender: params.senders,
    });
    return;
  }
  recordSenderInbound(recipient, params.atMs);
  releaseHeldResearch(livePushDeps(api, lexroomLogger(api.logger), recipient)).catch(
    (error: unknown) => {
      api.logger.error(
        `ada held research release failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    },
  );
}
