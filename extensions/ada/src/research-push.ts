import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { whatsappWindowOpen } from "./collector.js";
import {
  ADA_WHATSAPP_CHANNEL,
  isConfiguredLawyerSender,
  normalizeWhatsAppNumber,
  sendAdaWhatsAppText,
} from "./google-notify.js";
import { sendKapsoPdf } from "./kapso-document.js";
import { formatSources } from "./lexroom-citations.js";
import type { LexroomFailure, ResearchOutcome } from "./lexroom-client.js";
import { lexroomLogger, type LexroomLog } from "./lexroom-log.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { researchLinkLine, resolveLanguage, type Language } from "./research-link-outbound.js";
import { buildResearchPdf, type ResearchPdf } from "./research-pdf.js";
import { readDigestReadyTemplate, sendDigestReadyNotice } from "./whatsapp-template.js";

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
const MAX_MESSAGE_CHARS = 3500;
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
  nudge: () => Promise<"sent" | "unset" | "failed">;
  readProfileLanguage?: () => Promise<string | undefined>;
  log: LexroomLog;
  now?: () => number;
  retryDelayMs?: number;
};

type Strings = {
  ack: string;
  sources: string;
  failed: string;
  timeout: string;
  notConnected: string;
  retry: string;
};

const STRINGS: Record<Language, Strings> = {
  it: {
    ack: "Ho avviato la ricerca su Lexroom. Va avanti in background e ci vorrà circa un minuto o due: ti scrivo io appena è pronta.",
    sources: "Fonti",
    failed: "La ricerca su Lexroom non è andata a buon fine.",
    timeout: "Lexroom non ha risposto in tempo e la richiesta è stata interrotta.",
    notConnected: "Lexroom non è collegato: chiedimi di collegarlo e ti mando il link.",
    retry: "Dimmi se vuoi che riprovi.",
  },
  en: {
    ack: "I've started the research on Lexroom. It runs in the background and takes a minute or two: I'll message you as soon as it's ready.",
    sources: "Sources",
    failed: "The Lexroom research did not complete.",
    timeout: "Lexroom did not respond in time and the request was abandoned.",
    notConnected: "Lexroom is not connected: ask me to connect it and I'll send you the link.",
    retry: "Tell me if you want me to try again.",
  },
  es: {
    ack: "He iniciado la investigación en Lexroom. Sigue en segundo plano y tarda uno o dos minutos: te escribo en cuanto esté lista.",
    sources: "Fuentes",
    failed: "La investigación en Lexroom no se completó.",
    timeout: "Lexroom no respondió a tiempo y la solicitud se interrumpió.",
    notConnected: "Lexroom no está conectado: pídeme que lo conecte y te envío el enlace.",
    retry: "Dime si quieres que lo intente de nuevo.",
  },
  fr: {
    ack: "J'ai lancé la recherche sur Lexroom. Elle tourne en arrière-plan et prend une à deux minutes : je vous écris dès qu'elle est prête.",
    sources: "Sources",
    failed: "La recherche sur Lexroom n'a pas abouti.",
    timeout: "Lexroom n'a pas répondu à temps et la demande a été interrompue.",
    notConnected:
      "Lexroom n'est pas connecté : demandez-moi de le connecter et je vous envoie le lien.",
    retry: "Dites-moi si vous voulez que je réessaie.",
  },
  de: {
    ack: "Ich habe die Recherche in Lexroom gestartet. Sie läuft im Hintergrund und dauert ein bis zwei Minuten: Ich melde mich, sobald sie fertig ist.",
    sources: "Quellen",
    failed: "Die Lexroom-Recherche ist nicht abgeschlossen worden.",
    timeout: "Lexroom hat nicht rechtzeitig geantwortet und die Anfrage wurde abgebrochen.",
    notConnected:
      "Lexroom ist nicht verbunden: Bitten Sie mich, es zu verbinden, dann sende ich den Link.",
    retry: "Sagen Sie mir, wenn ich es noch einmal versuchen soll.",
  },
};

export function researchAckText(language: Language): string {
  return STRINGS[language].ack;
}

