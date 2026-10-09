import { describe, expect, it } from "vitest";
import type { CollectResult } from "./collector.js";
import type { DigestPlan } from "./digest.js";
import { decideDigestDelivery } from "./service.js";

const plan: DigestPlan = {
  deliver: true,
  items: [
    {
      matterId: "verdi",
      matterLabel: "Verdi",
      kind: "deadline",
      summary: "Hearing today",
      cost: 100,
      dueAt: "2026-10-06T14:00:00.000Z",
    },
  ],
  nextSteps: [
    {
      action: "research",
      matterId: "verdi",
      matterLabel: "Verdi",
      instruction: "Research",
    },
    {
      action: "draft_if_confirmed",
      matterId: "verdi",
      matterLabel: "Verdi",
      instruction: "Draft",
    },
  ],
};

const deliverable: CollectResult = {
  plan,
  signals: [],
  gmailSnapshot: [],
  calendarSnapshot: [],
  urgent: true,
};

describe("decideDigestDelivery", () => {
  it("stays silent when the collector did not clear the bar", () => {
    expect(
      decideDigestDelivery({
        result: {
          ...deliverable,
          plan: { deliver: false, reason: "nothing_cleared_the_bar" },
          urgent: false,
        },
        forceMorning: true,
        timeZone: "Europe/Rome",
        now: new Date("2026-10-06T05:40:00.000Z"),
        lastLawyerInboundAtMs: Date.now(),
      }),
    ).toEqual({ action: "silent" });
  });

  it("batches non-urgent hits until morning", () => {
    expect(
      decideDigestDelivery({
        result: { ...deliverable, urgent: false },
        forceMorning: false,
        timeZone: "Europe/Rome",
        now: new Date("2026-10-06T12:00:00.000Z"),
        lastLawyerInboundAtMs: Date.now(),
      }),
    ).toEqual({ action: "batch" });
  });

  it("holds a deliverable plan when the WhatsApp window is closed", () => {
    const now = new Date("2026-10-06T05:40:00.000Z");
    expect(
      decideDigestDelivery({
        result: deliverable,
        forceMorning: true,
        timeZone: "Europe/Rome",
        now,
        lastLawyerInboundAtMs: now.getTime() - 30 * 60 * 60 * 1000,
      }),
    ).toEqual({ action: "hold", plan });
  });

  it("dispatches when urgent and the window is open", () => {
    const now = new Date("2026-10-06T05:40:00.000Z");
    expect(
      decideDigestDelivery({
        result: deliverable,
        forceMorning: false,
        timeZone: "Europe/Rome",
        now,
        lastLawyerInboundAtMs: now.getTime() - 60 * 60 * 1000,
      }),
    ).toEqual({ action: "dispatch", plan });
  });
});
