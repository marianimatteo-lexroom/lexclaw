import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { formatSource, type CitedSource } from "./lexroom-citations.js";
import type { Language } from "./research-link-outbound.js";

/**
 * A one-page A4 summary of a finished research, sent next to the text answer. The answer is
 * condensed, never shrunk: type sizes are fixed, and the summary, then the key points, then the
 * sources are added only while they fit, with a note pointing to the full research at the link.
 */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const HEADER_H = 58;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const FOOTER_H = 66;
const BODY = { size: 10, lead: 14.5 };
const SMALL = { size: 9, lead: 12.5 };
const BULLET_INDENT = 13;

const MAX_TITLE_CHARS = 170;
const MAX_TITLE_LINES = 3;
const MAX_SUMMARY_CHARS = 760;
const MAX_SUMMARY_LINES = 11;
const MAX_POINT_CHARS = 250;
const MAX_POINTS = 7;
const MIN_SOURCES_KEPT = 3;
const MAX_SLUG_CHARS = 40;
const TIME_ZONE = "Europe/Rome";

const INK = rgb(0.067, 0.094, 0.153);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.86, 0.88, 0.91);
const BAND = rgb(0.118, 0.161, 0.231);
const ACCENT = rgb(0.2, 0.255, 0.333);
const LINK = rgb(0.114, 0.306, 0.847);

type Labels = {
  subtitle: string;
  summary: string;
  points: string;
  sources: string;
  fullResearch: string;
  truncated: string;
  locale: string;
};

const LABELS: Record<Language, Labels> = {
  it: {
    subtitle: "Ricerca legale",
    summary: "Sintesi",
    points: "Punti chiave",
    sources: "Fonti principali",
    fullResearch: "Ricerca completa su Lexroom:",
    truncated: "Riepilogo abbreviato: il testo integrale della ricerca è al link.",
    locale: "it-IT",
  },
  en: {
    subtitle: "Legal research",
    summary: "Summary",
    points: "Key points",
    sources: "Main sources",
    fullResearch: "Full research in Lexroom:",
    truncated: "Shortened summary: the full research is at the link.",
    locale: "en-GB",
  },
  es: {
    subtitle: "Investigación jurídica",
    summary: "Resumen",
    points: "Puntos clave",
    sources: "Fuentes principales",
    fullResearch: "Investigación completa en Lexroom:",
    truncated: "Resumen abreviado: la investigación completa está en el enlace.",
    locale: "es-ES",
  },
  fr: {
    subtitle: "Recherche juridique",
    summary: "Synthèse",
    points: "Points clés",
    sources: "Sources principales",
    fullResearch: "Recherche complète sur Lexroom :",
    truncated: "Synthèse abrégée : la recherche complète est au lien.",
    locale: "fr-FR",
  },
  de: {
    subtitle: "Juristische Recherche",
    summary: "Zusammenfassung",
    points: "Kernpunkte",
    sources: "Wichtigste Quellen",
    fullResearch: "Vollständige Recherche in Lexroom:",
    truncated: "Gekürzte Fassung: die vollständige Recherche steht unter dem Link.",
    locale: "de-DE",
  },
};

export type ResearchPdfInput = {
  /** The question or topic the research answered. */
  query: string;
  /** The answer in WhatsApp formatting, with its `[n]` markers. */
  answer: string;
  sources: readonly CitedSource[];
  /** The research in the Lexroom web app; left out of the page when absent. */
  researchUrl?: string;
  language: Language;
  now?: Date;
};

export type ResearchPdf = { filename: string; bytes: Uint8Array<ArrayBuffer> };

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Cuts at a sentence end or word boundary, marking the cut with an ellipsis. */
function clip(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) {
    return { text, cut: false };
  }
  const head = text.slice(0, limit);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "));
  const at = sentence > limit * 0.6 ? sentence + 1 : head.lastIndexOf(" ");
  const kept = (at > limit * 0.4 ? head.slice(0, at) : head).trimEnd().replace(/[,;:]$/u, "");
  return { text: /[.!?]$/u.test(kept) ? kept : `${kept}…`, cut: true };
}

const BULLET = /^\s*(?:[-•–—*]|\d{1,2}[.)])\s+(.*)$/u;
const BOLD_LINE = /^\s*\*[^*\n]+\*\s*:?\s*$/u;

function plain(text: string): string {
  return collapse(
    text
      .replace(/\*([^*\n]+)\*/gu, "$1")
      .replace(/<\/?[a-z][^>]*>/giu, "")
      .replaceAll("`", ""),
  );
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ[])/u)
    .map(collapse)
    .filter(Boolean);
}

/**
 * The paragraphs, bullets and sentences a one-page summary is made from. Headings are dropped
 * because the page has its own; sources are listed separately and never read from the text.
 */
