const DEFAULT_COUNTRY_CODE = "39";
const PHONE_HEADERS = new Set(["phone", "telefono", "numero", "cellulare", "mobile"]);
const NAME_HEADERS = new Set(["name", "nome"]);
const OPT_OUT_PHRASES = new Set(["stop", "basta", "annulla iscrizione"]);

export type Recipient = { phone: string; name?: string };
export type ParsedList = { recipients: Recipient[]; invalid: number; duplicates: number };

/**
 * Normalizes one phone number to E.164 (`+393331234567`). A leading `00` means `+`; a number with
 * neither is Italian unless it already starts with `39` and is too long to be a national number.
 * Returns null when the result cannot be a phone number.
 */
export function normalizePhone(raw: string): string | null {
  let value = raw.replace(/[\s.\-()\u00a0]/gu, "");
  if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }
  const international = value.startsWith("+");
  let digits = international ? value.slice(1) : value;
  if (!/^\d+$/u.test(digits)) {
    return null;
  }
  if (!international && !(digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length >= 11)) {
    digits = `${DEFAULT_COUNTRY_CODE}${digits}`;
  }
  if (digits.startsWith("0")) {
    return null;
  }
  const national = digits.startsWith(DEFAULT_COUNTRY_CODE)
    ? digits.length - DEFAULT_COUNTRY_CODE.length
    : undefined;
  const plausible =
    national === undefined
      ? digits.length >= 8 && digits.length <= 15
      : national >= 6 && national <= 11;
  return plausible ? `+${digits}` : null;
}

/** `+393331234567` becomes `+39*******67`: enough to recognize a number, not to dial it. */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}${"*".repeat(Math.max(phone.length - 5, 1))}${phone.slice(-2)}`;
}

/** The first word of a name, letters only, so it is safe inside a template variable. */
export function firstName(raw: string | undefined): string | undefined {
  const word = raw
    ?.trim()
    .split(/\s+/u)[0]
    ?.replace(/[^\p{L}\p{M}'’-]/gu, "");
  return word ? word.slice(0, 40) : undefined;
}

/** True when the whole message is a request to stop receiving messages. */
export function isOptOutText(text: string): boolean {
  const phrase = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return OPT_OUT_PHRASES.has(phrase);
}

function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Reads a list of numbers, one per row, each with an optional name: `number`, `number,name`, or a
 * header row naming a phone/telefono column and optionally a name/nome column. Cells are
 * separated by comma, semicolon or tab, whichever the first row uses. Repeated numbers count
 * once; a row without a usable number counts as invalid.
 */
export function parseRecipientList(text: string): ParsedList {
  const lines = text
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim());
  const delimiter = [";", "\t", ","].find((candidate) => lines[0]?.includes(candidate)) ?? ",";
  const rows = lines.map((line) => splitRow(line, delimiter));
  const header = rows[0]?.map((cell) => cell.toLowerCase());
  const hasHeader = header?.some((cell) => PHONE_HEADERS.has(cell) || NAME_HEADERS.has(cell));
  const phoneColumn = hasHeader
    ? Math.max(header?.findIndex((c) => PHONE_HEADERS.has(c)) ?? 0, 0)
    : 0;
  const nameColumn = hasHeader ? (header?.findIndex((c) => NAME_HEADERS.has(c)) ?? -1) : 1;

  const seen = new Set<string>();
  const result: ParsedList = { recipients: [], invalid: 0, duplicates: 0 };
  for (const row of hasHeader ? rows.slice(1) : rows) {
    const phone = normalizePhone(row[phoneColumn] ?? "");
    if (!phone) {
      result.invalid += 1;
    } else if (seen.has(phone)) {
      result.duplicates += 1;
    } else {
      seen.add(phone);
      const name = firstName(nameColumn >= 0 ? row[nameColumn] : undefined);
      result.recipients.push(name ? { phone, name } : { phone });
    }
  }
  return result;
}
