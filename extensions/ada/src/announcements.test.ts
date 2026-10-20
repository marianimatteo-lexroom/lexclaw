import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "./memory.js";

const mocks = vi.hoisted(() => ({
  registry: undefined as undefined | MemoryStore,
  memories: new Map<string, MemoryStore>(),
  append: vi.fn(),
  send: vi.fn(),
  granola: new Set<string>(),
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  appendAssistantMirrorMessageByIdentity: mocks.append,
}));
vi.mock("./google-notify.js", () => ({ sendAdaWhatsAppText: mocks.send }));
vi.mock("./granola-account.js", () => ({
  openAdaGranolaAccountFromApi: async (_api: unknown, owner: string) => ({
    readAccount: async () => (mocks.granola.has(owner) ? { connected: true } : null),
  }),
}));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaRegistryFromApi: async () => mocks.registry,
  openAdaMemoryIfExistsFromApi: async (_api: unknown, owner: string) =>
    mocks.memories.get(owner) ?? null,
  openAdaMemoryFromApi: async (_api: unknown, owner: string) => {
    const memory = mocks.memories.get(owner);
    if (!memory) {
      throw new Error("no test memory");
    }
    return memory;
  },
}));

import {
  ANNOUNCEMENT_SETTLE_MS,
  deliverAnnouncement,
  deliverToRecipients,
  listAnnouncementRecipients,
  liveAnnouncementDeps,
  parseAnnouncementInput,
  registerAnnouncementRelease,
  releasePendingAnnouncement,
  resolveAnnouncementText,
  type AnnouncementDeps,
  type AnnouncementRecipient,
} from "./announcements.js";
import { ANNOUNCEMENTS_OFF_KEY, type Announcement } from "./memory-contract.js";
import { realStore } from "./preference-test-support.js";
import { executeAdaSetPreference } from "./preference-tools.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { clearHeldResearch, recordSenderInbound } from "./research-push.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = Date.parse("2026-10-20T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const PAOLO = "393331111111";
const ANNA = "393332222222";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const recipient = (owner: string): AnnouncementRecipient => ({
  owner,
  sessionKey: `agent:main:kapso-whatsapp:direct:${owner}`,
  sessionId: `session-${owner}`,
});

const GRANOLA: Announcement = {
  id: "granola",
  feature: "granola",
  createdAtMs: NOW - HOUR,
  texts: {
    it: "Novità: puoi collegare Granola per leggere le tue note. Vuoi il link?",
    en: "New: you can connect Granola so I read your meeting notes. Want the link?",
    es: "Novedad: puedes conectar Granola. ¿Quieres el enlace?",
  },
};

let registry: MemoryStore;

beforeEach(() => {
  vi.clearAllMocks();
  clearInboundLanguages();
  clearHeldResearch();
  mocks.memories.clear();
  mocks.granola.clear();
  mocks.send.mockResolvedValue({ ok: true });
  mocks.append.mockResolvedValue({ ok: true, messageId: "m1" });
  registry = realStore(tempDirs.make("ada-announcements-"), "memory");
  mocks.registry = registry;
});

function makeDeps(overrides: Partial<AnnouncementDeps> = {}) {
  return {
    registry: async () => registry,
    now: () => NOW,
    windowOpen: vi.fn<AnnouncementDeps["windowOpen"]>(overrides.windowOpen ?? (async () => true)),
    optedOut: vi.fn<AnnouncementDeps["optedOut"]>(overrides.optedOut ?? (async () => false)),
    hasFeature: vi.fn<AnnouncementDeps["hasFeature"]>(overrides.hasFeature ?? (async () => false)),
    language: vi.fn<AnnouncementDeps["language"]>(overrides.language ?? (async () => "it")),
    send: vi.fn<AnnouncementDeps["send"]>(overrides.send ?? (async () => ({ ok: true }))),
    recordInHistory: vi.fn<AnnouncementDeps["recordInHistory"]>(
      overrides.recordInHistory ?? (async () => true),
    ),
    log: logger,
  } satisfies AnnouncementDeps;
}

describe("announcement input", () => {
  const valid = { id: "granola-1", texts: { it: "Ciao", en: "Hi" }, feature: "granola" };

  it("needs a slug id and at least Italian and English, and trims the texts", () => {
    expect(parseAnnouncementInput({ ...valid, texts: { it: " Ciao ", en: "Hi" } }, NOW)).toEqual({
      ok: true,
      dryRun: false,
      announcement: {
        id: "granola-1",
        texts: { it: "Ciao", en: "Hi" },
        feature: "granola",
        createdAtMs: NOW,
      },
    });
    for (const body of [
      { ...valid, id: "Not A Slug" },
      { ...valid, texts: { it: "Ciao" } },
      { ...valid, texts: { it: "Ciao", en: "  " } },
      { ...valid, texts: { it: "Ciao", en: "Hi", pt: "Oi" } },
      { ...valid, feature: "unknown-feature" },
      null,
    ]) {
      expect(parseAnnouncementInput(body, NOW).ok).toBe(false);
    }
    expect(
      parseAnnouncementInput({ ...valid, feature: undefined, dryRun: true }, NOW),
    ).toMatchObject({
      ok: true,
      dryRun: true,
      announcement: { feature: null },
    });
  });
});

describe("delivery dedupe", () => {
  it("sends each number at most once, however often the announcement is run", async () => {
    await registry.saveAnnouncement(GRANOLA);
    const deps = makeDeps();
    const recipients = [recipient(PAOLO), recipient(ANNA)];
    const first = await deliverToRecipients(deps, GRANOLA, recipients);
    const second = await deliverToRecipients(deps, GRANOLA, recipients);
    expect(first.map(({ outcome }) => outcome.status)).toEqual(["sent", "sent"]);
    expect(second.map(({ outcome }) => outcome.status)).toEqual(["sent", "sent"]);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(await registry.listAnnouncementDeliveries()).toHaveLength(2);
  });

  it("does not send twice when two passes race for the same number", async () => {
    const deps = makeDeps();
    const [a, b] = await Promise.all([
      deliverAnnouncement(deps, GRANOLA, recipient(PAOLO), undefined),
      deliverAnnouncement(deps, GRANOLA, recipient(PAOLO), undefined),
    ]);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect([a.status, b.status].toSorted()).toEqual(["pending", "sent"]);
  });

  it("frees the claim when the send fails, so the number is tried again", async () => {
    const deps = makeDeps();
    deps.send.mockResolvedValueOnce({ ok: false, error: "boom" });
    const failed = await deliverAnnouncement(deps, GRANOLA, recipient(PAOLO), undefined);
    expect(failed).toMatchObject({ status: "pending", reason: "send_failed" });
    expect(await registry.listAnnouncementDeliveries()).toEqual([]);
    deps.send.mockResolvedValue({ ok: true });
    const retried = await deliverAnnouncement(deps, GRANOLA, recipient(PAOLO), undefined);
    expect(retried.status).toBe("sent");
  });

  it("keeps announcements and deliveries out of the copy the lawyer adopts from the registry", async () => {
    await registry.saveAnnouncement(GRANOLA);
    await deliverAnnouncement(makeDeps(), GRANOLA, recipient(PAOLO), undefined);
    const dir = tempDirs.make("ada-announcements-copy-");
    await registry.exportSnapshot(path.join(dir, "copy.sqlite"));
    const copy = realStore(dir, "copy");
    expect(await copy.listAnnouncements()).toEqual([]);
    expect(await copy.listAnnouncementDeliveries()).toEqual([]);
  });

  it("never overwrites an announcement that exists", async () => {
    expect(await registry.saveAnnouncement(GRANOLA)).toBe(true);
    expect(await registry.saveAnnouncement({ ...GRANOLA, texts: { it: "x", en: "y" } })).toBe(
      false,
    );
    expect((await registry.listAnnouncements())[0]?.texts.it).toBe(GRANOLA.texts.it);
  });
});

describe("the 24-hour window", () => {
  it("keeps a number outside its window pending, sends nothing, and delivers after its next answer", async () => {
    await registry.saveAnnouncement(GRANOLA);
    const deps = makeDeps({ windowOpen: vi.fn(async () => false) });
    const [held] = await deliverToRecipients(deps, GRANOLA, [recipient(PAOLO)]);
    expect(held?.outcome).toMatchObject({ status: "pending", reason: "window_closed" });
    expect(deps.send).not.toHaveBeenCalled();
    expect(await registry.listAnnouncementDeliveries()).toEqual([]);

    deps.windowOpen.mockResolvedValue(true);
    await releasePendingAnnouncement(deps, recipient(PAOLO));
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(PAOLO, GRANOLA.texts.it);

    await releasePendingAnnouncement(deps, recipient(PAOLO));
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("hands a number at most one announcement per answer, oldest first", async () => {
    const second: Announcement = { ...GRANOLA, id: "second", feature: null, createdAtMs: NOW };
    await registry.saveAnnouncement(GRANOLA);
    await registry.saveAnnouncement(second);
    const deps = makeDeps();
    await releasePendingAnnouncement(deps, recipient(PAOLO));
    expect(deps.send).toHaveBeenCalledTimes(1);
    await releasePendingAnnouncement(deps, recipient(PAOLO));
    expect(deps.send).toHaveBeenCalledTimes(2);
    await releasePendingAnnouncement(deps, recipient(PAOLO));
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect((await registry.listAnnouncementDeliveries()).map((row) => row.announcementId)).toEqual([
      "granola",
      "second",
    ]);
  });

  it("derives the window from the number's last inbound message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const deps = liveAnnouncementDeps({ logger } as never);
      expect(await deps.windowOpen(PAOLO)).toBe(false);
      recordSenderInbound(PAOLO, NOW - 23 * HOUR);
      expect(await deps.windowOpen(PAOLO)).toBe(true);
      recordSenderInbound(ANNA, NOW - 25 * HOUR);
      expect(await deps.windowOpen(ANNA)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("language", () => {
  it("uses the language of the number's latest message and falls back to Italian", async () => {
    const live = liveAnnouncementDeps({ logger } as never);
    recordInboundLanguage(
      PAOLO,
      "Hello Ada, could you please check what is on my calendar for tomorrow morning?",
    );
    expect(await live.language(PAOLO)).toBe("en");
    expect(resolveAnnouncementText(GRANOLA, await live.language(PAOLO))).toBe(GRANOLA.texts.en);
    expect(resolveAnnouncementText(GRANOLA, "es")).toBe(GRANOLA.texts.es);
    expect(resolveAnnouncementText(GRANOLA, "fr")).toBe(GRANOLA.texts.it);
    expect(await live.language(ANNA)).toBe("it");
  });

  it("sends the text in that language and never signs it", async () => {
    const signed: Announcement = {
      ...GRANOLA,
      texts: { it: "Ciao.\n\n— Ada", en: "Hello there.\n\n— Ada" },
    };
    const deps = makeDeps({ language: vi.fn(async () => "en" as const) });
    await deliverAnnouncement(deps, signed, recipient(PAOLO), undefined);
    expect(deps.send).toHaveBeenCalledWith(PAOLO, "Hello there.");
  });
});

describe("conversation history", () => {
  it("writes the sent text into the number's own session as an assistant message", async () => {
    const live = liveAnnouncementDeps({ logger } as never);
    expect(await live.recordInHistory(recipient(PAOLO), "granola", "Want the link?")).toBe(true);
    expect(mocks.append).toHaveBeenCalledWith({
      sessionKey: `agent:main:kapso-whatsapp:direct:${PAOLO}`,
      sessionId: `session-${PAOLO}`,
      text: "Want the link?",
      idempotencyKey: "ada-announcement:granola",
      updateMode: "none",
    });
  });

  it("records exactly the text that was sent, after the send", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      send: vi.fn(async () => {
        order.push("send");
        return { ok: true };
      }),
      recordInHistory: vi.fn(async () => {
        order.push("history");
        return true;
      }),
    });
    const outcome = await deliverAnnouncement(deps, GRANOLA, recipient(PAOLO), undefined);
    expect(order).toEqual(["send", "history"]);
    expect(deps.recordInHistory).toHaveBeenCalledWith(
      recipient(PAOLO),
      "granola",
      GRANOLA.texts.it,
    );
    expect(outcome).toMatchObject({ status: "sent", recordedInHistory: true });
  });

  it("keeps the delivery and reports it when the history write fails", async () => {
    const deps = makeDeps({
      recordInHistory: vi.fn(async () => {
        throw new Error("no session");
      }),
    });
    const outcome = await deliverAnnouncement(deps, GRANOLA, recipient(PAOLO), undefined);
    expect(outcome).toMatchObject({ status: "sent", recordedInHistory: false });
    expect(await registry.listAnnouncementDeliveries()).toHaveLength(1);
  });
});

describe("opting out of news", () => {
  it("skips a number that saved announcements_off through ada_set_preference, for good", async () => {
    const memory = realStore(tempDirs.make("ada-announcements-paolo-"), "memory");
    mocks.memories.set(PAOLO, memory);
    mocks.memories.set(ANNA, realStore(tempDirs.make("ada-announcements-anna-"), "memory"));
    await executeAdaSetPreference(
      { logger, runtimeSource: "/fake/index.ts", runtime: {}, config: {} } as never,
      PAOLO,
      { key: ANNOUNCEMENTS_OFF_KEY, text: "Does not want product news." },
    );
    const live = liveAnnouncementDeps({ logger } as never);
    const deps = makeDeps({ optedOut: live.optedOut });
    const results = await deliverToRecipients(deps, GRANOLA, [recipient(PAOLO), recipient(ANNA)]);
    expect(results.map(({ outcome }) => [outcome.status, outcome.reason])).toEqual([
      ["skipped", "announcements_off"],
      ["sent", null],
    ]);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(ANNA, GRANOLA.texts.it);
    await releasePendingAnnouncement(deps, recipient(PAOLO));
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
});

describe("a feature the number already has", () => {
  it("skips an announcement about Granola for a number with Granola connected", async () => {
    mocks.granola.add(PAOLO);
    const live = liveAnnouncementDeps({ logger } as never);
    const deps = makeDeps({ hasFeature: live.hasFeature });
    const results = await deliverToRecipients(deps, GRANOLA, [recipient(PAOLO), recipient(ANNA)]);
    expect(results.map(({ outcome }) => [outcome.status, outcome.reason])).toEqual([
      ["skipped", "feature_connected"],
      ["sent", null],
    ]);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(ANNA, GRANOLA.texts.it);
  });

  it("does not look at features for an announcement that is not about one", async () => {
    const deps = makeDeps();
    await deliverAnnouncement(deps, { ...GRANOLA, feature: null }, recipient(PAOLO), undefined);
    expect(deps.hasFeature).not.toHaveBeenCalled();
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
});

describe("the dry run", () => {
  it("resolves each number's text and sends and records nothing", async () => {
    const deps = makeDeps({
      language: vi.fn(async (owner: string) =>
        owner === PAOLO ? ("en" as const) : ("it" as const),
      ),
      windowOpen: vi.fn(async (owner: string) => owner === PAOLO),
    });
    const results = await deliverToRecipients(deps, GRANOLA, [recipient(PAOLO), recipient(ANNA)], {
      dryRun: true,
    });
    expect(results.map(({ outcome }) => [outcome.status, outcome.language, outcome.text])).toEqual([
      ["would_send", "en", GRANOLA.texts.en],
      ["pending", "it", GRANOLA.texts.it],
    ]);
    expect(deps.send).not.toHaveBeenCalled();
    expect(await registry.listAnnouncementDeliveries()).toEqual([]);
  });
});

describe("release after the answer", () => {
  type MessageSent = (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<void>;

  async function setup() {
    await registry.saveAnnouncement({ ...GRANOLA, feature: null });
    let handler: MessageSent | undefined;
    const api = {
      logger,
      config: {},
      runtimeSource: "/fake/index.ts",
      runtime: {
        agent: {
          session: { getSessionEntryAsync: async () => ({ sessionId: `session-${PAOLO}` }) },
        },
      },
      on: (name: string, fn: MessageSent) => {
        if (name === "message_sent") {
          handler = fn;
        }
      },
    };
    registerAnnouncementRelease(api as never);
    const sessionKey = `agent:main:kapso-whatsapp:direct:${PAOLO}`;
    const fire = (event: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) =>
      handler?.(
        { to: `+${PAOLO}`, content: "answer", success: true, runId: "run-1", sessionKey, ...event },
        { channelId: "kapso-whatsapp", ...ctx },
      );
    return { fire };
  }

  it("delivers a pending announcement once the number's answer went out, and writes it to history", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime(NOW);
      recordSenderInbound(PAOLO, NOW - 1000);
      const { fire } = await setup();
      await fire();
      await fire();
      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_SETTLE_MS);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.send).toHaveBeenCalledWith({
        api: expect.anything(),
        to: `+${PAOLO}`,
        text: GRANOLA.texts.it,
      });
      expect(mocks.append).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: `session-${PAOLO}`, text: GRANOLA.texts.it }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the last message of an answer that is several WhatsApp messages", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime(NOW);
      recordSenderInbound(PAOLO, NOW - 1000);
      const { fire } = await setup();
      await fire({ content: "first part" });
      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_SETTLE_MS - 1000);
      expect(mocks.send).not.toHaveBeenCalled();
      await fire({ content: "second part" });
      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_SETTLE_MS - 1000);
      expect(mocks.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for a failed send, a message with no run, or another channel", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime(NOW);
      recordSenderInbound(PAOLO, NOW - 1000);
      const { fire } = await setup();
      await fire({ success: false });
      await fire({ runId: undefined });
      await fire({}, { channelId: "telegram" });
      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_SETTLE_MS);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listAnnouncementRecipients", () => {
  it("lists each agent's sessions, one per WhatsApp number, the most recent first", () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = {
      agent: {
        session: {
          listSessionEntries: (params: Record<string, unknown>) => {
            calls.push(params);
            if (!params.agentId) {
              throw new Error("Cannot resolve SQLite session scope without an agent id");
            }
            return [
              {
                sessionKey: `agent:main:kapso-whatsapp:direct:${PAOLO}`,
                entry: { sessionId: "old", updatedAt: 1 },
              },
              {
                sessionKey: `agent:main:kapso-whatsapp:direct:${PAOLO}`,
                entry: { sessionId: "new", updatedAt: 2 },
              },
              { sessionKey: "agent:main:telegram:direct:393330000000", entry: { sessionId: "t" } },
            ];
          },
        },
      },
    };
    const recipients = listAnnouncementRecipients({ runtime, config: {} } as never);
    expect(calls).toEqual([{ agentId: "main", readOnly: true, includeParticipants: false }]);
    expect(recipients).toEqual([
      { owner: PAOLO, sessionKey: `agent:main:kapso-whatsapp:direct:${PAOLO}`, sessionId: "new" },
    ]);
  });
});
