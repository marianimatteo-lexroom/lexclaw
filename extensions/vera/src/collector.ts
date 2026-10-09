import type { DigestPlan, DigestSignal } from "./digest.js";
import { planDigest } from "./digest.js";
import type { CalendarEvent, InboxMessage } from "./google-api.js";
import type {
  CalendarSnapshotRow,
  GmailSnapshotRow,
  MemoryTodo,
} from "./memory-contract.js";
import { matchMatterId } from "./memory-render.js";

export type MatterAlias = { matterId: string; alias: string; title: string };

export type CollectInput = {
  now: Date;
  inbox: readonly InboxMessage[];
  events: readonly CalendarEvent[];
  previousGmail: readonly GmailSnapshotRow[];
  previousCalendar: readonly CalendarSnapshotRow[];
  aliases: readonly MatterAlias[];
  todos: readonly MemoryTodo[];
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
    if (movedCloser || (hours <= 24 && hours >= -12)) {
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
    signals.push({
      matterId: todo.matterId,
      matterLabel: matterLabel(todo.matterId, input.aliases),
      kind: "decision_waiting",
      summary: todo.title,
      needsDecision: true,
    });
  }

  const plan = planDigest(signals, input.now);
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
