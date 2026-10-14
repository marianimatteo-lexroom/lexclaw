import { classifyDeadlineText, parseDeadlines } from "./deadline-parse.js";
import { localIsoDate, localTimeLabel, parseIsoDate, zonedTimeToUtcMs } from "./deadline-time.js";
import type { DigestDeadlineInput, DigestPlan, DigestSignal } from "./digest.js";
import { planDigest } from "./digest.js";
import type { CalendarEvent, InboxMessage } from "./google-api.js";
import type {
  CalendarSnapshotRow,
  DeadlineCandidate,
  DeadlineSource,
  GmailSnapshotRow,
  MemoryTodo,
} from "./memory-contract.js";
import { matchMatterId } from "./memory-render.js";

export type MatterAlias = { matterId: string; alias: string; title: string };

export type CollectInput = {
  now: Date;
  /** When true, re-emit current deadlines and open lawyer todos for the morning pass. */
  forceMorning: boolean;
  inbox: readonly InboxMessage[];
  events: readonly CalendarEvent[];
  previousGmail: readonly GmailSnapshotRow[];
  previousCalendar: readonly CalendarSnapshotRow[];
  aliases: readonly MatterAlias[];
  todos: readonly MemoryTodo[];
  /** Todo ids already open on the previous collect; used to detect new open loops. */
  previousOpenTodoIds?: readonly string[];
  /** Deadline intake output; absent unless `deadlineIntake.enabled` is set. */
  deadlines?: DeadlineDigestInput;
};

export type DeadlineDigestInput = {
  signals: readonly DigestSignal[];
  lines: readonly DigestDeadlineInput[];
};

export type CollectResult = {
  plan: DigestPlan;
  signals: DigestSignal[];
  gmailSnapshot: GmailSnapshotRow[];
  calendarSnapshot: CalendarSnapshotRow[];
  /** True when a same-day deadline or movedCloser hit should wake before 07:40. */
  urgent: boolean;
};

