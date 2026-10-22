import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, ThreadMessage } from "./google-api.js";
import { PREP_ON_KEY, type DeadlineCandidate } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { realStore } from "./preference-test-support.js";
import {
  listPreps,
  listReminders,
  listWatches,
  markMentioned,
  saveReminder,
  saveWatch,
  type ThreadWatch,
} from "./proactive-store.js";
import {
  PREP_DAILY_CAP,
  releaseReadyNotices,
  runProactivePass,
  type ProactiveSeams,
} from "./proactive.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const OWNER = "393331111111";
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
/** 11:00 in Rome. */
const NOW = new Date("2026-10-27T10:00:00.000Z");
const api = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  config: {},
  runtime: {},
  runtimeSource: "",
  pluginConfig: {},
} as never;

type Harness = ReturnType<typeof setup>;

function setup(options: { windowOpen?: boolean } = {}) {
  const memory = realStore(tempDirs.make("ada-proactive-"), "owner");
  const texts: string[] = [];
  const seams = {
    sendText: vi.fn(async (text: string) => {
      texts.push(text);
      return { ok: true };
    }),
    sendTemplate: vi.fn(async () => "sent" as const),
    mirror: vi.fn(async () => true),
    readThread: vi.fn<ProactiveSeams["readThread"]>(async () => ({ ok: true, messages: [] })),
    readEvents: vi.fn(async () => [] as CalendarEvent[]),
  } satisfies ProactiveSeams;
  const openWindow = options.windowOpen !== false;
  const ready = memory.writeWake({
    lastLawyerInboundAtMs: openWindow ? NOW.getTime() - HOUR : NOW.getTime() - 30 * HOUR,
  });
  const run = async (at: Date = NOW) => {
    await ready;
    await runProactivePass({ api, owner: OWNER, memory, now: at, seams });
  };
  const release = async (at: Date) => {
    await memory.writeWake({ lastLawyerInboundAtMs: at.getTime() });
    await releaseReadyNotices({ api, owner: OWNER, memory, now: at, seams });
  };
  return { memory, texts, seams, run, release };
}

async function remind(memory: MemoryStore, id: string, text: string, dueAtMs: number) {
  await saveReminder(
    memory,
    { id, text, dueAtMs, createdAtMs: dueAtMs - HOUR, state: "pending" },
    1,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  recordInboundLanguage(OWNER, "please remind me of this");
});
afterEach(() => {
  clearInboundLanguages();
});

