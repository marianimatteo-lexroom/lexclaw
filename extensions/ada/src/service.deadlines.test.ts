import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestMemory } from "./deadline-test-support.js";
import type { DigestPlan } from "./digest.js";
import type { MemoryStore } from "./memory.js";
import { heldPlanBackoffMs, runAdaCollectPass } from "./service.js";

const google = vi.hoisted(() => ({
  loadAccessToken: vi.fn(),
  listInboxMessages: vi.fn(),
  listUpcomingEvents: vi.fn(),
  watchGmailInbox: vi.fn(),
  listMessageIds: vi.fn(),
}));

vi.mock("./google-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-api.js")>()),
  ...google,
}));

vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async () => ({
    readAccount: async () => ({ email: "lawyer@example.com" }),
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const HOUR_MS = 60 * 60 * 1000;
const MORNING = new Date("2026-10-06T05:40:00.000Z");
const BASE_CONFIG = {
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-0123456789",
};
const HEARING = {
  id: "e-verdi",
  summary: "Verdi hearing",
  start: "2026-10-06T14:00:00.000Z",
  end: "2026-10-06T15:00:00.000Z",
  status: "confirmed",
};

function apiWith(pluginConfig: Record<string, unknown>): OpenClawPluginApi {
  return createTestPluginApi({ id: "ada", pluginConfig });
}

function openMemory(): { memory: MemoryStore; close: () => void } {
  const opened = openTestMemory(tempDirs.make("ada-deadlines-"));
  const memory = Object.assign(Object.create(opened.memory), {
    listMatterAliases: async () => [{ matterId: "verdi", alias: "Verdi", title: "Verdi" }],
  }) as MemoryStore;
  return { memory, close: opened.close };
}

function dispatched(dispatch: ReturnType<typeof vi.fn>): DigestPlan {
  return dispatch.mock.calls.at(-1)?.[0].plan;
}

describe("deadline intake in the collect pass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    google.loadAccessToken.mockResolvedValue({ ok: true, accessToken: "token" });
    google.watchGmailInbox.mockResolvedValue({ ok: false });
    google.listInboxMessages.mockResolvedValue({ ok: true, messages: [] });
    google.listMessageIds.mockResolvedValue({ ok: true, ids: [] });
    google.listUpcomingEvents.mockResolvedValue({ ok: true, events: [HEARING] });
  });

  it("stays off by default: no scan, no deadline lines, nothing stored", async () => {
    const { memory, close } = openMemory();
    const dispatch = vi.fn(async () => ({ ok: true }));
    await memory.writeWake({ lastLawyerInboundAtMs: MORNING.getTime() - HOUR_MS });

    await runAdaCollectPass({
      api: apiWith(BASE_CONFIG),
      memory,
      now: MORNING,
      forceMorning: true,
      trigger: "morning",
      dispatchDigestTurn: dispatch,
    });

    expect(google.listMessageIds).not.toHaveBeenCalled();
    expect(dispatched(dispatch)).not.toHaveProperty("deadlines");
    expect(await memory.listDeadlines()).toEqual([]);
    close();
  });

  const enabled = () => apiWith({ ...BASE_CONFIG, deadlineIntake: { enabled: true } });

  it("numbers the current deadlines when a held plan is released, and records the offer once delivered", async () => {
    const { memory, close } = openMemory();
    const dispatch = vi.fn(async () => ({ ok: true }));
    await memory.writeWake({ lastLawyerInboundAtMs: MORNING.getTime() - 30 * HOUR_MS });

    const held = await runAdaCollectPass({
      api: enabled(),
      memory,
      now: MORNING,
      forceMorning: true,
      trigger: "morning",
      dispatchDigestTurn: dispatch,
    });
    expect(held).toMatchObject({ held: true, reason: "whatsapp_window_closed" });
    expect(dispatch).not.toHaveBeenCalled();
    expect((await memory.listDeadlines())[0]).toMatchObject({ offerNo: null, offeredCount: 0 });

    const replyAt = new Date(MORNING.getTime() + HOUR_MS);
    await memory.writeWake({ lastLawyerInboundAtMs: replyAt.getTime() });
    await runAdaCollectPass({
      api: enabled(),
      memory,
      now: replyAt,
      forceMorning: true,
      trigger: "inbound",
      dispatchDigestTurn: dispatch,
    });

    const plan = dispatched(dispatch);
    expect(plan).toMatchObject({
      deliver: true,
      deadlines: [{ no: 1, matterId: "verdi", status: "candidate" }],
    });
    expect((await memory.listDeadlines())[0]).toMatchObject({ offerNo: 1, offeredCount: 1 });
    expect((await memory.readWake()).heldPlanJson).toBeNull();
    close();
  });

  it("keeps listing deadlines when a failed dispatch is retried from the held plan", async () => {
    const { memory, close } = openMemory();
    await memory.writeWake({ lastLawyerInboundAtMs: MORNING.getTime() - HOUR_MS });

    const failing = vi.fn(async () => ({ ok: false, reason: "hooks_unavailable" }));
    const first = await runAdaCollectPass({
      api: enabled(),
      memory,
      now: MORNING,
      forceMorning: true,
      trigger: "morning",
      dispatchDigestTurn: failing,
    });
    expect(first).toMatchObject({ held: true, reason: "hooks_unavailable" });
    expect((await memory.listDeadlines())[0]).toMatchObject({ offerNo: null });

    const retry = vi.fn(async () => ({ ok: true }));
    const retryAt = new Date(MORNING.getTime() + heldPlanBackoffMs(1));
    const second = await runAdaCollectPass({
      api: enabled(),
      memory,
      now: retryAt,
      forceMorning: false,
      trigger: "poll",
      dispatchDigestTurn: retry,
    });

    expect(second.delivered).toBe(true);
    expect(dispatched(retry)).toMatchObject({ deadlines: [{ no: 1, matterId: "verdi" }] });
    expect((await memory.listDeadlines())[0]).toMatchObject({ offerNo: 1, offeredCount: 1 });
    close();
  });
});
