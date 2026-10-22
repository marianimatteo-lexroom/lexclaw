import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  collectDeadlineCandidates,
  type DeadlineDigestInput,
  type DeadlineScanMessage,
  type MatterAlias,
} from "./collector.js";
import {
  addDaysIso,
  diffDaysIso,
  localIsoDate,
  parseIsoDate,
  zonedTimeToUtcMs,
} from "./deadline-time.js";
import type { DigestDeadlineInput, DigestPhrase, DigestPlan, DigestSignal } from "./digest.js";
import {
  listMessageIds,
  listUpcomingEvents,
  readAttachmentBytes,
  readMessageContent,
} from "./google-api.js";
import { PARKED_TODO_PREFIX, type DeadlineItem } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { parseRawMime } from "./mime-text.js";
import { extractPdfText } from "./pdf-text.js";

export const MORNING_HOUR = 7;
export const MORNING_MINUTE = 40;

export type ReminderStep = { id: string; daysBefore: number };

export type DeadlineIntakeConfig = {
  enabled: boolean;
  reminders: ReminderStep[];
  horizonDays: number;
  minConfidence: number;
};

export const DEFAULT_REMINDER_CADENCE = ["7d", "2d", "morning-of"] as const;
const DEFAULT_HORIZON_DAYS = 60;
const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * An unanswered decision is listed this many times in all: the digest it first appears in, the
 * next digest, and a final one that says it is the last reminder. After that it is parked in open
 * loops. A hearing or deadline within 48 hours keeps being listed: it is an alert, not a nudge.
 */
const MAX_OFFERS = 3;

/** The open-loop todo that stands for a candidate deadline nobody answered. */
export const parkedDeadlineTodoId = (deadlineId: string) =>
  `${PARKED_TODO_PREFIX}deadline-${deadlineId}`;
const OFFER_HORIZON_DAYS = 30;
const TRACKED_HORIZON_DAYS = 21;
const MAX_DIGEST_LINES = 6;
const NEAR_HOURS = 48;
const SCAN_MAX_IDS = 25;
const SCAN_MAX_READS = 10;
const MAX_PDFS_PER_MESSAGE = 3;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_FUTURE_DAYS = 548;
const GMAIL_QUERY =
  'in:inbox newer_than:3d -in:spam -in:trash (udienza OR scadenza OR termine OR termini OR cancelleria OR "posta certificata" OR hearing OR deadline OR rinvio OR citazione OR notifica OR comparizione OR court)';

/** "7d" and "morning-of" are the cadence steps; anything else is ignored. */
export function parseReminderCadence(raw: unknown): ReminderStep[] {
  const entries = Array.isArray(raw) ? raw : DEFAULT_REMINDER_CADENCE;
  const steps = new Map<string, ReminderStep>();
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const text = entry.trim().toLowerCase();
    if (text === "morning-of") {
      steps.set("morning-of", { id: "morning-of", daysBefore: 0 });
      continue;
    }
    const match = /^(\d{1,3})d$/u.exec(text);
    const days = match ? Number(match[1]) : Number.NaN;
    if (Number.isInteger(days) && days >= 1) {
      steps.set(`${days}d`, { id: `${days}d`, daysBefore: days });
    }
  }
  return [...steps.values()].toSorted((a, b) => b.daysBefore - a.daysBefore);
}

export function readDeadlineIntakeConfig(pluginConfig: unknown): DeadlineIntakeConfig {
  const raw =
    pluginConfig && typeof pluginConfig === "object"
      ? (pluginConfig as { deadlineIntake?: unknown }).deadlineIntake
      : undefined;
  const section = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const horizon = section.horizonDays;
  const confidence = section.minConfidence;
  return {
    enabled: section.enabled === true,
    reminders: parseReminderCadence(section.reminders),
    horizonDays:
      typeof horizon === "number" && Number.isInteger(horizon) && horizon >= 1 && horizon <= 365
        ? horizon
        : DEFAULT_HORIZON_DAYS,
    minConfidence:
      typeof confidence === "number" && confidence >= 0 && confidence <= 1
        ? confidence
        : DEFAULT_MIN_CONFIDENCE,
  };
}

/** Reminders go out in the morning digest slot of the step's day, in the item's zone. */
export function reminderFireAtMs(item: DeadlineItem, step: ReminderStep): number {
  const day = parseIsoDate(addDaysIso(item.dueDate, -step.daysBefore));
  if (!day) {
    throw new Error("invalid due date");
  }
  return zonedTimeToUtcMs(
    item.timeZone,
    day.year,
    day.month,
    day.day,
    MORNING_HOUR,
    MORNING_MINUTE,
  );
}

