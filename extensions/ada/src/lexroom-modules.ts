/** Last-resort list when `GET /v1/user/modules` is unavailable. */
export const FALLBACK_MODULES: readonly string[] = [
  "Privacy e Data Protection",
  "IP",
  "Lavoro",
  "Civile",
  "Societario",
  "Famiglia",
  "Tributario",
  "Banking",
  "Amministrativo",
  "Penale",
  "Diritto dei Consumatori",
  "real_estate_it",
  "business_distress_it",
  "compliance_it",
  "school_law_it",
];

export const MODULES_TTL_MS = 60 * 60 * 1000;

const LIST_KEYS = ["modules", "data", "items", "results", "available_modules"];
const NAME_KEYS = ["name", "module", "title", "id", "slug", "key"];

/** Pulls module names out of the response shapes `/v1/user/modules` has been seen to use. */
export function normalizeModules(data: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(data)) {
    raw = data;
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const key = LIST_KEYS.find((candidate) => Array.isArray(record[candidate]));
    raw = key ? (record[key] as unknown[]) : [];
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      names.push(item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of NAME_KEYS) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
          names.push(value.trim());
          break;
        }
      }
    }
  }
  return [...new Set(names)];
}

/** The requested modules the user may search, or every available module when none match. */
export function chooseModules(
  requested: readonly string[],
  available: readonly string[],
): string[] {
  const allowed = new Set(available);
  const picked = requested.filter((name) => allowed.has(name));
  return picked.length > 0 ? picked : [...available];
}
