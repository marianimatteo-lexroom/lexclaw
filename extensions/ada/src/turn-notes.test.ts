import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeadlineCandidate, DeadlineItem } from "./memory-contract.js";
import { WORK_PROFILE_KEY } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { realStore } from "./preference-test-support.js";
import { markMentioned, writeMarker } from "./proactive-store.js";
import {
  pickPiggybackItem,
  registerTurnNotes,
  WORK_PROFILE_AFTER_MS,
  WORK_PROFILE_NOTE,
} from "./turn-notes.js";

const stores = vi.hoisted(() => ({ byOwner: new Map<string, unknown>() }));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryIfExistsFromApi: async (_api: unknown, owner: string) =>
    stores.byOwner.get(owner) ?? null,
}));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ANNA = "393331111111";
const BRUNO = "393332222222";
const DAY = 24 * 60 * 60 * 1000;
/** 11:00 in Rome. */
const NOON = Date.parse("2026-10-27T10:00:00.000Z");
let clock = NOON;

const sessionOf = (owner: string) => `agent:main:kapso-whatsapp:direct:${owner}`;
const ctxFor = (owner: string, extra: Record<string, unknown> = {}) => ({
  senderId: owner,
  channel: "kapso-whatsapp",
  channelId: owner,
  sessionKey: sessionOf(owner),
  runId: "run-1",
  trigger: "user",
  toolAuthority: { allows: () => true, assertActive: () => {} },
  ...extra,
});

function register() {
  const handlers = new Map<string, Handler>();
  registerTurnNotes(
    createTestPluginApi({
      id: "ada",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: ((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }) as OpenClawPluginApi["on"],
    }),
    () => new Date(clock),
  );
  const handler = handlers.get("before_prompt_build");
  if (!handler) {
    throw new Error("turn notes hook missing");
  }
  return handler;
}

function store(owner: string): MemoryStore {
  const memory = realStore(tempDirs.make("ada-turn-notes-"), owner);
  stores.byOwner.set(owner, memory);
  return memory;
}

function candidate(overrides: Partial<DeadlineCandidate> = {}): DeadlineCandidate {
  return {
    matterId: "rossi",
    type: "hearing",
    title: "Udienza R.G. 1234/2026",
    dueAtMs: Date.parse("2026-10-28T08:30:00.000Z"),
    dueDate: "2026-10-28",
    dueTime: "09:30",
    timeZone: "Europe/Rome",
    confidence: 0.9,
    source: { kind: "email", ref: "m1", label: "Cancelleria", excerpt: "udienza" },
    ...overrides,
  };
}

async function seed(memory: MemoryStore, overrides: Partial<DeadlineCandidate> = {}) {
  await memory.upsertRecord(
    {
      id: "rossi-one-pager",
      matterId: "rossi",
      folder: "workstreams/active",
      type: "workstream",
      title: "Rossi SRL",
      aliases: ["Rossi"],
      body: "- Matter",
      validFromMs: 1,
      validToMs: null,
      supersededBy: null,
    },
    "create",
    1,
  );
  const { created } = await memory.upsertDeadlines([candidate(overrides)], 1);
  const id = created[0]?.id ?? "";
  await memory.updateDeadline(id, { status: "tracked" }, 2);
  return id;
}

const noteOf = (result: unknown) =>
  (result as { prependContext?: string } | undefined)?.prependContext;

beforeEach(() => {
  stores.byOwner.clear();
  clock = NOON;
});

