import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectResult } from "./collector.js";
import type { DigestPlan } from "./digest.js";
import type { InboxMessage } from "./google-api.js";
import type { CalendarSnapshotRow, GmailSnapshotRow, WakeState } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import {
  HELD_PLAN_MAX_ATTEMPTS,
  decideDigestDelivery,
  heldPlanBackoffMs,
  recordLawyerInbound,
  registerVeraService,
  runVeraCollectPass,
} from "./service.js";

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

const memoryModule = vi.hoisted(() => ({ openVeraMemoryFromApi: vi.fn() }));

vi.mock("./memory.js", () => memoryModule);

vi.mock("./google-account.js", () => ({
  openVeraGoogleAccountFromApi: async () => ({
    readAccount: async () => ({ email: "lawyer@example.com" }),
  }),
}));

const plan: DigestPlan = {
  deliver: true,
  items: [
    {
      matterId: "verdi",
      matterLabel: "Verdi",
      kind: "deadline",
      summary: "Hearing today",
      cost: 100,
      dueAt: "2026-10-06T14:00:00.000Z",
    },
  ],
  nextSteps: [
    {
      action: "research",
      matterId: "verdi",
      matterLabel: "Verdi",
      instruction: "Research",
    },
    {
      action: "draft_if_confirmed",
      matterId: "verdi",
      matterLabel: "Verdi",
      instruction: "Draft",
    },
  ],
};

const deliverable: CollectResult = {
  plan,
  signals: [],
  gmailSnapshot: [],
  calendarSnapshot: [],
  urgent: true,
};

describe("decideDigestDelivery", () => {
  it("stays silent when the collector did not clear the bar", () => {
    expect(
      decideDigestDelivery({
        result: {
          ...deliverable,
          plan: { deliver: false, reason: "nothing_cleared_the_bar" },
          urgent: false,
        },
        forceMorning: true,
        timeZone: "Europe/Rome",
        now: new Date("2026-10-06T05:40:00.000Z"),
        lastLawyerInboundAtMs: Date.now(),
      }),
    ).toEqual({ action: "silent" });
  });

  it("batches non-urgent hits until morning", () => {
    expect(
      decideDigestDelivery({
        result: { ...deliverable, urgent: false },
        forceMorning: false,
        timeZone: "Europe/Rome",
        now: new Date("2026-10-06T12:00:00.000Z"),
        lastLawyerInboundAtMs: Date.now(),
      }),
    ).toEqual({ action: "batch" });
  });

  it("holds a deliverable plan when the WhatsApp window is closed", () => {
    const now = new Date("2026-10-06T05:40:00.000Z");
    expect(
      decideDigestDelivery({
        result: deliverable,
        forceMorning: true,
        timeZone: "Europe/Rome",
        now,
        lastLawyerInboundAtMs: now.getTime() - 30 * 60 * 60 * 1000,
      }),
    ).toEqual({ action: "hold", plan });
  });

  it("dispatches when urgent and the window is open", () => {
    const now = new Date("2026-10-06T05:40:00.000Z");
    expect(
      decideDigestDelivery({
        result: deliverable,
        forceMorning: false,
        timeZone: "Europe/Rome",
        now,
        lastLawyerInboundAtMs: now.getTime() - 60 * 60 * 1000,
      }),
    ).toEqual({ action: "dispatch", plan });
  });
});

const HOUR_MS = 60 * 60 * 1000;
const MORNING = new Date("2026-10-06T05:40:00.000Z");
const POLL_1 = new Date(MORNING.getTime() + 10 * 60 * 1000);

const HEARING = {
  id: "e-verdi",
  summary: "Verdi hearing",
  start: "2026-10-06T14:00:00.000Z",
  end: "2026-10-06T15:00:00.000Z",
  status: "confirmed",
};

const BIANCHI_MAIL: InboxMessage = {
  id: "m-bianchi",
  from: "opposing@example.com",
  subject: "Bianchi: please confirm the draft",
  date: "2026-10-06T03:00:00.000Z",
  snippet: "Can you confirm?",
};