describe("reminders", () => {
  it("fires a due reminder once, as free text inside the window, and not before its time", async () => {
    const t = setup();
    await remind(t.memory, "r1", "Call Rossi about the brief", NOW.getTime() - 5 * MINUTE);
    await remind(t.memory, "r2", "Later today", NOW.getTime() + 2 * HOUR);

    await t.run();

    expect(t.texts).toEqual(["Reminder: Call Rossi about the brief"]);
    expect(t.seams.sendTemplate).not.toHaveBeenCalled();
    expect((await listReminders(t.memory)).map((reminder) => reminder.id)).toEqual(["r2"]);
    expect(t.seams.mirror).toHaveBeenCalledOnce();

    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(t.texts).toHaveLength(1);
  });

  it("says when a late reminder was meant to come", async () => {
    const t = setup();
    await remind(t.memory, "r1", "Send the memo", NOW.getTime() - 5 * HOUR);
    await t.run();
    expect(t.texts[0]).toMatch(/^Reminder \(it was for .*\): Send the memo$/u);
  });

  it("writes the words around the reminder in the language of the latest message", async () => {
    recordInboundLanguage(OWNER, "Ricordami di chiamare il cliente domani");
    const t = setup();
    await remind(t.memory, "r1", "chiamare Rossi", NOW.getTime() - MINUTE);
    await t.run();
    expect(t.texts).toEqual(["Promemoria: chiamare Rossi"]);
  });

  it("batches reminders that are due together into one message", async () => {
    const t = setup();
    await remind(t.memory, "r1", "First", NOW.getTime() - 2 * MINUTE);
    await remind(t.memory, "r2", "Second", NOW.getTime() - MINUTE);
    await t.run();
    expect(t.texts).toEqual(["Reminder: First\nReminder: Second"]);
  });

  it("outside the window sends only the request-ready template, once, and holds the content", async () => {
    const t = setup({ windowOpen: false });
    await remind(t.memory, "r1", "Call Rossi", NOW.getTime() - MINUTE);
    await remind(t.memory, "r2", "Send the memo", NOW.getTime() - MINUTE);

    await t.run();
    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    await t.run(new Date(NOW.getTime() + 30 * MINUTE));

    expect(t.texts).toEqual([]);
    expect(t.seams.sendText).not.toHaveBeenCalled();
    expect(t.seams.sendTemplate).toHaveBeenCalledOnce();
    expect((await listReminders(t.memory)).map((reminder) => reminder.state)).toEqual([
      "ready",
      "ready",
    ]);
  });

  it("releases the held reminders as one text when the number writes, and a later poll sends nothing", async () => {
    const t = setup({ windowOpen: false });
    await remind(t.memory, "r1", "Call Rossi", NOW.getTime() - MINUTE);
    await t.run();

    await t.release(new Date(NOW.getTime() + 3 * HOUR));

    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toContain("Call Rossi");
    expect(await listReminders(t.memory)).toEqual([]);
    await t.run(new Date(NOW.getTime() + 4 * HOUR));
    expect(t.texts).toHaveLength(1);
  });

  it("sends the template again for a later closed window, not for the same one", async () => {
    const t = setup({ windowOpen: false });
    await remind(t.memory, "r1", "One", NOW.getTime() - MINUTE);
    await t.run();
    await t.release(new Date(NOW.getTime() + HOUR));
    const later = new Date(NOW.getTime() + 40 * HOUR);
    await remind(t.memory, "r2", "Two", later.getTime() - MINUTE);
    await t.run(later);
    expect(t.seams.sendTemplate).toHaveBeenCalledTimes(2);
  });

  it("keeps the reminder when the text cannot be sent, and tries again at the next poll", async () => {
    const t = setup();
    await remind(t.memory, "r1", "Call Rossi", NOW.getTime() - MINUTE);
    t.seams.sendText.mockResolvedValueOnce({ ok: false });
    await t.run();
    expect(await listReminders(t.memory)).toHaveLength(1);
    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(t.texts).toHaveLength(1);
    expect(await listReminders(t.memory)).toEqual([]);
  });

  it("holds without failing when no request template is configured", async () => {
    const t = setup({ windowOpen: false });
    t.seams.sendTemplate.mockResolvedValue("unset" as never);
    await remind(t.memory, "r1", "Call Rossi", NOW.getTime() - MINUTE);
    await t.run();
    expect(t.texts).toEqual([]);
    expect(await listReminders(t.memory)).toHaveLength(1);
  });
});

function watch(id: string, overrides: Partial<ThreadWatch> = {}): ThreadWatch {
  return {
    id: `google:${id}`,
    provider: "google",
    threadId: id,
    subject: "Memoria Rossi",
    to: "avv.verdi@example.com",
    sentAtMs: NOW.getTime() - 5 * HOUR,
    seenIds: [`own-${id}`],
    reply: null,
    state: "pending",
    ...overrides,
  };
}

const own = (id: string): ThreadMessage => ({
  id: `own-${id}`,
  from: "me@example.com",
  subject: "Memoria Rossi",
  snippet: "Ecco la memoria",
  atMs: NOW.getTime() - 5 * HOUR,
  own: true,
});
const answer = (id: string, atMs = NOW.getTime() - HOUR): ThreadMessage => ({
  id: `reply-${id}`,
  from: "Avv. Verdi <avv.verdi@example.com>",
  subject: "Re: Memoria Rossi",
  snippet: "Ricevuta, la leggo   domani\nmattina.",
  atMs,
  own: false,
});

