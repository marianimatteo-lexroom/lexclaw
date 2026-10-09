import type { MemoryRecord } from "./memory-contract.js";

/**
 * Instinct-style page: frontmatter, fact lines, and [[links]].
 * The answering model reads this text; search uses aliases, not embeddings.
 */
export function renderMemoryPage(record: MemoryRecord): string {
  const aliases = record.aliases.map((alias) => JSON.stringify(alias)).join(", ");
  return [
    "---",
    `id: ${record.id}`,
    `type: ${record.type}`,
    `matter: ${record.matterId || "lawyer"}`,
    `folder: ${record.folder}`,
    `aliases: [${aliases}]`,
    "---",
    record.body.trim(),
    "",
  ].join("\n");
}

/** Case-insensitive substring match on id, title, and aliases. Misspellings do not hit. */
export function matchesMemoryQuery(record: MemoryRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  if (record.id.toLowerCase().includes(needle)) {
    return true;
  }
  if (record.title.toLowerCase().includes(needle)) {
    return true;
  }
  return record.aliases.some((alias) => alias.toLowerCase().includes(needle));
}

export function rankMemoryHits(records: readonly MemoryRecord[], query: string): MemoryRecord[] {
  const needle = query.trim().toLowerCase();
  return records
    .filter((record) => matchesMemoryQuery(record, needle))
    .toSorted((a, b) => {
      const aExact = a.aliases.some((alias) => alias.toLowerCase() === needle) ? 0 : 1;
      const bExact = b.aliases.some((alias) => alias.toLowerCase() === needle) ? 0 : 1;
      if (aExact !== bExact) {
        return aExact - bExact;
      }
      return a.id.localeCompare(b.id);
    });
}

/** Pick a matter when an email or event text contains one of that matter's aliases. */
export function matchMatterId(
  text: string,
  aliases: readonly { matterId: string; alias: string }[],
): string | null {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) {
    return null;
  }
  let best: { matterId: string; alias: string } | null = null;
  for (const entry of aliases) {
    const alias = entry.alias.trim().toLowerCase();
    if (alias.length < 2 || !haystack.includes(alias)) {
      continue;
    }
    if (!best || alias.length > best.alias.length) {
      best = { matterId: entry.matterId, alias };
    }
  }
  return best?.matterId ?? null;
}
