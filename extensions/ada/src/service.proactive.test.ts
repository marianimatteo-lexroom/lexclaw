import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const granola = vi.hoisted(() => ({
  runGranolaKeepAlive: vi.fn(async () => {}),
  releaseHeldGranolaReminder: vi.fn(async () => {}),
}));
vi.mock("./granola-reminder.js", () => granola);

const stores = vi.hoisted(() => ({
  byOwner: new Map<string, unknown>(),
  withMemory: [] as string[],
}));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async () => ({ readAccount: async () => null }),
  openAdaGoogleAccountDbFromApi: async () => ({ listOwners: async () => [] }),
}));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryFromApi: async (_api: unknown, owner: string) => stores.byOwner.get(owner),
  openAdaMemoryIfExistsFromApi: async (_api: unknown, owner: string) =>
    stores.byOwner.get(owner) ?? null,
  listAdaMemoryOwners: () => stores.withMemory,
}));
vi.mock("./transcript-mirror.js", () => ({ mirrorSentText: async () => true }));

import type { MemoryStore } from "./memory.js";
import { realStore } from "./preference-test-support.js";
import { listReminders, saveReminder } from "./proactive-store.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { recordSenderInbound, registerAdaService } from "./service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const LAWYER = "390000000000";
const ANNA = "393331111111";
const HOUR = 60 * 60 * 1000;
/** 11:00 in Rome. */
const NOW = new Date("2026-10-27T10:00:00.000Z");

type Job = { id: string; run: () => unknown };

const texts: Array<{ to: string; text: string }> = [];
const sendText = vi.fn(async (params: { to: string; text: string }) => {
  texts.push({ to: params.to, text: params.text });
});

function makeApi(registerService?: OpenClawPluginApi["registerService"]) {
  return createTestPluginApi({
    id: "ada",
    config: {
      channels: { "kapso-whatsapp": { defaultTo: `+${LAWYER}` } },
    } as OpenClawPluginApi["config"],
    pluginConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
    } as unknown as OpenClawPluginApi["runtime"],
    ...(registerService ? { registerService } : {}),
  });
}

async function openNumber(
  owner: string,
  wake: { lastLawyerInboundAtMs: number },
): Promise<MemoryStore> {
  const memory = realStore(tempDirs.make("ada-service-proactive-"), owner);
  await memory.writeWake(wake);
  stores.byOwner.set(owner, memory);
  stores.withMemory.push(owner);
  return memory;
}

async function dueReminder(memory: MemoryStore, text: string) {
  await saveReminder(
    memory,
    { id: "r1", text, dueAtMs: NOW.getTime() - 5 * 60_000, createdAtMs: 1, state: "pending" },
    1,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  texts.length = 0;
  stores.byOwner.clear();
  stores.withMemory.length = 0;
  clearInboundLanguages();
  recordInboundLanguage(ANNA, "please remind me");
});

describe("the 15-minute poll reaches reminders", () => {
  it("fires a due reminder for a number that connected no account, from the poll, and asks it to connect nothing", async () => {
    const memory = await openNumber(ANNA, { lastLawyerInboundAtMs: NOW.getTime() - HOUR });
    await dueReminder(memory, "Call Rossi");
    const jobs: Job[] = [];
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const dispatchDigestTurn = vi.fn(async () => ({ ok: true }));
    registerAdaService({
      api: makeApi((registered) => {
        service = registered;
      }),
      now: () => NOW,
      dispatchDigestTurn,
    });
    await service?.start({ scheduler: { schedule: (job: Job) => void jobs.push(job) } } as never);

    await jobs.find((job) => job.id === "ada-poll")?.run();

    expect(texts).toEqual([{ to: `+${ANNA}`, text: "Reminder: Call Rossi" }]);
    expect(await listReminders(memory)).toEqual([]);
    expect(dispatchDigestTurn).not.toHaveBeenCalled();
    void service?.stop?.({} as never);
  });

  it("leaves a number whose reminder is not due alone, and sends nothing to a closed window", async () => {
    const closed = await openNumber(ANNA, { lastLawyerInboundAtMs: NOW.getTime() - 30 * HOUR });
    await dueReminder(closed, "Held");
    const jobs: Job[] = [];
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    registerAdaService({
      api: makeApi((registered) => {
        service = registered;
      }),
      now: () => NOW,
    });
    await service?.start({ scheduler: { schedule: (job: Job) => void jobs.push(job) } } as never);
    await jobs.find((job) => job.id === "ada-poll")?.run();
    expect(texts).toEqual([]);
    expect(await listReminders(closed)).toMatchObject([{ id: "r1", state: "ready" }]);
    void service?.stop?.({} as never);
  });
});

describe("the message that opens the window releases what was held", () => {
  it("sends a held reminder to the number that wrote, and only to it", async () => {
    const anna = await openNumber(ANNA, { lastLawyerInboundAtMs: NOW.getTime() - 30 * HOUR });
    await dueReminder(anna, "Call Rossi");
    const bruno = await openNumber("393332222222", {
      lastLawyerInboundAtMs: NOW.getTime() - 30 * HOUR,
    });
    await dueReminder(bruno, "Bruno's own");
    const api = makeApi();

    await recordSenderInbound({
      api,
      atMs: NOW.getTime(),
      channelId: "kapso-whatsapp",
      senders: [`+${ANNA}`],
    });
    await vi.waitFor(() => expect(texts).toHaveLength(1));

    expect(texts[0]).toEqual({ to: `+${ANNA}`, text: "Reminder: Call Rossi" });
    expect(await listReminders(anna)).toEqual([]);
    expect(await listReminders(bruno)).toHaveLength(1);
  });
});