describe("sent-thread watch", () => {
  it("surfaces the reply to a mail Ada sent, once, inside the window", async () => {
    const t = setup();
    await saveWatch(t.memory, watch("t1"), 1);
    t.seams.readThread.mockResolvedValue({ ok: true, messages: [own("t1"), answer("t1")] });

    await t.run();

    expect(t.texts).toEqual([
      'Avv. Verdi replied to "Memoria Rossi": Ricevuta, la leggo domani mattina.\n\nWant me to draft a reply?',
    ]);
    expect(await listWatches(t.memory)).toEqual([]);
    expect(t.seams.sendTemplate).not.toHaveBeenCalled();

    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(t.texts).toHaveLength(1);
  });

  it("says nothing while nobody else has written, and ignores the person's own messages", async () => {
    const t = setup();
    await saveWatch(t.memory, watch("t1"), 1);
    t.seams.readThread.mockResolvedValue({
      ok: true,
      messages: [own("t1"), { ...own("t1"), id: "own-later", atMs: NOW.getTime() - HOUR }],
    });
    await t.run();
    expect(t.texts).toEqual([]);
    expect(await listWatches(t.memory)).toHaveLength(1);
  });

  it("does not take a message older than the mail Ada sent for its reply", async () => {
    const t = setup();
    await saveWatch(t.memory, watch("t1"), 1);
    t.seams.readThread.mockResolvedValue({
      ok: true,
      messages: [own("t1"), answer("t1", NOW.getTime() - 9 * HOUR)],
    });
    await t.run();
    expect(t.texts).toEqual([]);
  });

  it("batches the replies of several threads into one message, one line each", async () => {
    const t = setup();
    await saveWatch(t.memory, watch("t1"), 1);
    await saveWatch(t.memory, watch("t2", { subject: "Contratto Bianchi" }), 1);
    t.seams.readThread.mockImplementation(async (value: ThreadWatch) => ({
      ok: true as const,
      messages: [own(value.threadId), answer(value.threadId)],
    }));
    await t.run();
    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]?.match(/replied to/gu)).toHaveLength(2);
    expect(t.texts[0]?.match(/Want me to draft a reply\?/gu)).toHaveLength(1);
    expect(await listWatches(t.memory)).toEqual([]);
  });

  it("outside the window holds the reply, sends only the request-ready template once, and releases it on the next message", async () => {
    const t = setup({ windowOpen: false });
    await saveWatch(t.memory, watch("t1"), 1);
    t.seams.readThread.mockResolvedValue({ ok: true, messages: [own("t1"), answer("t1")] });

    await t.run();
    await t.run(new Date(NOW.getTime() + 15 * MINUTE));

    expect(t.texts).toEqual([]);
    expect(t.seams.sendTemplate).toHaveBeenCalledOnce();
    expect(await listWatches(t.memory)).toMatchObject([{ state: "ready" }]);
    expect(t.seams.readThread).toHaveBeenCalledOnce();

    await t.release(new Date(NOW.getTime() + 2 * HOUR));
    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toContain("Avv. Verdi");
    expect(await listWatches(t.memory)).toEqual([]);
  });

  it("keeps what a lookup watch resolved, so the next poll reads the conversation and never searches Sent Items again", async () => {
    const t = setup();
    const lookup = watch("lookup:1", { provider: "outlook", id: "outlook:lookup:1", seenIds: [] });
    await saveWatch(t.memory, lookup, 1);
    t.seams.readThread.mockResolvedValueOnce({
      ok: true,
      messages: [own("conv-9")],
      resolved: { threadId: "conv-9", ownId: "sent-9" },
    });
    await t.run();
    expect(await listWatches(t.memory)).toMatchObject([
      { id: "outlook:conv-9", threadId: "conv-9", seenIds: ["sent-9"], state: "pending" },
    ]);

    t.seams.readThread.mockResolvedValueOnce({
      ok: true,
      messages: [own("conv-9"), answer("conv-9")],
    });
    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(t.seams.readThread).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "conv-9" }),
    );
    expect(t.texts).toHaveLength(1);
  });

  it("does not report Ada's own sent message as a reply when a watch resolves", async () => {
    const t = setup();
    await saveWatch(
      t.memory,
      watch("lookup:2", { provider: "outlook", id: "outlook:lookup:2", seenIds: [] }),
      1,
    );
    t.seams.readThread.mockResolvedValue({
      ok: true,
      messages: [{ ...answer("x"), id: "sent-2", from: "anna@contoso.example" }],
      resolved: { threadId: "conv-2", ownId: "sent-2" },
    });
    await t.run();
    expect(t.texts).toEqual([]);
  });

  it("reads the watches looked at longest ago first, so none starves behind newer ones", async () => {
    const t = setup();
    for (let index = 0; index < 25; index += 1) {
      await saveWatch(
        t.memory,
        watch(`w${String(index).padStart(2, "0")}`, {
          sentAtMs: NOW.getTime() - (index + 1) * HOUR,
        }),
        1000 + index,
      );
    }
    const seen = () => t.seams.readThread.mock.calls.map(([value]) => value.threadId);
    await t.run();
    expect(seen()).toHaveLength(20);
    expect(seen()).not.toContain("w20");
    t.seams.readThread.mockClear();
    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(seen().slice(0, 5)).toEqual(["w20", "w21", "w22", "w23", "w24"]);
  });

  it("expires every watch past its month, even beyond the ones a pass reads", async () => {
    const t = setup();
    for (let index = 0; index < 22; index += 1) {
      await saveWatch(
        t.memory,
        watch(`n${index}`, { sentAtMs: NOW.getTime() - HOUR - index }),
        2000 + index,
      );
    }
    await saveWatch(t.memory, watch("ancient", { sentAtMs: NOW.getTime() - 40 * 24 * HOUR }), 1);
    await t.run();
    expect((await listWatches(t.memory)).map((entry) => entry.threadId)).not.toContain("ancient");
  });

  it("re-keys a resolved lookup watch to its conversation and merges it with a watch already there", async () => {
    const t = setup();
    await saveWatch(
      t.memory,
      watch("lookup:3", { provider: "outlook", id: "outlook:lookup:3", seenIds: [] }),
      1,
    );
    await saveWatch(
      t.memory,
      watch("conv-3", {
        provider: "outlook",
        id: "outlook:conv-3",
        seenIds: ["earlier"],
        sentAtMs: NOW.getTime() - HOUR,
      }),
      2,
    );
    t.seams.readThread.mockImplementation(async (value: ThreadWatch) =>
      value.threadId.startsWith("lookup:")
        ? {
            ok: true as const,
            messages: [own("conv-3")],
            resolved: { threadId: "conv-3", ownId: "sent-3" },
          }
        : { ok: true as const, messages: [own("conv-3")] },
    );
    await t.run();
    const watches = await listWatches(t.memory);
    expect(watches.map((entry) => entry.id)).toEqual(["outlook:conv-3"]);
    expect(watches[0]?.seenIds.toSorted()).toEqual(["earlier", "sent-3"]);
    expect(watches[0]?.sentAtMs).toBe(NOW.getTime() - 5 * HOUR);
  });

  it("drops a watch whose thread is gone, and one older than a month", async () => {
    const t = setup();
    await saveWatch(t.memory, watch("gone"), 1);
    await saveWatch(t.memory, watch("old", { sentAtMs: NOW.getTime() - 31 * 24 * HOUR }), 1);
    t.seams.readThread.mockResolvedValue({ ok: false, gone: true });
    await t.run();
    expect(await listWatches(t.memory)).toEqual([]);
    expect(t.seams.readThread).toHaveBeenCalledOnce();
  });

  it("keeps the watch when the provider cannot be reached for a moment", async () => {
    const t = setup();
    await saveWatch(t.memory, watch("t1"), 1);
    t.seams.readThread.mockResolvedValue({ ok: false, gone: false });
    await t.run();
    expect(await listWatches(t.memory)).toHaveLength(1);
  });
});