function condense(answer: string): { summary: string; points: string[]; summaryCut: boolean } {
  const paragraphs: string[] = [];
  const bullets: string[] = [];
  let open: string[] = [];
  const flush = () => {
    if (open.length > 0) {
      paragraphs.push(plain(open.join(" ")));
      open = [];
    }
  };
  for (const line of answer.split("\n")) {
    const bullet = BULLET.exec(line);
    if (!line.trim() || BOLD_LINE.test(line) || bullet) {
      flush();
    }
    if (bullet) {
      const text = plain(bullet[1] ?? "");
      if (text) {
        bullets.push(text);
      }
    } else if (line.trim() && !BOLD_LINE.test(line)) {
      open.push(line);
    }
  }
  flush();
  const body = paragraphs.filter(Boolean);

  const lead = body.length > 0 ? body : bullets.splice(0, 1);
  const leadSentences = lead.flatMap(sentences);
  let summary = "";
  let used = 0;
  for (const sentence of leadSentences) {
    if (summary && summary.length + sentence.length + 1 > MAX_SUMMARY_CHARS) {
      break;
    }
    summary = summary ? `${summary} ${sentence}` : sentence;
    used += 1;
  }
  const clipped = clip(summary, MAX_SUMMARY_CHARS);

  const rest = leadSentences.slice(used);
  const candidates = bullets.length >= 2 ? bullets : [...bullets, ...rest];
  const points = candidates
    .slice(0, MAX_POINTS)
    .map((point) => clip(point, MAX_POINT_CHARS).text)
    .filter(Boolean);
  const dropped = candidates.length > points.length;
  return { summary: clipped.text, points, summaryCut: clipped.cut || dropped };
}

/** The characters Helvetica's WinAnsi encoding can draw; anything else would throw. */
function drawable(text: string, font: PDFFont): string {
  const supported = font.getCharacterSet();
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (supported.includes(code)) {
      out += char;
    } else if (/\s/u.test(char)) {
      out += " ";
    } else if (code >= 0x20) {
      out += "?";
    }
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  const fits = (candidate: string) => font.widthOfTextAtSize(candidate, size) <= width;
  for (const word of text.split(" ").filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    let rest = word;
    while (!fits(rest)) {
      let end = rest.length - 1;
      while (end > 1 && !fits(rest.slice(0, end))) {
        end -= 1;
      }
      lines.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    line = rest;
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "text"; lines: string[]; style: typeof BODY; indent: number; bullet: boolean };

const HEADING_H = 30;
const BLOCK_GAP = 5;

function blockHeight(block: Block): number {
  return block.kind === "heading"
    ? HEADING_H
    : block.lines.length * block.style.lead + (block.bullet ? BLOCK_GAP : 0);
}

function dateParts(now: Date, locale: string): { iso: string; long: string } {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const long = new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  return { iso, long };
}

function slugOf(query: string): string {
  const slug = query
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug.length <= MAX_SLUG_CHARS) {
    return slug;
  }
  const head = slug.slice(0, MAX_SLUG_CHARS);
  const at = head.lastIndexOf("-");
  return (at > MAX_SLUG_CHARS / 2 ? head.slice(0, at) : head).replace(/-+$/u, "");
}

/** `lexroom-ricerca-<short-slug>-<yyyy-mm-dd>.pdf`, ASCII only. */
export function researchPdfFilename(query: string, isoDate: string): string {
  const slug = slugOf(query);
  return `lexroom-ricerca-${slug ? `${slug}-` : ""}${isoDate}.pdf`;
}

function linkAnnotation(
  pdf: PDFDocument,
  page: PDFPage,
  rect: [number, number, number, number],
  url: string,
): void {
  const annotation = pdf.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: rect,
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
  });
  page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(annotation)]));
}

