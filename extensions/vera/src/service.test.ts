import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectResult } from "./collector.js";
import type { DigestPlan } from "./digest.js";
import type { MemoryStore } from "./memory.js";
import type { WakeState } from "./memory-contract.js";
import { decideDigestDelivery, runVeraCollectPass, type VeraCollectLogEvent } from "./service.js";

const google = vi.hoisted(() => ({
  account: null as { email: string } | null,
  events: [] as Array<{ id: string; summary: string; start: string; end: string; status: string }>,
}));

vi.mock("./google-account.js", () => ({
  openVeraGoogleAccountFromApi: async () => ({ readAccount: async () => google.account }),
}));
vi.mock("./google-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-api.js")>()),
  loadAccessToken: async () => ({ ok: true, accessToken: "token" }),
  listInboxMessages: async () => ({ ok: true, messages: [] }),
  listUpcomingEvents: async () => ({ ok: true, events: google.events }),
  watchGmailInbox: async () => ({ ok: false }),
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

describe("runVeraCollectPass", () => {
  const now = new Date("2026-10-14T09:00:00.000Z");
  const googleConfig = {
    googleClientId: "client",
    googleClientSecret: "secret",
    googleRedirectUri: "https://vera.example.com/vera/google/callback",
    googleStateSecret: "0123456789abcdef",
  };

  function setup(params: { wake?: Partial<WakeState>; config?: unknown }) {
    const info = vi.fn();
    const error = vi.fn();
    const api = {
      pluginConfig: params.config ?? googleConfig,
      logger: { info, error, warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;
    let wake: WakeState = {
      lastLawyerInboundAtMs: null,
      lastReconcileAtMs: null,
      lastCollectAtMs: null,
      lastDigestAtMs: null,
      heldPlanJson: null,
      heldPlanAtMs: null,
      watchExpirationMs: null,
      openTodoIdsJson: null,
      ...params.wake,
    };
    const memory = {
      readGmailSnapshot: async () => [],
      readCalendarSnapshot: async () => [],
      listMatterAliases: async () => [{ matterId: "verdi", alias: "Verdi", title: "Verdi" }],
      listTodos: async () => [],
      readProfile: async () => null,
      replaceGmailSnapshot: async () => {},
      replaceCalendarSnapshot: async () => {},
      readWake: async () => wake,
      writeWake: async (patch: Partial<WakeState>) => {
        wake = { ...wake, ...patch };
      },
    } as unknown as MemoryStore;
    const run = (overrides: { dispatchOk?: boolean; trigger?: "poll" | "inbound" } = {}) =>
      runVeraCollectPass({
        api,
        memory,
        now,
        forceMorning: false,
        trigger: overrides.trigger ?? "poll",
        dispatchDigestTurn: async () =>
          overrides.dispatchOk === false ? { ok: false, reason: "hooks_unavailable" } : { ok: true },
      });
    const events = (): VeraCollectLogEvent[] =>
      info.mock.calls.map(([line]) => JSON.parse(String(line)) as VeraCollectLogEvent);
    return { run, events, error, wake: () => wake };
  }

  beforeEach(() => {
    google.account = { email: "lawyer@example.com" };
    google.events = [
      {
        id: "hearing",
        summary: "Verdi hearing",
        start: "2026-10-14T13:00:00.000Z",
        end: "2026-10-14T14:00:00.000Z",
        status: "confirmed",
      },
    ];
  });

  it("logs a skipped event when Google is not configured", async () => {
    const t = setup({ config: {} });
    await t.run();
    expect(t.events()).toEqual([
      expect.objectContaining({
        event: "vera.collect",
        trigger: "poll",
        result: "skipped",
        decision: "none",
        delivered: false,
        held: false,
        windowOpen: null,
      }),
    ]);
    expect(t.wake().lastCollectAtMs).toBeNull();
  });

  it("holds when the window is closed, keeps the first hold time, and logs the reason", async () => {
    const t = setup({});
    await t.run();
    const firstHold = t.wake().heldPlanAtMs;
    expect(firstHold).toBe(now.getTime());
    expect(t.wake()).toMatchObject({ lastCollectAtMs: now.getTime(), lastDigestAtMs: null });
    expect(t.events()[0]).toMatchObject({
      result: "collected",
      decision: "hold",
      dispatchReason: "whatsapp_window_closed",
      held: true,
      windowOpen: false,
      deliverable: true,
      urgent: true,
    });

    const later = setup({ wake: { heldPlanJson: "{}", heldPlanAtMs: 1234 } });
    await later.run();
    expect(later.wake().heldPlanAtMs).toBe(1234);
  });

  it("records the digest time and clears the hold when the window is open", async () => {
    const t = setup({
      wake: {
        heldPlanJson: "{}",
        heldPlanAtMs: 1234,
        lastLawyerInboundAtMs: now.getTime() - 60 * 60 * 1000,
      },
    });
    await t.run({ trigger: "inbound" });
    expect(t.wake()).toMatchObject({
      lastCollectAtMs: now.getTime(),
      lastDigestAtMs: now.getTime(),
      heldPlanJson: null,
      heldPlanAtMs: null,
    });
    expect(t.events()[0]).toMatchObject({
      trigger: "inbound",
      result: "collected",
      decision: "dispatch",
      delivered: true,
      windowOpen: true,
    });
  });

  it("logs a rejected dispatch, keeps collect fresh, and does not record a digest", async () => {
    const t = setup({ wake: { lastLawyerInboundAtMs: now.getTime() - 60 * 60 * 1000 } });
    await t.run({ dispatchOk: false });
    expect(t.wake()).toMatchObject({ lastCollectAtMs: now.getTime(), lastDigestAtMs: null });
    expect(t.events()[0]).toMatchObject({
      decision: "dispatch",
      dispatchReason: "hooks_unavailable",
      delivered: false,
    });
  });

  it("logs an error event at error level and rethrows", async () => {
    const t = setup({});
    google.account = {
      get email(): string {
        throw new Error("boom");
      },
    };
    await expect(t.run()).rejects.toThrow("boom");
    expect(t.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(t.error.mock.calls[0]?.[0]))).toMatchObject({
      event: "vera.collect",
      result: "error",
      error: "boom",
    });
  });
});
