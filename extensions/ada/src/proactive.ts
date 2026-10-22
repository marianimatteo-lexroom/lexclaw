import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { whatsappWindowOpen } from "./collector.js";
import { deadlineDueLabel } from "./deadline-intake.js";
import { diffDaysIso, localIsoDate, localParts, parseIsoDate } from "./deadline-time.js";
import { renderCountdownText, type CountdownLine } from "./digest-text.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { maskNumber } from "./inbound-log.js";
import { PARKED_TODO_PREFIX, PREP_ON_KEY, type MemoryTodo } from "./memory-contract.js";
import { matchMatterId } from "./memory-render.js";
import type { MemoryStore } from "./memory.js";
import {
  liveEventReader,
  liveThreadReader,
  type EventReader,
  type ThreadReader,
} from "./proactive-reads.js";
import {
  countdownSent,
  listPreps,
  listReminders,
  listWatches,
  markCountdown,
  markMentioned,
  mentionedOn,
  readMarker,
  REMINDER_TTL_MS,
  removePrep,
  removeReminder,
  removeWatch,
  savePrep,
  saveReminder,
  saveWatch,
  WATCH_TTL_MS,
  writeMarker,
  type PrepFacts,
  type PrepNotice,
} from "./proactive-store.js";
import { renderReadyNotices } from "./proactive-text.js";
import { resolveLanguage } from "./research-link-outbound.js";
import { effectiveTimeZone } from "./schedule.js";
import { findReply } from "./thread-watch.js";
import { mirrorSentText } from "./transcript-mirror.js";
import { sendRequestReadyNotice } from "./whatsapp-template.js";

/**
 * Everything Ada owes a number beyond the digest, on the existing 15-minute poll: reminders the
 * person set, replies to mails Ada sent for them, a recap before a hearing they asked to be
 * prepared for, and a countdown for confirmed deadlines due today or tomorrow.
 *
 * Inside the 24-hour WhatsApp window the content goes out as free text. Outside it, nothing but
 * the UTILITY request-ready template may go, and it carries no content: the content stays here
 * until the number writes, and the reply releases it. At most one such template goes per closed
 * window, however many things are waiting. The deadline countdown never sends a template: with the
 * window closed the deadline rides the 07:40 digest instead.
 */
type ProactiveApi = Pick<
  OpenClawPluginApi,
  "config" | "logger" | "runtime" | "runtimeSource" | "pluginConfig"
>;

/** What the pass needs from the outside world; injected by tests. */
export type ProactiveSeams = {
  sendText: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /** The request-ready template: `unset` when it is not configured. */
  sendTemplate: () => Promise<"sent" | "unset" | "failed">;
  mirror: (text: string, key: string) => Promise<unknown>;
  readThread: ThreadReader;
  readEvents: EventReader;
};

