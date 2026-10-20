import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./memory.js", () => ({
  openAdaMemoryFromApi: vi.fn(),
  openAdaMemoryIfExistsFromApi,
  openAdaRegistryFromApi: vi.fn(),
}));

import {
  clearHeldGranolaReminders,
  releaseHeldGranolaReminder,
  remindGranolaReconnect,
  runGranolaKeepAlive,
} from "./granola-reminder.js";
import {
  ANNA,
  BRUNO,
  GRANOLA_PLUGIN_CONFIG,
  newMockGranola,
  openGranolaTestDb,
  signInThroughFlow,
} from "./granola-test-support.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { recordSenderInbound } from "./research-push.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = new Date("2026-10-20T09:00:00.000Z");
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

async function setup() {
  const mock = newMockGranola();
  const store = openGranolaTestDb(tempDirs.make("ada-granola-reminder-"));
  const sent: Array<{ to: string; text: string }> = [];
  const api = {
    runtimeSource: "/fake/ada/index.ts",
    config: {},
    pluginConfig: GRANOLA_PLUGIN_CONFIG,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (params: { to: string; text: string }) => {
              sent.push({ to: params.to, text: params.text });
            },
          }),
        },
      },
    },
  } as never;
  await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now: NOW });
  await signInThroughFlow({ mock, db: store.db, owner: BRUNO, user: "bruno", now: NOW });
  return { mock, store, sent, api };
}

beforeEach(() => {
  clearHeldGranolaReminders();
  clearInboundLanguages();
});

describe("Granola keep-alive and reconnect reminder", () => {
  it("renews tokens that would expire before the next poll, and leaves fresh ones alone", async () => {
    const { mock, store, api, sent } = await setup();
    const anna = await store.db.readAccount(ANNA);
    await runGranolaKeepAlive(api, at(HOUR - 10 * 60_000), { db: store.db, fetchImpl: mock.fetch });
    expect(mock.refreshes).toBe(2);
    expect((await store.db.readAccount(ANNA))?.accessToken).not.toBe(anna?.accessToken);
    await runGranolaKeepAlive(api, at(HOUR - 5 * 60_000), { db: store.db, fetchImpl: mock.fetch });
    expect(mock.refreshes).toBe(2);
    expect(sent).toEqual([]);
  });

  it("sends one reminder with a fresh short link to the number whose refresh failed for good", async () => {
    const { mock, store, api, sent } = await setup();
    mock.refreshFailure = "invalid_grant";
    await runGranolaKeepAlive(api, at(HOUR), { db: store.db, fetchImpl: mock.fetch });
    expect(sent).toHaveLength(2);
    expect(sent.map((message) => message.to).toSorted()).toEqual([`+${ANNA}`, `+${BRUNO}`]);
    for (const message of sent) {
      expect(message.text).toContain("Il collegamento a Granola è scaduto");
      expect(message.text).toMatch(/https:\/\/vera\.example\/gr\/[A-Za-z0-9_-]{10}/u);
      expect(message.text).not.toContain("oauth2/authorize");
    }
    expect(sent[0]?.text).not.toBe(sent[1]?.text);
    expect(await store.db.listOwners()).toEqual([]);
  });

  it("writes the reminder in the language of the latest message", async () => {
    const { mock, store, api, sent } = await setup();
    recordInboundLanguage(
      ANNA,
      "Hello, could you please tell me what the notes said about the call?",
    );
    mock.refreshFailure = "invalid_grant";
    await runGranolaKeepAlive(api, at(HOUR), { db: store.db, fetchImpl: mock.fetch });
    const forAnna = sent.find((message) => message.to === `+${ANNA}`);
    expect(forAnna?.text).toContain("The Granola connection expired");
  });

  it("does not remind about a refresh that only failed for now", async () => {
    const { mock, api, sent, store } = await setup();
    mock.refreshFailure = "server_error";
    await runGranolaKeepAlive(api, at(HOUR), { db: store.db, fetchImpl: mock.fetch });
    expect(sent).toEqual([]);
    expect(await store.db.listOwners()).toEqual([ANNA, BRUNO]);
  });

  it("sends at most one reminder a day to one number", async () => {
    const { mock, store, api, sent } = await setup();
    const remind = (offsetMs: number) =>
      remindGranolaReconnect(api, store.db, ANNA, at(offsetMs), { fetchImpl: mock.fetch });
    expect(await remind(0)).toBe("sent");
    expect(await remind(HOUR)).toBe("skipped");
    expect(await remind(23 * HOUR)).toBe("skipped");
    expect(sent).toHaveLength(1);
    expect(await remind(24 * HOUR)).toBe("sent");
    expect(sent).toHaveLength(2);
    // Another number has its own day.
    expect(
      await remindGranolaReconnect(api, store.db, BRUNO, at(25 * HOUR), { fetchImpl: mock.fetch }),
    ).toBe("sent");
    expect(sent.at(-1)?.to).toBe(`+${BRUNO}`);
  });

  it("keeps the reminder for the next message when the WhatsApp window is closed", async () => {
    const { mock, store, api, sent } = await setup();
    recordSenderInbound(ANNA, NOW.getTime() - 30 * HOUR);
    expect(await remindGranolaReconnect(api, store.db, ANNA, NOW, { fetchImpl: mock.fetch })).toBe(
      "held",
    );
    expect(sent).toEqual([]);

    // She writes: the reminder goes out once, with a link made now, and is not repeated.
    await releaseHeldGranolaReminder(api, ANNA, at(2 * HOUR).getTime(), {
      db: store.db,
      fetchImpl: mock.fetch,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`+${ANNA}`);
    await releaseHeldGranolaReminder(api, ANNA, at(3 * HOUR).getTime(), {
      db: store.db,
      fetchImpl: mock.fetch,
    });
    expect(sent).toHaveLength(1);
    await releaseHeldGranolaReminder(api, BRUNO, at(3 * HOUR).getTime(), {
      db: store.db,
      fetchImpl: mock.fetch,
    });
    expect(sent).toHaveLength(1);
  });

  it("holds the reminder when the send fails, and keeps it for the next message", async () => {
    const { mock, store, api, sent } = await setup();
    const failing = {
      ...(api as object),
      runtime: {
        channel: {
          outbound: {
            loadAdapter: async () => ({
              sendText: async () => {
                throw new Error("down");
              },
            }),
          },
        },
      },
    } as never;
    expect(
      await remindGranolaReconnect(failing, store.db, ANNA, NOW, { fetchImpl: mock.fetch }),
    ).toBe("held");
    await releaseHeldGranolaReminder(api, ANNA, at(HOUR).getTime(), {
      db: store.db,
      fetchImpl: mock.fetch,
    });
    expect(sent).toHaveLength(1);
  });
});