async function seedMatter(memory: MemoryStore) {
  await memory.upsertRecord(
    {
      id: "rossi-one-pager",
      matterId: "rossi",
      folder: "workstreams/active",
      type: "workstream",
      title: "Rossi SRL",
      aliases: ["Rossi"],
      body: "- Matter: Rossi SRL",
      validFromMs: 1,
      validToMs: null,
      supersededBy: null,
    },
    "create",
    1,
  );
}

function candidate(overrides: Partial<DeadlineCandidate> = {}): DeadlineCandidate {
  return {
    matterId: "rossi",
    type: "deadline",
    title: "Deposito memoria",
    dueAtMs: Date.parse("2026-10-28T15:00:00.000Z"),
    dueDate: "2026-10-28",
    dueTime: "16:00",
    timeZone: "Europe/Rome",
    confidence: 0.9,
    source: { kind: "email", ref: "m1", label: "Cancelleria", excerpt: "termine" },
    ...overrides,
  };
}

/** Due in two weeks: inside a recap's reach and far from any countdown. */
const FAR = { dueDate: "2026-11-10", dueAtMs: Date.parse("2026-11-10T15:00:00.000Z") };

async function trackDeadline(memory: MemoryStore, overrides: Partial<DeadlineCandidate> = {}) {
  const { created } = await memory.upsertDeadlines([candidate(overrides)], 1);
  const id = created[0]?.id ?? "";
  await memory.updateDeadline(id, { status: "tracked" }, 2);
  return id;
}

