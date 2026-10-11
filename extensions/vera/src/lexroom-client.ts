export const DEFAULT_LEXROOM_BASE_URL = "https://api.lexroom.ai";
export const LEXROOM_CLIENT_TYPE = "app_lex";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ANSWER_CHARS = 24_000;

export type LexroomConfig = {
  accessToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
};

type ResearchAnswer = string | { text?: string };

type ResearchDocumentFile = {
  title?: unknown;
  section_title?: unknown;
  citation_id?: unknown;
  files?: unknown;
};

type ResearchSnapshot = {
  id?: string;
  status?: string;
  error?: unknown;
  answer?: ResearchAnswer;
  documents?: unknown;
  draft?: { id?: string; title?: string; content?: string; edited_content?: string };
};

export type CitedSource = {
  title: string;
};

export type ResearchOutcome = {
  ok: true;
  matterId: string;
  researchId?: string;
  status: string;
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
      content: string;
    };

export type LexroomFailure = { ok: false; error: string };

type FetchLike = typeof fetch;

function baseUrl(config: LexroomConfig): string {
  return (config.baseUrl?.trim() || DEFAULT_LEXROOM_BASE_URL).replace(/\/+$/u, "");
}

function timeoutMs(config: LexroomConfig): number {
  return config.timeoutMs && config.timeoutMs >= 1000 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function token(config: LexroomConfig): string {
  const accessToken = config.accessToken?.trim();
  if (!accessToken) {
    throw new Error("Vera needs a Lexroom bearer token in plugins.entries.vera.config.accessToken");
  }
  return accessToken;
}

function headers(accessToken: string): Headers {
  const result = new Headers();
  result.set("Authorization", `Bearer ${accessToken}`);
  result.set("X-Client-Type", LEXROOM_CLIENT_TYPE);
  result.set("X-Request-ID", crypto.randomUUID());
  result.set("Content-Type", "application/json");
  result.set("Accept", "application/x-ndjson, application/json");
  return result;
}

async function errorMessage(response: Response): Promise<string> {
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
    return "Lexroom requires a verified sign-in. Complete MFA, then refresh the Vera access token.";
  }
  if (status === 401) {
    return "Lexroom rejected the access token. Sign in again and update Vera's access token.";
  }
  return detail ? `Lexroom returned ${status}: ${detail}` : `Lexroom returned ${status}`;
}

