import {
  addDaysIso,
  diffDaysIso,
  isValidCalendarDate,
  isoDate,
  localIsoDate,
  parseIsoDate,
  weekdayOf,
  zonedTimeToUtcMs,
} from "./deadline-time.js";

export type DeadlineKind = "deadline" | "hearing";

export type ParsedDeadline = {
  type: DeadlineKind;
  /** YYYY-MM-DD in the lawyer's time zone. */
  dueDate: string;
  /** HH:MM in the lawyer's time zone, null when the text names no time. */
  dueTime: string | null;
  dueAtMs: number;
  confidence: number;
  excerpt: string;
  /** The text announces a postponement; `movedFromDate` is set when it names the old date. */
  rescheduled?: boolean;
  movedFromDate?: string;
};

export type ParseDeadlineOptions = {
  /** Instant the text was written, used for relative terms and years left out. */
  referenceMs: number;
  timeZone: string;
};

const MONTHS: Record<string, number> = {
  gennaio: 1,
  gen: 1,
  january: 1,
  jan: 1,
  febbraio: 2,
  feb: 2,
  february: 2,
  marzo: 3,
  mar: 3,
  march: 3,
  aprile: 4,
  apr: 4,
  april: 4,
  maggio: 5,
  mag: 5,
  may: 5,
  giugno: 6,
  giu: 6,
  june: 6,
  jun: 6,
  luglio: 7,
  lug: 7,
  july: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  august: 8,
  aug: 8,
  settembre: 9,
  sett: 9,
  set: 9,
  september: 9,
  sept: 9,
  sep: 9,
  ottobre: 10,
  ott: 10,
  october: 10,
  oct: 10,
  novembre: 11,
  nov: 11,
  november: 11,
  dicembre: 12,
  dic: 12,
  december: 12,
  dec: 12,
};

const MONTH_ALTERNATION = Object.keys(MONTHS)
  .toSorted((a, b) => b.length - a.length)
  .join("|");

const WEEKDAYS: Record<string, number> = {
  domenica: 0,
  sunday: 0,
  lunedi: 1,
  lunedì: 1,
  monday: 1,
  martedi: 2,
  martedì: 2,
  tuesday: 2,
  mercoledi: 3,
  mercoledì: 3,
  wednesday: 3,
  giovedi: 4,
  giovedì: 4,
  thursday: 4,
  venerdi: 5,
  venerdì: 5,
  friday: 5,
  sabato: 6,
  saturday: 6,
};

const DAY_FIRST_NAMED = new RegExp(
  `(?<![\\d/.:-])(\\d{1,2})(?:\\s?(?:st|nd|rd|th|°|º))?\\s+(?:of\\s+|di\\s+)?(${MONTH_ALTERNATION})\\b\\.?(?:,?\\s*(\\d{4})(?!\\d))?`,
  "giu",
);
const MONTH_FIRST_NAMED = new RegExp(
  `\\b(${MONTH_ALTERNATION})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{4})(?!\\d))?`,
  "giu",
);
const NUMERIC_DATE = /(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/gu;
const ISO_DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?!\d)/gu;

type Keyword = { start: number; end: number; kind: DeadlineKind; weight: number };

const KEYWORD_PATTERNS: Array<{ re: RegExp; kind: DeadlineKind; weight: number }> = [
  {
    re: /\b(?:udienza|udienze|comparizione|camera di consiglio|hearing|oral arguments?|court date|trial date|trial)\b/giu,
    kind: "hearing",
    weight: 0.8,
  },
  {
    re: /\b(?:comparire|appear before|discussione orale)\b/giu,
    kind: "hearing",
    weight: 0.7,
  },
  {
    re: /\b(?:scadenza|scade|scadono|deadline|due date|termine perentorio|no later than|not later than|entro e non oltre|due (?:by|on))\b/giu,
    kind: "deadline",
    weight: 0.8,
  },
  {
    re: /\b(?:termine|termini|entro(?: il)?|(?:filed|submitted|served|response|reply|payment) by|must be filed|to be filed|deposito)\b/giu,
    kind: "deadline",
    weight: 0.65,
  },
];