/** Steps whose slot already passed when the lawyer confirms are settled, not sent late. */
export function seedReminders(
  item: DeadlineItem,
  steps: readonly ReminderStep[],
  nowMs: number,
): string[] {
  const settled = steps
    .filter((step) => reminderFireAtMs(item, step) <= nowMs)
    .map((step) => step.id);
  return [...new Set([...item.remindersSent, ...settled])];
}

/**
 * The reminder a tracked item owes now. When several steps are overdue together (the
 * WhatsApp window was closed) only the latest is sent and the rest are settled with it.
 */
export function dueReminder(
  item: DeadlineItem,
  steps: readonly ReminderStep[],
  nowMs: number,
): { step: ReminderStep; covers: string[] } | null {
  if (item.status !== "tracked" || item.dueAtMs <= nowMs) {
    return null;
  }
  const overdue = steps.filter(
    (step) => !item.remindersSent.includes(step.id) && reminderFireAtMs(item, step) <= nowMs,
  );
  const latest = overdue.toSorted((a, b) => a.daysBefore - b.daysBefore)[0];
  return latest ? { step: latest, covers: overdue.map((step) => step.id) } : null;
}

export function deadlineDueLabel(item: Pick<DeadlineItem, "dueDate" | "dueTime">): string {
  return item.dueTime ? `${item.dueDate} ${item.dueTime}` : item.dueDate;
}

function typeLabel(item: DeadlineItem): string {
  return item.type === "hearing" ? "Hearing" : "Deadline";
}

export type DeadlineIntakeDeps = {
  listMessageIds: typeof listMessageIds;
  readMessageContent: typeof readMessageContent;
  readAttachmentBytes: typeof readAttachmentBytes;
  listUpcomingEvents: typeof listUpcomingEvents;
};

const DEFAULT_DEPS: DeadlineIntakeDeps = {
  listMessageIds,
  readMessageContent,
  readAttachmentBytes,
  listUpcomingEvents,
};

export type DeadlineIntakeRun = {
  digest: DeadlineDigestInput;
  /** Record the numbers and reminders of a digest that was actually delivered. */
  commit(plan: DigestPlan): Promise<void>;
};

type StopReason = "auth" | "rate_limit";

async function readScanMessages(params: {
  deps: DeadlineIntakeDeps;
  memory: MemoryStore;
  accessToken: string;
  now: Date;
  log: (message: string) => void;
}): Promise<{ messages: DeadlineScanMessage[]; completeIds: string[] }> {
  const listed = await params.deps.listMessageIds({
    accessToken: params.accessToken,
    query: GMAIL_QUERY,
    max: SCAN_MAX_IDS,
  });
  if (!listed.ok) {
    params.log(`gmail search failed (${listed.status})`);
    return { messages: [], completeIds: [] };
  }
  const unscanned = (await params.memory.filterUnscannedMessages(listed.ids)).slice(
    0,
    SCAN_MAX_READS,
  );
  const messages: DeadlineScanMessage[] = [];
  const completeIds: string[] = [];
  let stop: StopReason | null = null;

  for (const id of unscanned) {
    if (stop) {
      break;
    }
    const read = await params.deps.readMessageContent({ accessToken: params.accessToken, id });
    if (!read.ok) {
      if (read.status === 400 || read.status === 404 || read.status === 410) {
        // Gone or unreadable for good: retrying would only starve newer mail.
        completeIds.push(id);
      }
      stop =
        read.status === 401 || read.status === 403
          ? "auth"
          : read.status === 429
            ? "rate_limit"
            : null;
      continue;
    }
    const { attachments, bodyText, ...message } = read.content;
    let text = bodyText;
    const attachmentTexts: Array<{ filename: string; text: string }> = [];
    let partial = false;
    let pdfBudget = MAX_PDFS_PER_MESSAGE;

    for (const attachment of attachments.slice(0, MAX_PDFS_PER_MESSAGE + 2)) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        continue;
      }
      const fetched = await params.deps.readAttachmentBytes({
        accessToken: params.accessToken,
        messageId: id,
        attachmentId: attachment.attachmentId,
      });
      if (!fetched.ok) {
        partial = true;
        continue;
      }
      if (attachment.kind === "pdf") {
        if (pdfBudget > 0) {
          pdfBudget -= 1;
          const pdfText = extractPdfText(fetched.bytes);
          if (pdfText) {
            attachmentTexts.push({ filename: attachment.filename, text: pdfText });
          }
        }
        continue;
      }
      const envelope = parseRawMime(fetched.bytes);
      if (envelope.text) {
        text = `${text}\n${envelope.text}`;
      }
      for (const pdf of envelope.pdfs) {
        if (pdfBudget <= 0) {
          break;
        }
        pdfBudget -= 1;
        const pdfText = extractPdfText(pdf.bytes);
        if (pdfText) {
          attachmentTexts.push({ filename: pdf.filename, text: pdfText });
        }
      }
    }
    messages.push({ ...message, bodyText: text, attachmentTexts });
    if (!partial) {
      completeIds.push(id);
    }
  }
  if (stop) {
    params.log(`gmail read stopped early (${stop})`);
  }
  return { messages, completeIds };
}

