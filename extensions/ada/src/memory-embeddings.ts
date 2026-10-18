import type { MemoryRecord } from "./memory-contract.js";
import { matchesMemoryQuery } from "./memory-render.js";

/** voyage-law-2 vectors; a response of any other size is rejected rather than stored. */
export const EMBEDDING_DIMS = 1024;

const MAX_EMBEDDING_CHARS = 8000;
/** Below this cosine a note that matches no keyword is not related enough to be returned. */
export const MIN_SEMANTIC_SIMILARITY = 0.4;
const KEYWORD_WEIGHT = 0.3;
const EXACT_ALIAS_WEIGHT = 0.2;

/** What a note is embedded as. The store keeps a vector only while this text is unchanged. */
export function embeddingText(record: Pick<MemoryRecord, "title" | "aliases" | "body">): string {
  return [record.title, record.aliases.join(", "), record.body]
    .filter((part) => part.trim() !== "")
    .join("\n")
    .slice(0, MAX_EMBEDDING_CHARS);
}

export function packVector(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

export function unpackVector(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.slice().buffer);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/**
 * Keyword matches (id, title, alias) and meaning matches in one ranking. A note with no vector
 * can still rank on its keyword match, so a half-embedded number degrades to the old behaviour
 * instead of losing notes. Notes without a keyword match need MIN_SEMANTIC_SIMILARITY to appear.
 */
export function rankHybridHits(
  records: readonly MemoryRecord[],
  query: string,
  vectors: ReadonlyMap<string, Float32Array>,
  queryVector: readonly number[],
): MemoryRecord[] {
  const needle = query.trim().toLowerCase();
  return records
    .map((record) => {
      const keyword = matchesMemoryQuery(record, needle);
      const vector = vectors.get(record.id);
      const similarity = vector ? cosine(queryVector, vector) : 0;
      const exact = record.aliases.some((alias) => alias.toLowerCase() === needle);
      const score = similarity + (keyword ? KEYWORD_WEIGHT : 0) + (exact ? EXACT_ALIAS_WEIGHT : 0);
      return { record, keyword, similarity, score };
    })
    .filter((hit) => hit.keyword || hit.similarity >= MIN_SEMANTIC_SIMILARITY)
    .toSorted((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .map((hit) => hit.record);
}
