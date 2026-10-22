import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LawyerProfile, WakeState } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { registerAdaService } from "./service.js";

const google = vi.hoisted(() => ({
  loadAccessToken: vi.fn(),
  listInboxMessages: vi.fn(),
  listUpcomingEvents: vi.fn(),
  watchGmailInbox: vi.fn(),
}));
vi.mock("./google-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-api.js")>()),
  ...google,
}));

const accounts = vi.hoisted(() => ({ connected: new Map<string, { email: string }>() }));
const memories = vi.hoisted(() => ({ byOwner: new Map<string, unknown>() }));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async (_api: unknown, owner: string) => ({
    readAccount: async () => accounts.connected.get(owner) ?? null,
  }),
  openAdaGoogleAccountDbFromApi: async () => ({
    listOwners: async () => [...accounts.connected.keys()],
  }),
}));
vi.mock("./memory.js", () => {
  const open = async (_api: unknown, owner: string) => memories.byOwner.get(owner) ?? null;
  return {
    openAdaMemoryFromApi: open,
    openAdaMemoryIfExistsFromApi: open,
    listAdaMemoryOwners: () => [],
  };
});

const LAWYER = "390000000000";
const ROME_NUMBER = "393331111111";
const SHANGHAI_NUMBER = "8613800000000";
const HOUR_MS = 3_600_000;

type MemoryFake = MemoryStore & {
  wake: () => WakeState;
  setZone: (zone: string | null) => void;
};

function memoryFor(options: {
  zone?: string | null;
  lastCollectAtMs?: number | null;
  nowMs: number;
}) {
  let zone = options.zone ?? null;
  let wake: WakeState = {
    lastLawyerInboundAtMs: options.nowMs - HOUR_MS,
    lastReconcileAtMs: null,
    lastCollectAtMs: options.lastCollectAtMs ?? null,
    lastDigestAtMs: null,
    lastMorningBriefAtMs: null,
    lastConnectNudgeAtMs: null,
    heldPlanJson: null,
    heldPlanAtMs: null,
    heldPlanAttempts: 0,
    heldPlanNextAttemptAtMs: null,
    heldPlanTemplateAttemptedAtMs: null,
    heldBriefDay: null,
    watchExpirationMs: null,
    openTodoIdsJson: null,
  };
  return {
    readGmailSnapshot: async () => [],
    replaceGmailSnapshot: async () => {},
    readCalendarSnapshot: async () => [],
    replaceCalendarSnapshot: async () => {},
    listMatterAliases: async () => [],
    listTodos: async () => [],
    readProfile: async () => (zone ? ({ timezone: zone } as LawyerProfile) : null),
    listPreferences: async () => [],
    readWake: async () => ({ ...wake }),
    writeWake: async (patch: Partial<WakeState>) => {
      wake = { ...wake, ...patch };
    },
    wake: () => wake,
    setZone: (next: string | null) => {
      zone = next;
    },
  } as unknown as MemoryFake;
}

type Job = { id: string; atMs?: number; delayMs?: number; run: () => unknown };

async function startService(options: { now: Date; withoutScheduler?: boolean }) {
  const clock = { value: options.now };
  const pending = new Map<string, Job>();
  const scheduled: Job[] = [];
  const dispatched: Array<{ owner: string; connectOnly?: boolean; idempotencyKey: string }> = [];
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = createTestPluginApi({
    id: "ada",
    logger,
    config: {
      channels: { "kapso-whatsapp": { defaultTo: `+${LAWYER}` } },
    } as OpenClawPluginApi["config"],
    pluginConfig: {
      googleClientId: "client-id",
      googleClientSecret: "client-secret",
      googleRedirectUri: "https://gateway.example/ada/google/callback",
      googleStateSecret: "state-secret-0123456789",
    },
    registerService: (registered) => {
      service = registered;
    },
  });
  registerAdaService({
    api,
    now: () => clock.value,
    dispatchDigestTurn: async (request) => {
      dispatched.push({
        owner: request.owner,
        connectOnly: request.connectOnly,
        idempotencyKey: request.idempotencyKey,
      });
      return { ok: true };
    },
  });
  await service?.start({
    scheduler: options.withoutScheduler
      ? undefined
      : {
          schedule: (job: Job) => {
            scheduled.push(job);
            pending.set(job.id, job);
          },
        },
  } as never);
  return {
    api,
    logger,
    clock,
    scheduled,
    dispatched,
    pendingMorning: () => pending.get("ada-morning"),
    pendingIso: (id: string) => {
      const atMs = pending.get(id)?.atMs;
      return atMs === undefined ? undefined : new Date(atMs).toISOString();
    },
    /** Runs the pending job the way the host does: it is consumed, then it may schedule again. */
    async fire(id: string, at?: Date) {
      const job = pending.get(id);
      if (!job) {
        throw new Error(`no pending ${id}`);
      }
      pending.delete(id);
      clock.value = at ?? new Date(job.atMs ?? clock.value.getTime());
      await job.run();
    },
  };
}

