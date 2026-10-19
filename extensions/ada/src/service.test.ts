import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectResult } from "./collector.js";
import type { DigestPlan } from "./digest.js";
import type { DigestDispatchRequest } from "./dispatch-digest.js";
import type { WakeState } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { decideDigestDelivery, runAdaCollectPass, type AdaCollectLogEvent } from "./service.js";

const google = vi.hoisted(() => ({
  account: null as { email: string } | null,
  events: [] as Array<{ id: string; summary: string; start: string; end: string; status: string }>,
  messages: [] as Array<{
    id: string;
    from: string;
    subject: string;
    date: string;
    snippet: string;
    unread?: true;
  }>,
}));

vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async () => ({ readAccount: async () => google.account }),
}));
vi.mock("./google-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-api.js")>()),
  loadAccessToken: async () => ({ ok: true, accessToken: "token" }),
  listInboxMessages: async () => ({ ok: true, messages: google.messages }),
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
        morningPass: false,
        briefedToday: false,
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
        morningPass: false,
        briefedToday: false,
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
        morningPass: false,
        briefedToday: false,
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
        morningPass: false,
        briefedToday: false,
        timeZone: "Europe/Rome",
        now,
        lastLawyerInboundAtMs: now.getTime() - 60 * 60 * 1000,
      }),
    ).toEqual({ action: "dispatch", plan });
  });
});

describe("decideDigestDelivery on a quiet morning", () => {
  const quiet: CollectResult = {
    ...deliverable,
    plan: { deliver: false, reason: "nothing_cleared_the_bar" },
    urgent: false,
  };
  const at = new Date("2026-10-06T05:40:00.000Z");
  const base = {
    result: quiet,
    forceMorning: true,
    morningPass: true,
    briefedToday: false,
    timeZone: "Europe/Rome",
    now: at,
    lastLawyerInboundAtMs: at.getTime() - 60 * 60 * 1000,
  };

  it("sends the short brief at the morning pass when the WhatsApp window is open", () => {
    expect(decideDigestDelivery(base)).toEqual({ action: "brief" });
  });

  it("stays silent when the window is closed: nothing is held and no template is owed", () => {
    expect(
      decideDigestDelivery({ ...base, lastLawyerInboundAtMs: at.getTime() - 30 * 60 * 60 * 1000 }),
    ).toEqual({ action: "silent" });
    expect(decideDigestDelivery({ ...base, lastLawyerInboundAtMs: null })).toEqual({
      action: "silent",
    });
  });

  it("stays silent when a brief already went out on this local day", () => {
    expect(decideDigestDelivery({ ...base, briefedToday: true })).toEqual({ action: "silent" });
  });

  it("leaves polls and the release of a held plan alone", () => {
    expect(decideDigestDelivery({ ...base, forceMorning: false, morningPass: false })).toEqual({
      action: "silent",
    });
    expect(decideDigestDelivery({ ...base, morningPass: false })).toEqual({ action: "silent" });
  });

  it("turns a repeated morning pass into a poll for a plan that is deliverable", () => {
    const later = { ...base, now: new Date("2026-10-06T12:00:00.000Z"), briefedToday: true };
    expect(decideDigestDelivery({ ...later, result: { ...deliverable, urgent: false } })).toEqual({
      action: "batch",
    });
    expect(decideDigestDelivery({ ...later, result: deliverable })).toEqual({
      action: "dispatch",
      plan,
    });
  });
});