describe("the piggyback note", () => {
  it("hands the model the open item due tomorrow once, and not again the same day", async () => {
    const memory = store(ANNA);
    await seed(memory);
    const hook = register();

    const first = noteOf(await hook({}, ctxFor(ANNA, { runId: "run-1" })));
    expect(first).toContain("One open item to mention (this turn only)");
    expect(first).toContain('hearing for "Rossi SRL", tomorrow (2026-10-28 09:30)');
    expect(first).toContain("First answer what they asked, in full");
    expect(first).toContain("ada_deadline_reply");

    clock = NOON + 30 * 60 * 1000;
    expect(await hook({}, ctxFor(ANNA, { runId: "run-2" }))).toBeUndefined();
  });

  it("is a new offer the next day", async () => {
    const memory = store(ANNA);
    await seed(memory, { dueAtMs: Date.parse("2026-10-28T15:00:00.000Z"), dueTime: "16:00" });
    const hook = register();
    await hook({}, ctxFor(ANNA, { runId: "run-1" }));
    clock = NOON + DAY;
    expect(noteOf(await hook({}, ctxFor(ANNA, { runId: "run-2" })))).toContain("today");
  });

  it("gives a retry of the same run the same note, and no other run", async () => {
    const memory = store(ANNA);
    await seed(memory);
    const hook = register();
    const first = noteOf(await hook({}, ctxFor(ANNA, { runId: "run-1" })));
    expect(noteOf(await hook({}, ctxFor(ANNA, { runId: "run-1" })))).toBe(first);
    expect(await hook({}, ctxFor(ANNA, { runId: "run-2" }))).toBeUndefined();
  });

  it("mentions one item per turn: the most time-sensitive, the next one on the next turn", async () => {
    const memory = store(ANNA);
    await seed(memory);
    await memory.upsertDeadlines(
      [
        candidate({
          type: "deadline",
          title: "Deposito memoria",
          dueDate: "2026-10-27",
          dueAtMs: Date.parse("2026-10-27T15:00:00.000Z"),
          dueTime: "16:00",
        }),
      ],
      3,
    );
    const hook = register();
    const first = noteOf(await hook({}, ctxFor(ANNA, { runId: "run-1" }))) ?? "";
    expect(first).toContain("Deposito memoria");
    expect(first).not.toContain("Udienza R.G.");
    const second = noteOf(await hook({}, ctxFor(ANNA, { runId: "run-2" }))) ?? "";
    expect(second).toContain("Udienza R.G.");
    expect(await hook({}, ctxFor(ANNA, { runId: "run-3" }))).toBeUndefined();
  });

  it("does not mention what a digest, a brief or a countdown already named today", async () => {
    const memory = store(ANNA);
    const id = await seed(memory);
    await markMentioned(memory, [id], "2026-10-27", NOON - 3 * 60 * 60 * 1000);
    expect(await register()({}, ctxFor(ANNA))).toBeUndefined();
  });

  it("only speaks for a person's own private turn, and keeps each number's items apart", async () => {
    const memory = store(ANNA);
    store(BRUNO);
    await seed(memory);
    const hook = register();
    expect(await hook({}, ctxFor(BRUNO))).toBeUndefined();
    expect(await hook({}, ctxFor(ANNA, { trigger: "cron" }))).toBeUndefined();
    expect(
      await hook({}, ctxFor(ANNA, { channel: "telegram", channelId: "telegram" })),
    ).toBeUndefined();
    expect(
      await hook(
        {},
        ctxFor(ANNA, { toolAuthority: { allows: () => false, assertActive: () => {} } }),
      ),
    ).toBeUndefined();
    expect(noteOf(await hook({}, ctxFor(ANNA)))).toContain("Rossi SRL");
  });

  it("picks nothing for an item that is further away, already over, or closed", () => {
    const base = {
      id: "d1",
      dedupeKey: "k",
      matterId: "rossi",
      type: "hearing",
      title: "t",
      dueAtMs: Date.parse("2026-10-28T08:30:00.000Z"),
      dueDate: "2026-10-28",
      dueTime: "09:30",
      timeZone: "Europe/Rome",
      confidence: 0.9,
      sources: [],
      status: "tracked",
      offerNo: null,
      offeredCount: 0,
      remindersSent: [],
      researchStatus: "none",
      brief: null,
      briefAtMs: null,
      movedFromMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    } as DeadlineItem;
    const pick = (item: Partial<DeadlineItem>) =>
      pickPiggybackItem({
        deadlines: [{ ...base, ...item }],
        mentioned: new Set(),
        nowMs: NOON,
        timeZone: "Europe/Rome",
      });
    expect(pick({})?.id).toBe("d1");
    expect(pick({ status: "candidate" })?.id).toBe("d1");
    expect(pick({ dueDate: "2026-10-30" })).toBeNull();
    expect(pick({ dueDate: "2026-10-27", dueAtMs: NOON - 1000 })).toBeNull();
    expect(pick({ status: "done" })).toBeNull();
    expect(pick({ status: "dismissed" })).toBeNull();
  });
});

describe("the work-profile offer", () => {
  it("comes once after about two weeks of use, and then never again", async () => {
    const memory = store(ANNA);
    const hook = register();
    expect(await hook({}, ctxFor(ANNA, { runId: "run-1" }))).toBeUndefined();

    clock = NOON + WORK_PROFILE_AFTER_MS - 1000;
    expect(await hook({}, ctxFor(ANNA, { runId: "run-2" }))).toBeUndefined();

    clock = NOON + WORK_PROFILE_AFTER_MS;
    expect(noteOf(await hook({}, ctxFor(ANNA, { runId: "run-3" })))).toBe(WORK_PROFILE_NOTE);
    clock += DAY;
    expect(await hook({}, ctxFor(ANNA, { runId: "run-4" }))).toBeUndefined();
    expect(await memory.listProactive("marker")).toHaveLength(2);
  });

  it("asks for consent: it tells the model to save only after a yes, and to skip silently with nothing true to say", () => {
    expect(WORK_PROFILE_NOTE).toContain(
      `ada_set_preference using the key ${WORK_PROFILE_KEY} only after they say yes`,
    );
    expect(WORK_PROFILE_NOTE).toContain("whether you should save it");
    expect(WORK_PROFILE_NOTE).toContain("skip this offer silently");
    expect(WORK_PROFILE_NOTE).not.toMatch(/reply with|say the word|type /iu);
  });

  it("is not offered to someone who already saved a profile, and waits for a turn without a piggyback", async () => {
    const saved = store(ANNA);
    await writeMarker(saved, "first_seen", NOON - 30 * DAY);
    await saved.setPreference(WORK_PROFILE_KEY, "Works mostly on civil litigation.", 1);
    expect(await register()({}, ctxFor(ANNA))).toBeUndefined();

    const busy = store(BRUNO);
    await writeMarker(busy, "first_seen", NOON - 30 * DAY);
    await seed(busy);
    const hook = register();
    expect(noteOf(await hook({}, ctxFor(BRUNO, { runId: "run-1" })))).toContain(
      "One open item to mention",
    );
    expect(noteOf(await hook({}, ctxFor(BRUNO, { runId: "run-2" })))).toBe(WORK_PROFILE_NOTE);
  });

  it("is only offered where ada_set_preference is available", async () => {
    const memory = store(ANNA);
    await writeMarker(memory, "first_seen", NOON - 30 * DAY);
    const only = (name: string) => ({
      toolAuthority: { allows: (tool: string) => tool === name, assertActive: () => {} },
    });
    const hook = register();
    expect(await hook({}, ctxFor(ANNA, only("ada_todo_list")))).toBeUndefined();
    expect(noteOf(await hook({}, ctxFor(ANNA, only("ada_set_preference"))))).toBe(
      WORK_PROFILE_NOTE,
    );
  });
});