/** The numbers whose Google account a pass read since the last call. */
function visited(): string[] {
  const emails = google.loadAccessToken.mock.calls.map(
    (args) => (args[0] as { account: { email: string } }).account.email,
  );
  google.loadAccessToken.mockClear();
  return emails.toSorted();
}

function connect(
  owner: string,
  zone: string | null,
  nowMs: number,
  lastCollectAtMs?: number | null,
) {
  accounts.connected.set(owner, { email: `${owner}@example.com` });
  const memory = memoryFor({ zone, nowMs, lastCollectAtMs });
  memories.byOwner.set(owner, memory);
  return memory;
}

beforeEach(() => {
  vi.clearAllMocks();
  accounts.connected.clear();
  memories.byOwner.clear();
  google.watchGmailInbox.mockResolvedValue({ ok: false });
  google.listInboxMessages.mockResolvedValue({ ok: true, messages: [] });
  google.listUpcomingEvents.mockResolvedValue({ ok: true, events: [] });
  google.loadAccessToken.mockImplementation(
    async ({ account }: { account: { email: string } }) => ({
      ok: true,
      accessToken: `token-${account.email}`,
    }),
  );
});

describe("each number gets its morning pass at 07:40 on its own clock", () => {
  const emailOf = (owner: string) => `${owner}@example.com`;

  it("wakes at the earliest slot, runs only the numbers that are due, then moves to the next", async () => {
    const start = new Date("2026-10-06T03:00:00.000Z");
    connect(ROME_NUMBER, "Europe/Rome", start.getTime());
    connect(SHANGHAI_NUMBER, "Asia/Shanghai", start.getTime());
    const service = await startService({ now: start });

    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T05:40:00.000Z");
    await service.fire("ada-morning");
    expect(visited()).toEqual([emailOf(ROME_NUMBER)]);

    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T23:40:00.000Z");
    await service.fire("ada-morning");
    expect(visited()).toEqual([emailOf(SHANGHAI_NUMBER)]);

    expect(service.pendingIso("ada-morning")).toBe("2026-10-07T05:40:00.000Z");
  });

  it("falls back to Europe/Rome for a number with no profile or an unusable zone", async () => {
    const start = new Date("2026-10-06T03:00:00.000Z");
    connect(ROME_NUMBER, null, start.getTime());
    connect(SHANGHAI_NUMBER, "Mars/Olympus", start.getTime());
    const service = await startService({ now: start });

    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T05:40:00.000Z");
    await service.fire("ada-morning");
    expect(visited()).toEqual([emailOf(ROME_NUMBER), emailOf(SHANGHAI_NUMBER)].toSorted());
  });

  it("keeps 07:40 local through the night Rome leaves summer time, in both zones", async () => {
    const start = new Date("2026-10-24T12:00:00.000Z");
    connect(ROME_NUMBER, "Europe/Rome", start.getTime());
    connect(SHANGHAI_NUMBER, "Asia/Shanghai", start.getTime());
    const service = await startService({ now: start });

    const fired: Array<[string, string[]]> = [];
    for (let run = 0; run < 4; run += 1) {
      const at = service.pendingIso("ada-morning") ?? "";
      await service.fire("ada-morning");
      fired.push([at, visited()]);
    }
    expect(fired).toEqual([
      ["2026-10-24T23:40:00.000Z", [emailOf(SHANGHAI_NUMBER)]],
      ["2026-10-25T06:40:00.000Z", [emailOf(ROME_NUMBER)]],
      ["2026-10-25T23:40:00.000Z", [emailOf(SHANGHAI_NUMBER)]],
      ["2026-10-26T06:40:00.000Z", [emailOf(ROME_NUMBER)]],
    ]);
  });

  it("runs a slot once when the timer wakes slightly early", async () => {
    const start = new Date("2026-10-06T03:00:00.000Z");
    connect(ROME_NUMBER, "Europe/Rome", start.getTime());
    const service = await startService({ now: start });
    await service.fire("ada-morning", new Date("2026-10-06T05:39:59.500Z"));
    expect(visited()).toEqual([emailOf(ROME_NUMBER)]);
    expect(service.pendingIso("ada-morning")).toBe("2026-10-07T05:40:00.000Z");
  });

  it("re-arms on the next poll when a number is added, a zone changes, and a number is removed", async () => {
    const start = new Date("2026-10-06T03:00:00.000Z");
    // The lawyer is always visited, so it sits on the Shanghai clock to stay out of the way.
    connect(LAWYER, "Asia/Shanghai", start.getTime());
    const rome = connect(ROME_NUMBER, "Europe/Rome", start.getTime());
    const service = await startService({ now: start });
    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T05:40:00.000Z");
    const poll = async () => {
      const job = service.scheduled.findLast((entry) => entry.id === "ada-poll");
      await job?.run();
    };

    // Added: Shanghai's 07:40 (23:40Z) is later, so the timer stays on Rome's.
    connect(SHANGHAI_NUMBER, "Asia/Shanghai", start.getTime());
    await poll();
    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T05:40:00.000Z");

    // Zone changed: Rome's number says it is in Shanghai, so nothing is due before 23:40Z.
    rome.setZone("Asia/Shanghai");
    await poll();
    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T23:40:00.000Z");

    // Removed: the remaining Shanghai-clock number keeps the slot; a Tokyo number is earlier.
    const tokyo = "8190000000000";
    connect(tokyo, "Asia/Tokyo", start.getTime());
    await poll();
    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T22:40:00.000Z");
    accounts.connected.delete(tokyo);
    await poll();
    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T23:40:00.000Z");
  });

  it("does not run a pass for a zone change made between the timer being set and its slot", async () => {
    const start = new Date("2026-10-06T03:00:00.000Z");
    const rome = connect(ROME_NUMBER, "Europe/Rome", start.getTime());
    const service = await startService({ now: start });
    rome.setZone("Asia/Shanghai");
    await service.fire("ada-morning");
    expect(visited()).toEqual([]);
    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T23:40:00.000Z");
  });
});

