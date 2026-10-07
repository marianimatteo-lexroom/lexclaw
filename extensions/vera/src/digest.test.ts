import { describe, expect, it } from "vitest";
import { planDigest, waitingCost, type DigestSignal } from "./digest.js";

const NOW = new Date("2026-10-06T05:40:00.000Z");

function signal(
  overrides: Partial<DigestSignal> & Pick<DigestSignal, "matterId" | "kind">,
): DigestSignal {
  return {
    matterLabel: overrides.matterId,
    summary: `${overrides.matterId} changed`,
    ...overrides,
  };
}

describe("planDigest", () => {
  it("stays silent when nothing clears the bar", () => {
    const plan = planDigest(
      [
        signal({
          matterId: "neri",
          matterLabel: "Neri",
          kind: "overnight_email",
          summary: "Newsletter",
          needsDecision: false,
        }),
      ],
      NOW,
    );
    expect(plan).toEqual({ deliver: false, reason: "nothing_cleared_the_bar" });
  });

  it("ranks a Tuesday morning and offers research before a confirmed draft", () => {
    const plan = planDigest(
      [
        signal({
          matterId: "neri",
          matterLabel: "Neri",
          kind: "overnight_email",
          summary: "Nothing the lawyer must answer",
          needsDecision: false,
        }),
        signal({
          matterId: "rossi",
          matterLabel: "Rossi",
          kind: "calendar_move",
          summary: "Hearing moved to Thursday",
          dueAt: "2026-10-08T07:00:00.000Z",
          movedCloser: true,
        }),
        signal({
          matterId: "bianchi",
          matterLabel: "Bianchi",
          kind: "overnight_email",
          summary: "Opposing counsel replied on the contract",
          needsDecision: true,
        }),
        signal({
          matterId: "verdi",
          matterLabel: "Verdi",
          kind: "deadline",
          summary: "Brief is due tomorrow",
          dueAt: "2026-10-07T05:00:00.000Z",
        }),
      ],
      NOW,
    );

    expect(plan.deliver).toBe(true);
    if (!plan.deliver) {
      return;
    }
    expect(plan.items.map((item) => item.matterId)).toEqual(["verdi", "rossi", "bianchi"]);
    expect(plan.items.map((item) => item.cost)).toEqual([100, 70, 60]);
    expect(plan.nextSteps).toEqual([
      {
        action: "research",
        matterId: "verdi",
        matterLabel: "Verdi",
        instruction: "Research only the Verdi matter: Brief is due tomorrow",
      },
      {
        action: "draft_if_confirmed",
        matterId: "bianchi",
        matterLabel: "Bianchi",
        instruction:
          "After the lawyer confirms, draft only for the Bianchi matter: Opposing counsel replied on the contract",
      },
    ]);
    expect(plan.items.some((item) => item.summary.includes("Neri"))).toBe(false);
    expect(plan.items.find((item) => item.matterId === "verdi")?.summary).not.toContain("Bianchi");
  });

  it("offers both steps on the only matter that clears the bar", () => {
    const plan = planDigest(
      [
        signal({
          matterId: "verdi",
          matterLabel: "Verdi",
          kind: "deadline",
          summary: "Brief is due tomorrow",
          dueAt: "2026-10-07T05:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(plan.deliver).toBe(true);
    if (!plan.deliver) {
      return;
    }
    expect(plan.nextSteps.map((step) => step.action)).toEqual(["research", "draft_if_confirmed"]);
    expect(plan.nextSteps.every((step) => step.matterId === "verdi")).toBe(true);
  });

  it("keeps one line per matter and lets a same-day deadline outrank a later one", () => {
    const plan = planDigest(
      [
        signal({
          matterId: "verdi",
          matterLabel: "Verdi",
          kind: "overnight_email",
          summary: "Mail that loses to the deadline",
          needsDecision: true,
        }),
        signal({
          matterId: "verdi",
          matterLabel: "Verdi",
          kind: "deadline",
          summary: "Hearing today",
          dueAt: "2026-10-06T15:00:00.000Z",
        }),
        signal({
          matterId: "rossi",
          matterLabel: "Rossi",
          kind: "deadline",
          summary: "Due in two days",
          dueAt: "2026-10-08T04:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(plan.deliver).toBe(true);
    if (!plan.deliver) {
      return;
    }
    expect(plan.items.map((item) => [item.matterId, item.cost, item.summary])).toEqual([
      ["verdi", 100, "Hearing today"],
      ["rossi", 80, "Due in two days"],
    ]);
  });

  it("rejects a signal that has no matter", () => {
    expect(() =>
      planDigest(
        [signal({ matterId: "  ", matterLabel: "Rossi", kind: "deadline", summary: "Due" })],
        NOW,
      ),
    ).toThrow(/matterId/);
  });
});

describe("waitingCost", () => {
  it("ignores a hearing that moved later and is not close", () => {
    expect(
      waitingCost(
        signal({
          matterId: "rossi",
          kind: "calendar_move",
          summary: "Hearing pushed to next month",
          dueAt: "2026-11-06T05:40:00.000Z",
          movedCloser: false,
        }),
        NOW,
      ),
    ).toBe(0);
  });
});
