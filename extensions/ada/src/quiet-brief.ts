import type { MatterAlias } from "./collector.js";
import { localIsoDate, localTimeLabel, parseIsoDate } from "./deadline-time.js";
import type { DigestDeadlineInput } from "./digest.js";
import type { CalendarEvent, InboxMessage } from "./google-api.js";
import { matchMatterId } from "./memory-render.js";

const MAX_HIGHLIGHTS = 3;
const MAX_DEADLINES = 3;
const DEADLINE_HORIZON_DAYS = 14;
const SUBJECT_CHARS = 80;
const TITLE_CHARS = 80;

/**
 * What the morning brief says when nothing cleared the urgency bar: the day ahead, the mail
 * waiting, and the hearings and deadlines coming up. Plain facts in the person's own clock;
 * the words around them are written per language at send time.
 */
export type QuietBrief = {
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
}): QuietBrief {
  const unread = input.inbox.filter((message) => message.unread);
  const mailHighlights: QuietBrief["mailHighlights"] = [];
  for (const message of unread) {
    const matterId = matchMatterId(
      `${message.from} ${message.subject} ${message.snippet}`,
      input.aliases,
    );
    if (matterId && mailHighlights.length < MAX_HIGHLIGHTS) {
      mailHighlights.push({
        matter: input.aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId,
        subject: clip(message.subject || message.snippet, SUBJECT_CHARS),
      });
    }
  }
  return {
    alertedToday: input.alertedToday ?? false,
    events: todaysEvents(input.events, input.now, input.timeZone),
    unreadMail: unread.length,
    unreadMailCapped: input.inboxFull ?? input.inbox.length >= input.inboxLimit,
    mailHighlights,
    deadlines: (input.deadlines ?? [])
      .filter((line) => line.daysLeft >= 0 && line.daysLeft <= DEADLINE_HORIZON_DAYS)
      .slice(0, MAX_DEADLINES)
      .map((line) => ({
        matter: line.matterLabel,
        type: line.type,
        due: line.due,
        daysLeft: line.daysLeft,
      })),
  };
}
