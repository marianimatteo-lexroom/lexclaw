import { readAdaEnv } from "./ada-env.js";
import { maskNumber } from "./inbound-log.js";
import { EMBEDDING_DIMS } from "./memory-embeddings.js";
import type { MemoryStore } from "./memory.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
export const DEFAULT_EMBEDDING_MODEL = "voyage-law-2";
const QUERY_TIMEOUT_MS = 3_000;
const DOCUMENT_TIMEOUT_MS = 10_000;
const DOCUMENT_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 20_000;
/** Free-tier limits are low: after a 429 no request is sent for this long. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const ERROR_COOLDOWN_MS = 15_000;
/** Notes embedded per background pass: a handful per request keeps token use under free-tier limits. */
export const BACKFILL_BATCH = 8;

export type VoyageEmbedder = {
  /** The embedding model while VOYAGE_API_KEY is set, null otherwise. */
  model(): string | null;
  /** Vectors in input order, or null on any failure; never throws. */
  embed(texts: string[], kind: "document" | "query"): Promise<number[][] | null>;
};

type EmbedderDeps = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function vectorsOf(body: unknown, count: number): number[][] | null {
  const data = (body as { data?: Array<{ index?: number; embedding?: unknown }> } | null)?.data;
  if (!Array.isArray(data) || data.length !== count) {
    return null;
  }
  const vectors: number[][] = [];
  for (const [position, entry] of data.entries()) {
    const embedding = entry?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIMS ||
      !embedding.every((value) => typeof value === "number")
    ) {
      return null;
    }
    vectors[entry.index ?? position] = embedding;
  }
  return vectors.length === count && vectors.every(Boolean) ? vectors : null;
}

/**
 * Voyage embeddings over plain fetch. Searches get one 3s attempt so a reply is never held up;
 * background document batches retry a 429 with backoff. After a failure the embedder stays quiet
 * for a cooldown, so an outage or rate limit costs at most one slow request.
 */
export function createVoyageEmbedder(deps: EmbedderDeps = {}): VoyageEmbedder {
  const env = () => deps.env ?? process.env;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((done) => {
        setTimeout(done, ms);
      }));
  const now = deps.now ?? Date.now;
  let quietUntil = 0;

  const apiKey = () => env().VOYAGE_API_KEY?.trim() || null;
  const model = () =>
    apiKey() ? (readAdaEnv(env(), "MEMORY_EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL) : null;

  return {
    model,
    async embed(texts, kind) {
      const key = apiKey();
      const modelName = model();
      if (!key || !modelName || texts.length === 0 || now() < quietUntil) {
        return null;
      }
      const attempts = kind === "query" ? 1 : DOCUMENT_ATTEMPTS;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await (deps.fetch ?? fetch)(VOYAGE_URL, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ input: texts, model: modelName, input_type: kind }),
            signal: AbortSignal.timeout(kind === "query" ? QUERY_TIMEOUT_MS : DOCUMENT_TIMEOUT_MS),
          });
          if (response.status === 429) {
            const wait = Math.min(
              retryAfterMs(response) ?? 2_000 * 2 ** (attempt - 1),
              MAX_RETRY_WAIT_MS,
            );
            if (attempt < attempts) {
              await sleep(wait);
              continue;
            }
            quietUntil = now() + RATE_LIMIT_COOLDOWN_MS;
            return null;
          }
          if (!response.ok) {
            quietUntil = now() + ERROR_COOLDOWN_MS;
            return null;
          }
          return vectorsOf(await response.json(), texts.length);
        } catch {
          quietUntil = now() + ERROR_COOLDOWN_MS;
          return null;
        }
      }
      return null;
    },
  };
}

export const voyageEmbedder = createVoyageEmbedder();

export type EmbeddedMemoryStore = MemoryStore & {
  /** Resolves when no background embedding pass is running. */
  settled(): Promise<void>;
};

/**
 * One number's store with meaning-based recall. Notes are embedded in the background (the write
 * has already returned) and searched by blending keyword and vector similarity. Every failure
 * path ends in the plain keyword store, so a reply never depends on Voyage. Vectors live in the
 * same per-number file and only that file's vectors are read.
 */
export function withEmbeddings(
  store: MemoryStore,
  params: { owner: string; embedder: VoyageEmbedder; log?: (message: string) => void },
): EmbeddedMemoryStore {
  let running: Promise<void> | null = null;
  let rerun = false;

  async function pass(): Promise<void> {
    const model = params.embedder.model();
    if (!model) {
      return;
    }
    const pending = await store.listUnembedded(model, BACKFILL_BATCH);
    if (pending.length === 0) {
      return;
    }
    const vectors = await params.embedder.embed(
      pending.map((note) => note.text),
      "document",
    );
    if (!vectors) {
      params.log?.(
        `ada memory embeddings deferred pending=${pending.length} owner=${maskNumber(params.owner)}`,
      );
      return;
    }
    const stored = await store.storeEmbeddings(
      model,
      pending.flatMap((note, index) => {
        const vector = vectors[index];
        return vector ? [{ ...note, vector }] : [];
      }),
    );
    params.log?.(`ada memory embeddings stored=${stored} owner=${maskNumber(params.owner)}`);
  }

  function schedule(): void {
    if (!params.embedder.model()) {
      return;
    }
    if (running) {
      rerun = true;
      return;
    }
    running = (async () => {
      do {
        rerun = false;
        try {
          await pass();
        } catch (error) {
          params.log?.(
            `ada memory embeddings failed error=${error instanceof Error ? error.name : "unknown"} owner=${maskNumber(params.owner)}`,
          );
        }
      } while (rerun);
    })().finally(() => {
      running = null;
    });
  }

  return {
    ...store,
    async upsertRecord(record, reason, atMs) {
      await store.upsertRecord(record, reason, atMs);
      schedule();
    },
    async searchRecords(query, matterId) {
      const model = params.embedder.model();
      if (!model) {
        return await store.searchRecords(query, matterId);
      }
      const queryVector = (await params.embedder.embed([query], "query"))?.[0];
      schedule();
      return await store.searchRecords(
        query,
        matterId,
        queryVector ? { queryVector, model } : undefined,
      );
    },
    async settled() {
      await running;
    },
  };
}
