import { citedSources, toWhatsAppText, type CitedSource } from "./lexroom-citations.js";
import { ndjsonLines, parseNdjsonLine } from "./lexroom-stream.js";

export type { CitedSource } from "./lexroom-citations.js";

export const DEFAULT_LEXROOM_BASE_URL = "https://api.lexroom.ai";
export const LEXROOM_CLIENT_TYPE = "app_lex";
/** Lexroom rejects a research request with no module, so one is always sent. */
export const DEFAULT_RESEARCH_MODULES: readonly string[] = ["Civile"];

const DEFAULT_TIMEOUT_MS = 120_000;
const STORED_DRAFT_TIMEOUT_MS = 30_000;
const MAX_ANSWER_CHARS = 24_000;
const MAX_DRAFT_CHARS = 100_000;
const FAILED_STATUSES = new Set(["FAILED", "ERROR", "CANCELED", "CANCELLED"]);
const PERMISSION_DENIED = "You do not have permission to perform this action.";

export type LexroomConfig = {
  accessToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
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

function timeoutMs(config: LexroomConfig): number {
  return config.timeoutMs && config.timeoutMs >= 1000 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
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

function headers(accessToken: string): Headers {
  const result = new Headers();
  result.set("Authorization", `Bearer ${accessToken}`);
  result.set("X-Client-Type", LEXROOM_CLIENT_TYPE);
  result.set("X-Request-ID", crypto.randomUUID());
  result.set("Content-Type", "application/json");
  result.set("Accept", "*/*");
  return result;
}

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

async function errorMessage(response: Response): Promise<LexroomError> {
  const status = response.status;
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      detail = body.detail.slice(0, 200);
    }
  } catch {
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
  if (error instanceof LexroomError) {
    return { ok: false, error: error.message, ...(error.reason ? { reason: error.reason } : {}) };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { ok: false, error: "Lexroom did not answer in time. Try again shortly." };
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

/** Each HTTP call gets its own budget: selectors, the stream, and the draft fetch. */
function phaseSignal(
  config: LexroomConfig,
  caller: AbortSignal | undefined,
  capMs = Number.POSITIVE_INFINITY,
): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(Math.min(timeoutMs(config), capMs)),
    ...(caller ? [caller] : []),
  ]);
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  config: LexroomConfig,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetchImpl(url, {
    method: init.method,
    headers: headers(token(config)),
    ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
    signal,
  });
  if (!response.ok) {
    throw await errorMessage(response);
  }
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

/**
 * Every line is a full cumulative snapshot, so only the last one matters. Returns
 * as soon as one reports DONE; a stream that ends first is an error, not a partial.
 */
async function readFinalSnapshot(response: Response): Promise<ResearchSnapshot> {
  if (!response.body) {
    throw new LexroomError("Lexroom returned an empty research stream");
  }
  let latest: ResearchSnapshot | undefined;
  for await (const line of ndjsonLines(response.body)) {
    const snapshot = snapshotFrom(parseNdjsonLine(line));
    if (!snapshot) {
      continue;
    }
    latest = snapshot;
    const status = snapshot.status?.toUpperCase();
    if (status === "DONE") {
      return snapshot;
    }
    if (status && FAILED_STATUSES.has(status)) {
      throw new LexroomError("Lexroom could not complete this request. Try again shortly.");
    }
  }
  throw new LexroomError(
    latest
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

export async function runResearch(input: {
  config: LexroomConfig;
  matterId: string;
  query: string;
  libraryDocumentIds?: readonly string[];
  modules?: readonly string[];
  parentResearchId?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
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
  try {
    const response = await request(
      fetchImpl,
      `${baseUrl(input.config)}/v1/ask_me_anything`,
      input.config,
      {
        method: "POST",
        body: {
          query,
          search_on_modules: modulesFor(input.modules, input.config),
          documents: [],
          is_temporary: false,
          ...libraryScope(input.libraryDocumentIds),
          ...(input.parentResearchId?.trim()
            ? { parent_research_id: input.parentResearchId.trim() }
            : {}),
        },
      },
      phaseSignal(input.config, input.signal),
    );
    const snapshot = await readFinalSnapshot(response);
    const answer = clip(toWhatsAppText(answerText(snapshot.answer)), MAX_ANSWER_CHARS);
    return {
      ok: true,
      matterId,
      ...(snapshot.id ? { researchId: snapshot.id } : {}),
      status: snapshot.status ?? "DONE",
      answer,
      sources: citedSources(snapshot.documents, answer),
    };
  } catch (error) {
    return failure(error, "Lexroom research failed", input.config.accessToken);
  }
}

/** Lexroom flags the modules it picked for the prompt; inactive ones are not chosen. */
async function selectModules(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  prompt: string,
  caller: AbortSignal | undefined,
): Promise<string[]> {
  const response = await request(
    fetchImpl,
    `${baseUrl(config)}/v2/ai/drafting/selectors`,
    config,
    { method: "POST", body: { prompt, template: null } },
    phaseSignal(config, caller),
  );
  const body = (await response.json()) as {
    modules?: Array<{ name?: unknown; is_active?: unknown }>;
  };
  const selected = (body.modules ?? [])
    .filter((module) => module.is_active !== false)
    .map((module) => (typeof module.name === "string" ? module.name : ""));
  return modulesFor(selected, config);
}

/**
 * The streamed final snapshot already carries the draft; the stored object is only a
 * backstop. An earlier integration saw this GET hang, so it gets a short budget.
 */
async function loadStoredDraft(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  id: string,
  caller: AbortSignal | undefined,
): Promise<ResearchSnapshot> {
  const response = await request(
    fetchImpl,
    `${baseUrl(config)}/v2/craft/drafting/${encodeURIComponent(id)}`,
    config,
    { method: "GET" },
    phaseSignal(config, caller, STORED_DRAFT_TIMEOUT_MS),
  );
  const body = (await response.json()) as ResearchSnapshot & { research?: ResearchSnapshot };
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
  try {
    const provided = names(input.modules);
    const modules =
      provided.length > 0
        ? provided
        : await selectModules(fetchImpl, input.config, prompt, input.signal);
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
      phaseSignal(input.config, input.signal),
    );
    let snapshot = await readFinalSnapshot(response);
    if (!draftContent(snapshot) && snapshot.id) {
      snapshot = await loadStoredDraft(fetchImpl, input.config, snapshot.id, input.signal);
    }
    const content = draftContent(snapshot);
    if (!content) {
      throw new LexroomError("Lexroom finished without producing a draft.");
    }
    const analysis = toWhatsAppText(nonEmpty(snapshot.analysis));
    const title = nonEmpty(snapshot.draft?.title);
    return {
      ok: true,
      drafted: true,
      matterId,
      ...(snapshot.id ? { researchId: snapshot.id } : {}),
      status: snapshot.status ?? "DONE",
      ...(title ? { title } : {}),
      content: clip(content, MAX_DRAFT_CHARS),
      ...(analysis ? { analysis } : {}),
      sources: citedSources(snapshot.sources, content, analysis),
    };
  } catch (error) {
    return failure(error, "Lexroom drafting failed", input.config.accessToken);
  }
}