const hearing = (id: string, startMs: number, summary = "Udienza Rossi"): CalendarEvent => ({
  id,
  summary,
  start: new Date(startMs).toISOString(),
  end: new Date(startMs + HOUR).toISOString(),
  status: "confirmed",
});

describe("prep before a hearing or meeting", () => {
  async function optedIn(t: Harness, keys: string[] = [PREP_ON_KEY]) {
    await seedMatter(t.memory);
    await t.memory.upsertTodo({
      id: "t-1",
      matterId: "rossi",
      owner: "lawyer",
      title: "Collect the signed power of attorney",
      status: "pending",
      detail: "",
      updatedAtMs: 1,
    });
    await trackDeadline(t.memory, FAR);
    for (const key of keys) {
      await t.memory.setPreference(key, "asked for it", 1);
    }
  }

  it("does nothing, and reads no calendar, for a person who did not opt in", async () => {
    const t = setup();
    await seedMatter(t.memory);
    await trackDeadline(t.memory, FAR);
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);
    await t.run();
    expect(t.seams.readEvents).not.toHaveBeenCalled();
    expect(t.texts).toEqual([]);
  });

  it("pushes a recap about an hour before a matter's event, inside the window, once", async () => {
    const t = setup();
    await optedIn(t);
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);

    await t.run();

    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toContain("Udienza Rossi (Rossi SRL)");
    expect(t.texts[0]).toContain("Deposito memoria");
    expect(t.texts[0]).toContain("Collect the signed power of attorney");
    expect(await listPreps(t.memory)).toMatchObject([{ state: "sent" }]);

    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(t.texts).toHaveLength(1);
  });

  it("leaves out events that are too far, too near, or of no matter", async () => {
    const t = setup();
    await optedIn(t);
    t.seams.readEvents.mockResolvedValue([
      hearing("far", NOW.getTime() + 3 * HOUR),
      hearing("near", NOW.getTime() + 20 * MINUTE),
      hearing("other", NOW.getTime() + 75 * MINUTE, "Pranzo con un collega"),
    ]);
    await t.run();
    expect(t.texts).toEqual([]);
  });

  it("skips an event when there is nothing to recap besides the event itself", async () => {
    const t = setup();
    await seedMatter(t.memory);
    await t.memory.setPreference(PREP_ON_KEY, "asked for it", 1);
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);
    await t.run();
    expect(t.texts).toEqual([]);
  });

  it("stops at the daily cap", async () => {
    const t = setup();
    await optedIn(t);
    t.seams.readEvents.mockResolvedValue(
      Array.from({ length: PREP_DAILY_CAP + 2 }, (_, index) =>
        hearing(`e${index}`, NOW.getTime() + (65 + index) * MINUTE),
      ),
    );
    await t.run();
    expect(await listPreps(t.memory)).toHaveLength(PREP_DAILY_CAP);
    await t.run(new Date(NOW.getTime() + 5 * MINUTE));
    expect(await listPreps(t.memory)).toHaveLength(PREP_DAILY_CAP);
  });

  it("outside the window holds the recap and never sends a template for it, even next to a reminder's", async () => {
    const t = setup({ windowOpen: false });
    await optedIn(t);
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);
    await t.run();
    expect(t.texts).toEqual([]);
    expect(t.seams.sendTemplate).not.toHaveBeenCalled();
    expect(await listPreps(t.memory)).toMatchObject([{ state: "ready" }]);

    await t.release(new Date(NOW.getTime() + 30 * MINUTE));
    expect(t.texts).toHaveLength(1);
  });

  it("sends no template for a held recap, while a reminder held beside it still gets the one template", async () => {
    const t = setup({ windowOpen: false });
    await optedIn(t);
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);
    await t.run();
    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(t.seams.sendTemplate).not.toHaveBeenCalled();
    await remind(t.memory, "r1", "Call Rossi", NOW.getTime() + 20 * MINUTE);
    await t.run(new Date(NOW.getTime() + 30 * MINUTE));
    expect(t.seams.sendTemplate).toHaveBeenCalledOnce();
    expect(t.texts).toEqual([]);
  });

  it("skips an all-day event, which has a date and no time", async () => {
    const t = setup();
    await optedIn(t);
    t.seams.readEvents.mockResolvedValue([
      { ...hearing("e1", NOW.getTime() + 75 * MINUTE), start: "2026-10-27", end: "2026-10-28" },
    ]);
    await t.run();
    expect(t.texts).toEqual([]);
    expect(await listPreps(t.memory)).toEqual([]);
  });

  it("leaves a parked decision out of the recap, so its English title never lands in another language", async () => {
    const t = setup();
    await optedIn(t);
    await t.memory.upsertTodo({
      id: "parked-deadline-d1",
      matterId: "rossi",
      owner: "lawyer",
      title: "Confirm tracking: Udienza (2026-11-12 09:30)",
      status: "pending",
      detail: "",
      updatedAtMs: 1,
    });
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);
    await t.run();
    expect(t.texts[0]).toContain("Collect the signed power of attorney");
    expect(t.texts[0]).not.toContain("Confirm tracking");
  });

  it("prunes sent recaps a day after their event, so old rows never crowd new ones out", async () => {
    const t = setup();
    await optedIn(t);
    const day = 24 * HOUR;
    for (const [id, startMs] of [
      ["old", NOW.getTime() - 2 * day],
      ["recent", NOW.getTime() - 2 * HOUR],
    ] as const) {
      await t.memory.putProactive({
        kind: "prep",
        id,
        dueAtMs: startMs,
        status: "sent",
        data: JSON.stringify({
          title: "x",
          startMs,
          matterLabel: "",
          facts: {},
          day: "2026-10-20",
        }),
        updatedAtMs: 1,
      });
    }
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);
    await t.run();
    expect((await listPreps(t.memory)).map((prep) => prep.id).includes("old")).toBe(false);
    expect((await listPreps(t.memory)).map((prep) => prep.id).includes("recent")).toBe(true);
  });

  it("drops a held recap once its event has started", async () => {
    const t = setup({ windowOpen: false });
    await optedIn(t);
    t.seams.readEvents.mockResolvedValue([hearing("e1", NOW.getTime() + 75 * MINUTE)]);
    await t.run();
    await t.release(new Date(NOW.getTime() + 3 * HOUR));
    expect(t.texts).toEqual([]);
    expect(await listPreps(t.memory)).toEqual([]);
  });
});