describe("runAdaCollectPass", () => {
  const now = new Date("2026-10-14T09:00:00.000Z");
  const googleConfig = {
    googleClientId: "client",
    googleClientSecret: "secret",
    googleRedirectUri: "https://ada.example.com/ada/google/callback",
    googleStateSecret: "0123456789abcdef",
  };

  function setup(params: { wake?: Partial<WakeState>; config?: unknown; timezone?: string }) {
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
      lastMorningBriefAtMs: null,
      heldPlanJson: null,
      heldPlanAtMs: null,
      watchExpirationMs: null,
      openTodoIdsJson: null,
      ...params.wake,
    };
    let gmailSnapshot: Awaited<ReturnType<MemoryStore["readGmailSnapshot"]>> = [];
    let calendarSnapshot: Awaited<ReturnType<MemoryStore["readCalendarSnapshot"]>> = [];
    const memory = {
      readGmailSnapshot: async () => gmailSnapshot,
      readCalendarSnapshot: async () => calendarSnapshot,
      listMatterAliases: async () => [{ matterId: "verdi", alias: "Verdi", title: "Verdi" }],
      listTodos: async () => [],
      readProfile: async () => (params.timezone ? { timezone: params.timezone } : null),
      replaceGmailSnapshot: async (rows: typeof gmailSnapshot) => {
        gmailSnapshot = rows;
      },
      replaceCalendarSnapshot: async (rows: typeof calendarSnapshot) => {
        calendarSnapshot = rows;
      },
      readWake: async () => wake,
      writeWake: async (patch: Partial<WakeState>) => {
        wake = { ...wake, ...patch };
      },
    } as unknown as MemoryStore;
    const dispatched: DigestDispatchRequest[] = [];
    const run = (
      overrides: {
        dispatchOk?: boolean;
        trigger?: "poll" | "inbound" | "morning";
        at?: Date;
        catchUp?: boolean;
      } = {},
    ) =>
      runAdaCollectPass({
        api,
        memory,
        now: overrides.at ?? now,
        forceMorning: overrides.trigger === "morning" || overrides.trigger === "inbound",
        trigger: overrides.trigger ?? "poll",
        catchUp: overrides.catchUp,
        dispatchDigestTurn: async (request) => {
          dispatched.push(request);
          return overrides.dispatchOk === false
            ? { ok: false, reason: "hooks_unavailable" }
            : { ok: true };
        },
      });
    const events = (): AdaCollectLogEvent[] =>
      info.mock.calls.map(([line]) => JSON.parse(String(line)) as AdaCollectLogEvent);
    return { run, events, error, dispatched, wake: () => wake };
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
    google.messages = [];
  });

  it("logs a skipped event when Google is not configured", async () => {
    const t = setup({ config: {} });
    await t.run();
    expect(t.events()).toEqual([
      expect.objectContaining({
        event: "ada.collect",
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

  describe("the morning brief on a quiet day", () => {
    const lunch = {
      id: "lunch",
      summary: "Pranzo con Bianchi",
      start: "2026-10-14T10:30:00.000Z",
      end: "2026-10-14T11:30:00.000Z",
      status: "confirmed",
    };
    const unreadVerdi = {
      id: "m1",
      from: "Verdi <verdi@example.com>",
      subject: "Nuova memoria",
      date: "Wed, 14 Oct 2026 07:00:00 +0200",
      snippet: "Allego la memoria",
      unread: true as const,
    };
    const open = { lastLawyerInboundAtMs: now.getTime() - 60 * 60 * 1000 };

    beforeEach(() => {
      google.events = [lunch];
      google.messages = [unreadVerdi];
    });

    it("sends the agenda and unread mail with no urgent plan, and marks the day as briefed", async () => {
      const t = setup({ wake: open, timezone: "Europe/Rome" });
      await t.run({ trigger: "morning" });
      expect(t.dispatched).toHaveLength(1);
      expect(t.dispatched[0]).toMatchObject({
        plan: { deliver: false },
        idempotencyKey: expect.stringMatching(/^brief:.*:2026-10-14$/u),
        brief: {
          events: [{ time: "12:30", summary: "Pranzo con Bianchi" }],
          unreadMail: 1,
          mailHighlights: [{ matter: "Verdi", subject: "Nuova memoria" }],
          deadlines: [],
        },
      });
      expect(t.wake()).toMatchObject({
        lastCollectAtMs: now.getTime(),
        lastDigestAtMs: now.getTime(),
        lastMorningBriefAtMs: now.getTime(),
        heldPlanJson: null,
      });
      expect(t.events()[0]).toMatchObject({
        trigger: "morning",
        result: "collected",
        decision: "brief",
        delivered: true,
        deliverable: false,
      });
    });

    it("sends one brief per local day, counted on the number's own clock", async () => {
      // 15:30Z and 16:30Z are one day in Rome (17:30, 18:30) and two in Shanghai (23:30, 00:30).
      const first = new Date("2026-10-14T15:30:00.000Z");
      const second = new Date("2026-10-14T16:30:00.000Z");
      google.events = [];
      google.messages = [];

      const rome = setup({ wake: open, timezone: "Europe/Rome" });
      await rome.run({ trigger: "morning", at: first });
      await rome.run({ trigger: "morning", at: second });
      expect(rome.dispatched).toHaveLength(1);
      expect(rome.events()[1]).toMatchObject({ decision: "silent", delivered: false });

      const shanghai = setup({ wake: open, timezone: "Asia/Shanghai" });
      await shanghai.run({ trigger: "morning", at: first });
      await shanghai.run({ trigger: "morning", at: second });
      expect(shanghai.dispatched).toHaveLength(2);
    });

    it("does not count a failed send, so the next morning pass tries again", async () => {
      const t = setup({ wake: open });
      await t.run({ trigger: "morning", dispatchOk: false });
      expect(t.wake()).toMatchObject({
        lastCollectAtMs: now.getTime(),
        lastMorningBriefAtMs: null,
      });
      expect(t.events()[0]).toMatchObject({
        decision: "brief",
        delivered: false,
        dispatchReason: "hooks_unavailable",
      });
      await t.run({ trigger: "morning" });
      expect(t.dispatched).toHaveLength(2);
      expect(t.wake().lastMorningBriefAtMs).toBe(now.getTime());
    });

    it("sends the brief from a catch-up before 11:00 local time, and skips it from 11:00 on", async () => {
      google.events = [];
      google.messages = [];
      // Rome is UTC+2 on 14 October: 08:59Z is 10:59 local, 09:00Z is 11:00.
      const early = setup({ wake: open, timezone: "Europe/Rome" });
      await early.run({ trigger: "morning", catchUp: true, at: new Date("2026-10-14T08:59:00Z") });
      expect(early.dispatched).toHaveLength(1);
      expect(early.wake().lastMorningBriefAtMs).toBe(Date.parse("2026-10-14T08:59:00Z"));

      const late = setup({ wake: open, timezone: "Europe/Rome" });
      await late.run({ trigger: "morning", catchUp: true, at: new Date("2026-10-14T09:00:00Z") });
      expect(late.dispatched).toEqual([]);
      expect(late.wake()).toMatchObject({
        lastCollectAtMs: Date.parse("2026-10-14T09:00:00Z"),
        lastMorningBriefAtMs: null,
      });
      expect(late.events()[0]).toMatchObject({ result: "collected", decision: "silent" });

      // The same hour on the number's own clock: 09:00Z is 17:00 in Shanghai, still too late,
      // and 01:00Z is 09:00 in Shanghai, early enough.
      const shanghai = setup({ wake: open, timezone: "Asia/Shanghai" });
      await shanghai.run({
        trigger: "morning",
        catchUp: true,
        at: new Date("2026-10-14T09:00:00Z"),
      });
      await shanghai.run({
        trigger: "morning",
        catchUp: true,
        at: new Date("2026-10-15T01:00:00Z"),
      });
      expect(shanghai.dispatched).toHaveLength(1);
    });

    it("still sends the regular 07:40 pass whatever the hour, and an urgent plan from a late catch-up", async () => {
      google.events = [];
      google.messages = [];
      const regular = setup({ wake: open, timezone: "Europe/Rome" });
      await regular.run({ trigger: "morning", at: new Date("2026-10-14T15:00:00Z") });
      expect(regular.dispatched).toHaveLength(1);

      google.events = [
        {
          id: "hearing",
          summary: "Verdi hearing",
          start: "2026-10-14T16:00:00.000Z",
          end: "2026-10-14T17:00:00.000Z",
          status: "confirmed",
        },
      ];
      const urgent = setup({ wake: open, timezone: "Europe/Rome" });
      await urgent.run({ trigger: "morning", catchUp: true, at: new Date("2026-10-14T15:00:00Z") });
      expect(urgent.dispatched[0]).toMatchObject({ plan: { deliver: true } });
    });

    it("sends one message, not two, when a poll lands in the 07:40 minute before the morning pass", async () => {
      google.events = [];
      google.messages = [{ ...unreadVerdi, subject: "Verdi: please confirm the hearing?" }];
      const t = setup({ wake: open, timezone: "Europe/Rome" });
      await t.run({ trigger: "poll", at: new Date("2026-10-14T05:40:20.000Z") });
      await t.run({ trigger: "morning", at: new Date("2026-10-14T05:40:30.000Z") });
      expect(t.dispatched).toHaveLength(1);
      expect(t.dispatched[0]).toMatchObject({
        plan: { deliver: true },
        idempotencyKey: expect.stringMatching(/^digest:.*:2026-10-14:verdi$/u),
      });
      expect(t.wake().lastMorningBriefAtMs).toBe(Date.parse("2026-10-14T05:40:20.000Z"));
      expect(t.events()[1]).toMatchObject({ trigger: "morning", decision: "silent" });
    });

    it("does not say nothing is urgent when an alert already went out earlier the same local day", async () => {
      google.events = [];
      google.messages = [];
      const earlier = Date.parse("2026-10-14T03:00:00.000Z");
      const alerted = setup({
        wake: { ...open, lastDigestAtMs: earlier },
        timezone: "Europe/Rome",
      });
      await alerted.run({ trigger: "morning" });
      expect(alerted.dispatched[0]?.brief).toMatchObject({ alertedToday: true });

      const yesterday = setup({
        wake: { ...open, lastDigestAtMs: Date.parse("2026-10-13T08:00:00.000Z") },
        timezone: "Europe/Rome",
      });
      await yesterday.run({ trigger: "morning" });
      expect(yesterday.dispatched[0]?.brief).toMatchObject({ alertedToday: false });

      // 03:00Z on the 14th is the evening of the 13th in Los Angeles.
      const otherZone = setup({
        wake: { ...open, lastDigestAtMs: earlier },
        timezone: "America/Los_Angeles",
      });
      await otherZone.run({ trigger: "morning" });
      expect(otherZone.dispatched[0]?.brief).toMatchObject({ alertedToday: false });
    });

    it("counts an urgent morning digest as the day's brief", async () => {
      google.events = [
        {
          id: "hearing",
          summary: "Verdi hearing",
          start: "2026-10-14T13:00:00.000Z",
          end: "2026-10-14T14:00:00.000Z",
          status: "confirmed",
        },
      ];
      const t = setup({ wake: open });
      await t.run({ trigger: "morning" });
      expect(t.dispatched[0]).toMatchObject({ plan: { deliver: true } });
      expect(t.dispatched[0]?.brief).toBeUndefined();
      expect(t.wake().lastMorningBriefAtMs).toBe(now.getTime());
    });

    it("keeps today's behavior when the window is closed: nothing sent, held, or templated", async () => {
      const t = setup({ wake: { lastLawyerInboundAtMs: now.getTime() - 30 * 60 * 60 * 1000 } });
      await t.run({ trigger: "morning" });
      expect(t.dispatched).toEqual([]);
      expect(t.wake()).toMatchObject({
        lastCollectAtMs: now.getTime(),
        heldPlanJson: null,
        lastMorningBriefAtMs: null,
      });
      expect(t.events()[0]).toMatchObject({ decision: "silent", windowOpen: false });
    });

    it("still holds an urgent plan when the window is closed at the morning pass", async () => {
      google.events = [
        {
          id: "hearing",
          summary: "Verdi hearing",
          start: "2026-10-14T13:00:00.000Z",
          end: "2026-10-14T14:00:00.000Z",
          status: "confirmed",
        },
      ];
      const t = setup({ wake: { lastLawyerInboundAtMs: now.getTime() - 30 * 60 * 60 * 1000 } });
      await t.run({ trigger: "morning" });
      expect(t.dispatched).toEqual([]);
      expect(t.wake().heldPlanJson).not.toBeNull();
      expect(t.wake().lastMorningBriefAtMs).toBeNull();
      expect(t.events()[0]).toMatchObject({ decision: "hold", held: true, windowOpen: false });
    });

    it("never sends it from a poll or from the release of a held plan", async () => {
      const t = setup({ wake: open });
      await t.run({ trigger: "poll" });
      await t.run({ trigger: "inbound" });
      expect(t.dispatched).toEqual([]);
      expect(t.wake().lastMorningBriefAtMs).toBeNull();
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
      event: "ada.collect",
      result: "error",
      error: "boom",
    });
  });
});
