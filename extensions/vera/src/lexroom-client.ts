import { citedSources, toWhatsAppText, type CitedSource } from "./lexroom-citations.js";
import {
  createGuard,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  LexroomTimeoutError,
  type LexroomGuard,
} from "./lexroom-guard.js";
import { ndjsonLines, parseNdjsonLine } from "./lexroom-stream.js";

export type { CitedSource } from "./lexroom-citations.js";

export const DEFAULT_LEXROOM_BASE_URL = "https://api.lexroom.ai";
export const LEXROOM_CLIENT_TYPE = "app_lex";
/** Lexroom rejects a research request with no module, so one is always sent. */
export const DEFAULT_RESEARCH_MODULES: readonly string[] = ["Civile"];

const MIN_TIMEOUT_MS = 1000;
const PROGRESS_LOG_EVERY_LINES = 10;
const MAX_ANSWER_CHARS = 24_000;
const MAX_DRAFT_CHARS = 100_000;
const FAILED_STATUSES = new Set(["FAILED", "ERROR", "CANCELED", "CANCELLED"]);
const PERMISSION_DENIED = "You do not have permission to perform this action.";

export type LexroomConfig = {
  accessToken?: string;
  baseUrl?: string;
  /** Cap on one whole research or draft call, selectors and stream included. Default 180000. */
  timeoutMs?: number;
  /** Longest silence tolerated before the call is abandoned. Default 45000. */
  idleTimeoutMs?: number;
  /** Modules searched when the caller names none. Defaults to ["Civile"]. */
  researchModules?: readonly string[];
};

type ResearchSnapshot = {
  id?: string;
  status?: string;
  answer?: string | { text?: string };
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

type StreamStats = { lines: number; status?: string };

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

function limits(config: LexroomConfig): { idleMs: number; totalMs: number } {
  const valid = (value: number | undefined, fallback: number) =>
    value && value >= MIN_TIMEOUT_MS ? value : fallback;
  return {
    idleMs: valid(config.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
    totalMs: valid(config.timeoutMs, DEFAULT_TOTAL_TIMEOUT_MS),
  };
}

function token(config: LexroomConfig): string {
  const accessToken = config.accessToken?.trim();
  if (!accessToken) {
    throw new LexroomError(
      "Vera needs a Lexroom bearer token in plugins.entries.vera.config.accessToken",
    );
  }
  return accessToken;
}

/**
 * The web app sends only the bearer and a JSON content type. `Accept-Encoding: identity`
 * is deliberate: Node's fetch hands back a gzip-encoded body only once it ends, so a
 * compressing proxy would make a live stream look silent until it is over.
 */
function headers(accessToken: string, accept: string): Headers {
  const result = new Headers();
  result.set("Authorization", `Bearer ${accessToken}`);
  result.set("Content-Type", "application/json");
  result.set("Accept", accept);
  result.set("Accept-Encoding", "identity");
  return result;
}

const STREAM_ACCEPT = "text/event-stream, application/x-ndjson, */*;q=0.5";
const JSON_ACCEPT = "application/json, */*;q=0.5";

function names(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((name) => name.trim()).filter((name) => name.length > 0))];
}

function modulesFor(explicit: readonly string[] | undefined, config: LexroomConfig): string[] {
  const chosen = names(explicit);
  if (chosen.length > 0) {
    return chosen;
  }
  const configured = names(config.researchModules);
  return configured.length > 0 ? configured : [...DEFAULT_RESEARCH_MODULES];
}

