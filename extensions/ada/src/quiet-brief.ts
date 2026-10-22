import type { MatterAlias } from "./collector.js";
import { localIsoDate, localTimeLabel, parseIsoDate } from "./deadline-time.js";
import type { DigestDeadlineInput } from "./digest.js";
import type { CalendarEvent, InboxMessage } from "./google-api.js";
import { matchMatterId } from "./memory-render.js";
import { NO_TEXT_PREFS, type TextPrefs } from "./text-prefs.js";

const MAX_HIGHLIGHTS = 3;
const MAX_DEADLINES = 3;
const DEADLINE_HORIZON_DAYS = 14;
const SUBJECT_CHARS = 80;
const TITLE_CHARS = 80;

/** How many lines a brief keeps for a person who asked for shorter texts. */
const SHORT_EVENTS = 3;
const SHORT_HIGHLIGHTS = 1;
const SHORT_DEADLINES = 1;

/**
 * What the morning brief says when nothing cleared the urgency bar: the day ahead, the mail
 * waiting, and the hearings and deadlines coming up. Plain facts in the person's own clock;
 * the words around them are written per language at send time. It is only sent when
 * `quietBriefHasContent` says it has something to tell.
 */
export type QuietBrief = {
  /** The person did not ask to leave the agenda out, so an empty agenda still says so. */
  agenda: boolean;
  /** An urgent alert already went to this number earlier today, so the brief cannot say nothing is urgent. */
  alertedToday: boolean;
  /** Today's events in the person's own zone, in order; `time` is null for an all-day event. */
  events: Array<{ time: string | null; summary: string }>;
  /** Unread messages in the inbox window Ada read. */
  unreadMail: number;
  /** True when the window was full, so there may be more unread mail than `unreadMail`. */
  unreadMailCapped: boolean;
  /** Unread mail about one of the person's matters, newest first. */
  mailHighlights: Array<{ matter: string; subject: string }>;
  deadlines: Array<{
    /** The deadline's id, so a mention in the brief counts as told for the day. */
    id: string;
    matter: string;
    type: "deadline" | "hearing";
    due: string;
    daysLeft: number;
  }>;
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function todaysEvents(events: readonly CalendarEvent[], now: Date, timeZone: string) {
  const today = localIsoDate(now.getTime(), timeZone);
  const found: Array<{ sortKey: string; time: string | null; summary: string }> = [];
  for (const event of events) {
    if (event.status === "cancelled") {
      continue;
    }
    const summary = clip(event.summary, TITLE_CHARS);
    if (parseIsoDate(event.start)) {
      if (event.start === today) {
        found.push({ sortKey: "", time: null, summary });
      }
      continue;
    }
    const startMs = Date.parse(event.start);
    if (Number.isFinite(startMs) && localIsoDate(startMs, timeZone) === today) {
      const time = localTimeLabel(startMs, timeZone);
      found.push({ sortKey: time, time, summary });
    }
  }
  return found
    .toSorted((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ time, summary }) => ({ time, summary }));
}

export function buildQuietBrief(input: {
  now: Date;
  timeZone: string;
  events: readonly CalendarEvent[];
  inbox: readonly InboxMessage[];
  /** How many messages Ada asked Gmail for; a full window means there may be more. */
  inboxLimit: number;
  /** Set when the inbox is the merge of several providers: true when any one of them came back full. */
  inboxFull?: boolean;
  aliases: readonly MatterAlias[];
  deadlines?: readonly DigestDeadlineInput[];
  alertedToday?: boolean;
  prefs?: TextPrefs;
}): QuietBrief {
  const prefs = input.prefs ?? NO_TEXT_PREFS;
  const unread = prefs.skipMail ? [] : input.inbox.filter((message) => message.unread);
  const mailHighlights: QuietBrief["mailHighlights"] = [];
  for (const message of unread) {
    const matterId = matchMatterId(
      `${message.from} ${message.subject} ${message.snippet}`,
      input.aliases,
    );
    if (matterId && mailHighlights.length < (prefs.short ? SHORT_HIGHLIGHTS : MAX_HIGHLIGHTS)) {
      mailHighlights.push({
        matter: input.aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId,
        subject: clip(message.subject || message.snippet, SUBJECT_CHARS),
      });
    }
  }
  const events = prefs.skipAgenda ? [] : todaysEvents(input.events, input.now, input.timeZone);
  return {
    agenda: !prefs.skipAgenda,
    alertedToday: input.alertedToday ?? false,
    events: prefs.short ? events.slice(0, SHORT_EVENTS) : events,
    unreadMail: unread.length,
    unreadMailCapped:
      !prefs.skipMail && (input.inboxFull ?? input.inbox.length >= input.inboxLimit),
    mailHighlights,
    deadlines: (input.deadlines ?? [])
      .filter((line) => line.daysLeft >= 0 && line.daysLeft <= DEADLINE_HORIZON_DAYS)
      .slice(0, prefs.short ? SHORT_DEADLINES : MAX_DEADLINES)
      .map((line) => ({
        id: line.id,
        matter: line.matterLabel,
        type: line.type,
        due: line.due,
        daysLeft: line.daysLeft,
      })),
  };
}

/**
 * Whether the brief has anything to say beyond a count of unread mail: an event today, mail about
 * one of the person's matters, or a hearing or deadline coming up. A quiet morning has none, and
 * then Ada sends nothing at all.
 */
export function quietBriefHasContent(brief: QuietBrief): boolean {
  return brief.events.length > 0 || brief.mailHighlights.length > 0 || brief.deadlines.length > 0;
}
