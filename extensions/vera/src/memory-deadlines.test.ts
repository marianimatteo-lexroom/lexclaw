import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { openTestMemory } from "./deadline-test-support.js";
import type { DeadlineCandidate } from "./memory-contract.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DAY_MS = 24 * 60 * 60 * 1000;

function open() {
  return openTestMemory(tempDirs.make("vera-deadlines-"));
}

function candidate(overrides: Partial<DeadlineCandidate> = {}): DeadlineCandidate {
  return {
    matterId: "rossi",
    type: "hearing",
    title: "Avviso di udienza R.G. 1234/2026",
    dueAtMs: Date.parse("2026-11-12T08:30:00.000Z"),
    dueDate: "2026-11-12",
    dueTime: "09:30",
    timeZone: "Europe/Rome",
    confidence: 0.9,
    source: {
      kind: "email",
      ref: "msg-1",
      label: "Cancelleria: avviso",
      excerpt: "udienza 12 novembre",
    },
    ...overrides,
  };
}

function onDate(dueDate: string, overrides: Partial<DeadlineCandidate> = {}): DeadlineCandidate {
  return candidate({ dueDate, dueAtMs: Date.parse(`${dueDate}T08:30:00.000Z`), ...overrides });
}

describe("vera deadline memory", () => {
  it("stores one item per matter, type, and date across sources and keeps the lawyer's choice", async () => {
    const { memory, close } = open();
    try {
      const first = await memory.upsertDeadlines([candidate()], 1000);
      expect(first.created).toHaveLength(1);
      const id = first.created[0]?.id ?? "";
      await memory.updateDeadline(id, { status: "tracked", remindersSent: ["7d"] }, 1500);

      const calendar = candidate({
        confidence: 0.95,
        source: {
          kind: "calendar",
          ref: "evt-1",
          label: "Udienza Rossi",
          excerpt: "Udienza Rossi",
        },
      });
      const second = await memory.upsertDeadlines([calendar, candidate()], 2000);
      expect(second.created).toEqual([]);
      expect(second.updated).toHaveLength(1);

      const items = await memory.listDeadlines();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id,
        status: "tracked",
        remindersSent: ["7d"],
        confidence: 0.95,
      });
      expect(items[0]?.sources.map((source) => source.kind)).toEqual(["email", "calendar"]);
    } finally {
      close();
    }
  });

  it("keeps matters and types apart and learns a time the first source lacked", async () => {
    const { memory, close } = open();
    try {
      await memory.upsertDeadlines(
        [
          candidate({ dueTime: null, dueAtMs: Date.parse("2026-11-12T08:00:00.000Z") }),
          candidate({ matterId: "bianchi" }),
          candidate({ type: "deadline" }),
        ],
        1000,
      );
      expect(await memory.listDeadlines()).toHaveLength(3);
      await memory.upsertDeadlines([candidate()], 2000);
      const hearing = (await memory.listDeadlines("rossi")).find((item) => item.type === "hearing");
      expect(hearing).toMatchObject({
        dueTime: "09:30",
        dueAtMs: Date.parse("2026-11-12T08:30:00.000Z"),
      });
    } finally {
      close();
    }
  });

  it("follows a calendar event that only changes time within the same day", async () => {
    const { memory, close } = open();
    try {
      const calendar = candidate({
        source: {
          kind: "calendar",
          ref: "evt-1",
          label: "Udienza Rossi",
          excerpt: "Udienza Rossi",
        },
        movesFrom: { sourceRef: "evt-1" },
      });
      await memory.upsertDeadlines([calendar], 1000);
      const later = await memory.upsertDeadlines(
        [{ ...calendar, dueTime: "11:00", dueAtMs: Date.parse("2026-11-12T10:00:00.000Z") }],
        2000,
      );
      expect(later.moved).toEqual([]);
      expect(later.updated[0]).toMatchObject({
        dueDate: "2026-11-12",
        dueTime: "11:00",
        dueAtMs: Date.parse("2026-11-12T10:00:00.000Z"),
      });
      expect(await memory.listDeadlines()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("moves a tracked item when its calendar event changes date and retires the old date", async () => {
    const { memory, close } = open();
    try {
      const calendar = candidate({
        source: {
          kind: "calendar",
          ref: "evt-1",
          label: "Udienza Rossi",
          excerpt: "Udienza Rossi",
        },
        movesFrom: { sourceRef: "evt-1" },
      });
      const created = (await memory.upsertDeadlines([calendar], 1000)).created[0];
      await memory.updateDeadline(created?.id ?? "", { status: "tracked" }, 1100);

      const moved = await memory.upsertDeadlines([{ ...calendar, ...onDate("2026-11-19") }], 2000);
      expect(moved.moved).toHaveLength(1);
      expect(moved.created).toEqual([]);
      expect(moved.moved[0]).toMatchObject({
        status: "tracked",
        dueDate: "2026-11-19",
        movedFromMs: Date.parse("2026-11-12T08:30:00.000Z"),
        remindersSent: [],
        offeredCount: 0,
      });
      expect(
        (await memory.listDeadlines()).map((item) => `${item.dueDate}:${item.status}`),
      ).toEqual(["2026-11-12:superseded", "2026-11-19:tracked"]);

      const stale = await memory.upsertDeadlines([candidate()], 3000);
      expect(stale.created).toEqual([]);
      expect(stale.moved).toEqual([]);
      expect(
        (await memory.listDeadlines()).filter((item) => item.status !== "superseded"),
      ).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("brings a retired date back when the calendar event moves back to it", async () => {
    const { memory, close } = open();
    try {
      const calendar = candidate({
        source: { kind: "calendar", ref: "evt-1", label: "Udienza Rossi", excerpt: "Udienza Rossi" },
        movesFrom: { sourceRef: "evt-1" },
      });
      const created = (await memory.upsertDeadlines([calendar], 1000)).created[0];
      await memory.updateDeadline(created?.id ?? "", { status: "tracked" }, 1100);
      await memory.upsertDeadlines([{ ...calendar, ...onDate("2026-11-19") }], 2000);
      const back = await memory.upsertDeadlines([calendar], 3000);
      expect(back.moved).toHaveLength(1);
      expect((await memory.listDeadlines()).map((item) => `${item.dueDate}:${item.status}`)).toEqual([
        "2026-11-12:tracked",
        "2026-11-19:superseded",
      ]);
    } finally {
      close();
    }
  });

  it("keeps a calendar time of day from overriding a time learned from mail", async () => {
    const { memory, close } = open();
    try {
      const calendar = candidate({
        dueTime: null,
        dueAtMs: Date.parse("2026-11-12T08:00:00.000Z"),
        source: { kind: "calendar", ref: "evt-1", label: "Udienza Rossi", excerpt: "Udienza Rossi" },
      });
      await memory.upsertDeadlines([calendar], 1000);
      await memory.upsertDeadlines([candidate()], 2000);
      await memory.upsertDeadlines([calendar], 3000);
      expect((await memory.listDeadlines())[0]).toMatchObject({ dueTime: "09:30" });
    } finally {
      close();
    }
  });

  it("never lets a late update revive a superseded row or drop settled reminders", async () => {
    const { memory, close } = open();
    try {
      const calendar = candidate({
        source: { kind: "calendar", ref: "evt-1", label: "Udienza Rossi", excerpt: "Udienza Rossi" },
        movesFrom: { sourceRef: "evt-1" },
      });
      const old = (await memory.upsertDeadlines([calendar], 1000)).created[0];
      const next = (await memory.upsertDeadlines([{ ...calendar, ...onDate("2026-11-19") }], 2000))
        .moved[0];
      const stale = await memory.updateDeadline(old?.id ?? "", { status: "tracked" }, 3000);
      expect(stale?.status).toBe("superseded");

      await memory.updateDeadline(next?.id ?? "", { status: "tracked", remindersSent: ["7d"] }, 3100);
      await memory.updateDeadline(next?.id ?? "", { remindersSent: [] }, 3200);
      expect((await memory.getDeadline(next?.id ?? ""))?.remindersSent).toEqual(["7d"]);
    } finally {
      close();
    }
  });

  it("moves by the old date named in a postponement notice, and by a lone open item", async () => {
    const { memory, close } = open();
    try {
      await memory.upsertDeadlines([candidate()], 1000);
      const named = await memory.upsertDeadlines(
        [
          onDate("2027-01-14", {
            source: { kind: "email", ref: "msg-2", label: "rinvio", excerpt: "rinviata" },
            movesFrom: { dueDate: "2026-11-12" },
            rescheduled: true,
          }),
        ],
        2000,
      );
      expect(named.moved).toHaveLength(1);

      const lone = await memory.upsertDeadlines(
        [
          onDate("2027-02-04", {
            source: { kind: "email", ref: "msg-3", label: "rinvio", excerpt: "rinviata" },
            rescheduled: true,
          }),
        ],
        3000,
      );
      expect(lone.moved).toHaveLength(1);
      expect(lone.moved[0]?.movedFromMs).toBe(Date.parse("2027-01-14T08:30:00.000Z"));
    } finally {
      close();
    }
  });

  it("does not guess which item moved when two are open", async () => {
    const { memory, close } = open();
    try {
      await memory.upsertDeadlines(
        [
          candidate(),
          onDate("2026-12-10", {
            source: { kind: "email", ref: "msg-9", label: "other", excerpt: "other" },
          }),
        ],
        1000,
      );
      const result = await memory.upsertDeadlines(
        [
          onDate("2027-01-14", {
            rescheduled: true,
            source: { kind: "email", ref: "msg-4", label: "rinvio", excerpt: "rinviata" },
          }),
        ],
        2000,
      );
      expect(result.created).toHaveLength(1);
      expect(result.moved).toEqual([]);
    } finally {
      close();
    }
  });

  it("does not revive a dismissed item when another source repeats it", async () => {
    const { memory, close } = open();
    try {
      const id = (await memory.upsertDeadlines([candidate()], 1000)).created[0]?.id ?? "";
      await memory.updateDeadline(id, { status: "dismissed" }, 1100);
      const again = await memory.upsertDeadlines(
        [
          candidate({
            confidence: 0.99,
            source: { kind: "pdf", ref: "msg-5#avviso.pdf", label: "pdf", excerpt: "udienza" },
          }),
        ],
        2000,
      );
      expect(again.created).toEqual([]);
      expect((await memory.getDeadline(id))?.status).toBe("dismissed");
    } finally {
      close();
    }
  });

  it("renumbers offers per delivered digest and settles the reminders it carried", async () => {
    const { memory, close } = open();
    try {
      const [a, b, c] = (
        await memory.upsertDeadlines(
          [
            candidate(),
            onDate("2026-11-20", { matterId: "bianchi" }),
            onDate("2026-11-25", { matterId: "verdi" }),
          ],
          1000,
        )
      ).created;
      const ids = { a: a?.id ?? "", b: b?.id ?? "", c: c?.id ?? "" };
      await memory.commitDeadlineDigest(
        [
          { id: ids.a, no: 1 },
          { id: ids.b, no: 2 },
        ],
        [],
        2000,
      );
      await memory.commitDeadlineDigest(
        [
          { id: ids.c, no: 1 },
          { id: ids.a, no: 2 },
        ],
        [{ id: ids.a, steps: ["7d", "2d"] }],
        3000,
      );
      const byId = new Map((await memory.listDeadlines()).map((item) => [item.id, item]));
      expect(byId.get(ids.a)).toMatchObject({
        offerNo: 2,
        offeredCount: 2,
        remindersSent: ["7d", "2d"],
      });
      expect(byId.get(ids.b)).toMatchObject({ offerNo: null, offeredCount: 1 });
      expect(byId.get(ids.c)).toMatchObject({ offerNo: 1, offeredCount: 1 });
    } finally {
      close();
    }
  });

  it("remembers scanned messages and forgets them after three weeks", async () => {
    const { memory, close } = open();
    try {
      await memory.markMessagesScanned(["m1", "m2"], 1000);
      expect(await memory.filterUnscannedMessages(["m1", "m3", "m2"])).toEqual(["m3"]);
      await memory.markMessagesScanned(["m4"], 1000 + 22 * DAY_MS);
      expect(await memory.filterUnscannedMessages(["m1", "m4"])).toEqual(["m1"]);
    } finally {
      close();
    }
  });

  it("rejects malformed candidates", async () => {
    const { memory, close } = open();
    try {
      await expect(
        memory.upsertDeadlines([candidate({ dueDate: "12/11/2026" })], 1000),
      ).rejects.toThrow("due date is invalid");
      await expect(
        memory.upsertDeadlines([candidate({ matterId: "bad matter!" })], 1000),
      ).rejects.toThrow("matterId is invalid");
    } finally {
      close();
    }
  });
});
