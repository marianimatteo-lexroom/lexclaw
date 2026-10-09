import { describe, expect, it } from "vitest";
import { collectDigest, whatsappWindowOpen } from "./collector.js";

const NOW = new Date("2026-10-06T05:40:00.000Z");
const ALIASES = [
  { matterId: "verdi", alias: "Verdi", title: "Verdi" },
  { matterId: "bianchi", alias: "Bianchi", title: "Bianchi" },
];

describe("collectDigest", () => {
  it("stays silent and updates snapshots when nothing clears the bar", () => {
    const result = collectDigest({
      now: NOW,
      inbox: [
        {
          id: "m1",
          from: "news@example.com",
          subject: "Weekly newsletter",
          date: "2026-10-06T01:00:00.000Z",
          snippet: "Offers",
        },
      ],
      events: [],
      previousGmail: [],
      previousCalendar: [],
      aliases: ALIASES,
      todos: [],
    });
    expect(result.plan).toEqual({ deliver: false, reason: "nothing_cleared_the_bar" });
    expect(result.signals).toEqual([]);
    expect(result.gmailSnapshot).toHaveLength(1);
    expect(result.urgent).toBe(false);
  });

  it("drops unknown mail and ranks a same-day Verdi hearing as urgent", () => {
    const result = collectDigest({
      now: NOW,
      inbox: [
        {
          id: "m-unknown",
          from: "spam@example.com",
          subject: "Buy now",
          date: "2026-10-06T02:00:00.000Z",
          snippet: "Sale",
        },
        {
          id: "m-bianchi",
          from: "opposing@example.com",
          subject: "Bianchi: please confirm the draft",
          date: "2026-10-06T03:00:00.000Z",
          snippet: "Can you confirm?",
        },
      ],
      events: [
        {
          id: "e-verdi",
          summary: "Verdi hearing",
          start: "2026-10-06T14:00:00.000Z",
          end: "2026-10-06T15:00:00.000Z",
          status: "confirmed",
        },
      ],
      previousGmail: [],
      previousCalendar: [],
      aliases: ALIASES,
      todos: [],
    });
    expect(result.signals.some((signal) => signal.summary === "Buy now")).toBe(false);
    expect(result.plan.deliver).toBe(true);
    if (result.plan.deliver) {
      expect(result.plan.items[0]?.matterId).toBe("verdi");
      expect(result.plan.items.some((item) => item.matterId === "bianchi")).toBe(true);
    }
    expect(result.urgent).toBe(true);
  });

  it("marks a hearing that moved earlier", () => {
    const result = collectDigest({
      now: NOW,
      inbox: [],
      events: [
        {
          id: "e1",
          summary: "Verdi conference",
          start: "2026-10-08T10:00:00.000Z",
          end: "2026-10-08T11:00:00.000Z",
          status: "confirmed",
        },
      ],
      previousGmail: [],
      previousCalendar: [
        {
          eventId: "e1",
          summary: "Verdi conference",
          startMs: Date.parse("2026-10-10T10:00:00.000Z"),
          endMs: Date.parse("2026-10-10T11:00:00.000Z"),
          matterId: "verdi",
          seenAtMs: 1,
        },
      ],
      aliases: ALIASES,
      todos: [],
    });
    expect(result.signals[0]).toMatchObject({
      kind: "calendar_move",
      movedCloser: true,
      matterId: "verdi",
    });
    expect(result.urgent).toBe(true);
  });

  it("treats the WhatsApp window as closed after 24 hours", () => {
    expect(whatsappWindowOpen(null, NOW.getTime())).toBe(false);
    expect(whatsappWindowOpen(NOW.getTime() - 23 * 60 * 60 * 1000, NOW.getTime())).toBe(true);
    expect(whatsappWindowOpen(NOW.getTime() - 25 * 60 * 60 * 1000, NOW.getTime())).toBe(false);
  });
});
