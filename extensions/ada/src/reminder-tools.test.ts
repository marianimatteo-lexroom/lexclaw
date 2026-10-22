import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "./memory.js";
import { realStore } from "./preference-test-support.js";
import { MAX_REMINDERS } from "./proactive-store.js";
import {
  executeAdaCancelReminder,
  executeAdaListReminders,
  executeAdaSetReminder,
  parseReminderTime,
} from "./reminder-tools.js";
import { clearHeldResearch, recordSenderInbound } from "./research-push.js";

const stores = vi.hoisted(() => ({ byOwner: new Map<string, unknown>() }));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryFromApi: async (_api: unknown, owner: string) => stores.byOwner.get(owner),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ANNA = "393331111111";
const BRUNO = "393332222222";
/** 11:00 in Rome. */
const NOW = new Date("2026-10-27T10:00:00.000Z");
const api = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as never;

function store(owner: string, timezone?: string): MemoryStore {
  const memory = realStore(tempDirs.make("ada-reminders-"), owner);
  stores.byOwner.set(owner, memory);
  if (timezone) {
    void memory.setProfileTimezone(timezone, 1);
  }
  return memory;
}

beforeEach(() => {
  clearHeldResearch();
  stores.byOwner.clear();
  vi.clearAllMocks();
});

describe("parseReminderTime", () => {
  it("reads a time without an offset on the person's own clock", () => {
    // Rome is on winter time from 25 October.
    expect(parseReminderTime("2026-10-27T15:30", "Europe/Rome")).toBe(
      Date.parse("2026-10-27T14:30:00.000Z"),
    );
    expect(parseReminderTime("2026-10-20T15:30", "Europe/Rome")).toBe(
      Date.parse("2026-10-20T13:30:00.000Z"),
    );
    expect(parseReminderTime("2026-12-01 09:00", "Europe/Rome")).toBe(
      Date.parse("2026-12-01T08:00:00.000Z"),
    );
    expect(parseReminderTime("2026-10-27T09:00", "Asia/Shanghai")).toBe(
      Date.parse("2026-10-27T01:00:00.000Z"),
    );
  });

  it("keeps the offset when the time carries one", () => {
    const at = Date.parse("2026-10-27T13:30:00.000Z");
    expect(parseReminderTime("2026-10-27T13:30:00Z", "Asia/Shanghai")).toBe(at);
    expect(parseReminderTime("2026-10-27T15:30:00+02:00", "Asia/Shanghai")).toBe(at);
    expect(parseReminderTime("2026-10-27T15:30+0200", "Asia/Shanghai")).toBe(at);
  });

  it("refuses what is not a date and time", () => {
    for (const bad of ["tomorrow at 9", "2026-10-27", "2026-02-30T09:00", "2026-10-27T25:00", ""]) {
      expect(parseReminderTime(bad, "Europe/Rome"), bad).toBeNull();
    }
  });
});

