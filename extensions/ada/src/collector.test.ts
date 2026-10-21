import { describe, expect, it } from "vitest";
import { collectDigest, whatsappWindowOpen } from "./collector.js";
import { renderDigestText } from "./digest-text.js";
import type { Language } from "./research-link-outbound.js";

const NOW = new Date("2026-10-06T05:40:00.000Z");
const ALIASES = [
  { matterId: "verdi", alias: "Verdi", title: "Verdi" },
  { matterId: "bianchi", alias: "Bianchi", title: "Bianchi" },
];

describe("collectDigest", () => {
  it("stays silent and updates snapshots when nothing clears the bar", () => {
    const result = collectDigest({
      now: NOW,
      forceMorning: false,
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
      forceMorning: false,
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

  it("does not re-signal an unchanged calendar event on a poll", () => {
    const result = collectDigest({
      now: NOW,
      forceMorning: false,
      inbox: [],
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
      previousCalendar: [
        {
          eventId: "e-verdi",
          summary: "Verdi hearing",
          startMs: Date.parse("2026-10-06T14:00:00.000Z"),
          endMs: Date.parse("2026-10-06T15:00:00.000Z"),
          matterId: "verdi",
          seenAtMs: 1,
        },
      ],
      aliases: ALIASES,
      todos: [],
    });
    expect(result.plan).toEqual({ deliver: false, reason: "nothing_cleared_the_bar" });
  });

  it("marks a hearing that moved earlier", () => {
    const result = collectDigest({
      now: NOW,
      forceMorning: false,
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

  describe("the digest written from what it collects", () => {
    const aliases = [...ALIASES, { matterId: "rossi", alias: "Rossi", title: "Rossi" }];
    const collected = () => {
      const plan = collectDigest({
        now: NOW,
        forceMorning: false,
        inbox: [
          {
            id: "m-rossi",
            from: "Rossi <client@example.com>",
            subject: "",
            date: "2026-10-06T03:00:00.000Z",
            snippet: "Please confirm the filing?",
          },
        ],
        events: [
          {
            id: "e-verdi",
            summary: "Verdi conference",
            start: "2026-10-08T10:00:00.000Z",
            end: "2026-10-08T11:00:00.000Z",
            status: "confirmed",
          },
          {
            id: "e-bianchi",
            summary: "Bianchi hearing",
            start: "2026-10-06T14:00:00.000Z",
            end: "2026-10-06T15:00:00.000Z",
            status: "confirmed",
          },
        ],
        previousGmail: [],
        previousCalendar: [
          {
            eventId: "e-verdi",
            summary: "Verdi conference",
            startMs: Date.parse("2026-10-10T10:00:00.000Z"),
            endMs: Date.parse("2026-10-10T11:00:00.000Z"),
            matterId: "verdi",
            seenAtMs: 1,
          },
        ],
        aliases,
        todos: [],
      }).plan;
      if (!plan.deliver) {
        throw new Error("expected a digest");
      }
      return plan;
    };

    it("carries each fragment as data, not as English text, next to the raw event title", () => {
      const items = collected().items;
      expect(items.map((item) => item.phrase)).toEqual(
        expect.arrayContaining([
          { id: "calendar_due", text: "Bianchi hearing" },
          { id: "calendar_moved", text: "Verdi conference" },
          { id: "new_email" },
        ]),
      );
    });

    it.each([
      ["it", ["Bianchi hearing: in scadenza", "Verdi conference: anticipato", "Nuova email"]],
      ["es", ["Bianchi hearing: vence", "Verdi conference: adelantado", "Correo nuevo"]],
      ["fr", ["Bianchi hearing : échéance", "Verdi conference : avancé", "Nouvel e-mail"]],
      ["de", ["Bianchi hearing: fällig", "Verdi conference: vorverlegt", "Neue E-Mail"]],
      ["en", ["Bianchi hearing: due", "Verdi conference: moved earlier", "New email"]],
    ] as const)("writes them in %s without English fragments", (language: Language, expected) => {
      const text = renderDigestText(collected(), language, "Europe/Rome");
      for (const fragment of expected) {
        expect(text, language).toContain(fragment);
      }
      if (language !== "en") {
        expect(text, language).not.toMatch(/moved earlier|\bis due\b|\bdue\b|New email/u);
      }
    });
  });

  it("treats the WhatsApp window as closed after 24 hours", () => {
    expect(whatsappWindowOpen(null, NOW.getTime())).toBe(false);
    expect(whatsappWindowOpen(NOW.getTime() - 23 * 60 * 60 * 1000, NOW.getTime())).toBe(true);
    expect(whatsappWindowOpen(NOW.getTime() - 25 * 60 * 60 * 1000, NOW.getTime())).toBe(false);
  });
});
