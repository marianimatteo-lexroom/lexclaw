import { describe, expect, it } from "vitest";
import {
  numberDeadlineLines,
  planDigest,
  waitingCost,
  type DigestDeadlineInput,
  type DigestSignal,
} from "./digest.js";

const NOW = new Date("2026-10-14T05:40:00.000Z");

function line(
  id: string,
  due: string,
  overrides: Partial<DigestDeadlineInput> = {},
): DigestDeadlineInput {
  return {
    id,
    matterId: "rossi",
    matterLabel: "Rossi",
    type: "hearing",
    title: "Avviso di udienza",
    dueAt: `${due}T08:30:00.000Z`,
    due: `${due} 09:30`,
    daysLeft: 20,
    status: "candidate",
    confidence: 0.9,
    source: "Cancelleria",
    briefReady: false,
    ...overrides,
  };
}

const signal: DigestSignal = {
  matterId: "rossi",
  matterLabel: "Rossi",
  kind: "decision_waiting",
  summary: "Confirm tracking Hearing 2026-11-12 09:30",
  dueAt: "2026-11-12T08:30:00.000Z",
  needsDecision: true,
};

describe("planDigest with deadline lines", () => {
  it("numbers lines in the order given and writes the short reply actions", () => {
    const plan = planDigest([signal], NOW, [
      line("dl-a", "2026-11-12"),
      line("dl-b", "2026-11-20", { matterId: "verdi", matterLabel: "Verdi" }),
    ]);
    expect(
      plan.deliver &&
        plan.deadlines?.map((entry) => [entry.no, entry.id, entry.replyHint, entry.skipHint]),
    ).toEqual([
      [1, "dl-a", "reply 1 to run research", "reply skip 1 to dismiss"],
      [2, "dl-b", "reply 2 to run research", "reply skip 2 to dismiss"],
    ]);
  });

  it("adds no deadline field when there is nothing to list, and no plan when nothing clears the bar", () => {
    const plain = planDigest([signal], NOW);
    expect(plain.deliver && "deadlines" in plain).toBe(false);
    expect(planDigest([], NOW, [line("dl-a", "2026-11-12")])).toEqual({
      deliver: false,
      reason: "nothing_cleared_the_bar",
    });
  });

  it("scores a confirmed item's reminder or move above the bar, and leaves other signals alone", () => {
    const base: DigestSignal = {
      matterId: "rossi",
      matterLabel: "Rossi",
      kind: "deadline",
      summary: "Hearing",
      dueAt: "2026-11-05T08:30:00.000Z",
    };
    expect(waitingCost(base, NOW)).toBe(0);
    expect(waitingCost({ ...base, tracked: "reminder" }, NOW)).toBe(60);
    expect(waitingCost({ ...base, tracked: "moved" }, NOW)).toBe(60);
    const imminent = { ...base, dueAt: "2026-10-14T20:00:00.000Z", tracked: "reminder" as const };
    expect(waitingCost(imminent, NOW)).toBe(100);
  });

  it("keeps the number a line gets stable when re-numbered from the same input", () => {
    const lines = [line("dl-a", "2026-11-12"), line("dl-b", "2026-11-20")];
    expect(numberDeadlineLines(lines)).toEqual(numberDeadlineLines(lines));
  });
});
