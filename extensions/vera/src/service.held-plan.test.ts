import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectResult } from "./collector.js";
import type { DigestPlan } from "./digest.js";
import type { InboxMessage } from "./google-api.js";
import type { CalendarSnapshotRow, GmailSnapshotRow, WakeState } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { HELD_PLAN_MAX_ATTEMPTS, heldPlanBackoffMs, runVeraCollectPass } from "./service.js";

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

function createMemory(wake: Partial<WakeState> = {}) {
  let gmail: GmailSnapshotRow[] = [];
  let calendar: CalendarSnapshotRow[] = [];
  let state: WakeState = {
    lastLawyerInboundAtMs: MORNING.getTime() - HOUR_MS,
    lastReconcileAtMs: null,
    lastCollectAtMs: null,
    lastDigestAtMs: null,
    heldPlanJson: null,
    heldPlanAtMs: null,
    heldPlanAttempts: 0,
    heldPlanNextAttemptAtMs: null,
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
    readProfile: async () => null,
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
  },
) {
  return runVeraCollectPass({
    api,
    memory,
    now: options.now,
    forceMorning: options.forceMorning ?? false,
    trigger: "poll",
    dispatchDigestTurn: options.dispatch,
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
      lastCollectAtMs: MORNING.getTime(),
      lastDigestAtMs: null,
      heldPlanAtMs: MORNING.getTime(),
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
