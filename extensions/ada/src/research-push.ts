import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { whatsappWindowOpen } from "./collector.js";
import {
  ADA_WHATSAPP_CHANNEL,
  isConfiguredLawyerSender,
  sendAdaWhatsAppText,
} from "./google-notify.js";
import { formatSources } from "./lexroom-citations.js";
import type { LexroomFailure, LexroomLog, ResearchOutcome } from "./lexroom-client.js";
import { lexroomLogger } from "./lexroom-log.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { researchLinkLine, resolveLanguage, type Language } from "./research-link-outbound.js";
import { readDigestReadyTemplate, sendDigestReadyNotice } from "./whatsapp-template.js";

/**
 * A research takes a minute or two, so Ada does not hold the chat turn for it. When the lawyer
 * asks for one, code tells them at once that it runs in the background, and when it ends code
 * sends the answer as a new WhatsApp message, with the sources and the link to the Lexroom app.
 * Nothing here depends on the model remembering to do either.
 *
 * A free-text message only reaches the lawyer inside WhatsApp's 24-hour window. When the window
 * is known to be closed, or a send fails twice, the result is held in this process, the
 * pre-approved template (the same one that releases a held digest) asks the lawyer to write, and
 * their next message releases it.
 */
const MAX_MESSAGE_CHARS = 3500;
const RETRY_DELAY_MS = 2000;
const MAX_HELD = 5;
const HELD_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_FAILURE_CHARS = 300;

type SendResult = { ok: true } | { ok: false; error: string };

export type PushDeps = {
  send: (text: string) => Promise<SendResult>;
  /** Whether the 24-hour window is open; null when Ada has no inbound message on record. */
  windowOpen: () => Promise<boolean | null>;
  /** The ready-template nudge that asks the lawyer to write, or why it was not sent. */
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

type Held = { jobId: string; messages: string[]; heldAtMs: number };

const held: Held[] = [];

function pruneHeld(nowMs: number): void {
  for (let index = held.length - 1; index >= 0; index -= 1) {
    if (nowMs - (held[index]?.heldAtMs ?? 0) > HELD_TTL_MS) {
      held.splice(index, 1);
    }
  }
}

/** Drops every held result. For tests: the queue is shared by the whole process. */
export function clearHeldResearch(): void {
  held.length = 0;
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
  params: { jobId: string; startedAtMs: number; result: ResearchOutcome | LexroomFailure },
  deps: PushDeps,
): Promise<"sent" | "held"> {
  const now = deps.now ?? Date.now;
  const messages = await researchMessages(params.result, deps);
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
  held.push({ jobId: params.jobId, messages, heldAtMs: now() });
  while (held.length > MAX_HELD) {
    held.shift();
  }
  const nudge = await deps.nudge().catch(() => "failed" as const);
  deps.log("result.held", { job: params.jobId, reason, outcome, nudge });
  return "held";
}

/**
 * Sends every held result. Called when the lawyer writes, which reopens the window. A result
 * that still cannot be sent stays held for the next message.
 */
export async function releaseHeldResearch(deps: PushDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  pruneHeld(now());
  let released = 0;
  while (held.length > 0) {
    const next = held[0];
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
    held.shift();
    released += 1;
    deps.log("result.pushed", {
      job: next.jobId,
      chunks: next.messages.length,
      via: "released",
      heldMs: now() - next.heldAtMs,
    });
  }
  return released;
}

/** The sender, window check and nudge of a running Ada, built from its plugin API. */
export function livePushDeps(
  api: Pick<OpenClawPluginApi, "config" | "runtime" | "runtimeSource" | "logger" | "pluginConfig">,
  log: LexroomLog,
): PushDeps {
  const memory = () => openAdaMemoryFromApi(api);
  return {
    send: (text) => sendAdaWhatsAppText({ api, text }),
    windowOpen: async () => {
      const { lastLawyerInboundAtMs } = await (await memory()).readWake();
      return lastLawyerInboundAtMs === null
        ? null
        : whatsappWindowOpen(lastLawyerInboundAtMs, Date.now());
    },
    nudge: async () => {
      const template = readDigestReadyTemplate(api.pluginConfig);
      if (!template) {
        return "unset";
      }
      const result = await sendDigestReadyNotice({ api, template });
      return result.ok ? "sent" : "failed";
    },
    readProfileLanguage: async () => (await (await memory()).readProfile())?.language,
    log,
  };
}

/**
 * Called for every inbound message: when it is the configured lawyer's, the 24-hour window is
 * open again and any research held back is sent. Runs in the background and never throws.
 */
export function releaseHeldResearchForInbound(params: {
  api: Parameters<typeof livePushDeps>[0];
  channelId: string | undefined;
  senders: unknown[];
}): void {
  const { api } = params;
  if (
    (params.channelId !== undefined && params.channelId !== ADA_WHATSAPP_CHANNEL) ||
    !isConfiguredLawyerSender(api.config, ...params.senders)
  ) {
    return;
  }
  releaseHeldResearch(livePushDeps(api, lexroomLogger(api.logger))).catch((error: unknown) => {
    api.logger.error(
      `ada held research release failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  });
}