function createMemory(wake: Partial<WakeState> = {}, timezone?: string) {
  let gmail: GmailSnapshotRow[] = [];
  let calendar: CalendarSnapshotRow[] = [];
  let state: WakeState = {
    lastLawyerInboundAtMs: MORNING.getTime() - HOUR_MS,
    lastReconcileAtMs: null,
    lastCollectAtMs: null,
    heldPlanJson: null,
    heldPlanAttempts: 0,
    heldPlanNextAttemptAtMs: null,
    heldPlanTemplateAttemptedAtMs: null,
    watchExpirationMs: null,
    openTodoIdsJson: null,
    ...wake,
  };
  const memory = {
    readGmailSnapshot: async () => gmail,
    replaceGmailSnapshot: async (rows: GmailSnapshotRow[]) => {
      gmail = rows;
    },
    readCalendarSnapshot: async () => calendar,
    replaceCalendarSnapshot: async (rows: CalendarSnapshotRow[]) => {
      calendar = rows;
    },
    listMatterAliases: async () => [
      { matterId: "verdi", alias: "Verdi", title: "Verdi" },
      { matterId: "bianchi", alias: "Bianchi", title: "Bianchi" },
    ],
    listTodos: async () => [],
    readProfile: async () => (timezone ? { timezone } : null),
    readWake: async () => ({ ...state }),
    writeWake: async (patch: Partial<WakeState>) => {
      state = { ...state, ...patch };
    },
  } as unknown as MemoryStore;
  return {
    memory,
    wake: () => state,
    gmail: () => gmail,
    calendar: () => calendar,
  };
}

function setGoogle(reads: { messages?: InboxMessage[]; events?: unknown[] }) {
  google.listInboxMessages.mockResolvedValue({ ok: true, messages: reads.messages ?? [] });
  google.listUpcomingEvents.mockResolvedValue({ ok: true, events: reads.events ?? [] });
}

const api: OpenClawPluginApi = createTestPluginApi({
  id: "vera",
  pluginConfig: {
    googleClientId: "client-id",
    googleClientSecret: "client-secret",
    googleRedirectUri: "https://gateway.example/vera/google/callback",
    googleStateSecret: "state-secret-0123456789",
  },
});

function pass(
  memory: MemoryStore,
  options: {
    now: Date;
    forceMorning?: boolean;
    dispatch: Parameters<typeof runVeraCollectPass>[0]["dispatchDigestTurn"];
    api?: OpenClawPluginApi;
    sendDigestReadyNotice?: Parameters<typeof runVeraCollectPass>[0]["sendDigestReadyNotice"];
  },
) {
  return runVeraCollectPass({
    api: options.api ?? api,
    memory,
    now: options.now,
    forceMorning: options.forceMorning ?? false,
    dispatchDigestTurn: options.dispatch,
    sendDigestReadyNotice: options.sendDigestReadyNotice,
  });
}