describe("deadline countdown", () => {
  it("nudges once, in the window, for a confirmed deadline due tomorrow, and never with a template", async () => {
    const t = setup();
    await seedMatter(t.memory);
    await trackDeadline(t.memory);

    await t.run();

    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toContain("Coming up:");
    expect(t.texts[0]).toContain("Rossi SRL: deadline 2026-10-28 16:00 (tomorrow)");
    expect(t.seams.sendTemplate).not.toHaveBeenCalled();

    await t.run(new Date(NOW.getTime() + 15 * MINUTE));
    expect(t.texts).toHaveLength(1);
  });

  it("with the window closed sends nothing at all: the deadline rides the 07:40 digest", async () => {
    const t = setup({ windowOpen: false });
    await seedMatter(t.memory);
    await trackDeadline(t.memory);
    await t.run();
    expect(t.texts).toEqual([]);
    expect(t.seams.sendText).not.toHaveBeenCalled();
    expect(t.seams.sendTemplate).not.toHaveBeenCalled();
  });

  it("leaves out an unconfirmed deadline, one further away, and the hours of the night", async () => {
    const t = setup();
    await seedMatter(t.memory);
    await t.memory.upsertDeadlines([candidate()], 1);
    await trackDeadline(t.memory, {
      dueDate: "2026-11-05",
      dueAtMs: Date.parse("2026-11-05T15:00:00.000Z"),
    });
    await t.run();
    expect(t.texts).toEqual([]);

    await trackDeadline(t.memory, {
      type: "hearing",
      dueDate: "2026-10-28",
      dueAtMs: Date.parse("2026-10-28T08:00:00.000Z"),
      dueTime: "10:00",
    });
    await t.run(new Date("2026-10-27T22:00:00.000Z"));
    expect(t.texts).toEqual([]);
  });

  it("does not repeat what the digest or the brief already named today", async () => {
    const t = setup();
    await seedMatter(t.memory);
    const id = await trackDeadline(t.memory);
    await markMentioned(t.memory, [id], "2026-10-27", NOW.getTime() - 3 * HOUR);
    await t.run();
    expect(t.texts).toEqual([]);
  });

  it("never counts a timed deadline down on a day the digest, brief or piggyback line already named it, however close it is", async () => {
    const t = setup();
    await seedMatter(t.memory);
    const id = await trackDeadline(t.memory, {
      type: "hearing",
      dueDate: "2026-10-27",
      dueAtMs: Date.parse("2026-10-27T12:00:00.000Z"),
      dueTime: "14:00",
    });
    await markMentioned(t.memory, [id], "2026-10-27", NOW.getTime() - 3 * HOUR);
    await t.run();
    await t.run(new Date(NOW.getTime() + 90 * MINUTE));
    expect(t.texts).toEqual([]);
  });

  it("counts a timed deadline down when nothing named it today", async () => {
    const t = setup();
    await seedMatter(t.memory);
    await trackDeadline(t.memory, {
      type: "hearing",
      dueDate: "2026-10-27",
      dueAtMs: Date.parse("2026-10-27T12:00:00.000Z"),
      dueTime: "14:00",
    });
    await t.run();
    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toContain("hearing 2026-10-27 14:00 (today)");
  });

  it("never nudges twice for the same deadline", async () => {
    const t = setup();
    await seedMatter(t.memory);
    await trackDeadline(t.memory);
    await t.run();
    expect(t.texts).toHaveLength(1);
    await t.run(new Date(NOW.getTime() + 30 * MINUTE));
    expect(t.texts).toHaveLength(1);
  });
});

describe("a failing step does not stop the others", () => {
  it("still delivers a reminder when the watch poll throws", async () => {
    const t = setup();
    await remind(t.memory, "r1", "Call Rossi", NOW.getTime() - MINUTE);
    await saveWatch(t.memory, watch("t1"), 1);
    t.seams.readThread.mockRejectedValue(new Error("provider down"));
    await t.run();
    expect(t.texts).toEqual(["Reminder: Call Rossi"]);
  });
});