async function errorMessage(response: Response, guard: LexroomGuard): Promise<LexroomError> {
  const status = response.status;
  let detail = "";
  try {
    const body = (await guard.race(response.json())) as { detail?: unknown };
    if (typeof body.detail === "string") {
      detail = body.detail.slice(0, 200);
    }
  } catch (error) {
    if (guard.timedOut() || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    detail = "";
  }
  if (detail === "mfa_step_up_required") {
    return new LexroomError(
      "Lexroom requires a verified sign-in. Complete MFA, then refresh the Vera access token.",
    );
  }
  // A missing or revoked bearer is a 403 with this detail on the Lexroom API, not always a 401.
  if (status === 401 || (status === 403 && (!detail || detail === PERMISSION_DENIED))) {
    return new LexroomError(
      "Lexroom rejected the saved sign-in. Call vera_lexroom_connect and send that link.",
      "not_connected",
    );
  }
  return new LexroomError(
    detail ? `Lexroom returned ${status}: ${detail}` : `Lexroom returned ${status}`,
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
  call: { guard: LexroomGuard; trace: Trace; step: string; accept: string },
): Promise<Response> {
  const { guard, trace, step } = call;
  guard.touch();
  const response = await guard.race(
    fetchImpl(url, {
      method: init.method,
      headers: headers(token(config), call.accept),
      ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
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
    throw await errorMessage(response, guard);
  }
  guard.touch();
  return response;
}

function snapshotFrom(parsed: unknown): ResearchSnapshot | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as { research?: unknown; error?: unknown; detail?: unknown };
  const message = [record.error, record.detail].find((value) => typeof value === "string");
  if (typeof message === "string" && message.trim() && record.research === undefined) {
    throw new LexroomError(message.trim().slice(0, 200));
  }
  const nested = record.research;
  if (!nested || typeof nested !== "object") {
    return undefined;
  }
  const error = (nested as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) {
    throw new LexroomError(error.trim().slice(0, 200));
  }
  return nested as ResearchSnapshot;
}

function groupCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function hasPayload(chunk: Uint8Array): boolean {
  return chunk.some((byte) => byte > 0x20);
}

/**
 * Every line is a full cumulative snapshot, so only the last one matters. Returns
 * as soon as one reports DONE; a stream that ends first is an error, not a partial.
 * Any payload bytes count as progress for the idle limit, so one multi-MB line that
 * is still downloading is not mistaken for silence.
 */
async function readFinalSnapshot(
  response: Response,
  call: { guard: LexroomGuard; trace: Trace; step: string; stats: StreamStats },
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
  try {
    for (;;) {
      const next = await guard.race(iterator.next());
      if (next.done) {
        break;
      }
      const snapshot = snapshotFrom(parseNdjsonLine(next.value));
      if (!snapshot) {
        continue;
      }
      stats.lines += 1;
      const status = snapshot.status?.toUpperCase();
      if (stats.lines === 1) {
        trace(`${step}.first_line`, { ms: guard.elapsedMs(), status: status ?? "" });
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
  throw new LexroomError(
    stats.lines > 0
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
  trace(kind ? `${step}.timeout` : `${step}.failed`, {
    ...(kind ? { kind } : { error: result.error.slice(0, 160) }),
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
  const guard = createGuard({ ...limits(input.config), signal: input.signal });
  try {
    const modules = modulesFor(input.modules, input.config);
    const library = libraryScope(input.libraryDocumentIds);
    trace(`${step}.start`, {
      modules: modules.join(","),
      queryLength: query.length,
      libraryDocuments: library.library_documents?.[0]?.document_ids.length ?? 0,
      ...limits(input.config),
    });
    const response = await request(
      fetchImpl,
      `${baseUrl(input.config)}/v1/ask_me_anything`,
      input.config,
      {
        method: "POST",
        body: {
          // The web app appends a newline to what the lawyer typed.
          query: `${query}\n`,
          search_on_modules: modules,
          documents: [],
          is_temporary: false,
          ...library,
          ...(input.parentResearchId?.trim()
            ? { parent_research_id: input.parentResearchId.trim() }
            : {}),
        },
      },
      { guard, trace, step, accept: STREAM_ACCEPT },
    );
    const snapshot = await readFinalSnapshot(response, { guard, trace, step, stats });
    const answer = clip(toWhatsAppText(answerText(snapshot.answer)), MAX_ANSWER_CHARS);
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

/** Lexroom flags the modules it picked for the prompt; inactive ones are not chosen. */
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
    { ...call, step: "selectors", accept: JSON_ACCEPT },
  );
  const body = (await call.guard.race(response.json())) as {
    modules?: Array<{ name?: unknown; is_active?: unknown }>;
  };
  const selected = (body.modules ?? [])
    .filter((module) => module.is_active !== false)
    .map((module) => (typeof module.name === "string" ? module.name : ""));
  const modules = modulesFor(selected, config);
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
    { ...call, step: "stored_draft", accept: JSON_ACCEPT },
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
      { guard, trace, step, accept: STREAM_ACCEPT },
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