/** Past-tense phrase right before a date: the date records what already happened. */
const PAST_BEFORE =
  /(?:notificat[oaie]|depositat[oaie]|pubblicat[oaie]|emess[oa]|inviat[oaie]|ricevut[oaie]|trasmess[oaie]|comunicat[oaie]|svolt[oaie]|tenut[oaie]|sent|filed|served|dated|issued|received|published|held|delivered)\s+(?:(?:il|in data|il giorno|on|the)\s+)?$/iu;

/** A date that names another document, not a due date ("sentenza del 5 marzo"). */
const REFERENCE_BEFORE =
  /(?:sentenza|ordinanza|decreto|provvedimento|atto|contratto|lettera|e-?mail|pec|nota|missiva|verbale|judg(?:e)?ment|order|decision|ruling|letter|contract|minutes)\s+(?:n\.?\s*[\w/.-]+\s+)?(?:del|dell'|datat[oa]\s+|in data|dated|of|from)\s*(?:il\s+)?$/iu;

const RESCHEDULE =
  /\b(?:rinviat[oaie]|rinviare|rinvio|differit[oaie]|spostat[oaie]|postponed|postponement|rescheduled|adjourned|moved\s+(?:to|from))\b/iu;

const RANGE_JOIN = /^\s*(?:al|fino al|fino a|to|until|through|and|e|–|-)\s*$/iu;
const RANGE_BEFORE = /(?:dal|dall'|from|between|tra)\s*$/iu;

const RELATIVE_IT =
  /entro\s+(?:il\s+)?(?:termine\s+(?:perentorio\s+)?di\s+)?(\d{1,3})\s+giorn[oi](?:\s+(lavorativ[oi]|di calendario|liberi|naturali))?\s+(?:dalla|dal|da|dall'|dalle)\s*(?:la\s+|il\s+|l')?(?:notifica|ricezione|ricevimento|comunicazione|presente|data\s+odierna|trasmissione)/giu;
const RELATIVE_EN =
  /within\s+(\d{1,3})\s+(?:(calendar|business|working)\s+)?days\s+(?:of|from|after)\s+(?:the\s+)?(?:receipt|service|notice|notification|date of this|this)/giu;

const ABBREVIATION_END =
  /(?:\b(?:art|artt|n|nn|nr|no|dott|dr|avv|sig|prof|ing|ex|cfr|vs|st|ss|rg|r\.g|c\.p\.c|c\.c|p\.m|a\.m))\.$/iu;

const MAX_EXCERPT = 200;
const KEYWORD_REACH = 140;
const FAR_KEYWORD = 80;
const HEARING_DEFAULT_TIME = { hour: 9, minute: 0 };
const DEADLINE_DEFAULT_TIME = { hour: 23, minute: 59 };

type DateMention = {
  start: number;
  end: number;
  year: number;
  month: number;
  day: number;
  yearImplied: boolean;
  ambiguous: boolean;
  usOrder: boolean;
};

function fullYear(raw: string): number {
  const year = Number(raw);
  return raw.length === 2 ? 2000 + year : year;
}

function collectMentions(segment: string, reference: { year: number; iso: string }): DateMention[] {
  const found: DateMention[] = [];

  for (const match of segment.matchAll(DAY_FIRST_NAMED)) {
    const month = MONTHS[(match[2] ?? "").toLowerCase()];
    const day = Number(match[1]);
    if (!month) {
      continue;
    }
    const explicit = match[3] !== undefined;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      year: explicit ? Number(match[3]) : reference.year,
      month,
      day,
      yearImplied: !explicit,
      ambiguous: false,
      usOrder: false,
    });
  }
  for (const match of segment.matchAll(MONTH_FIRST_NAMED)) {
    const month = MONTHS[(match[1] ?? "").toLowerCase()];
    const day = Number(match[2]);
    if (!month) {
      continue;
    }
    const explicit = match[3] !== undefined;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      year: explicit ? Number(match[3]) : reference.year,
      month,
      day,
      yearImplied: !explicit,
      ambiguous: false,
      usOrder: false,
    });
  }
  for (const match of segment.matchAll(NUMERIC_DATE)) {
    const first = Number(match[1]);
    const second = Number(match[3]);
    const year = fullYear(match[4] ?? "");
    // Europe/Rome convention is day first; "11/25/2026" can only be month first.
    const usOrder = second > 12 && first <= 12;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      year,
      month: usOrder ? first : second,
      day: usOrder ? second : first,
      yearImplied: false,
      ambiguous: !usOrder && first <= 12 && second <= 12 && first !== second,
      usOrder,
    });
  }
  for (const match of segment.matchAll(ISO_DATE)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      yearImplied: false,
      ambiguous: false,
      usOrder: false,
    });
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: DateMention[] = [];
  for (const mention of found) {
    const last = kept.at(-1);
    if (last && mention.start < last.end) {
      continue;
    }
    kept.push(mention);
  }

  const valid: DateMention[] = [];
  for (const mention of kept) {
    let { year } = mention;
    if (mention.yearImplied) {
      // A date without a year points at its next occurrence, unless it is only a few days old.
      const thisYear = isoDate(year, mention.month, Math.min(mention.day, 28));
      if (diffDaysIso(thisYear, reference.iso) > 14) {
        year += 1;
      }
    }
    if (!isValidCalendarDate(year, mention.month, mention.day)) {
      continue;
    }
    valid.push({ ...mention, year });
  }
  return valid;
}