export type ProactiveParams = {
  api: ProactiveApi;
  owner: string;
  memory: MemoryStore;
  now: Date;
  seams?: Partial<ProactiveSeams>;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A recap goes out about one hour to 90 minutes before the event; a 15-minute poll always lands in it. */
const PREP_EARLIEST_MS = 60 * MINUTE_MS;
const PREP_LATEST_MS = 90 * MINUTE_MS;
export const PREP_DAILY_CAP = 3;
/** A countdown goes out between these local hours only. */
const COUNTDOWN_FIRST_HOUR = 8;
const COUNTDOWN_LAST_HOUR = 20;
/** A timed deadline due today is counted down once it is this close, even if the day's digest named it. */
const COUNTDOWN_CLOSE_MS = 3 * HOUR_MS;
const COUNTDOWN_MAX_LINES = 3;
const WATCHES_PER_PASS = 20;

function liveSeams(api: ProactiveApi, owner: string, now: Date): ProactiveSeams {
  const to = `+${owner}`;
  return {
    sendText: (text) => sendAdaWhatsAppText({ api, to, text }),
    sendTemplate: async () => {
      const result = await sendRequestReadyNotice({ api, to });
      return result === null ? "unset" : result.ok ? "sent" : "failed";
    },
    mirror: (text, key) => mirrorSentText(api, owner, text, key),
    readThread: liveThreadReader(api, owner, now),
    readEvents: liveEventReader(api, owner),
  };
}

type Context = ProactiveParams & {
  seams: ProactiveSeams;
  nowMs: number;
  timeZone: string;
  day: string;
};

async function openContext(params: ProactiveParams): Promise<Context> {
  const profile = await params.memory.readProfile();
  const timeZone = effectiveTimeZone(profile?.timezone);
  const nowMs = params.now.getTime();
  return {
    ...params,
    seams: { ...liveSeams(params.api, params.owner, params.now), ...params.seams },
    nowMs,
    timeZone,
    day: localIsoDate(nowMs, timeZone),
  };
}

async function guarded(context: Context, step: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    context.api.logger.warn(
      `ada proactive ${step} failed owner=${maskNumber(context.owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

/** A reminder whose time came is now ready to be delivered; one nobody read for two months is dropped. */
async function promoteReminders(context: Context): Promise<void> {
  for (const reminder of await listReminders(context.memory)) {
    if (context.nowMs - reminder.dueAtMs > REMINDER_TTL_MS) {
      await removeReminder(context.memory, reminder.id);
    } else if (reminder.state === "pending" && reminder.dueAtMs <= context.nowMs) {
      await saveReminder(context.memory, { ...reminder, state: "ready" }, context.nowMs);
    }
  }
}

/** Looks at each mail Ada sent for the person; a reply from someone else makes the thread ready. */
async function pollWatches(context: Context): Promise<void> {
  const watches = (await listWatches(context.memory)).filter((watch) => watch.state === "pending");
  let read = 0;
  for (const watch of watches.toSorted((a, b) => b.sentAtMs - a.sentAtMs)) {
    if (context.nowMs - watch.sentAtMs > WATCH_TTL_MS) {
      await removeWatch(context.memory, watch.id);
      continue;
    }
    if (read >= WATCHES_PER_PASS) {
      break;
    }
    read += 1;
    const thread = await context.seams.readThread(watch);
    if (!thread.ok) {
      if (thread.gone) {
        await removeWatch(context.memory, watch.id);
      }
      continue;
    }
    // A watch that waited for Sent Items keeps what the lookup found, so the next poll reads the
    // conversation itself instead of searching the newest sent mail again.
    const found = thread.resolved
      ? {
          ...watch,
          threadId: thread.resolved.threadId,
          seenIds: [...watch.seenIds, thread.resolved.ownId],
        }
      : watch;
    const reply = findReply(found, thread.messages);
    if (reply) {
      await saveWatch(context.memory, { ...found, reply, state: "ready" }, context.nowMs);
    } else if (thread.resolved) {
      await saveWatch(context.memory, found, context.nowMs);
    }
  }
}

function prepId(eventId: string, startMs: number): string {
  return `${createHash("sha256").update(eventId).digest("base64url").slice(0, 24)}@${startMs}`;
}

const sender = (from: string) =>
  (/^\s*"?([^"<]+?)"?\s*<[^>]*>\s*$/u.exec(from)?.[1] ?? from).replace(/\s+/gu, " ").trim();

async function prepFacts(
  context: Context,
  matterId: string,
  aliases: ReadonlyArray<{ matterId: string; alias: string }>,
): Promise<PrepFacts> {
  const { memory, nowMs } = context;
  const [deadlines, todos, mails] = await Promise.all([
    memory.listDeadlines(matterId),
    memory.listTodos(matterId),
    memory.readGmailSnapshot(),
  ]);
  return {
    deadlines: deadlines
      .filter(
        (item) =>
          (item.status === "candidate" || item.status === "tracked") &&
          item.dueAtMs >= nowMs &&
          item.dueAtMs <= nowMs + 30 * 24 * HOUR_MS,
      )
      .toSorted((a, b) => a.dueAtMs - b.dueAtMs)
      .slice(0, 3)
      .map((item) => ({ type: item.type, due: deadlineDueLabel(item), title: item.title })),
    todos: todos
      .filter(
        (todo: MemoryTodo) =>
          todo.owner === "lawyer" &&
          todo.status !== "done" &&
          !todo.id.startsWith(PARKED_TODO_PREFIX),
      )
      .slice(0, 3)
      .map((todo) => todo.title),
    mails: mails
      .filter((row) => matchMatterId(`${row.from} ${row.subject}`, aliases) === matterId)
      .toSorted((a, b) => b.internalDateMs - a.internalDateMs)
      .slice(0, 3)
      .map((row) => `${sender(row.from)}: ${row.subject}`.slice(0, 160)),
  };
}

/**
 * A recap for each calendar event of a matter that starts in about an hour, for a person who asked
 * for it. Once per event, at most `PREP_DAILY_CAP` a local day, and only when there is something
 * to recap besides the event itself.
 */
async function planPrep(context: Context, preferences: readonly { key: string }[]): Promise<void> {
  if (!preferences.some((preference) => preference.key === PREP_ON_KEY)) {
    return;
  }
  const preps = await listPreps(context.memory);
  let today = preps.filter((prep) => prep.day === context.day).length;
  if (today >= PREP_DAILY_CAP) {
    return;
  }
  const events = await context.seams.readEvents(context.now, 2);
  const aliases = await context.memory.listMatterAliases();
  const soon = events
    .flatMap((event) => {
      // An all-day event has a date and no time, which would read as midnight UTC.
      const startMs = parseIsoDate(event.start) ? Number.NaN : Date.parse(event.start);
      const until = startMs - context.nowMs;
      return event.status !== "cancelled" && until >= PREP_EARLIEST_MS && until <= PREP_LATEST_MS
        ? [{ event, startMs }]
        : [];
    })
    .toSorted((a, b) => a.startMs - b.startMs);
  for (const { event, startMs } of soon) {
    const id = prepId(event.id, startMs);
    const matterId = matchMatterId(`${event.summary} ${event.description ?? ""}`, aliases);
    if (!matterId || preps.some((prep) => prep.id === id)) {
      continue;
    }
    const facts = await prepFacts(context, matterId, aliases);
    if (!facts.deadlines.length && !facts.todos.length && !facts.mails.length) {
      continue;
    }
    const notice: PrepNotice = {
      id,
      title: event.summary.slice(0, 200) || "…",
      startMs,
      matterLabel: aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId,
      facts,
      day: context.day,
      state: "ready",
    };
    await savePrep(context.memory, notice, context.nowMs);
    today += 1;
    if (today >= PREP_DAILY_CAP) {
      return;
    }
  }
}

/**
 * Sends what is ready. Inside the window one batched text goes out and the items are settled;
 * outside it the content stays and, if something that may use the template is waiting, one
 * request-ready template goes per closed window.
 */
async function deliverReady(context: Context, windowOpen: boolean): Promise<void> {
  const { memory, nowMs } = context;
  const reminders = (await listReminders(memory)).filter((reminder) => reminder.state === "ready");
  const replies = (await listWatches(memory)).filter(
    (watch) => watch.state === "ready" && watch.reply !== null,
  );
  const allPreps = await listPreps(memory);
  // A recap for an event that already started is no use any more.
  for (const stale of allPreps.filter((prep) => prep.state === "ready" && prep.startMs <= nowMs)) {
    await removePrep(memory, stale.id);
  }
  const preps = allPreps.filter((prep) => prep.state === "ready" && prep.startMs > nowMs);
  if (reminders.length + replies.length + preps.length === 0) {
    return;
  }
  if (windowOpen) {
    const profile = await memory.readProfile();
    const language = await resolveLanguage("", async () => profile?.language, context.owner);
    const text = renderReadyNotices(
      { reminders, replies, preps },
      language,
      context.timeZone,
      nowMs,
    );
    const sent = await context.seams.sendText(text);
    if (!sent.ok) {
      context.api.logger.warn(
        `ada proactive notice not sent owner=${maskNumber(context.owner)}: ${sent.error ?? "unknown"}`,
      );
      return;
    }
    for (const reminder of reminders) {
      await removeReminder(memory, reminder.id);
    }
    for (const watch of replies) {
      await removeWatch(memory, watch.id);
    }
    for (const prep of preps) {
      await savePrep(memory, { ...prep, state: "sent" }, nowMs);
    }
    await context.seams.mirror(text, `ada-proactive:${context.owner}:${nowMs}`);
    return;
  }
  // A recap is never announced with a template: it waits for the next message or goes stale.
  if (reminders.length === 0 && replies.length === 0) {
    return;
  }
  const wake = await memory.readWake();
  const lastTemplateMs = await readMarker(memory, "request_template");
  if (lastTemplateMs !== null && lastTemplateMs >= (wake.lastLawyerInboundAtMs ?? 0)) {
    return;
  }
  // Claimed before the send, so a send Kapso accepted but reported late is never repeated.
  await writeMarker(memory, "request_template", nowMs);
  const sent = await context.seams.sendTemplate();
  if (sent === "unset") {
    context.api.logger.warn(
      `ada proactive items held without a nudge owner=${maskNumber(context.owner)}: no request template`,
    );
  }
}

/** A confirmed deadline due today or tomorrow is told once, as free text and only in the window. */
async function runCountdown(context: Context): Promise<void> {
  const { memory, nowMs } = context;
  const hour = localParts(nowMs, context.timeZone).hour;
  if (hour < COUNTDOWN_FIRST_HOUR || hour >= COUNTDOWN_LAST_HOUR) {
    return;
  }
  const [deadlines, done, mentioned, aliases] = await Promise.all([
    memory.listDeadlines(),
    countdownSent(memory),
    mentionedOn(memory, context.day),
    memory.listMatterAliases(),
  ]);
  const due = deadlines
    .flatMap((item) => {
      const daysLeft = diffDaysIso(context.day, item.dueDate);
      const key = `${item.id}@${item.dueAtMs}`;
      if (item.status !== "tracked" || item.dueAtMs <= nowMs || daysLeft < 0 || daysLeft > 1) {
        return [];
      }
      const close =
        daysLeft === 0 && item.dueTime !== null && item.dueAtMs - nowMs <= COUNTDOWN_CLOSE_MS;
      return !done.has(key) && (close || !mentioned.has(item.id)) ? [{ item, key, daysLeft }] : [];
    })
    .toSorted((a, b) => a.item.dueAtMs - b.item.dueAtMs)
    .slice(0, COUNTDOWN_MAX_LINES);
  if (due.length === 0) {
    return;
  }
  const profile = await memory.readProfile();
  const language = await resolveLanguage("", async () => profile?.language, context.owner);
  const lines: CountdownLine[] = due.map(({ item, daysLeft }) => ({
    matterLabel: aliases.find((entry) => entry.matterId === item.matterId)?.title ?? item.matterId,
    type: item.type,
    due: deadlineDueLabel(item),
    daysLeft,
  }));
  const text = renderCountdownText(lines, language);
  const sent = await context.seams.sendText(text);
  if (!sent.ok) {
    return;
  }
  for (const { item, key } of due) {
    await markCountdown(memory, key, item.dueAtMs, nowMs);
  }
  await markMentioned(
    memory,
    due.map(({ item }) => item.id),
    context.day,
    nowMs,
  );
  await context.seams.mirror(text, `ada-countdown:${context.owner}:${nowMs}`);
}

/** The 15-minute poll for one number. Every step is isolated: one failing never stops another. */
export async function runProactivePass(params: ProactiveParams): Promise<void> {
  const context = await openContext(params);
  const [wake, preferences] = await Promise.all([
    params.memory.readWake(),
    params.memory.listPreferences(),
  ]);
  const windowOpen = whatsappWindowOpen(wake.lastLawyerInboundAtMs, context.nowMs);
  await guarded(context, "reminders", () => promoteReminders(context));
  await guarded(context, "watches", () => pollWatches(context));
  await guarded(context, "prep", () => planPrep(context, preferences));
  await guarded(context, "delivery", () => deliverReady(context, windowOpen));
  if (windowOpen) {
    await guarded(context, "countdown", () => runCountdown(context));
  }
}

/** The number just wrote, so its window is open: what was held for it goes out now. */
export async function releaseReadyNotices(params: ProactiveParams): Promise<void> {
  const context = await openContext(params);
  // A reminder that came due since the last poll goes out with the rest.
  await guarded(context, "reminders", () => promoteReminders(context));
  await guarded(context, "release", () => deliverReady(context, true));
}
