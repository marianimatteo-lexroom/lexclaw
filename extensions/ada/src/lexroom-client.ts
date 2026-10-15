import { citedSources, toWhatsAppText, type CitedSource } from "./lexroom-citations.js";
import {
  createGuard,
  DEFAULT_ANSWER_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  LexroomTimeoutError,
  type LexroomGuard,
} from "./lexroom-guard.js";
import {
  chooseModules,
  FALLBACK_MODULES,
  MODULES_TTL_MS,
  normalizeModules,
} from "./lexroom-modules.js";
import { ndjsonLines, parseNdjsonLine } from "./lexroom-stream.js";

export type { CitedSource } from "./lexroom-citations.js";

export const DEFAULT_LEXROOM_BASE_URL = "https://api.lexroom.ai";
export const LEXROOM_CLIENT_TYPE = "app_lex";

const MIN_TIMEOUT_MS = 1000;
const PROGRESS_LOG_EVERY_LINES = 10;
const MAX_ANSWER_CHARS = 24_000;
const MAX_DRAFT_CHARS = 100_000;
const FAILED_STATUSES = new Set(["FAILED", "ERROR", "CANCELED", "CANCELLED"]);
const AUTH_PROBE_PATH = "/v1/credits";
const AUTH_PROBE_TIMEOUT_MS = 15_000;

export type LexroomConfig = {
  accessToken?: string;
  baseUrl?: string;
  /** Cap on one whole research or draft call, selectors and stream included. Default 180000. */
  timeoutMs?: number;
  /** Longest silence tolerated before the call is abandoned. Default 45000. */
  idleTimeoutMs?: number;
  /** Research only: time allowed until the first answer text appears. Default 60000. */
  answerTimeoutMs?: number;
  /** Modules searched when the caller names none. Defaults to every module the user may search. */
  researchModules?: readonly string[];
};

type ResearchSnapshot = {
  id?: string;
  status?: string;
  answer?: string | { text?: string; html?: string };
  documents?: unknown;
  sources?: unknown;
  analysis?: unknown;
  draft?: { title?: unknown; content?: unknown; edited_content?: unknown } | null;
};

export type ResearchOutcome = {
  ok: true;
  matterId: string;
  researchId?: string;
  status: string;
  /** WhatsApp-formatted text. `[n]` markers match `sources[].id`. */
  answer: string;
  sources: CitedSource[];
};

export type DraftOutcome =
  | { ok: true; drafted: false; reason: "confirmation_required"; matterId: string }
  | {
      ok: true;
      drafted: true;
      matterId: string;
      researchId?: string;
      status: string;
      title?: string;
      /** Markdown as written by Lexroom, with `[●]` placeholders left for the lawyer. */
      content: string;
      /** Short WhatsApp-formatted summary of how the draft was built. */
      analysis?: string;
      sources: CitedSource[];
    };

export type LexroomFailure = { ok: false; error: string; reason?: "not_connected" };

type FetchLike = typeof fetch;

export type LexroomLogFields = Record<string, string | number | boolean>;
/** Structured diagnostics. Never pass tokens or query text, only lengths and counts. */
export type LexroomLog = (event: string, fields: LexroomLogFields) => void;
type Trace = (event: string, fields?: LexroomLogFields) => void;

type StreamStats = { lines: number; status?: string; answered?: boolean };

function createTrace(log: LexroomLog | undefined): Trace {
  return (event, fields = {}) => {
    try {
      log?.(event, fields);
    } catch {
      // Diagnostics must never change the outcome of a Lexroom call.
    }
  };
}

class LexroomError extends Error {
  constructor(
    message: string,
    readonly reason?: "not_connected",
    /** HTTP status and sanitized `detail` of the response that caused this, for the log. */
    readonly http?: { status: number; detail: string },
  ) {
    super(message);
  }
}

function baseUrl(config: LexroomConfig): string {
  const value = (config.baseUrl?.trim() || DEFAULT_LEXROOM_BASE_URL).replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LexroomError("Lexroom baseUrl must be an absolute URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new LexroomError("Lexroom baseUrl must be https, or http on localhost.");
  }
  return value;
}

function positiveMs(value: number | undefined, fallback: number): number {
  return value && value >= MIN_TIMEOUT_MS ? value : fallback;
}

