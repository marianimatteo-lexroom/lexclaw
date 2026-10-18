import { describe, expect, it } from "vitest";
import {
  buildInjectedBrief,
  renderLawyerProfile,
  renderMatterBrief,
  renderOpenLoopIndex,
} from "./brief.js";
import type { LawyerProfile, MemoryRecord, MemoryTodo } from "./memory-contract.js";

const PROFILE: LawyerProfile = {
  name: "Test Lawyer",
  timezone: "Europe/Rome",
  email: "lawyer@example.com",
  language: "it",
  jurisdiction: "IT",
  autonomy: "ask-first",
  channelStyle: "short",
  generatedAtMs: Date.parse("2026-10-10T08:30:00.000Z"),
};

function todo(overrides: Partial<MemoryTodo> & Pick<MemoryTodo, "id">): MemoryTodo {
  return {
    matterId: "matter-a",
    owner: "lawyer",
    title: `Todo ${overrides.id}`,
    status: "pending",
    detail: "",
    updatedAtMs: 1,
    ...overrides,
  };
}

function record(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    matterId: "matter-a",
    folder: "workstreams/active",
    type: "workstream",
    title: `Page ${overrides.id}`,
    aliases: [],
    body: `Body of ${overrides.id}`,
    validFromMs: 1,
    validToMs: null,
    supersededBy: null,
    ...overrides,
  };
}

describe("renderLawyerProfile", () => {
  it("lists the profile fields and a generation date", () => {
    expect(renderLawyerProfile(PROFILE).split("\n")).toEqual([
      "# Profile",
      "- Name: Test Lawyer",
      "- Timezone: Europe/Rome",
      "- Email: lawyer@example.com",
      "- Language: it",
      "- Jurisdiction: IT",
      "- Autonomy: ask-first",
      "- Channel style: short",
      "- Generated: 2026-10-10 (may lag up to a day)",
    ]);
  });

  it("omits the email line when the profile has none", () => {
    expect(renderLawyerProfile({ ...PROFILE, email: null })).not.toContain("Email");
  });

  it("clips an oversized profile to its budget with an ellipsis", () => {
    const text = renderLawyerProfile({ ...PROFILE, name: "N".repeat(5000) });
    expect(text).toHaveLength(1200);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("renderOpenLoopIndex", () => {
  it("says none when there are no open todos", () => {
    expect(renderOpenLoopIndex([])).toBe("# Open loops\n(none)");
    expect(renderOpenLoopIndex([todo({ id: "t1", status: "done" })])).toBe("# Open loops\n(none)");
  });

  it("lists open todos with id, matter, owner, status, and title; skips done", () => {
    const text = renderOpenLoopIndex([
      todo({ id: "t1", status: "in_progress", owner: "counterparty", matterId: "matter-b" }),
      todo({ id: "t2", status: "done" }),
      todo({ id: "t3" }),
    ]);
    expect(text.split("\n")).toEqual([
      "# Open loops",
      "- [t1] matter-b / counterparty / in_progress: Todo t1",
      "- [t3] matter-a / lawyer / pending: Todo t3",
    ]);
  });

  it("stays within its budget when many todos are open", () => {
    const todos = Array.from({ length: 100 }, (_, index) =>
      todo({ id: `t${index}`, title: "A fairly long open loop title for the budget" }),
    );
    const text = renderOpenLoopIndex(todos);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("[t40]");
  });
});

describe("renderMatterBrief", () => {
  it("renders the one-pager, at most two timeline notes, and only this matter's open todos", () => {
    const text = renderMatterBrief({
      matterId: "matter-a",
      onePager: record({ id: "one-pager", body: "Client wants a quick settlement." }),
      timeline: [
        record({ id: "day-3", title: "Day 3" }),
        record({ id: "day-2", title: "Day 2" }),
        record({ id: "day-1", title: "Day 1" }),
      ],
      todos: [
        todo({ id: "t1", detail: "Call the clerk." }),
        todo({ id: "t2", matterId: "matter-b" }),
        todo({ id: "t3", status: "done" }),
      ],
    });
    expect(text).toContain("# Matter matter-a");
    expect(text).toContain("## One-pager");
    expect(text).toContain("Client wants a quick settlement.");
    expect(text).toContain("## Day 3");
    expect(text).toContain("## Day 2");
    expect(text).not.toContain("Day 1");
    expect(text).toContain("## Todos");
    expect(text).toContain("- [t1] lawyer: Todo t1");
    expect(text).toContain("Call the clerk.");
    expect(text).not.toContain("t2");
    expect(text).not.toContain("t3");
  });

  it("falls back to just the heading when the matter has no memory", () => {
    expect(
      renderMatterBrief({ matterId: "matter-a", onePager: null, timeline: [], todos: [] }),
    ).toBe("# Matter matter-a");
  });

  it("clips todo detail and the whole brief", () => {
    const detailed = renderMatterBrief({
      matterId: "matter-a",
      onePager: null,
      timeline: [],
      todos: [todo({ id: "t1", detail: "D".repeat(1000) })],
    });
    expect(detailed).toContain(`${"D".repeat(399)}…`);
    expect(detailed).not.toContain("D".repeat(400));

    const huge = renderMatterBrief({
      matterId: "matter-a",
      onePager: record({ id: "one-pager", body: "B".repeat(9000) }),
      timeline: [],
      todos: [],
    });
    expect(huge).toHaveLength(4000);
    expect(huge.endsWith("…")).toBe(true);
  });
});

describe("buildInjectedBrief", () => {
  it("joins profile, open loops, and session id in that order", () => {
    const text = buildInjectedBrief({
      profile: PROFILE,
      todos: [todo({ id: "t1" })],
      sessionKey: "session-123",
    });
    const blocks = text.split("\n\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatch(/^# Profile/u);
    expect(blocks[1]).toMatch(/^# Open loops/u);
    expect(blocks[2]).toBe("# Session\n- id: session-123");
  });

  it("still returns the open loop index when the profile is missing", () => {
    expect(buildInjectedBrief({ profile: null, todos: [] })).toBe("# Open loops\n(none)");
  });

  it("appends one block per requested matter using its pages and todos", () => {
    const text = buildInjectedBrief({
      profile: null,
      todos: [todo({ id: "t1", matterId: "matter-a" })],
      matterIds: ["matter-a", "matter-unknown"],
      matterPages: new Map([
        [
          "matter-a",
          { onePager: record({ id: "one-pager", body: "Known matter." }), timeline: [] },
        ],
      ]),
    });
    expect(text).toContain("# Matter matter-a");
    expect(text).toContain("Known matter.");
    expect(text).toContain("# Matter matter-unknown");
  });
});
