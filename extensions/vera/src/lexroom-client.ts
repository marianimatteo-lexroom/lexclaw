export const DEFAULT_LEXROOM_BASE_URL = "https://api.lexroom.ai";
export const LEXROOM_CLIENT_TYPE = "app_lex";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ANSWER_CHARS = 24_000;

export type LexroomConfig = {
  accessToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
};

type ResearchSnapshot = {
  id?: string;
  status?: string;
  answer?: { text?: string };
  draft?: { id?: string; title?: string; content?: string };
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
    const parsed = JSON.parse(trimmed) as { research?: ResearchSnapshot };
    if (!parsed.research || typeof parsed.research !== "object") {
      throw new Error("Lexroom stream line did not contain a research snapshot");
    }
    latest = parsed.research;
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

async function citedSources(
  fetchImpl: FetchLike,
  config: LexroomConfig,
  researchId: string,
  signal: AbortSignal,
): Promise<CitedSource[]> {
  const response = await fetchImpl(`${baseUrl(config)}/v1/cited_public_sources/${researchId}`, {
    method: "GET",
    headers: headers(token(config)),
    signal,
  });
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { cited_sources?: unknown };
  if (!Array.isArray(body.cited_sources)) {
    return [];
  }
  return body.cited_sources
    .map((source) => {
      if (!source || typeof source !== "object") {
        return undefined;
      }
      const title = (source as { title?: unknown }).title;
      return typeof title === "string" && title.trim() ? { title: title.trim() } : undefined;
    })
    .filter((source): source is CitedSource => source !== undefined)
    .slice(0, 12);
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
        ...libraryScope(input.libraryDocumentIds),
        ...(modules.length > 0 ? { search_on_modules: modules } : {}),
        ...(input.parentResearchId?.trim()
          ? { parent_research_id: input.parentResearchId.trim() }
          : {}),
      },
      signal,
    );
    const snapshot = await readResearchStream(response);
    const sources =
      snapshot.status === "DONE" && snapshot.id
        ? await citedSources(fetchImpl, input.config, snapshot.id, signal)
        : [];
    return {
      ok: true,
      matterId,
      ...(snapshot.id ? { researchId: snapshot.id } : {}),
      status: snapshot.status ?? "UNKNOWN",
      answer: clip(snapshot.answer?.text),
      sources,
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
    { prompt },
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
      content: clip(snapshot.draft?.content),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Lexroom drafting failed" };
  }
}