function collectKeywords(segment: string): Keyword[] {
  const hits: Keyword[] = [];
  for (const pattern of KEYWORD_PATTERNS) {
    for (const match of segment.matchAll(pattern.re)) {
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: pattern.kind,
        weight: pattern.weight,
      });
    }
  }
  return hits;
}

function nearestKeyword(
  mention: DateMention,
  keywords: readonly Keyword[],
): { keyword: Keyword; distance: number } | null {
  let best: { keyword: Keyword; distance: number; score: number } | null = null;
  for (const keyword of keywords) {
    const before = keyword.end <= mention.start;
    const distance = before ? mention.start - keyword.end : keyword.start - mention.end;
    if (distance < 0 || distance > KEYWORD_REACH) {
      continue;
    }
    // A keyword that introduces the date beats one that trails it.
    const score = distance + (before ? 0 : 25);
    if (
      !best ||
      score < best.score ||
      (score === best.score && keyword.weight > best.keyword.weight)
    ) {
      best = { keyword, distance, score };
    }
  }
  return best ? { keyword: best.keyword, distance: best.distance } : null;
}

type TimeOfDay = { hour: number; minute: number };

function toTime(
  hourRaw: string,
  minuteRaw: string | undefined,
  meridiem: string | undefined,
): TimeOfDay | null {
  let hour = Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (meridiem) {
    const pm = meridiem.toLowerCase().startsWith("p");
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = pm ? (hour % 12) + 12 : hour % 12;
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

const TIME_PATTERNS: Array<(text: string) => TimeOfDay | null> = [
  (text) => {
    const match =
      /\b(?:ore|alle\s+ore|alle|h|at|@)\.?\s*(\d{1,2})\s*[:.,h]\s*(\d{2})\b\s*(a\.?m\.?|p\.?m\.?)?/iu.exec(
        text,
      );
    return match ? toTime(match[1] ?? "", match[2], match[3]) : null;
  },
  (text) => {
    const match = /(?<![\d:.])T?(\d{1,2}):(\d{2})(?!\d)\s*(a\.?m\.?|p\.?m\.?)?/iu.exec(text);
    return match ? toTime(match[1] ?? "", match[2], match[3]) : null;
  },
  (text) => {
    const match = /\bore\s+(\d{1,2})(?![\d:.,/-])/iu.exec(text);
    return match ? toTime(match[1] ?? "", undefined, undefined) : null;
  },
  (text) => {
    const match = /\b(?:at\s+)?(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/iu.exec(text);
    return match ? toTime(match[1] ?? "", undefined, match[2]) : null;
  },
];

function timeNear(
  segment: string,
  mention: DateMention,
  mentions: readonly DateMention[],
): TimeOfDay | null {
  const index = mentions.indexOf(mention);
  const nextStart = mentions[index + 1]?.start ?? segment.length;
  const previousEnd = mentions[index - 1]?.end ?? 0;
  const after = segment.slice(mention.end, Math.min(nextStart, mention.end + 60));
  for (const read of TIME_PATTERNS) {
    const found = read(after);
    if (found) {
      return found;
    }
  }
  const before = segment.slice(Math.max(previousEnd, mention.start - 40), mention.start);
  for (const read of TIME_PATTERNS) {
    const found = read(before);
    if (found) {
      return found;
    }
  }
  return null;
}

function weekdayMismatch(segment: string, mention: DateMention): boolean {
  const before = segment.slice(Math.max(0, mention.start - 24), mention.start);
  const match = /([a-zà-ÿ]+)\s*,?\s*(?:il\s+|the\s+)?$/iu.exec(before);
  const named = match ? WEEKDAYS[(match[1] ?? "").toLowerCase()] : undefined;
  if (named === undefined) {
    return false;
  }
  return weekdayOf(isoDate(mention.year, mention.month, mention.day)) !== named;
}

function splitSegments(text: string): string[] {
  const segments: string[] = [];
  for (const line of text.split(/\r?\n+/u)) {
    const pieces = line
      .split(/;\s*|(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ"'(])/u)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
    let buffer = "";
    for (const piece of pieces) {
      buffer = buffer ? `${buffer} ${piece}` : piece;
      if (ABBREVIATION_END.test(buffer)) {
        continue;
      }
      segments.push(buffer);
      buffer = "";
    }
    if (buffer) {
      segments.push(buffer);
    }
  }
  return segments;
}

function addWorkingDays(startIso: string, days: number): string {
  let current = startIso;
  let remaining = days;
  while (remaining > 0) {
    current = addDaysIso(current, 1);
    const weekday = weekdayOf(current);
    if (weekday !== 0 && weekday !== 6) {
      remaining -= 1;
    }
  }
  return current;
}

function clipExcerpt(segment: string): string {
  const flat = segment.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT - 1)}…` : flat;
}

function dueInstant(
  options: ParseDeadlineOptions,
  type: DeadlineKind,
  dueDate: string,
  time: TimeOfDay | null,
): { dueAtMs: number; dueTime: string | null } {
  const parsed = parseIsoDate(dueDate);
  if (!parsed) {
    throw new Error("invalid due date");
  }
  const effective = time ?? (type === "hearing" ? HEARING_DEFAULT_TIME : DEADLINE_DEFAULT_TIME);
  return {
    dueAtMs: zonedTimeToUtcMs(
      options.timeZone,
      parsed.year,
      parsed.month,
      parsed.day,
      effective.hour,
      effective.minute,
    ),
    dueTime: time
      ? `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`
      : null,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(0.99, Math.round(value * 100) / 100));
}

/** Which kind of obligation a title such as a calendar summary describes, if any. */
export function classifyDeadlineText(text: string): DeadlineKind | null {
  const keywords = collectKeywords(text);
  if (keywords.some((keyword) => keyword.kind === "hearing")) {
    return "hearing";
  }
  return keywords.some((keyword) => keyword.kind === "deadline") ? "deadline" : null;
}

/**
 * Find hearings and deadlines in free text (Italian or English). A date counts only
 * when a hearing or deadline term governs it; dates that record what already
 * happened or name another document are ignored.
 */
export function parseDeadlines(text: string, options: ParseDeadlineOptions): ParsedDeadline[] {
  const referenceIso = localIsoDate(options.referenceMs, options.timeZone);
  const reference = { year: Number(referenceIso.slice(0, 4)), iso: referenceIso };
  const results: ParsedDeadline[] = [];

  for (const segment of splitSegments(text.replaceAll("\u00a0", " "))) {
    const keywords = collectKeywords(segment);
    const mentions = collectMentions(segment, reference);
    const excerpt = clipExcerpt(segment);

    for (const [pattern, calendarGroup] of [
      [RELATIVE_IT, "di calendario"],
      [RELATIVE_EN, "calendar"],
    ] as const) {
      for (const match of segment.matchAll(pattern)) {
        const days = Number(match[1]);
        const kindWord = (match[2] ?? "").toLowerCase();
        const working = /lavorativ|business|working/u.test(kindWord);
        const dueDate = working
          ? addWorkingDays(referenceIso, days)
          : addDaysIso(referenceIso, days);
        const instant = dueInstant(options, "deadline", dueDate, null);
        results.push({
          type: "deadline",
          dueDate,
          dueTime: instant.dueTime,
          dueAtMs: instant.dueAtMs,
          confidence: working ? 0.55 : kindWord && kindWord !== calendarGroup ? 0.6 : 0.65,
          excerpt,
        });
      }
    }

    const moved = RESCHEDULE.test(segment) && mentions.length >= 1;
    const skipped = new Set<DateMention>();
    for (let i = 0; i < mentions.length - 1; i += 1) {
      const current = mentions[i];
      const next = mentions[i + 1];
      if (!current || !next) {
        continue;
      }
      if (
        RANGE_JOIN.test(segment.slice(current.end, next.start)) &&
        RANGE_BEFORE.test(segment.slice(Math.max(0, current.start - 12), current.start))
      ) {
        skipped.add(current);
      }
    }

    const live = mentions.filter((mention) => !skipped.has(mention));
    const target = moved ? (live.at(-1) ?? null) : null;
    const movedFrom =
      moved && mentions.length >= 2 && mentions[0] !== target ? mentions[0] : undefined;

    for (const mention of live) {
      if (moved && mention !== target) {
        continue;
      }
      const before = segment.slice(Math.max(0, mention.start - 60), mention.start);
      if (PAST_BEFORE.test(before) || REFERENCE_BEFORE.test(before)) {
        continue;
      }
      let match = nearestKeyword(mention, keywords);
      if (!match && moved) {
        const fallback = keywords.find((keyword) => keyword.kind === "hearing") ?? keywords[0];
        match = fallback ? { keyword: fallback, distance: 0 } : null;
      }
      if (!match) {
        continue;
      }
      const dueDate = isoDate(mention.year, mention.month, mention.day);
      const time = timeNear(segment, mention, live);
      const instant = dueInstant(options, match.keyword.kind, dueDate, time);

      let confidence = match.keyword.weight;
      if (!mention.yearImplied) {
        confidence += 0.1;
      }
      if (time) {
        confidence += 0.05;
      }
      if (mention.ambiguous) {
        confidence -= 0.05;
      }
      if (mention.usOrder) {
        confidence -= 0.1;
      }
      if (weekdayMismatch(segment, mention)) {
        confidence -= 0.25;
      }
      if (match.distance > FAR_KEYWORD) {
        confidence -= 0.1;
      }
      if (moved) {
        confidence += 0.05;
      }

      results.push({
        type: match.keyword.kind,
        dueDate,
        dueTime: instant.dueTime,
        dueAtMs: instant.dueAtMs,
        confidence: clamp(confidence),
        excerpt,
        ...(moved ? { rescheduled: true } : {}),
        ...(movedFrom
          ? { movedFromDate: isoDate(movedFrom.year, movedFrom.month, movedFrom.day) }
          : {}),
      });
    }
  }

  const merged = new Map<string, ParsedDeadline>();
  for (const result of results) {
    const key = `${result.type}|${result.dueDate}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, result);
      continue;
    }
    const winner = result.confidence > current.confidence ? result : current;
    const other = winner === result ? current : result;
    merged.set(key, {
      ...winner,
      ...(winner.dueTime === null && other.dueTime !== null
        ? { dueTime: other.dueTime, dueAtMs: other.dueAtMs }
        : {}),
    });
  }
  return [...merged.values()].toSorted((a, b) => a.dueAtMs - b.dueAtMs);
}