function parseEventStartMs(start: string): number | undefined {
  const parsed = Date.parse(start);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function matterLabel(matterId: string, aliases: readonly MatterAlias[]): string {
  return aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId;
}

function needsLawyerDecision(message: InboxMessage, aliases: readonly MatterAlias[]): boolean {
  const matterId = matchMatterId(`${message.from} ${message.subject} ${message.snippet}`, aliases);
  if (!matterId) {
    return false;
  }
  const text = `${message.subject} ${message.snippet}`.toLowerCase();
  return (
    text.includes("?") ||
    text.includes("prego") ||
    text.includes("please") ||
    text.includes("kindly") ||
    text.includes("conferma") ||
    text.includes("confirm") ||
    text.includes("rispond") ||
    text.includes("reply")
  );
}

/**
 * Diff inbox and calendar against the last snapshot, emit DigestSignals, and
 * plan without calling the model. Unknown mail (no matter alias) is dropped.
 */
export function collectDigest(input: CollectInput): CollectResult {
  const seenAtMs = input.now.getTime();
  const previousIds = new Set(input.previousGmail.map((row) => row.messageId));
  const previousEvents = new Map(input.previousCalendar.map((row) => [row.eventId, row]));
  const previousOpenTodos = new Set(input.previousOpenTodoIds ?? []);
  const signals: DigestSignal[] = [];
  let urgent = false;

  const gmailSnapshot: GmailSnapshotRow[] = input.inbox.map((message) => {
    const internalDateMs = Date.parse(message.date);
    return {
      messageId: message.id,
      internalDateMs: Number.isFinite(internalDateMs) ? internalDateMs : seenAtMs,
      from: message.from,
      subject: message.subject,
      seenAtMs,
    };
  });

  const calendarSnapshot: CalendarSnapshotRow[] = [];
  for (const event of input.events) {
    if (event.status === "cancelled") {
      continue;
    }
    const startMs = parseEventStartMs(event.start);
    if (startMs === undefined) {
      continue;
    }
    const endMs = parseEventStartMs(event.end) ?? null;
    const matterId = matchMatterId(event.summary, input.aliases);
    calendarSnapshot.push({
      eventId: event.id,
      summary: event.summary,
      startMs,
      endMs,
      matterId,
      seenAtMs,
    });

    if (!matterId) {
      continue;
    }
    const previous = previousEvents.get(event.id);
    const movedCloser = previous !== undefined && startMs < previous.startMs;
    const isNew = previous === undefined;
    // Polls only wake on new or moved events. Morning re-emits current deadlines.
    if (!input.forceMorning && !isNew && !movedCloser) {
      continue;
    }
    const kind = movedCloser ? "calendar_move" : "deadline";
    signals.push({
      matterId,
      matterLabel: matterLabel(matterId, input.aliases),
      kind,
      summary: movedCloser
        ? `${event.summary} moved earlier`
        : `${event.summary} is due`,
      dueAt: new Date(startMs).toISOString(),
      ...(movedCloser ? { movedCloser: true } : {}),
    });
    const hours = (startMs - seenAtMs) / (60 * 60 * 1000);
    if (movedCloser || (isNew && hours <= 24 && hours >= -12)) {
      urgent = true;
    }
  }

  for (const message of input.inbox) {
    if (previousIds.has(message.id)) {
      continue;
    }
    const matterId = matchMatterId(
      `${message.from} ${message.subject} ${message.snippet}`,
      input.aliases,
    );
    if (!matterId) {
      continue;
    }
    const decision = needsLawyerDecision(message, input.aliases);
    signals.push({
      matterId,
      matterLabel: matterLabel(matterId, input.aliases),
      kind: "overnight_email",
      summary: message.subject || "New email",
      needsDecision: decision,
    });
  }

  for (const todo of input.todos) {
    if (todo.owner !== "lawyer" || todo.status === "done") {
      continue;
    }
    if (!input.forceMorning && previousOpenTodos.has(todo.id)) {
      continue;
    }
    signals.push({
      matterId: todo.matterId,
      matterLabel: matterLabel(todo.matterId, input.aliases),
      kind: "decision_waiting",
      summary: todo.title,
      needsDecision: true,
    });
  }

  const plan = planDigest(
    input.deadlines ? [...signals, ...input.deadlines.signals] : signals,
    input.now,
    input.deadlines?.lines,
  );
  if (plan.deliver) {
    const top = plan.items[0];
    if (
      top &&
      (top.cost >= 100 || (top.kind === "calendar_move" && top.cost >= 70))
    ) {
      urgent = true;
    }
  } else {
    urgent = false;
  }

  return { plan, signals, gmailSnapshot, calendarSnapshot, urgent };
}

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function whatsappWindowOpen(
  lastLawyerInboundAtMs: number | null,
  nowMs: number,
): boolean {
  if (lastLawyerInboundAtMs === null) {
    return false;
  }
  return nowMs - lastLawyerInboundAtMs < WHATSAPP_WINDOW_MS;
}

/** 07:40 in the lawyer timezone. */
export function isMorningDigestSlot(now: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour === "07" && minute === "40";
}

export type DeadlineScanMessage = InboxMessage & {
  bodyText: string;
  /** Text read from PDF attachments, including PDFs inside a PEC envelope. */
  attachmentTexts: ReadonlyArray<{ filename: string; text: string }>;
};

const COURT_SENDER =
  /giustiziacert|giustizia\.it|cancelleria|tribunale|corte d['’]appello|\bcourt\b|tribunal/iu;
const SUBJECT_NOISE = /^(?:(?:re|fwd?|r|i)\s*:\s*|posta certificata\s*:\s*)+/iu;
const BODY_MATCH_CHARS = 4000;

const MAX_TITLE_CHARS = 200;

function clip(text: string, max = MAX_TITLE_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanSubject(subject: string): string {
  return subject.replace(SUBJECT_NOISE, "").trim();
}

function emailSource(
  message: DeadlineScanMessage,
  kind: "email" | "pdf",
  filename: string,
  excerpt: string,
): DeadlineSource {
  return {
    kind,
    ref: kind === "pdf" ? `${message.id}#${filename.slice(0, 80)}` : message.id,
    label: clip(
      kind === "pdf"
        ? `${cleanSubject(message.subject) || message.from} (${filename.slice(0, 80)})`
        : `${message.from}: ${cleanSubject(message.subject)}`,
    ),
    excerpt: clip(excerpt),
  };
}

function matterForMessage(
  message: DeadlineScanMessage,
  aliases: readonly MatterAlias[],
): string | null {
  return (
    matchMatterId(`${message.from} ${message.subject}`, aliases) ??
    matchMatterId(message.bodyText.slice(0, BODY_MATCH_CHARS), aliases) ??
    message.attachmentTexts
      .map((entry) => matchMatterId(entry.text.slice(0, BODY_MATCH_CHARS), aliases))
      .find((matterId) => matterId !== null) ??
    null
  );
}

function eventStart(
  start: string,
  type: "deadline" | "hearing",
  timeZone: string,
): { dueAtMs: number; dueDate: string; dueTime: string | null } | null {
  const dateOnly = parseIsoDate(start);
  if (dateOnly) {
    const [hour, minute] = type === "hearing" ? [9, 0] : [23, 59];
    return {
      dueAtMs: zonedTimeToUtcMs(
        timeZone,
        dateOnly.year,
        dateOnly.month,
        dateOnly.day,
        hour,
        minute,
      ),
      dueDate: start,
      dueTime: null,
    };
  }
  const ms = Date.parse(start);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return {
    dueAtMs: ms,
    dueDate: localIsoDate(ms, timeZone),
    dueTime: localTimeLabel(ms, timeZone),
  };
}

/**
 * Hearings and deadlines found in new mail (body, PDF text, PEC envelope) and in
 * calendar events, for matters the lawyer already has. Mail about unknown matters is
 * dropped, as in collectDigest. Pure: the caller owns fetching and storage.
 */
export function collectDeadlineCandidates(input: {
  now: Date;
  timeZone: string;
  messages: readonly DeadlineScanMessage[];
  events: readonly CalendarEvent[];
  aliases: readonly MatterAlias[];
}): DeadlineCandidate[] {
  const candidates: DeadlineCandidate[] = [];

  for (const message of input.messages) {
    const matterId = matterForMessage(message, input.aliases);
    if (!matterId) {
      continue;
    }
    const parsedDate = Date.parse(message.date);
    const referenceMs = Number.isFinite(parsedDate) ? parsedDate : input.now.getTime();
    const court = COURT_SENDER.test(
      `${message.from} ${message.subject} ${message.bodyText.slice(0, 600)}`,
    );
    const parts: Array<{ kind: "email" | "pdf"; filename: string; text: string }> = [
      {
        kind: "email",
        filename: "",
        text: `${cleanSubject(message.subject)}\n${message.bodyText || message.snippet}`,
      },
      ...message.attachmentTexts.map((entry) => ({
        kind: "pdf" as const,
        filename: entry.filename,
        text: entry.text,
      })),
    ];
    for (const part of parts) {
      for (const found of parseDeadlines(part.text, { referenceMs, timeZone: input.timeZone })) {
        const confidence = Math.max(
          0,
          Math.min(0.99, found.confidence + (court ? 0.05 : 0) - (part.kind === "pdf" ? 0.05 : 0)),
        );
        candidates.push({
          matterId,
          type: found.type,
          title: clip(cleanSubject(message.subject) || found.excerpt),
          dueAtMs: found.dueAtMs,
          dueDate: found.dueDate,
          dueTime: found.dueTime,
          timeZone: input.timeZone,
          confidence: Math.round(confidence * 100) / 100,
          source: emailSource(message, part.kind, part.filename, found.excerpt),
          ...(found.movedFromDate ? { movesFrom: { dueDate: found.movedFromDate } } : {}),
          ...(found.rescheduled ? { rescheduled: true } : {}),
        });
      }
    }
  }

  for (const event of input.events) {
    if (event.status === "cancelled") {
      continue;
    }
    const matterId = matchMatterId(`${event.summary} ${event.description ?? ""}`, input.aliases);
    const fromSummary = classifyDeadlineText(event.summary);
    const type =
      fromSummary ??
      (matterId && event.description
        ? classifyDeadlineText(event.description.slice(0, 300))
        : null);
    if (!matterId || !type) {
      continue;
    }
    const when = eventStart(event.start, type, input.timeZone);
    if (!when) {
      continue;
    }
    candidates.push({
      matterId,
      type,
      title: clip(event.summary.trim() || "Calendar event"),
      ...when,
      timeZone: input.timeZone,
      confidence: fromSummary ? 0.9 : 0.8,
      source: {
        kind: "calendar",
        ref: event.id,
        label: clip(event.summary),
        excerpt: clip(event.summary),
      },
      movesFrom: { sourceRef: event.id },
    });
  }

  return candidates.toSorted((a, b) => a.dueAtMs - b.dueAtMs);
}