describe("ada_set_reminder", () => {
  it("saves a reminder on the asking number, answers with the time it set and says reminders are checked every 15 minutes", async () => {
    const memory = store(ANNA, "Europe/Rome");
    const result = await executeAdaSetReminder(
      api,
      ANNA,
      { at: "2026-10-29T09:00", text: "  Call   Rossi  " },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      text: "Call Rossi",
      dueAt: "2026-10-29 09:00",
      timeZone: "Europe/Rome",
      note: expect.stringContaining("every 15 minutes"),
    });
    const listed = await executeAdaListReminders(api, ANNA);
    expect(listed).toMatchObject({
      ok: true,
      reminders: [{ text: "Call Rossi", dueAt: "2026-10-29 09:00", status: "waiting" }],
    });
    expect(await memory.listProactive("reminder")).toHaveLength(1);
  });

  it("falls back to Europe/Rome when the person has no saved zone", async () => {
    store(ANNA);
    expect(
      await executeAdaSetReminder(api, ANNA, { at: "2026-10-29T09:00", text: "x" }, NOW),
    ).toMatchObject({ ok: true, timeZone: "Europe/Rome" });
  });

  it("refuses a past time, an unreadable time, too long a text and a date a year away", async () => {
    store(ANNA);
    for (const [at, text, error] of [
      ["2026-10-27T10:30", "", "short text"],
      ["2026-10-27T11:00", "x", "already passed"],
      ["soon", "x", "YYYY-MM-DDTHH:MM"],
      ["2028-01-01T09:00", "x", "more than a year"],
      ["2026-10-29T09:00", "x".repeat(400), "short text"],
    ] as const) {
      expect(await executeAdaSetReminder(api, ANNA, { at, text }, NOW)).toMatchObject({
        ok: false,
        error: expect.stringContaining(error),
      });
    }
    expect(await executeAdaListReminders(api, ANNA)).toMatchObject({ reminders: [] });
  });

  it("stops at the cap and says which tool frees a place", async () => {
    store(ANNA);
    for (let index = 0; index < MAX_REMINDERS; index += 1) {
      await executeAdaSetReminder(api, ANNA, { at: "2026-10-29T09:00", text: `r${index}` }, NOW);
    }
    expect(
      await executeAdaSetReminder(api, ANNA, { at: "2026-10-29T09:00", text: "one more" }, NOW),
    ).toMatchObject({ ok: false, error: expect.stringContaining("ada_cancel_reminder") });
  });

  it("keeps each number's reminders apart", async () => {
    store(ANNA);
    store(BRUNO);
    await executeAdaSetReminder(api, ANNA, { at: "2026-10-29T09:00", text: "Anna's" }, NOW);
    expect(await executeAdaListReminders(api, BRUNO)).toMatchObject({ reminders: [] });
    const [anna] = (await executeAdaListReminders(api, ANNA)).reminders ?? [];
    expect(await executeAdaCancelReminder(api, BRUNO, { id: anna?.id ?? "" })).toMatchObject({
      ok: false,
    });
    expect(await executeAdaListReminders(api, ANNA)).toMatchObject({
      reminders: [{ text: "Anna's" }],
    });
  });
});

describe("a first message", () => {
  it("is kept in the memory file the reminder creates, so the open window survives a restart", async () => {
    const memory = store(ANNA);
    recordSenderInbound(ANNA, NOW.getTime() - 5 * 60_000);
    await executeAdaSetReminder(api, ANNA, { at: "2026-10-27T15:00", text: "Call Rossi" }, NOW);
    expect((await memory.readWake()).lastLawyerInboundAtMs).toBe(NOW.getTime() - 5 * 60_000);
    clearHeldResearch();
    const other = store(BRUNO);
    await executeAdaSetReminder(api, BRUNO, { at: "2026-10-27T15:00", text: "x" }, NOW);
    expect((await other.readWake()).lastLawyerInboundAtMs).toBeNull();
  });
});

describe("ada_cancel_reminder", () => {
  it("cancels one reminder by its id and says so when the id is unknown", async () => {
    store(ANNA);
    const saved = await executeAdaSetReminder(
      api,
      ANNA,
      { at: "2026-10-29T09:00", text: "Call Rossi" },
      NOW,
    );
    const id = saved.ok ? saved.id : "";
    expect(await executeAdaCancelReminder(api, ANNA, { id })).toEqual({ ok: true, id });
    expect(await executeAdaCancelReminder(api, ANNA, { id })).toMatchObject({
      ok: false,
      error: expect.stringContaining("ada_list_reminders"),
    });
    expect(await executeAdaListReminders(api, ANNA)).toMatchObject({ reminders: [] });
  });

  it("lists a reminder that came due while the window was closed as waiting for the next message", async () => {
    const memory = store(ANNA);
    await memory.putProactive({
      kind: "reminder",
      id: "r-due",
      dueAtMs: NOW.getTime() - 1000,
      status: "ready",
      data: JSON.stringify({ text: "Held one", createdAtMs: 1 }),
      updatedAtMs: 1,
    });
    expect(await executeAdaListReminders(api, ANNA)).toMatchObject({
      reminders: [{ id: "r-due", status: "due, sent when they next write" }],
    });
  });
});
