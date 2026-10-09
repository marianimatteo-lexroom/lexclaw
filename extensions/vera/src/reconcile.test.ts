import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "./memory-contract.js";
import { applyReconcileEdits, buildDailyTimelineRecord } from "./reconcile.js";

describe("reconcile edits", () => {
  it("writes a correction and keeps the previous body for history via upsert", async () => {
    const store = new Map<string, MemoryRecord>();
    const revisions: Array<{ previousBody: string; reason: string }> = [];
    const current: MemoryRecord = {
      id: "fact-1",
      matterId: "rossi",
      folder: "knowledge/facts",
      type: "fact",
      title: "Fee",
      aliases: ["fee"],
      body: "- Fee was 100",
      validFromMs: 1,
      validToMs: null,
      supersededBy: null,
    };
    store.set("rossi:fact-1", current);

    const result = await applyReconcileEdits({
      atMs: 50,
      edits: [
        {
          kind: "supersede",
          id: "fact-1",
          matterId: "rossi",
          replacementBody: "- Fee was 100; corrected to 120 on 2026-10-06",
          atMs: 50,
        },
      ],
      getRecord: async (id, matterId) => store.get(`${matterId}:${id}`) ?? null,
      upsertRecord: async (record, reason) => {
        const key = `${record.matterId}:${record.id}`;
        const previous = store.get(key);
        if (previous && reason === "correction") {
          revisions.push({ previousBody: previous.body, reason });
        }
        store.set(key, record);
      },
      upsertTodo: async () => {},
    });

    expect(result.applied).toBe(1);
    expect(store.get("rossi:fact-1")?.body).toContain("corrected to 120");
    expect(revisions[0]?.previousBody).toBe("- Fee was 100");
    expect(buildDailyTimelineRecord({
      matterId: "rossi",
      day: "2026-10-06",
      body: "- Open loops: none",
      atMs: 50,
    }).folder).toBe("timeline/daily");
  });
});
