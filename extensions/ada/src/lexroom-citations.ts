const MAX_SOURCES = 30;
const TYPE_NORMATIVA = 1;
const TYPE_GIURISPRUDENZA = 3;

/** A Lexroom citation reduced to what a lawyer reads on WhatsApp. */
export type CitedSource = {
  /** Matches the `[n]` marker in the answer or draft text. */
  id: number;
  title: string;
  /** Court that issued a decision, when Lexroom names it. */
  court?: string;
  /** dd/mm/yyyy, case law only. */
  date?: string;
};

const COURT =
  /^(suprema corte|corte\b|tribunale|t\.?a\.?r\b|consiglio di stato|giudice di pace|commissione tributaria)/iu;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sentenceCase(value: string): string {
  const letters = value.replace(/[^\p{L}]/gu, "");
  if (!letters || letters !== letters.toUpperCase()) {
    return value;
  }
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "CODICE CIVILE" + "CODICE CIVILE-art. 1454" becomes "Codice civile, art. 1454". */
function normTitle(file: Record<string, unknown>): string {
  const title = text(file.title);
  const section = file.section_title;
  const parts = Array.isArray(section) ? section.map(text).filter(Boolean) : [];
  const code = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  if (!code) {
    return [title, text(section)].filter(Boolean).join(", ");
  }
  const article = last?.startsWith(`${code}-`) ? last.slice(code.length + 1).trim() : last;
  return [sentenceCase(code), article].filter(Boolean).join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSource(file: Record<string, unknown>, typeId: unknown): CitedSource | undefined {
  const id = typeof file.citation_id === "number" ? file.citation_id : Number(file.citation_id);
  if (!Number.isInteger(id)) {
    return undefined;
  }
  const isCase = typeId === TYPE_GIURISPRUDENZA || (typeId !== TYPE_NORMATIVA && "massima" in file);
  const title = typeId === TYPE_NORMATIVA ? normTitle(file) : text(file.title);
  if (!title) {
    return undefined;
  }
  if (!isCase) {
    return { id, title };
  }
  // `author` is the court for some decisions and the judge's name for others.
  const author = text(file.author);
  const court = COURT.test(author) ? author : undefined;
  const date = text(file.time);
  return { id, title, ...(court ? { court } : {}), ...(date ? { date } : {}) };
}

/** Flattens Lexroom's grouped citations (`documents[]` in research, `sources[]` in drafts). */
export function citationIndex(groups: unknown): Map<number, CitedSource> {
  const index = new Map<number, CitedSource>();
  if (!Array.isArray(groups)) {
    return index;
  }
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.files)) {
      continue;
    }
    for (const file of group.files) {
      const source = isRecord(file) ? toSource(file, group.type_id) : undefined;
      if (source && !index.has(source.id)) {
        index.set(source.id, source);
      }
    }
  }
  return index;
}

/** Sources actually cited by `[n]` markers in the given texts, in citation order. */
export function citedSources(groups: unknown, ...texts: string[]): CitedSource[] {
  const index = citationIndex(groups);
  const cited = new Set<number>();
  for (const body of texts) {
    for (const match of body.matchAll(/\[(\d{1,4})\]/gu)) {
      cited.add(Number(match[1]));
    }
  }
  return [...cited]
    .toSorted((a, b) => a - b)
    .flatMap((id) => index.get(id) ?? [])
    .slice(0, MAX_SOURCES);
}

export function formatSource(source: CitedSource): string {
  const court =
    source.court && !source.title.toLowerCase().includes(source.court.toLowerCase())
      ? ` - ${source.court}`
      : "";
  return `[${source.id}] ${source.title}${court}${source.date ? `, ${source.date}` : ""}`;
}

export function formatSources(sources: readonly CitedSource[]): string {
  return sources.map(formatSource).join("\n");
}

/** WhatsApp has no headings or tables and uses single asterisks for bold. */
export function toWhatsAppText(markdown: string): string {
  return markdown
    .replaceAll("</END>", "")
    .split("\n")
    .flatMap((line) => {
      if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/u.test(line) && line.includes("|")) {
        return [];
      }
      const row = /^\s*\|(.+)\|\s*$/u.exec(line);
      const plain = row
        ? (row[1] ?? "")
            .split("|")
            .map((cell) => cell.trim())
            .join(" | ")
        : line;
      const unbolded = plain.replace(/\*\*(.+?)\*\*/gu, "*$1*");
      const heading = /^#{1,6}\s+(.*)$/u.exec(unbolded);
      return [heading ? `*${(heading[1] ?? "").replaceAll("*", "").trim()}*` : unbolded];
    })
    .join("\n")
    .trim();
}