/** Builds the one-page PDF. Throws only on an internal error; callers treat the PDF as optional. */
export async function buildResearchPdf(input: ResearchPdfInput): Promise<ResearchPdf> {
  const labels = LABELS[input.language];
  const now = input.now ?? new Date();
  const date = dateParts(now, labels.locale);

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = (text: string, font: PDFFont = regular) => drawable(text, font);

  const title = clip(collapse(input.query) || labels.subtitle, MAX_TITLE_CHARS).text;
  const titleLines = wrap(safe(title, bold), bold, 16, CONTENT_W).slice(0, MAX_TITLE_LINES);
  const content = condense(input.answer);
  let truncated = content.summaryCut;

  const summaryLines = wrap(safe(content.summary), regular, BODY.size, CONTENT_W);
  if (summaryLines.length > MAX_SUMMARY_LINES) {
    summaryLines.length = MAX_SUMMARY_LINES;
    summaryLines[MAX_SUMMARY_LINES - 1] =
      `${summaryLines[MAX_SUMMARY_LINES - 1]?.replace(/[\s.,;:]+$/u, "")}…`;
    truncated = true;
  }

  const textBlock = (
    text: string,
    style: typeof BODY,
    bullet: boolean,
    font: PDFFont = regular,
  ): Block => ({
    kind: "text",
    lines: wrap(safe(text, font), font, style.size, CONTENT_W - (bullet ? BULLET_INDENT : 0)),
    style,
    indent: bullet ? BULLET_INDENT : 0,
    bullet,
  });

  const titleBlockHeight = titleLines.length * 21 + 16 + 20;
  const top = PAGE_H - HEADER_H - 30;
  const floor = MARGIN + FOOTER_H;
  const blocks: Block[] = [];
  let free = top - titleBlockHeight - floor;
  const place = (block: Block): boolean => {
    const height = blockHeight(block);
    if (height > free) {
      return false;
    }
    free -= height;
    blocks.push(block);
    return true;
  };

  if (summaryLines.length > 0) {
    place({ kind: "heading", text: labels.summary });
    place({ kind: "text", lines: summaryLines, style: BODY, indent: 0, bullet: false });
  }

  const sourceBlocks = input.sources.map((source) => textBlock(formatSource(source), SMALL, true));
  const reserved =
    sourceBlocks.length > 0
      ? HEADING_H +
        sourceBlocks.slice(0, MIN_SOURCES_KEPT).reduce((sum, block) => sum + blockHeight(block), 0)
      : 0;

  if (content.points.length > 0) {
    const pointBlocks = content.points.map((point) => textBlock(point, BODY, true));
    const budget = free - reserved;
    let used = HEADING_H;
    let fitting = 0;
    for (const block of pointBlocks) {
      if (used + blockHeight(block) > budget) {
        break;
      }
      used += blockHeight(block);
      fitting += 1;
    }
    if (fitting > 0) {
      place({ kind: "heading", text: labels.points });
      pointBlocks.slice(0, fitting).forEach((block) => place(block));
    }
    truncated ||= fitting < pointBlocks.length;
  }

  if (sourceBlocks.length > 0 && place({ kind: "heading", text: labels.sources })) {
    let shown = 0;
    for (const block of sourceBlocks) {
      if (!place(block)) {
        break;
      }
      shown += 1;
    }
    truncated ||= shown < sourceBlocks.length;
  }

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: BAND });
  page.drawText("Lexroom", {
    x: MARGIN,
    y: PAGE_H - HEADER_H / 2 - 6,
    size: 20,
    font: bold,
    color: rgb(1, 1, 1),
  });
  const subtitle = safe(labels.subtitle);
  page.drawText(subtitle, {
    x: PAGE_W - MARGIN - regular.widthOfTextAtSize(subtitle, 10),
    y: PAGE_H - HEADER_H / 2 - 3,
    size: 10,
    font: regular,
    color: rgb(0.8, 0.84, 0.9),
  });

  let y = top;
  for (const line of titleLines) {
    page.drawText(line, { x: MARGIN, y: y - 14, size: 16, font: bold, color: INK });
    y -= 21;
  }
  page.drawText(safe(date.long), { x: MARGIN, y: y - 10, size: 9.5, font: regular, color: MUTED });
  y -= 16;
  page.drawLine({
    start: { x: MARGIN, y: y - 8 },
    end: { x: PAGE_W - MARGIN, y: y - 8 },
    thickness: 0.8,
    color: RULE,
  });
  y -= 8;

  for (const block of blocks) {
    if (block.kind === "heading") {
      page.drawText(safe(block.text, bold), {
        x: MARGIN,
        y: y - 18,
        size: 9.5,
        font: bold,
        color: ACCENT,
      });
      y -= HEADING_H;
      continue;
    }
    block.lines.forEach((line, index) => {
      if (block.bullet && index === 0) {
        page.drawText("•", {
          x: MARGIN + 2,
          y: y - block.style.size,
          size: block.style.size,
          font: regular,
          color: ACCENT,
        });
      }
      page.drawText(line, {
        x: MARGIN + block.indent,
        y: y - block.style.size,
        size: block.style.size,
        font: regular,
        color: INK,
      });
      y -= block.style.lead;
    });
    y -= block.bullet ? BLOCK_GAP : 0;
  }

  let footerY = MARGIN + FOOTER_H - 14;
  page.drawLine({
    start: { x: MARGIN, y: footerY + 8 },
    end: { x: PAGE_W - MARGIN, y: footerY + 8 },
    thickness: 0.8,
    color: RULE,
  });
  if (input.researchUrl) {
    const label = safe(labels.fullResearch, bold);
    page.drawText(label, { x: MARGIN, y: footerY - 6, size: 9.5, font: bold, color: INK });
    footerY -= 15;
    const url = safe(input.researchUrl);
    const urlLines = wrap(url, regular, 9.5, CONTENT_W);
    const urlTop = footerY;
    for (const line of urlLines) {
      page.drawText(line, { x: MARGIN, y: footerY - 6, size: 9.5, font: regular, color: LINK });
      footerY -= 12;
    }
    linkAnnotation(
      pdf,
      page,
      [MARGIN, footerY - 4, MARGIN + CONTENT_W, urlTop + 6],
      input.researchUrl,
    );
  }
  if (truncated) {
    page.drawText(safe(labels.truncated), {
      x: MARGIN,
      y: MARGIN - 4,
      size: 8.5,
      font: regular,
      color: MUTED,
    });
  }

  pdf.setTitle(safe(title));
  pdf.setProducer("Ada");
  pdf.setCreator("Ada");
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);
  const saved = await pdf.save({ useObjectStreams: false });
  const bytes = new Uint8Array(new ArrayBuffer(saved.byteLength));
  bytes.set(saved);
  return { filename: researchPdfFilename(input.query, date.iso), bytes };
}