function matterLabelOf(matterId: string, aliases: readonly MatterAlias[]): string {
  return aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId;
}

/**
 * Read-only intake. Scans new mail and calendar for hearings and deadlines, stores them
 * as candidates in matter memory, and returns what the digest should show. Nothing is
 * sent, tracked, or researched here: that waits for the lawyer's reply. Returns null
 * when disabled or when anything fails, so the digest runs exactly as before.
 */
export async function prepareDeadlineIntake(params: {
  api: Pick<OpenClawPluginApi, "pluginConfig" | "logger">;
  memory: MemoryStore;
  now: Date;
  forceMorning: boolean;
  aliases: readonly MatterAlias[];
  timeZone: string;
  accessToken: string;
  deps?: DeadlineIntakeDeps;
}): Promise<DeadlineIntakeRun | null> {
  const config = readDeadlineIntakeConfig(params.api.pluginConfig);
  if (!config.enabled) {
    return null;
  }
  const deps = params.deps ?? DEFAULT_DEPS;
  const nowMs = params.now.getTime();
  const log = (message: string) => params.api.logger.warn(`ada deadline intake: ${message}`);

  // Intake of new items must not stop reminders for items the lawyer already confirmed.
  let freshIds = new Set<string>();
  try {
    const scan = await readScanMessages({
      deps,
      memory: params.memory,
      accessToken: params.accessToken,
      now: params.now,
      log,
    });
    const calendar = await deps.listUpcomingEvents({
      accessToken: params.accessToken,
      now: params.now,
      hours: config.horizonDays * 24,
      maxResults: 50,
      includeDescription: true,
    });
    if (!calendar.ok) {
      log(`calendar read failed (${calendar.status})`);
    }

    const candidates = collectDeadlineCandidates({
      now: params.now,
      timeZone: params.timeZone,
      messages: scan.messages,
      events: calendar.ok ? calendar.events : [],
      aliases: params.aliases,
    }).filter(
      (candidate) =>
        candidate.confidence >= config.minConfidence &&
        candidate.dueAtMs >= nowMs &&
        candidate.dueAtMs <= nowMs + MAX_FUTURE_DAYS * 86_400_000,
    );
    const upserted =
      candidates.length > 0
        ? await params.memory.upsertDeadlines(candidates, nowMs)
        : { created: [], moved: [], updated: [] };
    // Only after the items are stored: a failed upsert must not hide the mail from the next pass.
    if (scan.completeIds.length > 0) {
      await params.memory.markMessagesScanned(scan.completeIds, nowMs);
    }
    for (const item of upserted.moved) {
      if (item.status === "tracked") {
        await params.memory.updateDeadline(
          item.id,
          { remindersSent: seedReminders(item, config.reminders, nowMs) },
          nowMs,
        );
      }
    }
    freshIds = new Set([...upserted.created, ...upserted.moved].map((item) => item.id));
  } catch (error) {
    log(`scan skipped this pass: ${error instanceof Error ? error.message : "unknown"}`);
  }

  try {
    const today = localIsoDate(nowMs, params.timeZone);
    const upcoming = (await params.memory.listDeadlines()).filter(
      (item) => (item.status === "candidate" || item.status === "tracked") && item.dueAtMs >= nowMs,
    );

    const signals: DigestSignal[] = [];
    const lines: Array<{ line: DigestDeadlineInput; priority: number }> = [];
    for (const item of upcoming) {
      const hoursLeft = (item.dueAtMs - nowMs) / 3_600_000;
      const daysLeft = diffDaysIso(today, item.dueDate);
      const near = hoursLeft <= NEAR_HOURS;
      const reminder = dueReminder(item, config.reminders, nowMs);
      // A move stays unannounced until a delivered digest lists the item and raises offeredCount.
      const movedUnannounced = item.movedFromMs !== null && item.offeredCount === 0;
      const label = matterLabelOf(item.matterId, params.aliases);
      const summary = `${typeLabel(item)} ${deadlineDueLabel(item)}: ${item.title}`;
      const phrase = (flags: { confirm?: true; moved?: true } = {}): DigestPhrase => ({
        id: "tracked_deadline",
        type: item.type,
        due: deadlineDueLabel(item),
        title: item.title,
        ...flags,
      });
      const base = {
        matterId: item.matterId,
        matterLabel: label,
        dueAt: new Date(item.dueAtMs).toISOString(),
      };

      let listed = false;
      if (item.status === "candidate") {
        const offerable = item.offeredCount < MAX_OFFERS || near;
        if (offerable && daysLeft <= OFFER_HORIZON_DAYS) {
          listed = true;
          if (freshIds.has(item.id) || params.forceMorning) {
            signals.push(
              near
                ? { ...base, kind: "deadline", summary, phrase: phrase({ confirm: true }) }
                : {
                    ...base,
                    kind: "decision_waiting",
                    summary: `Confirm tracking ${summary}`,
                    phrase: phrase({ confirm: true }),
                    needsDecision: true,
                  },
            );
          }
        }
      } else if (reminder || movedUnannounced || daysLeft <= TRACKED_HORIZON_DAYS) {
        listed = true;
        if (reminder) {
          signals.push({
            ...base,
            kind: "deadline",
            summary,
            phrase: phrase(),
            tracked: "reminder",
          });
        } else if (movedUnannounced && (freshIds.has(item.id) || params.forceMorning)) {
          signals.push({
            ...base,
            kind: "deadline",
            summary: `${summary} (moved)`,
            phrase: phrase({ moved: true }),
            tracked: "moved",
          });
        } else if (near && params.forceMorning) {
          signals.push({ ...base, kind: "deadline", summary, phrase: phrase() });
        }
      }

      if (listed) {
        lines.push({
          priority: reminder ? 0 : 1,
          line: {
            id: item.id,
            matterId: item.matterId,
            matterLabel: label,
            type: item.type,
            title: item.title,
            dueAt: base.dueAt,
            due: deadlineDueLabel(item),
            daysLeft,
            status: item.status === "tracked" ? "tracked" : "candidate",
            confidence: item.confidence,
            source: item.sources[0]?.label ?? "",
            ...(movedUnannounced ? { moved: true } : {}),
            ...(item.status === "candidate" && item.offeredCount === MAX_OFFERS - 1
              ? { lastReminder: true }
              : {}),
            briefReady: item.researchStatus === "done",
            ...(reminder ? { reminder: { step: reminder.step.id, covers: reminder.covers } } : {}),
          },
        });
      }
    }

    const selected = lines
      .toSorted(
        (a, b) =>
          a.priority - b.priority ||
          Date.parse(a.line.dueAt) - Date.parse(b.line.dueAt) ||
          a.line.id.localeCompare(b.line.id),
      )
      .slice(0, MAX_DIGEST_LINES)
      .map((entry) => entry.line)
      .toSorted((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));

    return {
      digest: { signals, lines: selected },
      async commit(plan) {
        if (!plan.deliver || !plan.deadlines?.length) {
          return;
        }
        try {
          await params.memory.commitDeadlineDigest(
            plan.deadlines.map((line) => ({ id: line.id, no: line.no })),
            plan.deadlines.flatMap((line) =>
              line.reminder ? [{ id: line.id, steps: line.reminder.covers }] : [],
            ),
            nowMs,
          );
          // The last reminder went out: the decision moves to open loops and stops coming back.
          for (const line of plan.deadlines.filter((entry) => entry.lastReminder)) {
            await params.memory.upsertTodo({
              id: parkedDeadlineTodoId(line.id),
              matterId: line.matterId,
              owner: "lawyer",
              title: `Confirm tracking: ${line.title} (${line.due})`,
              status: "pending",
              detail: "Listed in three digests without an answer, so it was parked here.",
              updatedAtMs: nowMs,
            });
          }
        } catch (error) {
          log(
            `could not record the delivered digest: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      },
    };
  } catch (error) {
    log(`skipped this pass: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  }
}