function limits(config: LexroomConfig): { idleMs: number; totalMs: number } {
  return {
    idleMs: positiveMs(config.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
    totalMs: positiveMs(config.timeoutMs, DEFAULT_TOTAL_TIMEOUT_MS),
  };
}

function token(config: LexroomConfig): string {
  const accessToken = config.accessToken?.trim();
  if (!accessToken) {
    throw new LexroomError(
      "Ada needs a Lexroom bearer token in plugins.entries.ada.config.accessToken",
    );
  }
  return accessToken;
}

/** Exactly what the lexroom-bot client sends: the bearer, the client type, and JSON for POSTs. */
function headers(accessToken: string, method: "GET" | "POST"): Headers {
  const result = new Headers();
  result.set("Authorization", `Bearer ${accessToken}`);
  result.set("X-Client-Type", LEXROOM_CLIENT_TYPE);
  if (method === "POST") {
    result.set("Content-Type", "application/json");
  }
  return result;
}

/**
 * Escapes non-ASCII to \uXXXX so a request body is pure ASCII bytes, which keeps the
 * Python backend from choking on a UTF-8 decode whatever the runtime encoding is.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function names(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((name) => name.trim()).filter((name) => name.length > 0))];
}

function requestedModules(
  explicit: readonly string[] | undefined,
  config: LexroomConfig,
): string[] {
  const chosen = names(explicit);
  return chosen.length > 0 ? chosen : names(config.researchModules);
}

/** Keeps a server-supplied `detail` loggable: no token, no control characters, bounded. */
function safeDetail(detail: string, accessToken: string): string {
  const withoutToken = accessToken ? detail.replaceAll(accessToken, "[redacted]") : detail;
  return withoutToken
    .replace(/\s+/gu, " ")
    .replace(/[A-Za-z0-9_.-]{24,}/gu, "[redacted]")
    .trim()
    .slice(0, 160);
}

export type LexroomAuthVerdict = "accepted" | "rejected" | "unknown";

/**
 * One cheap authenticated GET the web app also makes, to learn whether Lexroom still
 * accepts the bearer. Costs no research credits. Only a 401 means the bearer is
 * rejected: a 403 comes from an authenticated user without some permission, and any other
 * status or a network failure proves nothing, so none of those is a reason to discard it.
 */
export async function checkLexroomAuth(input: {
  config: LexroomConfig;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  log?: LexroomLog;
}): Promise<LexroomAuthVerdict> {
  const trace = createTrace(input.log);
  const guard = createGuard({
    idleMs: AUTH_PROBE_TIMEOUT_MS,
    totalMs: AUTH_PROBE_TIMEOUT_MS,
    signal: input.signal,
  });
  let verdict: LexroomAuthVerdict = "unknown";
  let status = 0;
  try {
    const response = await guard.race(
      (input.fetchImpl ?? fetch)(`${baseUrl(input.config)}${AUTH_PROBE_PATH}`, {
        method: "GET",
        headers: headers(token(input.config), "GET"),
        signal: guard.signal,
      }),
    );
    status = response.status;
    void response.body?.cancel().catch(() => undefined);
    verdict = response.ok ? "accepted" : status === 401 ? "rejected" : "unknown";
  } catch {
    verdict = "unknown";
  } finally {
    guard.dispose();
  }
  trace("status.auth_probe", { verdict, status, ms: guard.elapsedMs() });
  return verdict;
}

function deniedMessage(detail: string, modules: readonly string[] | undefined): string {
  const text = detail.toLowerCase();
  const shown = detail ? ` Dettaglio Lexroom: "${detail}".` : "";
  const kept = "Il collegamento Lexroom resta valido, non serve ricollegare.";
  if (/modul/u.test(text)) {
    const which = modules?.length ? ` (${modules.join(", ")})` : "";
    return `Lexroom ha rifiutato la richiesta: l'utente non è autorizzato a usare i moduli richiesti${which}. Prova con altri moduli o verifica quelli abilitati sul piano Lexroom.${shown} ${kept}`;
  }
  if (/credit|quota|plan|piano|subscription|abbonament/u.test(text)) {
    return `Lexroom ha rifiutato la richiesta: crediti o piano non sufficienti per questa funzione.${shown} ${kept}`;
  }
  return `Lexroom ha negato la richiesta (403): l'account non ha i permessi per questa funzione.${shown} ${kept}`;
}

/**
 * Turns an error response into the failure to report. Only a 401 means the bearer is
 * rejected. A 403 is an authenticated user lacking a permission, such as a research
 * module: it is explained with Lexroom's own detail and never touches the saved sign-in.
 */
async function errorMessage(
  response: Response,
  call: { guard: LexroomGuard; config: LexroomConfig; modules?: readonly string[] },
): Promise<LexroomError> {
  const { guard, config } = call;
  const status = response.status;
  let rawDetail = "";
  try {
    const body = (await guard.race(response.json())) as { detail?: unknown };
    if (typeof body.detail === "string") {
      rawDetail = body.detail;
    }
  } catch (error) {
    if (guard.timedOut() || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
  }
  const detail = safeDetail(rawDetail, config.accessToken ?? "");
  const http = { status, detail };
  if (detail === "mfa_step_up_required") {
    return new LexroomError(
      "Lexroom requires a verified sign-in. Complete MFA, then refresh the Ada access token.",
      undefined,
      http,
    );
  }
  if (status === 401) {
    return new LexroomError(
      "Lexroom rejected the saved sign-in. Call ada_lexroom_connect and send that link.",
      "not_connected",
      http,
    );
  }
  if (status === 403) {
    return new LexroomError(deniedMessage(detail, call.modules), undefined, http);
  }
  return new LexroomError(
    detail ? `Lexroom returned ${status}: ${detail}` : `Lexroom returned ${status}`,
    undefined,
    http,
  );
}

function failure(
  error: unknown,
  fallback: string,
  accessToken: string | undefined,
): LexroomFailure {
  if (error instanceof LexroomError || error instanceof LexroomTimeoutError) {
    const reason = error instanceof LexroomError ? error.reason : undefined;
    return { ok: false, error: error.message, ...(reason ? { reason } : {}) };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { ok: false, error: "The Lexroom request was cancelled." };
  }
  const message = error instanceof Error ? error.message : fallback;
  return {
    ok: false,
    error: accessToken ? message.replaceAll(accessToken, "[redacted]") : message,
  };
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  config: LexroomConfig,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  call: {
    guard: LexroomGuard;
    trace: Trace;
    step: string;
    modules?: readonly string[];
  },
): Promise<Response> {
  const { guard, trace, step } = call;
  guard.touch();
  const response = await guard.race(
    fetchImpl(url, {
      method: init.method,
      headers: headers(token(config), init.method),
      ...(init.method === "POST" ? { body: asciiJson(init.body) } : {}),
      signal: guard.signal,
    }),
  );
  trace(`${step}.response`, {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    contentEncoding: response.headers.get("content-encoding") ?? "none",
    headersMs: guard.elapsedMs(),
  });
  if (!response.ok) {
    throw await errorMessage(response, { guard, config, modules: call.modules });
  }
  guard.touch();
  return response;
}

type ModulesCache = { key: string; modules: string[]; at: number };
let modulesCache: ModulesCache | undefined;

/**
 * The modules this user may search, from `GET /v1/user/modules`, kept for an hour like the
 * lexroom-bot client does. A failed lookup falls back to the full catalog instead of failing
 * the research; a stale token is then caught by the research call itself.
 */
async function userModules(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  call: { guard: LexroomGuard; trace: Trace },
): Promise<string[]> {
  const key = `${baseUrl(config)}\n${token(config)}`;
  if (modulesCache?.key === key && Date.now() - modulesCache.at < MODULES_TTL_MS) {
    return modulesCache.modules;
  }
  try {
    const response = await request(
      fetchImpl,
      `${baseUrl(config)}/v1/user/modules`,
      config,
      { method: "GET" },
      { ...call, step: "modules" },
    );
    const modules = normalizeModules(await call.guard.race(response.json()));
    if (modules.length === 0) {
      throw new LexroomError("Lexroom user/modules returned an empty list");
    }
    modulesCache = { key, modules, at: Date.now() };
    call.trace("modules.done", { count: modules.length });
    return modules;
  } catch (error) {
    if (call.guard.timedOut() || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    call.trace("modules.fallback", {
      error: (error instanceof Error ? error.message : "unknown").slice(0, 160),
    });
    return modulesCache?.key === key ? modulesCache.modules : [...FALLBACK_MODULES];
  }
}

/**
 * One stream line as a research snapshot. Like lexroom-bot, the snapshot is the `research`
 * envelope when there is one and the line itself otherwise, and a line without an `id` is
 * not a snapshot.
 */
function snapshotFrom(parsed: unknown): ResearchSnapshot | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as { research?: unknown; error?: unknown; detail?: unknown; id?: unknown };
  const message = [record.error, record.detail].find((value) => typeof value === "string");
  if (typeof message === "string" && message.trim() && !record.research && !record.id) {
    throw new LexroomError(message.trim().slice(0, 200));
  }
  const nested = record.research && typeof record.research === "object" ? record.research : parsed;
  const snapshot = nested as ResearchSnapshot & { error?: unknown };
  if (typeof snapshot.error === "string" && snapshot.error.trim()) {
    throw new LexroomError(snapshot.error.trim().slice(0, 200));
  }
  return typeof snapshot.id === "string" && snapshot.id ? snapshot : undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&quot;/giu, '"')
    .trim();
}

/**
 * The answer text of a snapshot, falling back to its HTML and then to the previous snapshot.
 * A terminal event often repeats the id without the answer body, and must not blank the answer.
 */
function mergeAnswer(previous: string, incoming: ResearchSnapshot["answer"]): string {
  const record = incoming && typeof incoming === "object" ? incoming : undefined;
  const raw = typeof incoming === "string" ? incoming : record?.text;
  const text = (typeof raw === "string" ? raw : "").replaceAll("</END>", "").trim();
  const html = (typeof record?.html === "string" ? record.html : "")
    .replaceAll("</END>", "")
    .trim();
  return text || (html ? stripHtml(html) : "") || previous;
}

function groupCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function hasPayload(chunk: Uint8Array): boolean {
  return chunk.some((byte) => byte > 0x20);
}

/**
 * Every line is a full cumulative snapshot, so only the last one matters. Returns
 * as soon as one reports DONE. A stream that ends first is an error, except where the caller
 * accepts the last snapshot (research does, as lexroom-bot does).
 * Any payload bytes count as progress for the idle limit, so one multi-MB line that
 * is still downloading is not mistaken for silence.
 */
async function readFinalSnapshot(
  response: Response,
  call: {
    guard: LexroomGuard;
    trace: Trace;
    step: string;
    stats: StreamStats;
    /** Research keeps whatever arrived before the stream ended; a draft must reach DONE. */
    partialOk?: boolean;
  },
): Promise<ResearchSnapshot> {
  const { guard, trace, step, stats } = call;
  if (!response.body) {
    throw new LexroomError("Lexroom returned an empty research stream");
  }
  const iterator = ndjsonLines(response.body, undefined, (chunk) => {
    if (hasPayload(chunk)) {
      guard.touch();
    }
  })[Symbol.asyncIterator]();
  let last: ResearchSnapshot | undefined;
  try {
    for (;;) {
      const next = await guard.race(iterator.next());
      if (next.done) {
        break;
      }
      const line = snapshotFrom(parseNdjsonLine(next.value));
      if (!line) {
        continue;
      }
      const snapshot: ResearchSnapshot = {
        ...line,
        answer: mergeAnswer(answerText(last?.answer), line.answer),
        documents: Array.isArray(line.documents) ? line.documents : last?.documents,
        sources: Array.isArray(line.sources) ? line.sources : last?.sources,
      };
      last = snapshot;
      stats.lines += 1;
      const status = snapshot.status?.toUpperCase();
      if (stats.lines === 1) {
        trace(`${step}.first_line`, { ms: guard.elapsedMs(), status: status ?? "" });
      }
      if (!stats.answered && answerText(snapshot.answer).trim()) {
        stats.answered = true;
        guard.endAnswerWait();
        trace(`${step}.first_answer`, { ms: guard.elapsedMs(), lines: stats.lines });
      }
      if (status !== stats.status || stats.lines % PROGRESS_LOG_EVERY_LINES === 0) {
        trace(`${step}.progress`, {
          lines: stats.lines,
          status: status ?? "",
          answerChars: answerText(snapshot.answer).length,
          groups: groupCount(snapshot.documents ?? snapshot.sources),
          ms: guard.elapsedMs(),
        });
      }
      stats.status = status;
      if (status === "DONE") {
        return snapshot;
      }
      if (status && FAILED_STATUSES.has(status)) {
        throw new LexroomError("Lexroom could not complete this request. Try again shortly.");
      }
    }
  } finally {
    void iterator.return(undefined).catch(() => undefined);
  }
  if (last && call.partialOk) {
    return last;
  }
  throw new LexroomError(
    last
      ? "Lexroom research stream ended before DONE"
      : "Lexroom returned an empty research stream",
  );
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…` : value;
}

function answerText(answer: ResearchSnapshot["answer"]): string {
  return typeof answer === "string" ? answer : (answer?.text ?? "");
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function libraryScope(documentIds: readonly string[] | undefined): {
  search_on_user_data: boolean;
  library_documents?: Array<{ document_ids: string[] }>;
} {
  const ids = names(documentIds);
  if (ids.length === 0) {
    return { search_on_user_data: false };
  }
  return {
    search_on_user_data: true,
    library_documents: [{ document_ids: ids }],
  };
}

/** Logs how an operation ended and returns the failure to hand back to the caller. */
function failed(params: {
  error: unknown;
  fallback: string;
  config: LexroomConfig;
  guard: LexroomGuard;
  trace: Trace;
  step: string;
  stats: StreamStats;
}): LexroomFailure {
  const { guard, trace, step, stats } = params;
  const result = failure(params.error, params.fallback, params.config.accessToken);
  const kind = guard.timedOut();
  const http = params.error instanceof LexroomError ? params.error.http : undefined;
  trace(kind ? `${step}.timeout` : `${step}.failed`, {
    ...(kind ? { kind } : { error: result.error.slice(0, 160) }),
    ...(http ? { httpStatus: http.status, detail: http.detail } : {}),
    ...(result.ok === false && result.reason ? { reason: result.reason } : {}),
    durationMs: guard.elapsedMs(),
    lines: stats.lines,
    lastStatus: stats.status ?? "",
  });
  return result;
}

export async function runResearch(input: {
  config: LexroomConfig;
  matterId: string;
  query: string;
  libraryDocumentIds?: readonly string[];
  modules?: readonly string[];
  parentResearchId?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  log?: LexroomLog;
}): Promise<ResearchOutcome | LexroomFailure> {
  const matterId = input.matterId.trim();
  const query = input.query.trim();
  if (!matterId) {
    return { ok: false, error: "matterId is required" };
  }
  if (!query) {
    return { ok: false, error: "query is required" };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const trace = createTrace(input.log);
  const step = "research";
  const stats: StreamStats = { lines: 0 };
  const answerMs = positiveMs(input.config.answerTimeoutMs, DEFAULT_ANSWER_TIMEOUT_MS);
  const guard = createGuard({ ...limits(input.config), answerMs, signal: input.signal });
  try {
    const modules = chooseModules(
      requestedModules(input.modules, input.config),
      await userModules(fetchImpl, input.config, { guard, trace }),
    );
    const library = libraryScope(input.libraryDocumentIds);
    trace(`${step}.start`, {
      modules: modules.join(","),
      queryLength: query.length,
      libraryDocuments: library.library_documents?.[0]?.document_ids.length ?? 0,
      ...limits(input.config),
      answerMs,
    });
    const response = await request(
      fetchImpl,
      `${baseUrl(input.config)}/v1/ask_me_anything`,
      input.config,
      {
        method: "POST",
        body: {
          query,
          ...library,
          search_on_modules: modules,
          ...(input.parentResearchId?.trim()
            ? { parent_research_id: input.parentResearchId.trim() }
            : {}),
        },
      },
      { guard, trace, step, modules },
    );
    const snapshot = await readFinalSnapshot(response, {
      guard,
      trace,
      step,
      stats,
      partialOk: true,
    });
    const answer = clip(toWhatsAppText(answerText(snapshot.answer)), MAX_ANSWER_CHARS);
    if (!answer && snapshot.status?.toUpperCase() !== "DONE") {
      throw new LexroomError("Lexroom research stream ended before DONE");
    }
    const sources = citedSources(snapshot.documents, answer);
    trace(`${step}.done`, {
      durationMs: guard.elapsedMs(),
      lines: stats.lines,
      answerChars: answer.length,
      sources: sources.length,
    });
    return {
      ok: true,
      matterId,
      ...(snapshot.id ? { researchId: snapshot.id } : {}),
      status: snapshot.status ?? "DONE",
      answer,
      sources,
    };
  } catch (error) {
    if (error instanceof LexroomError && error.http?.status === 401) {
      modulesCache = undefined;
    }
    return failed({
      error,
      fallback: "Lexroom research failed",
      config: input.config,
      guard,
      trace,
      step,
      stats,
    });
  } finally {
    guard.dispose();
  }
}

/** Lexroom flags the modules it picked for the prompt; inactive ones are not chosen. Without any pick, every module the user may search. */
async function selectModules(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  prompt: string,
  call: { guard: LexroomGuard; trace: Trace },
): Promise<string[]> {
  const response = await request(
    fetchImpl,
    `${baseUrl(config)}/v2/ai/drafting/selectors`,
    config,
    { method: "POST", body: { prompt, template: null } },
    { ...call, step: "selectors" },
  );
  const body = (await call.guard.race(response.json())) as {
    modules?: Array<{ name?: unknown; is_active?: unknown }>;
  };
  const selected = (body.modules ?? [])
    .filter((module) => module.is_active !== false)
    .map((module) => (typeof module.name === "string" ? module.name : ""));
  const picked = requestedModules(selected, config);
  const modules = picked.length > 0 ? picked : await userModules(fetchImpl, config, call);
  call.trace("selectors.done", { offered: body.modules?.length ?? 0, chosen: modules.join(",") });
  return modules;
}

/**
 * The streamed final snapshot already carries the draft; the stored object is only a
 * backstop. An earlier integration saw this GET hang, so it runs under the same limits.
 */
async function loadStoredDraft(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  id: string,
  call: { guard: LexroomGuard; trace: Trace },
): Promise<ResearchSnapshot> {
  const response = await request(
    fetchImpl,
    `${baseUrl(config)}/v2/craft/drafting/${encodeURIComponent(id)}`,
    config,
    { method: "GET" },
    { ...call, step: "stored_draft" },
  );
  const body = (await call.guard.race(response.json())) as ResearchSnapshot & {
    research?: ResearchSnapshot;
  };
  return body.research ?? body;
}

function draftContent(snapshot: ResearchSnapshot): string {
  return nonEmpty(snapshot.draft?.edited_content) || nonEmpty(snapshot.draft?.content);
}

export async function runDraft(input: {
  config: LexroomConfig;
  matterId: string;
  prompt: string;
  confirmed: boolean;
  modules?: readonly string[];
  parentResearchId?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  log?: LexroomLog;
}): Promise<DraftOutcome | LexroomFailure> {
  const matterId = input.matterId.trim();
  const prompt = input.prompt.trim();
  if (!matterId) {
    return { ok: false, error: "matterId is required" };
  }
  if (!prompt) {
    return { ok: false, error: "prompt is required" };
  }
  if (!input.confirmed) {
    return { ok: true, drafted: false, reason: "confirmation_required", matterId };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const trace = createTrace(input.log);
  const step = "draft";
  const stats: StreamStats = { lines: 0 };
  const guard = createGuard({ ...limits(input.config), signal: input.signal });
  try {
    trace(`${step}.start`, {
      promptLength: prompt.length,
      modulesProvided: names(input.modules).length,
      ...limits(input.config),
    });
    const provided = names(input.modules);
    const modules =
      provided.length > 0
        ? provided
        : await selectModules(fetchImpl, input.config, prompt, { guard, trace });
    const response = await request(
      fetchImpl,
      `${baseUrl(input.config)}/v2/ai/drafting`,
      input.config,
      {
        method: "POST",
        body: {
          prompt,
          template: null,
          modules,
          documents: [],
          ...(input.parentResearchId?.trim()
            ? { parent_research_id: input.parentResearchId.trim() }
            : {}),
        },
      },
      { guard, trace, step, modules },
    );
    let snapshot = await readFinalSnapshot(response, { guard, trace, step, stats });
    if (!draftContent(snapshot) && snapshot.id) {
      snapshot = await loadStoredDraft(fetchImpl, input.config, snapshot.id, { guard, trace });
    }
    const content = draftContent(snapshot);
    if (!content) {
      throw new LexroomError("Lexroom finished without producing a draft.");
    }
    const analysis = toWhatsAppText(nonEmpty(snapshot.analysis));
    const title = nonEmpty(snapshot.draft?.title);
    const sources = citedSources(snapshot.sources, content, analysis);
    trace(`${step}.done`, {
      durationMs: guard.elapsedMs(),
      lines: stats.lines,
      draftChars: content.length,
      sources: sources.length,
    });
    return {
      ok: true,
      drafted: true,
      matterId,
      ...(snapshot.id ? { researchId: snapshot.id } : {}),
      status: snapshot.status ?? "DONE",
      ...(title ? { title } : {}),
      content: clip(content, MAX_DRAFT_CHARS),
      ...(analysis ? { analysis } : {}),
      sources,
    };
  } catch (error) {
    return failed({
      error,
      fallback: "Lexroom drafting failed",
      config: input.config,
      guard,
      trace,
      step,
      stats,
    });
  } finally {
    guard.dispose();
  }
}