describe("runVeraCollectPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    google.loadAccessToken.mockResolvedValue({ ok: true, accessToken: "token" });
    google.watchGmailInbox.mockResolvedValue({ ok: false });
  });

  it("keeps the baseline and holds the plan when dispatch fails", async () => {
    setGoogle({ events: [HEARING] });
    const store = createMemory();
    const dispatch = vi.fn(async () => ({ ok: false, reason: "hooks_unavailable" }));

    const result = await pass(store.memory, { now: MORNING, forceMorning: true, dispatch });

    expect(result).toMatchObject({ delivered: false, held: true, reason: "hooks_unavailable" });
    expect(store.gmail()).toEqual([]);
    expect(store.calendar()).toEqual([]);
    expect(store.wake()).toMatchObject({
      heldPlanAttempts: 1,
      heldPlanNextAttemptAtMs: MORNING.getTime() + heldPlanBackoffMs(1),
      lastCollectAtMs: null,
    });
    expect(JSON.parse(store.wake().heldPlanJson ?? "null")).toMatchObject({
      deliver: true,
      items: [{ matterId: "verdi" }],
    });
  });

  it("treats a rejected or timed-out dispatch like any other failure", async () => {
    setGoogle({ events: [HEARING] });
    const store = createMemory();
    const dispatch = vi.fn(async () => {
      throw new Error("dispatch timed out");
    });

    const result = await pass(store.memory, { now: MORNING, forceMorning: true, dispatch });

    expect(result).toMatchObject({ held: true, reason: "dispatch timed out" });
    expect(store.wake().heldPlanAttempts).toBe(1);
    expect(store.calendar()).toEqual([]);
  });

  it("re-emits the dropped signal on the next poll and commits after success", async () => {
    setGoogle({ events: [HEARING] });
    const store = createMemory();
    await pass(store.memory, {
      now: MORNING,
      forceMorning: true,
      dispatch: async () => ({ ok: false, reason: "hooks_unavailable" }),
    });

    const retryAt = new Date(store.wake().heldPlanNextAttemptAtMs ?? 0);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const result = await pass(store.memory, { now: retryAt, dispatch });

    expect(result).toMatchObject({ delivered: true, held: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].plan).toMatchObject({ items: [{ matterId: "verdi" }] });
    expect(store.calendar()).toHaveLength(1);
    expect(store.wake()).toMatchObject({
      heldPlanJson: null,
      heldPlanAttempts: 0,
      heldPlanNextAttemptAtMs: null,
      lastCollectAtMs: retryAt.getTime(),
    });
  });

  it("replays the held plan even when the fresh diff no longer shows the signal", async () => {
    setGoogle({ events: [HEARING] });
    const store = createMemory();
    await pass(store.memory, {
      now: MORNING,
      forceMorning: true,
      dispatch: async () => ({ ok: false, reason: "hooks_unavailable" }),
    });

    setGoogle({ events: [] });
    const dispatch = vi.fn(async () => ({ ok: true }));
    const result = await pass(store.memory, {
      now: new Date(store.wake().heldPlanNextAttemptAtMs ?? 0),
      dispatch,
    });

    expect(result.delivered).toBe(true);
    expect(dispatch.mock.calls[0]?.[0].plan).toMatchObject({ items: [{ matterId: "verdi" }] });
    expect(store.wake().heldPlanJson).toBeNull();
  });

  it("does not dispatch or read Google again inside the backoff window", async () => {
    setGoogle({ events: [HEARING] });
    const store = createMemory();
    await pass(store.memory, {
      now: MORNING,
      forceMorning: true,
      dispatch: async () => ({ ok: false, reason: "hooks_unavailable" }),
    });
    google.listInboxMessages.mockClear();

    const dispatch = vi.fn(async () => ({ ok: true }));
    const result = await pass(store.memory, { now: POLL_1, dispatch });

    expect(result).toMatchObject({ collected: false, held: true, reason: "retry_backoff" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(google.listInboxMessages).not.toHaveBeenCalled();
    expect(store.wake().heldPlanAttempts).toBe(1);
  });

  it("stops after the retry cap and re-arms on the next morning slot", async () => {
    setGoogle({ events: [HEARING] });
    const store = createMemory();
    const failing = vi.fn(async () => ({ ok: false, reason: "hooks_unavailable" }));
    let now = MORNING;
    await pass(store.memory, { now, forceMorning: true, dispatch: failing });
    for (let attempt = 2; attempt <= HELD_PLAN_MAX_ATTEMPTS; attempt += 1) {
      now = new Date(store.wake().heldPlanNextAttemptAtMs ?? 0);
      await pass(store.memory, { now, dispatch: failing });
    }
    expect(failing).toHaveBeenCalledTimes(HELD_PLAN_MAX_ATTEMPTS);
    expect(store.wake()).toMatchObject({
      heldPlanAttempts: HELD_PLAN_MAX_ATTEMPTS,
      heldPlanNextAttemptAtMs: null,
    });

    const later = new Date(now.getTime() + 6 * HOUR_MS);
    const exhausted = await pass(store.memory, { now: later, dispatch: failing });
    expect(exhausted).toMatchObject({ collected: false, reason: "retries_exhausted" });
    expect(failing).toHaveBeenCalledTimes(HELD_PLAN_MAX_ATTEMPTS);

    const dispatch = vi.fn(async () => ({ ok: true }));
    const nextMorning = new Date(MORNING.getTime() + 24 * HOUR_MS);
    await store.memory.writeWake({ lastLawyerInboundAtMs: nextMorning.getTime() - HOUR_MS });
    setGoogle({
      events: [{ ...HEARING, start: "2026-10-07T14:00:00.000Z", end: "2026-10-07T15:00:00.000Z" }],
    });
    const rearmed = await pass(store.memory, {
      now: nextMorning,
      forceMorning: true,
      dispatch,
    });
    expect(rearmed.delivered).toBe(true);
    expect(store.wake().heldPlanJson).toBeNull();
  });

  it("commits the baseline when the plan is held for a closed WhatsApp window", async () => {
    setGoogle({ messages: [BIANCHI_MAIL], events: [HEARING] });
    const store = createMemory({ lastLawyerInboundAtMs: MORNING.getTime() - 30 * HOUR_MS });
    const dispatch = vi.fn(async () => ({ ok: true }));

    const result = await pass(store.memory, { now: MORNING, forceMorning: true, dispatch });

    expect(result).toMatchObject({ held: true, reason: "whatsapp_window_closed" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.gmail()).toHaveLength(1);
    expect(store.calendar()).toHaveLength(1);
    expect(store.wake()).toMatchObject({ heldPlanAttempts: 0, heldPlanNextAttemptAtMs: null });
  });

  it("keeps a held plan through quiet polls and releases it with the signals it carried", async () => {
    setGoogle({ messages: [BIANCHI_MAIL], events: [HEARING] });
    const store = createMemory({ lastLawyerInboundAtMs: MORNING.getTime() - 30 * HOUR_MS });
    const dispatch = vi.fn(async () => ({ ok: true }));
    await pass(store.memory, { now: MORNING, forceMorning: true, dispatch });

    const quiet = await pass(store.memory, { now: POLL_1, dispatch });
    expect(quiet).toMatchObject({ held: true, reason: "whatsapp_window_closed" });
    expect(store.wake().heldPlanJson).not.toBeNull();

    const replyAt = new Date(POLL_1.getTime() + HOUR_MS);
    await store.memory.writeWake({ lastLawyerInboundAtMs: replyAt.getTime() });
    const released = await pass(store.memory, { now: replyAt, forceMorning: true, dispatch });

    expect(released.delivered).toBe(true);
    const sent = dispatch.mock.calls[0]?.[0].plan;
    expect(sent?.deliver && sent.items.map((item) => item.matterId).toSorted()).toEqual([
      "bianchi",
      "verdi",
    ]);
    expect(store.wake().heldPlanJson).toBeNull();
  });

  it("leaves a batched signal in the baseline so the morning pass still sends it", async () => {
    const noon = new Date("2026-10-06T12:00:00.000Z");
    setGoogle({ messages: [BIANCHI_MAIL] });
    const store = createMemory({ lastLawyerInboundAtMs: noon.getTime() - HOUR_MS });
    const dispatch = vi.fn(async () => ({ ok: true }));

    const batched = await pass(store.memory, { now: noon, dispatch });
    expect(batched).toMatchObject({
      delivered: false,
      held: false,
      reason: "batched_until_morning",
    });
    expect(store.gmail()).toEqual([]);

    const nextMorning = new Date("2026-10-07T05:40:00.000Z");
    await store.memory.writeWake({ lastLawyerInboundAtMs: nextMorning.getTime() - HOUR_MS });
    const morning = await pass(store.memory, { now: nextMorning, forceMorning: true, dispatch });
    expect(morning.delivered).toBe(true);
    expect(dispatch.mock.calls[0]?.[0].plan).toMatchObject({ items: [{ matterId: "bianchi" }] });
  });
});

describe("heldPlanBackoffMs", () => {
  it("doubles from fifteen minutes up to two hours", () => {
    expect([1, 2, 3, 4, 5].map(heldPlanBackoffMs)).toEqual([
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
      120 * 60_000,
      120 * 60_000,
    ]);
  });
});

describe("collect pass concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    google.loadAccessToken.mockResolvedValue({ ok: true, accessToken: "token" });
    google.watchGmailInbox.mockResolvedValue({ ok: false });
    google.listUpcomingEvents.mockResolvedValue({ ok: true, events: [] });
  });

  function gatedInbox() {
    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    google.listInboxMessages.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      active -= 1;
      return { ok: true, messages: [] };
    });
    return { gates, maxActive: () => maxActive };
  }

  it("never overlaps passes and collapses a burst of polls into one trailing pass", async () => {
    const { gates, maxActive } = gatedInbox();
    const store = createMemory();
    const dispatch = vi.fn(async () => ({ ok: true }));

    const first = pass(store.memory, { now: MORNING, dispatch });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const second = pass(store.memory, { now: MORNING, dispatch });
    const third = pass(store.memory, { now: MORNING, dispatch });
    expect(third).toBe(second);

    gates[0]?.();
    await first;
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]?.();
    await Promise.all([second, third]);

    expect(google.listInboxMessages).toHaveBeenCalledTimes(2);
    expect(maxActive()).toBe(1);
  });

  it("queues a forced pass behind a running poll instead of dropping or merging it", async () => {
    const { gates, maxActive } = gatedInbox();
    const store = createMemory();
    const dispatch = vi.fn(async () => ({ ok: true }));

    const poll = pass(store.memory, { now: MORNING, dispatch });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const morning = pass(store.memory, { now: MORNING, forceMorning: true, dispatch });
    const laterPoll = pass(store.memory, { now: MORNING, dispatch });
    expect(morning).not.toBe(laterPoll);

    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(gates).toHaveLength(index + 1));
      gates[index]?.();
    }
    await Promise.all([poll, morning, laterPoll]);

    expect(google.listInboxMessages).toHaveBeenCalledTimes(3);
    expect(maxActive()).toBe(1);
  });

  it("releases a held plan on a lawyer reply that lands while a pass is dispatching", async () => {
    setGoogle({ events: [HEARING] });
    const store = createMemory();
    memoryModule.openVeraMemoryFromApi.mockResolvedValue(store.memory);
    const hookDispatch = vi.fn(async () => ({ ok: true, runId: "run" }));
    const replyApi = createTestPluginApi({
      id: "vera",
      pluginConfig: api.pluginConfig,
      runtime: {
        hooks: { dispatchHookAgentTurn: hookDispatch },
      } as unknown as OpenClawPluginApi["runtime"],
    });

    let failDispatch!: () => void;
    const poll = runVeraCollectPass({
      api: replyApi,
      memory: store.memory,
      now: MORNING,
      forceMorning: false,
      dispatchDigestTurn: () =>
        new Promise((resolve) => {
          failDispatch = () => resolve({ ok: false, reason: "timeout" });
        }),
    });
    await vi.waitFor(() => expect(failDispatch).toBeTypeOf("function"));

    const replyAtMs = MORNING.getTime() + 60_000;
    const reply = recordLawyerInbound({
      api: replyApi,
      atMs: replyAtMs,
      channelId: "kapso-whatsapp",
    });
    failDispatch();
    await Promise.all([poll, reply]);

    expect(hookDispatch).toHaveBeenCalledOnce();
    expect(hookDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Vera held digest",
        message: expect.stringContaining("The lawyer just texted"),
      }),
    );
    expect(store.wake()).toMatchObject({
      lastLawyerInboundAtMs: replyAtMs,
      heldPlanJson: null,
      heldPlanAttempts: 0,
    });
  });
});

