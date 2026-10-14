const MAX_DEPTH = 4;
const MAX_PDFS = 3;
const MAX_TEXT_CHARS = 20_000;

export type MimeContent = {
  text: string;
  pdfs: Array<{ filename: string; bytes: Buffer }>;
};

type Headers = Map<string, string>;

function splitHeaders(raw: string): { headers: Headers; body: string } {
  const boundary = /\r?\n\r?\n/u.exec(raw);
  const head = boundary ? raw.slice(0, boundary.index) : raw;
  const body = boundary ? raw.slice(boundary.index + boundary[0].length) : "";
  const headers: Headers = new Map();
  let last = "";
  for (const line of head.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line) && last) {
      headers.set(last, `${headers.get(last) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      last = line.slice(0, colon).trim().toLowerCase();
      headers.set(last, line.slice(colon + 1).trim());
    }
  }
  return { headers, body };
}

function parameter(value: string, name: string): string | null {
  const match = new RegExp(`${name}\\*?="?([^";]+)"?`, "iu").exec(value);
  return match?.[1]?.trim() ?? null;
}

function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replace(/[=]\r?\n/gu, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const char = joined[i] ?? "";
    if (char === "=" && /^[0-9A-F]{2}$/iu.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, headers: Headers): Buffer {
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (encoding === "base64") {
    return Buffer.from(body.replace(/\s+/gu, ""), "base64");
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return Buffer.from(body, "latin1");
}

function decodeText(bytes: Buffer, contentType: string): string {
  const charset = (parameter(contentType, "charset") ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/giu, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/[ \t]+/gu, " ");
}

function walk(
  raw: string,
  depth: number,
  out: { plain: string[]; html: string[]; pdfs: MimeContent["pdfs"] },
): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  const { headers, body } = splitHeaders(raw);
  const contentType = headers.get("content-type") ?? "text/plain";
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
  const disposition = headers.get("content-disposition") ?? "";
  const filename = parameter(disposition, "filename") ?? parameter(contentType, "name") ?? "";

  if (type.startsWith("multipart/")) {
    const boundary = parameter(contentType, "boundary");
    if (!boundary) {
      return;
    }
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) {
        break;
      }
      walk(part.replace(/^\r?\n/u, ""), depth + 1, out);
    }
    return;
  }
  if (type === "message/rfc822") {
    walk(body, depth + 1, out);
    return;
  }
  if (type === "application/pdf" || /\.pdf$/iu.test(filename)) {
    if (out.pdfs.length < MAX_PDFS) {
      out.pdfs.push({ filename: filename || "attachment.pdf", bytes: decodeBody(body, headers) });
    }
    return;
  }
  if (filename) {
    return;
  }
  if (type === "text/plain") {
    out.plain.push(decodeText(decodeBody(body, headers), contentType));
  } else if (type === "text/html") {
    out.html.push(htmlToText(decodeText(decodeBody(body, headers), contentType)));
  }
}

/**
 * Text and PDFs from a raw RFC 822 message. PEC providers wrap the real notice in a
 * `postacert.eml` attachment, so the Gmail body alone does not carry it.
 */
export function parseRawMime(raw: Buffer): MimeContent {
  const out = { plain: [] as string[], html: [] as string[], pdfs: [] as MimeContent["pdfs"] };
  walk(raw.toString("latin1"), 0, out);
  const text = (out.plain.length > 0 ? out.plain : out.html).join("\n").trim();
  return {
    text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
    pdfs: out.pdfs,
  };
}