describe("the connect ask follows the number's own slot", () => {
  it("is sent at the not-connected number's slot, keyed by its own local day", async () => {
    // 07:40 in Auckland (UTC+13 in October) is 18:40Z the day before; Rome is still on 6 October.
    const start = new Date("2026-10-06T12:00:00.000Z");
    memories.byOwner.set(LAWYER, memoryFor({ zone: "Pacific/Auckland", nowMs: start.getTime() }));
    const service = await startService({ now: start });
    expect(service.pendingIso("ada-morning")).toBe("2026-10-06T18:40:00.000Z");

    await service.fire("ada-morning");
    expect(service.dispatched).toEqual([
      { owner: LAWYER, connectOnly: true, idempotencyKey: `connect:${LAWYER}:2026-10-07` },
    ]);
  });
});

describe("catch-up after a restart is per number and per zone", () => {
  it("catches up only the numbers with no collect since the latest slot of their own zone", async () => {
    // 03:00Z: Rome's latest slot was 2026-10-05T05:40Z, Shanghai's 2026-10-05T23:40Z.
    const start = new Date("2026-10-06T03:00:00.000Z");
    const lastCollect = Date.parse("2026-10-05T12:00:00.000Z");
    connect(ROME_NUMBER, "Europe/Rome", start.getTime(), lastCollect);
    connect(SHANGHAI_NUMBER, "Asia/Shanghai", start.getTime(), lastCollect);
    const service = await startService({ now: start });

    expect(service.pendingIso("ada-catch-up")).toBe("2026-10-06T03:00:30.000Z");
    await service.fire("ada-catch-up");
    expect(visited()).toEqual([`${SHANGHAI_NUMBER}@example.com`]);
  });

  it("catches up nobody on a first boot or when every number collected since its slot", async () => {
    const start = new Date("2026-10-06T03:00:00.000Z");
    connect(ROME_NUMBER, "Europe/Rome", start.getTime(), null);
    connect(SHANGHAI_NUMBER, "Asia/Shanghai", start.getTime(), Date.parse("2026-10-05T23:41:00Z"));
    const service = await startService({ now: start });
    expect(service.pendingIso("ada-catch-up")).toBeUndefined();
  });

  it("does not send the connect ask from a catch-up", async () => {
    const start = new Date("2026-10-06T03:00:00.000Z");
    memories.byOwner.set(
      LAWYER,
      memoryFor({
        zone: "Asia/Shanghai",
        nowMs: start.getTime(),
        lastCollectAtMs: Date.parse("2026-10-05T12:00:00.000Z"),
      }),
    );
    const service = await startService({ now: start });
    await service.fire("ada-catch-up");
    expect(service.dispatched).toEqual([]);
  });
});

describe("a host without the service scheduler", () => {
  it("says so once at info level and arms the morning timer with setTimeout", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-10-06T03:00:00.000Z");
      connect(ROME_NUMBER, "Europe/Rome", start.getTime());
      const service = await startService({ now: start, withoutScheduler: true });
      const { logger } = service;
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("scheduler missing"));
      expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("scheduler missing"));
      const notes = logger.info.mock.calls.filter(([line]) =>
        String(line).includes("scheduler missing"),
      );
      expect(notes.map(([line]) => String(line)).join("\n")).toContain("setInterval");
      expect(notes.map(([line]) => String(line)).join("\n")).toContain("setTimeout");
      expect(notes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
