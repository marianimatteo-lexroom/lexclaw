import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "./memory.js";

const registry = vi.hoisted(() => ({ store: undefined as undefined | MemoryStore }));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaRegistryFromApi: async () => {
    if (!registry.store) {
      throw new Error("no registry");
    }
    return registry.store;
  },
}));

import { executeAdaReportFeedback, feedbackView } from "./feedback.js";
import { FEEDBACK_MAX_TEXT_CHARS } from "./memory-contract.js";
import { realStore } from "./preference-test-support.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const api = { logger, runtimeSource: "/fake/index.ts", runtime: {}, config: {} } as never;
const PAOLO = "393331111111";
const ANNA = "393332222222";
const NOW = new Date("2026-10-19T08:00:00.000Z");

beforeEach(() => {
  clearInboundLanguages();
  registry.store = realStore(tempDirs.make("ada-feedback-"), "memory");
});

describe("ada_report_feedback", () => {
  it("logs the report with number, time, category, text and language, and says it was passed on", async () => {
    recordInboundLanguage(
      PAOLO,
      "Ada, la risposta sulla prescrizione era sbagliata, non è quello che ho chiesto",
    );
    const result = await executeAdaReportFeedback(
      api,
      PAOLO,
      { category: "wrong_answer", text: "  The limitation answer\n was wrong. " },
      NOW,
    );
    expect(result).toEqual({ ok: true, passedToTeam: true });
    expect(await registry.store?.listFeedback(0)).toEqual([
      {
        id: 1,
        number: PAOLO,
        atMs: NOW.getTime(),
        category: "wrong_answer",
        text: "The limitation answer was wrong.",
        language: "it",
        status: "new",
      },
    ]);
  });

  it("keeps reports of different numbers apart by number, in one log for the team", async () => {
    await executeAdaReportFeedback(api, PAOLO, { category: "bug", text: "Link broken." }, NOW);
    await executeAdaReportFeedback(api, ANNA, { category: "complaint", text: "Too slow." }, NOW);
    const entries = (await registry.store?.listFeedback(0)) ?? [];
    expect(entries.map((entry) => [entry.number, entry.category])).toEqual([
      [PAOLO, "bug"],
      [ANNA, "complaint"],
    ]);
  });

  it("refuses an empty or over-long report, and a store failure is reported without its cause", async () => {
    expect(
      await executeAdaReportFeedback(api, PAOLO, { category: "bug", text: " " }, NOW),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await executeAdaReportFeedback(
        api,
        PAOLO,
        { category: "bug", text: "x".repeat(FEEDBACK_MAX_TEXT_CHARS + 1) },
        NOW,
      ),
    ).toMatchObject({ ok: false });
    expect(await registry.store?.listFeedback(0)).toEqual([]);
    registry.store = undefined;
    const failed = await executeAdaReportFeedback(
      api,
      PAOLO,
      { category: "bug", text: "Broken." },
      NOW,
    );
    expect(failed).toEqual({ ok: false, error: "Ada could not record the feedback." });
  });

  it("shows only the last four digits and a stable hash of the number", () => {
    const entry = {
      id: 7,
      number: PAOLO,
      atMs: NOW.getTime(),
      category: "bug" as const,
      text: "Broken.",
      language: "",
      status: "new" as const,
    };
    const view = feedbackView(entry);
    expect(view).toMatchObject({ id: 7, numberLast4: "1111", language: null, status: "new" });
    expect(view.numberHash).toMatch(/^[0-9a-f]{12}$/u);
    expect(feedbackView({ ...entry, id: 8 }).numberHash).toBe(view.numberHash);
    expect(feedbackView({ ...entry, number: ANNA }).numberHash).not.toBe(view.numberHash);
    expect(JSON.stringify(view)).not.toContain(PAOLO);
  });
});
