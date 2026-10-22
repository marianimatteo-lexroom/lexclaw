import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realStore } from "./preference-test-support.js";
import { claimRequestTemplate } from "./proactive-store.js";

const memoryStore = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryIfExistsFromApi: async () => memoryStore.current,
}));

import { lastInboundOf, livePushDeps, recordSenderInbound } from "./research-push.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("the request-ready template is claimed once per closed window", () => {
  it("is not sent for a held result when a reminder or watched reply already used this window's template, and is again after the number writes", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "w" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    const HOUR = 3_600_000;
    const T0 = Date.parse("2026-10-27T10:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    try {
      const store = realStore(tempDirs.make("ada-research-claim-"), "owner");
      memoryStore.current = store;
      await store.writeWake({ lastLawyerInboundAtMs: T0 - 30 * HOUR });
      const A = "390000000001";
      const deps = livePushDeps(
        {
          config: {
            channels: {
              "kapso-whatsapp": {
                apiKey: "kapso_test_key",
                phoneNumberId: "100000000000000",
                baseUrl: "https://api.kapso.ai/meta/whatsapp/",
              },
            },
          },
          pluginConfig: { requestReadyTemplate: { name: "ada_request_ready", language: "it" } },
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        } as unknown as Parameters<typeof livePushDeps>[0],
        vi.fn(),
        A,
      );
      // A held reminder already took the template of this closed window.
      await claimRequestTemplate(store, T0 - 30 * HOUR, T0);
      expect(await deps.nudge()).toBe("skipped");
      expect(fetchImpl).not.toHaveBeenCalled();

      // The number writes, and a day later that window has closed too.
      await store.writeWake({ lastLawyerInboundAtMs: T0 + HOUR });
      vi.setSystemTime(T0 + 30 * HOUR);
      expect(await deps.nudge()).toBe("sent");
      expect(await deps.nudge()).toBe("skipped");
      expect(fetchImpl).toHaveBeenCalledOnce();

      // Two paths asking at the same moment for a fresh closed window: one claim, one template.
      fetchImpl.mockClear();
      await store.writeWake({ lastLawyerInboundAtMs: T0 + 31 * HOUR });
      vi.setSystemTime(T0 + 60 * HOUR);
      const both = await Promise.all([deps.nudge(), deps.nudge()]);
      expect(both.toSorted()).toEqual(["sent", "skipped"]);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      memoryStore.current = null;
      vi.unstubAllGlobals();
    }
  });
});

describe("the request-ready template only reopens a closed window", () => {
  it("is not sent, and nothing is claimed, when a text failed inside an open window", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "w" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const store = realStore(tempDirs.make("ada-research-open-"), "owner");
      memoryStore.current = store;
      await store.writeWake({ lastLawyerInboundAtMs: Date.now() - 60_000 });
      const deps = livePushDeps(
        {
          config: {
            channels: {
              "kapso-whatsapp": {
                apiKey: "kapso_test_key",
                phoneNumberId: "100000000000000",
                baseUrl: "https://api.kapso.ai/meta/whatsapp/",
              },
            },
          },
          pluginConfig: { requestReadyTemplate: { name: "ada_request_ready", language: "it" } },
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        } as unknown as Parameters<typeof livePushDeps>[0],
        vi.fn(),
        "390000000001",
      );
      expect(await deps.nudge()).toBe("skipped");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await store.listProactive("marker")).toEqual([]);
    } finally {
      memoryStore.current = null;
      vi.unstubAllGlobals();
    }
  });
});

describe("when a number last wrote", () => {
  it("is the later of this process's record and the stored one, so a first message counts before any memory file exists", async () => {
    expect(lastInboundOf("390000000077", null)).toBeNull();
    expect(lastInboundOf("390000000077", 500)).toBe(500);
    recordSenderInbound("390000000077", 900);
    expect(lastInboundOf("390000000077", null)).toBe(900);
    expect(lastInboundOf("390000000077", 500)).toBe(900);
    expect(lastInboundOf("390000000077", 1200)).toBe(1200);
    const deps = livePushDeps(
      {
        config: {},
        pluginConfig: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as unknown as Parameters<typeof livePushDeps>[0],
      vi.fn(),
      "390000000077",
    );
    recordSenderInbound("390000000077", Date.now() - 1000);
    expect(await deps.windowOpen()).toBe(true);
  });
});