function clip(text: string | undefined): string {
  if (!text) {
    return "";
  }
  return text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}\n…` : text;
}

function snapshotFromLine(parsed: unknown): ResearchSnapshot {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Lexroom stream line did not contain a research snapshot");
  }
  const record = parsed as { research?: unknown; error?: unknown };
  const nested = record.research;
  const research =
    nested && typeof nested === "object" ? (nested as ResearchSnapshot) : (record as ResearchSnapshot);
  const error =
    typeof research.error === "string"
      ? research.error
      : typeof record.error === "string" && nested === undefined
        ? record.error
        : undefined;
  if (error?.trim()) {
    throw new Error(error.trim().slice(0, 200));
  }
  if (
    nested === undefined &&
    !("status" in record) &&
    !("answer" in record) &&
    !("draft" in record) &&
    !("id" in record)
  ) {
    throw new Error("Lexroom stream line did not contain a research snapshot");
  }
  return research;
}

function answerText(answer: ResearchAnswer | undefined): string {
  const raw = typeof answer === "string" ? answer : answer?.text;
  return raw ? raw.replaceAll("</END>", "") : "";
}

function documentFiles(documents: unknown): ResearchDocumentFile[] {
  if (!Array.isArray(documents)) {
    return [];
  }
  const files: ResearchDocumentFile[] = [];
  for (const document of documents) {
    if (!document || typeof document !== "object") {
      continue;
    }
    const nested = (document as ResearchDocumentFile).files;
    if (Array.isArray(nested)) {
      for (const file of nested) {
        if (file && typeof file === "object") {
          files.push(file as ResearchDocumentFile);
        }
      }
      continue;
    }
    files.push(document as ResearchDocumentFile);
  }
  return files;
}

function sourceTitle(file: ResearchDocumentFile): string {
  const title = typeof file.title === "string" ? file.title.trim() : "";
  const section = typeof file.section_title === "string" ? file.section_title.trim() : "";
  if (title && section && title !== section) {
    return `${title} / ${section}`;
  }
  return title || section;
}

function readableAnswer(snapshot: ResearchSnapshot): string {
  let text = answerText(snapshot.answer);
  for (const file of documentFiles(snapshot.documents)) {
    const citationId = file.citation_id;
    if (citationId === undefined || citationId === null || citationId === "") {
      continue;
    }
    const title = sourceTitle(file);
    if (!title) {
      continue;
    }
    text = text.replaceAll(`[${citationId}]`, `[${title}]`);
  }
  return text;
}

function sourcesFromResearch(snapshot: ResearchSnapshot): CitedSource[] {
  const seen = new Set<string>();
  const sources: CitedSource[] = [];
  for (const file of documentFiles(snapshot.documents)) {
    const title = sourceTitle(file);
    if (!title || seen.has(title)) {
      continue;
    }
    seen.add(title);
    sources.push({ title });
    if (sources.length >= 12) {
      break;
    }
  }
  return sources;
}

function draftText(snapshot: ResearchSnapshot): string {
  const edited = snapshot.draft?.edited_content;
  const content = snapshot.draft?.content;
  return typeof edited === "string" && edited.length > 0 ? edited : (content ?? "");
}

async function readResearchStream(response: Response): Promise<ResearchSnapshot> {
  if (!response.body) {
    throw new Error("Lexroom returned an empty research stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latest: ResearchSnapshot | undefined;
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    latest = snapshotFromLine(JSON.parse(trimmed) as unknown);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      consume(line);
      if (latest?.status === "DONE" || latest?.status === "FAILED") {
        await reader.cancel();
        return latest;
      }
    }
  }
  if (buffer.trim()) {
    consume(buffer);
  }
  if (latest?.status === "DONE" || latest?.status === "FAILED") {
    return latest;
  }
  throw new Error("Lexroom research stream ended before DONE or FAILED");
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  config: LexroomConfig,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: headers(token(config)),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response;
}

async function loadAmaResearch(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  researchId: string,
  signal: AbortSignal,
): Promise<ResearchSnapshot | undefined> {
  const response = await fetchImpl(`${baseUrl(config)}/v1/ask_me_anything/${researchId}`, {
    method: "GET",
    headers: headers(token(config)),
    signal,
  });
  if (response.status === 204 || !response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { research?: unknown };
  if (!body.research || typeof body.research !== "object") {
    return undefined;
  }
  return body.research as ResearchSnapshot;
}

function libraryScope(documentIds: readonly string[] | undefined): {
  search_on_user_data: boolean;
  library_documents?: Array<{ document_ids: string[] }>;
} {
  const ids = (documentIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
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
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs(input.config)),
    ...(input.signal ? [input.signal] : []),
  ]);
  try {
    const modules = (input.modules ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const response = await postJson(
      fetchImpl,
      `${baseUrl(input.config)}/v1/ask_me_anything`,
      input.config,
      {
        query,
        documents: [],
        is_temporary: false,
        ...libraryScope(input.libraryDocumentIds),
        ...(modules.length > 0 ? { search_on_modules: modules } : {}),
        ...(input.parentResearchId?.trim()
          ? { parent_research_id: input.parentResearchId.trim() }
          : {}),
      },
      signal,
    );
    const streamed = await readResearchStream(response);
    const stored =
      streamed.status === "DONE" && streamed.id
        ? await loadAmaResearch(fetchImpl, input.config, streamed.id, signal)
        : undefined;
    const snapshot = stored?.status === "DONE" ? stored : streamed;
    const answered = answerText(snapshot.answer) ? snapshot : streamed;
    const documented =
      documentFiles(snapshot.documents).length > 0 ? snapshot : streamed;
    const merged = { ...answered, documents: documented.documents };
    const researchId = snapshot.id ?? streamed.id;
    return {
      ok: true,
      matterId,
      ...(researchId ? { researchId } : {}),
      status: snapshot.status ?? streamed.status ?? "UNKNOWN",
      answer: clip(readableAnswer(merged)),
      sources: sourcesFromResearch(merged),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Lexroom research failed" };
  }
}

async function selectModules(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<string[]> {
  const response = await postJson(
    fetchImpl,
    `${baseUrl(config)}/v2/ai/drafting/selectors`,
    config,
    { prompt, template: null },
    signal,
  );
  const body = (await response.json()) as { modules?: Array<{ name?: unknown }> };
  const modules = (body.modules ?? [])
    .map((module) => (typeof module.name === "string" ? module.name.trim() : ""))
    .filter((name) => name.length > 0);
  if (modules.length === 0) {
    throw new Error("Lexroom did not select a drafting module for this prompt");
  }
  return modules;
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
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs(input.config)),
    ...(input.signal ? [input.signal] : []),
  ]);
  try {
    const provided = (input.modules ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const modules =
      provided.length > 0 ? provided : await selectModules(fetchImpl, input.config, prompt, signal);
    const response = await postJson(
      fetchImpl,
      `${baseUrl(input.config)}/v2/ai/drafting`,
      input.config,
      {
        prompt,
        documents: [],
        template: null,
        modules,
        ...(input.parentResearchId?.trim()
          ? { parent_research_id: input.parentResearchId.trim() }
          : {}),
      },
      signal,
    );
    const snapshot = await readResearchStream(response);
    return {
      ok: true,
      drafted: true,
      matterId,
      ...(snapshot.id ? { researchId: snapshot.id } : {}),
      status: snapshot.status ?? "UNKNOWN",
      ...(snapshot.draft?.title ? { title: snapshot.draft.title } : {}),
      content: clip(draftText(snapshot)),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Lexroom drafting failed" };
  }
}
