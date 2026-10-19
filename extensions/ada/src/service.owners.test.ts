import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WakeState } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { listCollectOwners, registerAdaService } from "./service.js";

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

const accounts = vi.hoisted(() => ({
  connected: new Map<string, { email: string }>(),
}));
const memories = vi.hoisted(() => ({
  byOwner: new Map<string, unknown>(),
  opened: [] as string[],
}));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async (_api: unknown, owner: string) => ({
    readAccount: async () => accounts.connected.get(owner) ?? null,
  }),
  openAdaGoogleAccountDbFromApi: async () => ({
    listOwners: async () => [...accounts.connected.keys()],
  }),
}));
vi.mock("./memory.js", () => {
  const open = async (_api: unknown, owner: string) => {
    memories.opened.push(owner);
    return memories.byOwner.get(owner);
  };
  return { openAdaMemoryFromApi: open, openAdaMemoryIfExistsFromApi: open };
});

const LAWYER = "390000000000";
const ANNA = "393331111111";
const BRUNO = "393332222222";
const NOW = new Date("2026-10-06T05:40:00.000Z");
const HOUR_MS = 3_600_000;

function memoryFor() {
  const state: WakeState = {
    lastLawyerInboundAtMs: NOW.getTime() - HOUR_MS,
    lastReconcileAtMs: null,
    lastCollectAtMs: null,
    lastDigestAtMs: null,
    lastMorningBriefAtMs: null,
    heldPlanJson: null,
    heldPlanAtMs: null,
    heldPlanAttempts: 0,
    heldPlanNextAttemptAtMs: null,
    heldPlanTemplateAttemptedAtMs: null,
    watchExpirationMs: null,
    openTodoIdsJson: null,
  };
  let wake = state;
  return {
    readGmailSnapshot: async () => [],
    replaceGmailSnapshot: async () => {},
    readCalendarSnapshot: async () => [],
    replaceCalendarSnapshot: async () => {},
    listMatterAliases: async () => [{ matterId: "m", alias: "Matter", title: "Matter" }],
    listTodos: async () => [],
    readProfile: async () => null,
    readWake: async () => ({ ...wake }),
    writeWake: async (patch: Partial<WakeState>) => {
      wake = { ...wake, ...patch };
    },
    wake: () => wake,
  } as unknown as MemoryStore & { wake: () => WakeState };
}

type Job = { id: string; run: () => unknown };

async function startService() {
  const jobs: Job[] = [];
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const dispatched: Array<{ owner: string; connectOnly?: boolean; summaries: string[] }> = [];
  const api = createTestPluginApi({
    id: "ada",
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
    now: () => NOW,
    dispatchDigestTurn: async (request) => {
      dispatched.push({
        owner: request.owner,
        connectOnly: request.connectOnly,
        summaries: request.plan.deliver ? request.plan.items.map((item) => item.summary) : [],
      });
      return { ok: true };
    },
  });
  await service?.start({ scheduler: { schedule: (job: Job) => void jobs.push(job) } } as never);
  return { api, jobs, dispatched };
}

const hearing = (summary: string) => ({
  id: `e-${summary}`,
  summary,
  start: "2026-10-06T14:00:00.000Z",
  end: "2026-10-06T15:00:00.000Z",
  status: "confirmed",
});

beforeEach(() => {
  vi.clearAllMocks();
  accounts.connected.clear();
  memories.byOwner.clear();
  memories.opened.length = 0;
  google.watchGmailInbox.mockResolvedValue({ ok: false });
  google.listInboxMessages.mockResolvedValue({ ok: true, messages: [] });
  google.loadAccessToken.mockImplementation(
    async ({ account }: { account: { email: string } }) => ({
      ok: true,
      accessToken: `token-${account.email}`,
    }),
  );
  google.listUpcomingEvents.mockImplementation(
    async ({ accessToken }: { accessToken: string }) => ({
      ok: true,
      events: accessToken === "token-anna@example.com" ? [hearing("Matter hearing for Anna")] : [],
    }),
  );
});

describe("the background service visits every connected number", () => {
  it("lists each number with a Google connection, plus the lawyer who is asked to connect", async () => {
    accounts.connected.set(BRUNO, { email: "bruno@example.com" });
    accounts.connected.set(ANNA, { email: "anna@example.com" });
    const { api } = await startService();
    expect(await listCollectOwners(api)).toEqual([LAWYER, ANNA, BRUNO].toSorted());
  });

  it("collects each number with its own account and memory, and sends each digest to its own number", async () => {
    accounts.connected.set(ANNA, { email: "anna@example.com" });
    accounts.connected.set(BRUNO, { email: "bruno@example.com" });
    for (const owner of [LAWYER, ANNA, BRUNO]) {
      memories.byOwner.set(owner, memoryFor());
    }
    const { jobs, dispatched } = await startService();
    await jobs.find((job) => job.id === "ada-poll")?.run();
    // Only Anna's calendar has anything urgent; the digest is hers, and is for her number alone.
    const reads = google.loadAccessToken.mock.calls.map(
      (args) => (args[0] as { account: { email: string } }).account.email,
    );
    expect(reads.toSorted()).toEqual(["anna@example.com", "bruno@example.com"]);
    expect(dispatched).toEqual([
      {
        owner: ANNA,
        connectOnly: undefined,
        summaries: [expect.stringContaining("Matter hearing for Anna")],
      },
    ]);
    expect(new Set(memories.opened)).toEqual(new Set([LAWYER, ANNA, BRUNO]));
    const anna = memories.byOwner.get(ANNA) as MemoryStore & { wake: () => WakeState };
    const bruno = memories.byOwner.get(BRUNO) as MemoryStore & { wake: () => WakeState };
    expect(anna.wake().lastCollectAtMs).toBe(NOW.getTime());
    expect(bruno.wake().lastCollectAtMs).toBe(NOW.getTime());
  });

  it("asks only the lawyer to connect Google on the morning run, never another number", async () => {
    accounts.connected.set(BRUNO, { email: "bruno@example.com" });
    for (const owner of [LAWYER, BRUNO]) {
      memories.byOwner.set(owner, memoryFor());
    }
    google.loadAccessToken.mockImplementation(
      async ({ account }: { account: { email: string } }) => ({
        ok: true,
        accessToken: `token-${account.email}`,
      }),
    );
    const { jobs, dispatched } = await startService();
    await jobs.find((job) => job.id === "ada-morning")?.run();
    expect(dispatched.filter((entry) => entry.connectOnly)).toEqual([
      { owner: LAWYER, connectOnly: true, summaries: [] },
    ]);
  });
});
