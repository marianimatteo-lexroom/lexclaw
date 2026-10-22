import type { ProactiveRow } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";

/**
 * The typed side of `vera_proactive`: what Ada owes one WhatsApp number beyond the digest. Every
 * row lives in that number's own memory file, so no query can reach another number's rows.
 *
 * `pending` rows wait for their moment (a reminder's time, a reply that has not come). `ready`
 * rows have their content and wait for the 24-hour WhatsApp window: free text inside it, the
 * request-ready template once outside it, and the content itself is only ever sent as text.
 */
export type ProactiveStore = Pick<
  MemoryStore,
  "putProactive" | "listProactive" | "removeProactive"
>;

export type ProactiveState = "pending" | "ready";

const KIND = {
  watch: "watch",
  reminder: "reminder",
  prep: "prep",
  mention: "mention",
  countdown: "countdown",
  marker: "marker",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseObject(data: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(data));
  } catch {
    return null;
  }
}

const text = (value: unknown, max = 500): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const stateOf = (status: string): ProactiveState => (status === "ready" ? "ready" : "pending");

/** A sent mail Ada watches for a reply, because the person asked her to send it. */
export type WatchReply = { from: string; subject: string; snippet: string; atMs: number };
export type ThreadWatch = {
  /** `google:<threadId>` or `outlook:<conversationId>`. */
  id: string;
  provider: "google" | "outlook";
  threadId: string;
  subject: string;
  to: string;
  sentAtMs: number;
  /** Messages of the thread that are not a reply: the person's own, and anything older. */
  seenIds: string[];
  reply: WatchReply | null;
  state: ProactiveState;
};

export const WATCH_TTL_MS = 30 * DAY_MS;
export const MAX_WATCHES = 50;

function readWatch(row: ProactiveRow): ThreadWatch | null {
  const data = parseObject(row.data);
  const provider =
    data?.provider === "outlook" ? "outlook" : data?.provider === "google" ? "google" : null;
  const threadId = text(data?.threadId, 300);
  const sentAtMs = finite(data?.sentAtMs);
  if (!data || !provider || !threadId || sentAtMs === null) {
    return null;
  }
  const reply = asObject(data.reply);
  const replyAtMs = finite(reply?.atMs);
  return {
    id: row.id,
    provider,
    threadId,
    subject: text(data.subject, 200) ?? "",
    to: text(data.to, 320) ?? "",
    sentAtMs,
    seenIds: Array.isArray(data.seenIds)
      ? data.seenIds.filter((id): id is string => typeof id === "string").slice(-200)
      : [],
    reply:
      reply && replyAtMs !== null
        ? {
            from: text(reply.from, 300) ?? "",
            subject: text(reply.subject, 200) ?? "",
            snippet: text(reply.snippet, 400) ?? "",
            atMs: replyAtMs,
          }
        : null,
    state: stateOf(row.status),
  };
}

export async function listWatches(store: ProactiveStore): Promise<ThreadWatch[]> {
  return (await store.listProactive(KIND.watch)).flatMap((row) => readWatch(row) ?? []);
}

export async function saveWatch(store: ProactiveStore, watch: ThreadWatch, atMs: number) {
  const { id, state, ...data } = watch;
  await store.putProactive({
    kind: KIND.watch,
    id,
    dueAtMs: null,
    status: state,
    data: JSON.stringify(data),
    updatedAtMs: atMs,
  });
}

export const removeWatch = (store: ProactiveStore, id: string) =>
  store.removeProactive(KIND.watch, id);

/** A reminder the person asked for; it fires at `dueAtMs`, to the minute of the next poll. */
export type Reminder = {
  id: string;
  text: string;
  dueAtMs: number;
  createdAtMs: number;
  state: ProactiveState;
};

export const MAX_REMINDERS = 50;
export const REMINDER_TEXT_MAX = 300;
/** A reminder nobody read for this long is dropped, so a number that went away is not stored forever. */
export const REMINDER_TTL_MS = 60 * DAY_MS;

function readReminder(row: ProactiveRow): Reminder | null {
  const data = parseObject(row.data);
  const body = text(data?.text, REMINDER_TEXT_MAX);
  const createdAtMs = finite(data?.createdAtMs);
  return body && row.dueAtMs !== null && createdAtMs !== null
    ? { id: row.id, text: body, dueAtMs: row.dueAtMs, createdAtMs, state: stateOf(row.status) }
    : null;
}

export async function listReminders(store: ProactiveStore): Promise<Reminder[]> {
  return (await store.listProactive(KIND.reminder)).flatMap((row) => readReminder(row) ?? []);
}

export async function saveReminder(store: ProactiveStore, reminder: Reminder, atMs: number) {
  await store.putProactive({
    kind: KIND.reminder,
    id: reminder.id,
    dueAtMs: reminder.dueAtMs,
    status: reminder.state,
    data: JSON.stringify({ text: reminder.text, createdAtMs: reminder.createdAtMs }),
    updatedAtMs: atMs,
  });
}