/** Splits at paragraph, then line, then word boundaries so no message passes the WhatsApp limit. */
export function chunkMessage(text: string, limit = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

/**
 * The messages that carry a finished research: the answer, then the cited sources and the link
 * line, always last. A failed research becomes one short message in the lawyer's language.
 */
export async function researchMessages(
  result: ResearchOutcome | LexroomFailure,
  deps: Pick<PushDeps, "readProfileLanguage">,
): Promise<string[]> {
  if (result.ok) {
    const language = await resolveLanguage(result.answer, deps.readProfileLanguage);
    const sources = result.sources.length
      ? `*${STRINGS[language].sources}*\n${formatSources(result.sources)}`
      : "";
    const link = result.researchUrl ? researchLinkLine(language, result.researchUrl) : "";
    return chunkMessage([result.answer, sources, link].filter(Boolean).join("\n\n"));
  }
  const language = await resolveLanguage("", deps.readProfileLanguage);
  const strings = STRINGS[language];
  const reason =
    result.reason === "timeout"
      ? strings.timeout
      : result.reason === "not_connected"
        ? strings.notConnected
        : result.error.slice(0, MAX_FAILURE_CHARS);
  return [`${strings.failed}\n${reason}\n${strings.retry}`];
}

type Held = { jobId: string; messages: string[]; document?: ResearchPdf; heldAtMs: number };

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

/** Sends the messages in order, one retry for the first failure. Returns the error if it gave up. */
async function sendAll(
  messages: readonly string[],
  deps: PushDeps,
): Promise<{ ok: true } | { ok: false; error: string; sent: number }> {
  let sent = 0;
  for (const text of messages) {
    let result = await deps.send(text);
    if (!result.ok) {
      await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
      result = await deps.send(text);
    }
    if (!result.ok) {
      return { ok: false, error: result.error, sent };
    }
    sent += 1;
  }
  return { ok: true };
}

/** Builds the research PDF, or returns undefined and logs a warning. Never throws. */
async function prepareResearchPdf(
  params: { jobId: string; query: string; result: ResearchOutcome | LexroomFailure },
  deps: Pick<PushDeps, "readProfileLanguage" | "log" | "sendDocument">,
): Promise<ResearchPdf | undefined> {
  const { result } = params;
  if (!deps.sendDocument || !result.ok || !result.answer.trim()) {
    return undefined;
  }
  try {
    const language = await resolveLanguage(result.answer, deps.readProfileLanguage);
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
  const language = await resolveLanguage(params.query, deps.readProfileLanguage);
  const result = await deps.send(researchAckText(language));
  if (result.ok) {
    deps.log("ack.sent", { job: params.jobId, language, ms: (deps.now ?? Date.now)() - startedAt });
  } else {
    deps.log("ack.failed", { job: params.jobId, error: result.error.slice(0, 120) });
  }
  return result.ok;
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
  },
  deps: PushDeps,
): Promise<"sent" | "held"> {
  const now = deps.now ?? Date.now;
  const messages = await researchMessages(params.result, deps);
  const document = await prepareResearchPdf(params, deps);
  const open = await deps.windowOpen().catch(() => null);
  const outcome = params.result.ok ? "done" : (params.result.reason ?? "failed");
  let reason = "window_closed";
  if (open !== false) {
    const sent = await sendAll(messages, deps);
    if (sent.ok) {
      deps.log("result.pushed", {
        job: params.jobId,
        outcome,
        chunks: messages.length,
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
      sent: sent.sent,
      chunks: messages.length,
    });
    // Messages already delivered stay delivered; only the rest waits for the window.
    messages.splice(0, sent.sent);
  }
  pruneHeld(now());
  const queue = held.get(deps.recipient) ?? [];
  queue.push({ jobId: params.jobId, messages, ...(document ? { document } : {}), heldAtMs: now() });
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
    const sent = await sendAll(next.messages, deps);
    if (!sent.ok) {
      next.messages.splice(0, sent.sent);
      deps.log("result.push_failed", {
        job: next.jobId,
        error: sent.error.slice(0, 120),
        via: "release",
      });
      break;
    }
    queue.shift();
    released += 1;
    deps.log("result.pushed", {
      job: next.jobId,
      chunks: next.messages.length,
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
 * The sender, window check and nudge of a running Ada for one WhatsApp number. The profile
 * language is the configured lawyer's, so it is only used for the lawyer.
 */
export function livePushDeps(
  api: Pick<OpenClawPluginApi, "config" | "runtime" | "runtimeSource" | "logger" | "pluginConfig">,
  log: LexroomLog,
  recipient: string,
): PushDeps {
  const memory = () => openAdaMemoryFromApi(api);
  const to = `+${recipient}`;
  const isLawyer = isConfiguredLawyerSender(api.config, recipient);
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
      const seen =
        lastInboundAtMs.get(recipient) ??
        (isLawyer ? (await (await memory()).readWake()).lastLawyerInboundAtMs : null);
      return seen === null ? null : whatsappWindowOpen(seen, Date.now());
    },
    nudge: async () => {
      const template = readDigestReadyTemplate(api.pluginConfig);
      if (!template) {
        return "unset";
      }
      const result = await sendDigestReadyNotice({ api, template, to });
      return result.ok ? "sent" : "failed";
    },
    ...(isLawyer
      ? { readProfileLanguage: async () => (await (await memory()).readProfile())?.language }
      : {}),
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
  if ((params.channelId !== undefined && params.channelId !== ADA_WHATSAPP_CHANNEL) || !recipient) {
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