describe("vera service scheduling", () => {
  type Job = { id: string; atMs?: number; delayMs?: number; everyMs?: number; run: () => unknown };

  async function startService(options: {
    now: Date;
    wake?: Partial<WakeState>;
    timezone?: string;
  }) {
    const clock = { value: options.now };
    const store = createMemory(options.wake, options.timezone);
    memoryModule.openVeraMemoryFromApi.mockResolvedValue(store.memory);
    const jobs: Job[] = [];
    const scheduler = { schedule: vi.fn((job: Job) => void jobs.push(job)) };
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const serviceApi = createTestPluginApi({
      id: "vera",
      pluginConfig: api.pluginConfig,
      registerService: (registered) => {
        service = registered;
      },
    });
    const dispatch = vi.fn(async () => ({ ok: true }));
    registerVeraService({ api: serviceApi, now: () => clock.value, dispatchDigestTurn: dispatch });
    await service?.start({ scheduler } as never);
    return {
      jobs,
      clock,
      store,
      dispatch,
      find: (id: string) => jobs.filter((job) => job.id === id),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    google.loadAccessToken.mockResolvedValue({ ok: true, accessToken: "token" });
    google.watchGmailInbox.mockResolvedValue({ ok: false });
    setGoogle({});
  });

  it("schedules the 07:40 Rome slot as a one-shot instead of a 24h interval", async () => {
    const { find } = await startService({ now: new Date("2026-10-06T03:00:00.000Z") });
    const morning = find("vera-morning");
    expect(morning).toHaveLength(1);
    expect(new Date(morning[0]?.atMs ?? 0).toISOString()).toBe("2026-10-06T05:40:00.000Z");
    expect(morning[0]?.everyMs).toBeUndefined();
    expect(find("vera-poll")[0]?.everyMs).toBe(15 * 60 * 1000);
  });

  it("recomputes the next slot after each run, including across the DST change", async () => {
    const { find, clock } = await startService({ now: new Date("2026-03-27T12:00:00.000Z") });
    const slots = [new Date(find("vera-morning")[0]?.atMs ?? 0).toISOString()];
    for (let day = 0; day < 3; day += 1) {
      const job = find("vera-morning").at(-1);
      clock.value = new Date((job?.atMs ?? 0) + 1500);
      await job?.run();
      slots.push(new Date(find("vera-morning").at(-1)?.atMs ?? 0).toISOString());
    }
    expect(slots).toEqual([
      "2026-03-28T06:40:00.000Z",
      "2026-03-29T05:40:00.000Z",
      "2026-03-30T05:40:00.000Z",
      "2026-03-31T05:40:00.000Z",
    ]);
  });

  it("does not fire the same slot twice when the timer wakes slightly early", async () => {
    const { find, clock } = await startService({ now: new Date("2026-10-06T03:00:00.000Z") });
    const job = find("vera-morning")[0];
    clock.value = new Date((job?.atMs ?? 0) - 500);
    await job?.run();
    expect(new Date(find("vera-morning").at(-1)?.atMs ?? 0).toISOString()).toBe(
      "2026-10-07T05:40:00.000Z",
    );
  });

  it("schedules the next slot even when the morning tick fails", async () => {
    const { find, clock } = await startService({ now: new Date("2026-10-06T03:00:00.000Z") });
    google.listInboxMessages.mockRejectedValue(new Error("google down"));
    const job = find("vera-morning")[0];
    clock.value = new Date(job?.atMs ?? 0);
    await job?.run();
    expect(find("vera-morning")).toHaveLength(2);
  });

  it("runs a missed-slot catch-up shortly after boot when nothing was collected since the slot", async () => {
    const now = new Date("2026-10-06T09:00:00.000Z");
    const { find, store, dispatch } = await startService({
      now,
      wake: { lastCollectAtMs: Date.parse("2026-10-05T14:00:00.000Z") },
    });
    const catchUp = find("vera-catch-up");
    expect(catchUp).toHaveLength(1);
    expect(catchUp[0]?.atMs).toBe(now.getTime() + 30_000);

    setGoogle({ events: [HEARING] });
    await catchUp[0]?.run();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(store.wake().lastCollectAtMs).toBe(now.getTime());
    expect(new Date(find("vera-morning")[0]?.atMs ?? 0).toISOString()).toBe(
      "2026-10-07T05:40:00.000Z",
    );
  });

  it("skips catch-up when the latest slot was collected, on first boot, and without a connect nag", async () => {
    const now = new Date("2026-10-06T09:00:00.000Z");
    const recent = await startService({
      now,
      wake: { lastCollectAtMs: Date.parse("2026-10-06T05:41:00.000Z") },
    });
    expect(recent.find("vera-catch-up")).toHaveLength(0);

    const fresh = await startService({ now, wake: { lastCollectAtMs: null } });
    expect(fresh.find("vera-catch-up")).toHaveLength(0);

    const stale = await startService({
      now,
      wake: { lastCollectAtMs: Date.parse("2026-10-05T14:00:00.000Z") },
    });
    google.listInboxMessages.mockResolvedValue({ ok: false, status: 401 });
    google.loadAccessToken.mockResolvedValue({ ok: false, reason: "not_connected" });
    await stale.find("vera-catch-up")[0]?.run();
    expect(stale.dispatch).not.toHaveBeenCalled();
  });

  it("uses the lawyer profile timezone for the slot", async () => {
    const { find } = await startService({
      now: new Date("2026-03-07T12:00:00.000Z"),
      timezone: "America/New_York",
    });
    expect(new Date(find("vera-morning")[0]?.atMs ?? 0).toISOString()).toBe(
      "2026-03-07T12:40:00.000Z",
    );
  });
});