export const removeReminder = (store: ProactiveStore, id: string) =>
  store.removeProactive(KIND.reminder, id);

/** What the recap before an event says; kept as facts so it is written in the language of the day it is sent. */
export type PrepFacts = {
  deadlines: Array<{ type: "deadline" | "hearing"; due: string; title: string }>;
  todos: string[];
  mails: string[];
};

/** A recap before a hearing or meeting: `ready` until it is sent, `sent` as the once-only and daily-cap log. */
export type PrepNotice = {
  id: string;
  title: string;
  startMs: number;
  matterLabel: string;
  facts: PrepFacts;
  /** The person also allowed the request-ready template for it while the window is closed. */
  template: boolean;
  /** The local day it was prepared, for the daily cap. */
  day: string;
  state: "ready" | "sent";
};

function readPrep(row: ProactiveRow): PrepNotice | null {
  const data = parseObject(row.data);
  const startMs = finite(data?.startMs);
  const facts = asObject(data?.facts);
  if (!data || startMs === null || !facts) {
    return null;
  }
  const strings = (value: unknown, max: number) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, max)
      : [];
  return {
    id: row.id,
    title: text(data.title, 200) ?? "",
    startMs,
    matterLabel: text(data.matterLabel, 200) ?? "",
    facts: {
      deadlines: Array.isArray(facts.deadlines)
        ? facts.deadlines.flatMap((entry: unknown) => {
            const item = asObject(entry);
            const due = text(item?.due, 40);
            return item && due
              ? [
                  {
                    type: item.type === "hearing" ? ("hearing" as const) : ("deadline" as const),
                    due,
                    title: text(item.title, 200) ?? "",
                  },
                ]
              : [];
          })
        : [],
      todos: strings(facts.todos, 5),
      mails: strings(facts.mails, 3),
    },
    template: data.template === true,
    day: text(data.day, 10) ?? "",
    state: row.status === "sent" ? "sent" : "ready",
  };
}

export async function listPreps(store: ProactiveStore): Promise<PrepNotice[]> {
  return (await store.listProactive(KIND.prep)).flatMap((row) => readPrep(row) ?? []);
}

export async function savePrep(store: ProactiveStore, prep: PrepNotice, atMs: number) {
  const { id, state, ...data } = prep;
  await store.putProactive({
    kind: KIND.prep,
    id,
    dueAtMs: prep.startMs,
    status: state,
    data: JSON.stringify(data),
    updatedAtMs: atMs,
  });
}

export const removePrep = (store: ProactiveStore, id: string) =>
  store.removeProactive(KIND.prep, id);

/**
 * Items already told to the person on `day` (a digest line, a brief line, a countdown, a nudge
 * inside an answer), so nothing is said twice in one day.
 */
export async function mentionedOn(store: ProactiveStore, day: string): Promise<Set<string>> {
  const rows = await store.listProactive(KIND.mention);
  return new Set(rows.filter((row) => parseObject(row.data)?.day === day).map((row) => row.id));
}

export async function markMentioned(
  store: ProactiveStore,
  ids: readonly string[],
  day: string,
  atMs: number,
) {
  for (const id of ids) {
    await store.putProactive({
      kind: KIND.mention,
      id,
      dueAtMs: null,
      status: "done",
      data: JSON.stringify({ day }),
      updatedAtMs: atMs,
    });
  }
  const stale = (await store.listProactive(KIND.mention)).filter(
    (row) => atMs - row.updatedAtMs > 3 * DAY_MS,
  );
  for (const row of stale) {
    await store.removeProactive(KIND.mention, row.id);
  }
}

/** Deadline countdowns already sent, by `<deadline id>@<due time>`: a moved deadline counts again. */
export async function countdownSent(store: ProactiveStore): Promise<Set<string>> {
  return new Set((await store.listProactive(KIND.countdown)).map((row) => row.id));
}

export async function markCountdown(
  store: ProactiveStore,
  key: string,
  dueAtMs: number,
  atMs: number,
) {
  await store.putProactive({
    kind: KIND.countdown,
    id: key,
    dueAtMs,
    status: "done",
    data: "{}",
    updatedAtMs: atMs,
  });
  for (const row of await store.listProactive(KIND.countdown)) {
    if (row.dueAtMs !== null && atMs - row.dueAtMs > 3 * DAY_MS) {
      await store.removeProactive(KIND.countdown, row.id);
    }
  }
}

/** One-off facts about the number: when it was first seen, when a template last went out, a one-time proposal. */
export type Marker = "request_template" | "first_seen" | "work_profile";

export async function readMarker(store: ProactiveStore, marker: Marker): Promise<number | null> {
  const row = (await store.listProactive(KIND.marker)).find((entry) => entry.id === marker);
  return row ? finite(parseObject(row.data)?.atMs) : null;
}

export async function writeMarker(store: ProactiveStore, marker: Marker, atMs: number) {
  await store.putProactive({
    kind: KIND.marker,
    id: marker,
    dueAtMs: null,
    status: "done",
    data: JSON.stringify({ atMs }),
    updatedAtMs: atMs,
  });
}
