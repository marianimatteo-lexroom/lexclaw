import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDigest, type MatterAlias } from "./collector.js";
import { prepareDeadlineIntake, type DeadlineIntakeDeps } from "./deadline-intake.js";
import { openTestMemory } from "./deadline-test-support.js";
import { executeAdaDeadlineReply } from "./deadline-tools.js";
import { renderDigestText } from "./digest-text.js";
import type { DeadlineCandidate } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DAY = 24 * 60 * 60 * 1000;
const OCT_14 = new Date("2026-10-14T05:40:00.000Z");
const ALIASES: MatterAlias[] = [{ matterId: "rossi", alias: "Rossi", title: "Rossi c. Bianchi" }];
const ENABLED = { deadlineIntake: { enabled: true } };
const OWNER = "393331111111";
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const toolApi = {
  runtimeSource: undefined,
  runtime: undefined,
  logger,
  config: { channels: { "kapso-whatsapp": { defaultTo: `+${OWNER}` } } },
} as never;

/** Nothing new in the mailbox or the calendar: only what is already stored is listed. */
const quietGoogle: DeadlineIntakeDeps = {
  listMessageIds: async () => ({ ok: true, ids: [] }),
  readMessageContent: async () => ({ ok: false, status: 404 }),
  readAttachmentBytes: async () => ({ ok: false, status: 404 }),
  listUpcomingEvents: async () => ({ ok: true, events: [] }),
};

const morningOf = (day: number) => new Date(OCT_14.getTime() + day * DAY);

function candidate(overrides: Partial<DeadlineCandidate> = {}): DeadlineCandidate {
  return {
    matterId: "rossi",
    type: "hearing",
    title: "Avviso di udienza R.G. 1234/2026",
    dueAtMs: Date.parse("2026-11-12T08:30:00.000Z"),
    dueDate: "2026-11-12",
    dueTime: "09:30",
    timeZone: "Europe/Rome",
    confidence: 0.9,
    source: { kind: "email", ref: "msg-1", label: "Cancelleria", excerpt: "udienza" },
    ...overrides,
  };
}

async function open(overrides: Partial<DeadlineCandidate> = {}) {
  const { memory, close } = openTestMemory(tempDirs.make("ada-last-reminder-"));
  await memory.upsertRecord(
    {
      id: "rossi-workstream",
      matterId: "rossi",
      folder: "workstreams/active",
      type: "workstream",
      title: "Rossi c. Bianchi",
      aliases: ["Rossi"],
      body: "- Matter",
      validFromMs: 1,
      validToMs: null,
      supersededBy: null,
    },
    "create",
    1,
  );
  await memory.upsertDeadlines([candidate(overrides)], 1);
  return { memory, close };
}

/** One morning pass: what the digest would list, and the listing recorded as delivered. */
async function morning(memory: MemoryStore, now: Date) {
  const intake = await prepareDeadlineIntake({
    api: { pluginConfig: ENABLED, logger },
    memory,
    now,
    forceMorning: true,
    aliases: ALIASES,
    timeZone: "Europe/Rome",
    accessToken: "token",
    deps: quietGoogle,
  });
  const result = collectDigest({
    now,
    forceMorning: true,
    inbox: [],
    events: [],
    previousGmail: [],
    previousCalendar: [],
    aliases: ALIASES,
    todos: await memory.listTodos(),
    ...(intake ? { deadlines: intake.digest } : {}),
  });
  if (result.plan.deliver) {
    await intake?.commit(result.plan);
  }
  return result.plan;
}

const listed = (plan: Awaited<ReturnType<typeof morning>>) =>
  plan.deliver ? (plan.deadlines ?? []) : [];

describe("a digest decision nobody answers", () => {
  it("is listed three times, the third as an explicit last reminder, then parked in open loops and left alone", async () => {
    const { memory, close } = await open();
    try {
      const first = await morning(memory, OCT_14);
      const second = await morning(memory, morningOf(1));
      const third = await morning(memory, morningOf(2));
      expect(listed(first)).toMatchObject([{ status: "candidate" }]);
      expect(listed(first)[0]?.lastReminder).toBeUndefined();
      expect(listed(second)[0]?.lastReminder).toBeUndefined();
      expect(listed(third)).toMatchObject([{ status: "candidate", lastReminder: true }]);
      if (third.deliver) {
        expect(renderDigestText(third, "it", "Europe/Rome")).toContain("Ultimo promemoria.");
        expect(renderDigestText(third, "en", "Europe/Rome")).toContain("Last reminder.");
      }

      const [item] = await memory.listDeadlines();
      expect(item?.offeredCount).toBe(3);
      expect(await memory.listTodos()).toMatchObject([
        {
          id: `parked-deadline-${item?.id}`,
          matterId: "rossi",
          owner: "lawyer",
          status: "pending",
          title: expect.stringContaining("Confirm tracking: "),
        },
      ]);

      const fourth = await morning(memory, morningOf(3));
      expect(listed(fourth)).toEqual([]);
      expect(fourth.deliver).toBe(false);
      expect((await memory.listDeadlines())[0]?.offeredCount).toBe(3);
    } finally {
      close();
    }
  });

  it("does not come back as a digest item through the todo it was parked as, unlike an ordinary open todo", async () => {
    const { memory, close } = await open();
    try {
      for (const day of [0, 1, 2]) {
        await morning(memory, morningOf(day));
      }
      const todos = await memory.listTodos();
      const base = {
        now: morningOf(5),
        forceMorning: true,
        inbox: [],
        events: [],
        previousGmail: [],
        previousCalendar: [],
        aliases: ALIASES,
      };
      expect(collectDigest({ ...base, todos }).plan.deliver).toBe(false);
      const ordinary = todos.map((todo) => Object.assign({}, todo, { id: "t-ordinary" }));
      expect(collectDigest({ ...base, todos: ordinary }).plan.deliver).toBe(true);
    } finally {
      close();
    }
  });

  it("closes the parked todo when the person finally answers", async () => {
    const { memory, close } = await open();
    try {
      for (const day of [0, 1, 2]) {
        await morning(memory, morningOf(day));
      }
      await executeAdaDeadlineReply(
        { ref: "1", action: "track" },
        ENABLED,
        toolApi,
        OWNER,
        undefined,
        morningOf(4),
        { memory },
      );
      expect(await memory.listTodos()).toMatchObject([{ status: "done" }]);
    } finally {
      close();
    }
  });

  it("parks nothing for a decision that was answered after its first listing", async () => {
    const { memory, close } = await open();
    try {
      await morning(memory, OCT_14);
      await executeAdaDeadlineReply(
        { ref: "1", action: "dismiss" },
        ENABLED,
        toolApi,
        OWNER,
        undefined,
        OCT_14,
        { memory },
      );
      await morning(memory, morningOf(1));
      await morning(memory, morningOf(2));
      expect(await memory.listTodos()).toEqual([]);
    } finally {
      close();
    }
  });

  it("keeps listing a hearing within 48 hours however often it was listed: an alert is not a nudge", async () => {
    const { memory, close } = await open({
      dueAtMs: Date.parse("2026-10-16T08:30:00.000Z"),
      dueDate: "2026-10-16",
    });
    try {
      for (const day of [0, 1, 2]) {
        await morning(memory, morningOf(day));
      }
      const fourth = await morning(memory, new Date("2026-10-16T05:40:00.000Z"));
      expect(listed(fourth)).toMatchObject([{ status: "candidate" }]);
    } finally {
      close();
    }
  });
});