describe("digest-ready template for a held plan", () => {
  const warn = vi.fn();
  const templateApi = createTestPluginApi({
    id: "vera",
    pluginConfig: {
      ...(api.pluginConfig as object),
      digestReadyTemplate: { name: "vera_digest_ready", language: "en" },
    },
    config: {
      channels: {
        "kapso-whatsapp": {
          apiKey: "kapso_test_key",
          phoneNumberId: "100000000000000",
          defaultTo: "+390000000000",
        },
      },
    } as OpenClawPluginApi["config"],
    logger: { info() {}, warn, error() {}, debug() {} },
  });
  const closedWindow = { lastLawyerInboundAtMs: MORNING.getTime() - 30 * HOUR_MS };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    google.loadAccessToken.mockResolvedValue({ ok: true, accessToken: "token" });
    google.watchGmailInbox.mockResolvedValue({ ok: false });
    setGoogle({ events: [HEARING] });
  });

  it("sends the template once when the plan is first held and not again on later polls", async () => {
    const store = createMemory(closedWindow);
    const notice = vi.fn(async () => ({ ok: true }));
    const dispatch = vi.fn(async () => ({ ok: true }));
    const run = (now: Date, forceMorning = false) =>
      pass(store.memory, {
        now,
        forceMorning,
        dispatch,
        api: templateApi,
        sendDigestReadyNotice: notice,
      });

    await run(MORNING, true);
    expect(notice).toHaveBeenCalledOnce();
    expect(notice).toHaveBeenCalledWith({ name: "vera_digest_ready", language: "en" });
    expect(store.wake().heldPlanTemplateAttemptedAtMs).toBe(MORNING.getTime());

    await run(POLL_1);
    await run(new Date(POLL_1.getTime() + 15 * 60_000));
    await run(new Date(MORNING.getTime() + 2 * HOUR_MS), true);
    expect(notice).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("releases the plan on a lawyer reply and nudges again only for the next held plan", async () => {
    const store = createMemory(closedWindow);
    const notice = vi.fn(async () => ({ ok: true }));
    const dispatch = vi.fn(async () => ({ ok: true }));
    await pass(store.memory, {
      now: MORNING,
      forceMorning: true,
      dispatch,
      api: templateApi,
      sendDigestReadyNotice: notice,
    });

    const replyAt = new Date(MORNING.getTime() + HOUR_MS);
    await store.memory.writeWake({ lastLawyerInboundAtMs: replyAt.getTime() });
    const released = await pass(store.memory, {
      now: replyAt,
      forceMorning: true,
      dispatch,
      api: templateApi,
      sendDigestReadyNotice: notice,
    });
    expect(released.delivered).toBe(true);
    expect(store.wake()).toMatchObject({
      heldPlanJson: null,
      heldPlanTemplateAttemptedAtMs: null,
    });

    const nextMorning = new Date(MORNING.getTime() + 24 * HOUR_MS);
    setGoogle({
      events: [
        {
          ...HEARING,
          id: "e-next",
          start: "2026-10-07T14:00:00.000Z",
          end: "2026-10-07T15:00:00.000Z",
        },
      ],
    });
    await store.memory.writeWake({ lastLawyerInboundAtMs: replyAt.getTime() - 30 * HOUR_MS });
    await pass(store.memory, {
      now: nextMorning,
      forceMorning: true,
      dispatch,
      api: templateApi,
      sendDigestReadyNotice: notice,
    });
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it("does nothing but warn once when digestReadyTemplate is unset", async () => {
    const store = createMemory(closedWindow);
    const notice = vi.fn(async () => ({ ok: true }));
    const unsetApi = createTestPluginApi({
      id: "vera",
      pluginConfig: api.pluginConfig,
      logger: { info() {}, warn, error() {}, debug() {} },
    });
    const dispatch = vi.fn(async () => ({ ok: true }));
    for (const now of [MORNING, POLL_1]) {
      await pass(store.memory, {
        now,
        forceMorning: now === MORNING,
        dispatch,
        api: unsetApi,
        sendDigestReadyNotice: notice,
      });
    }
    expect(notice).not.toHaveBeenCalled();
    expect(store.wake().heldPlanTemplateAttemptedAtMs).toBeNull();
    expect(store.wake().heldPlanJson).not.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("digestReadyTemplate");
  });

  it("keeps the hold and does not retry when the template send throws", async () => {
    const store = createMemory(closedWindow);
    const notice = vi.fn(async () => {
      throw new Error("kapso down");
    });
    const dispatch = vi.fn(async () => ({ ok: true }));
    const first = await pass(store.memory, {
      now: MORNING,
      forceMorning: true,
      dispatch,
      api: templateApi,
      sendDigestReadyNotice: notice,
    });
    expect(first).toMatchObject({ held: true, reason: "whatsapp_window_closed" });
    await pass(store.memory, {
      now: POLL_1,
      dispatch,
      api: templateApi,
      sendDigestReadyNotice: notice,
    });
    expect(notice).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("kapso down"));
  });

  it.each([
    ["a 4xx rejection", async () => new Response("{}", { status: 400 })],
    [
      "a network failure",
      async () => {
        throw new Error("socket hang up");
      },
    ],
  ])("calls Kapso at most once per held plan after %s", async (_label, respond) => {
    const fetchMock = vi.fn(respond);
    vi.stubGlobal("fetch", fetchMock);
    const store = createMemory(closedWindow);
    const dispatch = vi.fn(async () => ({ ok: true }));

    await pass(store.memory, { now: MORNING, forceMorning: true, dispatch, api: templateApi });
    await pass(store.memory, { now: POLL_1, dispatch, api: templateApi });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: "template",
      to: "390000000000",
      template: { name: "vera_digest_ready", language: { code: "en" } },
    });
    expect(store.wake().heldPlanJson).not.toBeNull();
  });

  it("sends through Kapso on 2xx", async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"messages":[{"id":"wamid.x"}]}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = createMemory(closedWindow);
    await pass(store.memory, {
      now: MORNING,
      forceMorning: true,
      dispatch: async () => ({ ok: true }),
      api: templateApi,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/messages",
    );
  });
});
