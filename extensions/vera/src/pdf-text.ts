import { inflateSync } from "node:zlib";

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_STREAM_INFLATED = 4 * 1024 * 1024;
const MAX_STREAMS = 400;
const MAX_TEXT_CHARS = 20_000;

type Operand = number | string | Operand[];

const WIN_1252_HIGH: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

function decodeBytes(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
    }
    return text;
  }
  let text = "";
  for (const byte of bytes) {
    text += byte >= 0x80 && byte <= 0x9f ? (WIN_1252_HIGH[byte] ?? "") : String.fromCharCode(byte);
  }
  return text;
}

type Cursor = { src: string; pos: number };

function readLiteralString(cursor: Cursor): string {
  const { src } = cursor;
  const bytes: number[] = [];
  let depth = 1;
  cursor.pos += 1;
  while (cursor.pos < src.length && depth > 0) {
    const char = src[cursor.pos] ?? "";
    cursor.pos += 1;
    if (char === "\\") {
      const next = src[cursor.pos] ?? "";
      cursor.pos += 1;
      if (/[0-7]/u.test(next)) {
        let octal = next;
        while (octal.length < 3 && /[0-7]/u.test(src[cursor.pos] ?? "")) {
          octal += src[cursor.pos];
          cursor.pos += 1;
        }
        bytes.push(Number.parseInt(octal, 8) & 0xff);
      } else if (next === "n") {
        bytes.push(10);
      } else if (next === "r") {
        bytes.push(13);
      } else if (next === "t") {
        bytes.push(9);
      } else if (next === "b") {
        bytes.push(8);
      } else if (next === "f") {
        bytes.push(12);
      } else if (next === "\r") {
        if (src[cursor.pos] === "\n") {
          cursor.pos += 1;
        }
      } else if (next !== "\n") {
        bytes.push(next.charCodeAt(0) & 0xff);
      }
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return decodeBytes(bytes);
}

function readHexString(cursor: Cursor): string {
  const end = cursor.src.indexOf(">", cursor.pos);
  const hex = cursor.src
    .slice(cursor.pos + 1, end === -1 ? cursor.src.length : end)
    .replace(/[^0-9a-f]/giu, "");
  cursor.pos = end === -1 ? cursor.src.length : end + 1;
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  }
  return decodeBytes(bytes);
}

function readArray(cursor: Cursor): Operand[] {
  cursor.pos += 1;
  const items: Operand[] = [];
  while (cursor.pos < cursor.src.length) {
    const char = cursor.src[cursor.pos] ?? "";
    if (char === "]") {
      cursor.pos += 1;
      break;
    }
    if (char === "(") {
      items.push(readLiteralString(cursor));
    } else if (char === "<") {
      items.push(readHexString(cursor));
    } else if (/[\d+.-]/u.test(char)) {
      const match = /^[+-]?\d*\.?\d+/u.exec(cursor.src.slice(cursor.pos, cursor.pos + 24));
      cursor.pos += match ? match[0].length : 1;
      items.push(match ? Number(match[0]) : 0);
    } else {
      cursor.pos += 1;
    }
  }
  return items;
}

function textFromContentStream(content: string): string {
  const cursor: Cursor = { src: content, pos: 0 };
  const stack: Operand[] = [];
  let out = "";
  let lastTmY: number | null = null;

  const newline = () => {
    if (out && !out.endsWith("\n")) {
      out += "\n";
    }
  };
  const space = () => {
    if (out && !/\s$/u.test(out)) {
      out += " ";
    }
  };
  const show = (operand: Operand | undefined) => {
    if (typeof operand === "string") {
      out += operand;
    } else if (Array.isArray(operand)) {
      for (const part of operand) {
        if (typeof part === "string") {
          out += part;
        } else if (typeof part === "number" && part < -200) {
          space();
        }
      }
    }
  };

  while (cursor.pos < content.length && out.length < MAX_TEXT_CHARS * 2) {
    const char = content[cursor.pos] ?? "";
    if (char === "(") {
      stack.push(readLiteralString(cursor));
    } else if (char === "<" && content[cursor.pos + 1] !== "<") {
      stack.push(readHexString(cursor));
    } else if (char === "[") {
      stack.push(readArray(cursor));
    } else if (/[+\-.\d]/u.test(char)) {
      const match = /^[+-]?\d*\.?\d+/u.exec(content.slice(cursor.pos, cursor.pos + 24));
      cursor.pos += match ? match[0].length : 1;
      stack.push(match ? Number(match[0]) : 0);
    } else if (/[A-Za-z'"*]/u.test(char)) {
      const match = /^[A-Za-z'"*]+/u.exec(content.slice(cursor.pos, cursor.pos + 8));
      const operator = match ? match[0] : char;
      cursor.pos += operator.length;
      switch (operator) {
        case "Tj":
        case "TJ":
          show(stack.at(-1));
          break;
        case "'":
        case '"':
          newline();
          show(stack.at(-1));
          break;
        case "T*":
          newline();
          break;
        case "Td":
        case "TD": {
          const ty = stack.at(-1);
          const tx = stack.at(-2);
          if (typeof ty === "number" && ty !== 0) {
            newline();
          } else if (typeof tx === "number" && tx !== 0) {
            space();
          }
          break;
        }
        case "Tm": {
          const y = stack.at(-1);
          if (typeof y === "number") {
            if (lastTmY !== null && y !== lastTmY) {
              newline();
            } else if (lastTmY !== null) {
              space();
            }
            lastTmY = y;
          }
          break;
        }
        case "ET":
          newline();
          break;
        default:
          break;
      }
      stack.length = 0;
    } else {
      cursor.pos += 1;
    }
  }
  return out;
}

function looksLikeText(text: string): boolean {
  const sample = text.slice(0, 2000);
  if (sample.length < 8) {
    return sample.length > 0;
  }
  const readable = sample.replace(/[^\p{L}\p{N}\s.,;:'"()/%€@°-]/gu, "").length;
  return readable / sample.length > 0.8;
}

/**
 * Best-effort text from a PDF without a PDF library: Flate-compressed or plain
 * content streams with standard text operators. Scanned pages and fonts with custom
 * encodings yield no text, and the caller then falls back to the email body.
 */
export function extractPdfText(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) {
    return "";
  }
  const raw = Buffer.from(bytes).toString("latin1");
  if (!raw.startsWith("%PDF")) {
    return "";
  }
  const pages: string[] = [];
  let streams = 0;
  let from = 0;
  while (streams < MAX_STREAMS) {
    const keyword = raw.indexOf("stream", from);
    if (keyword === -1) {
      break;
    }
    from = keyword + 6;
    if (raw.slice(keyword - 3, keyword) === "end") {
      continue;
    }
    let start = keyword + 6;
    if (raw[start] === "\r") {
      start += 1;
    }
    if (raw[start] === "\n") {
      start += 1;
    }
    const end = raw.indexOf("endstream", start);
    if (end === -1) {
      break;
    }
    from = end + 9;
    streams += 1;
    const dictionary = raw.slice(Math.max(0, keyword - 400), keyword);
    const dictStart = dictionary.lastIndexOf("obj");
    const header = dictStart === -1 ? dictionary : dictionary.slice(dictStart);
    let data = Buffer.from(raw.slice(start, end), "latin1");
    if (/\/FlateDecode/u.test(header)) {
      try {
        data = inflateSync(data, { maxOutputLength: MAX_STREAM_INFLATED });
      } catch {
        continue;
      }
    } else if (/\/Filter/u.test(header)) {
      continue;
    }
    const content = data.toString("latin1");
    if (!/\bBT\b/u.test(content)) {
      continue;
    }
    const text = textFromContentStream(content).trim();
    if (text) {
      pages.push(text);
    }
  }
  const joined = pages
    .join("\n\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!looksLikeText(joined)) {
    return "";
  }
  return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
}
