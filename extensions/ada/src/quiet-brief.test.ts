import { describe, expect, it } from "vitest";
import { renderQuietBriefText } from "./digest-text.js";
import type { DigestDeadlineInput } from "./digest.js";
import type { CalendarEvent, InboxMessage } from "./google-api.js";
import { buildQuietBrief, type QuietBrief } from "./quiet-brief.js";

const ALIASES = [{ matterId: "rossi", alias: "Rossi", title: "Rossi SRL" }];

function event(id: string, summary: string, start: string, status = "confirmed"): CalendarEvent {
  return { id, summary, start, end: start, status };
}

function mail(id: string, subject: string, unread = true, from = "someone@example.com") {
  return {
    id,
    from,
    subject,
    date: "",
    snippet: "",
    ...(unread ? { unread: true as const } : {}),
  } satisfies InboxMessage;
}

function deadline(id: string, daysLeft: number, type: "deadline" | "hearing" = "deadline") {
  return {
    id,
    matterId: "rossi",
    matterLabel: "Rossi SRL",
    type,
    title: "t",
    dueAt: "2026-10-20T09:00:00.000Z",
    due: "2026-10-20 11:00",
    daysLeft,
    status: "tracked",
    confidence: 0.9,
    source: "",
    briefReady: false,
  } satisfies DigestDeadlineInput;
}

describe("buildQuietBrief", () => {
  const base = { inboxLimit: 10, aliases: ALIASES };

  it("lists only the events of the person's own local day, in order, with all-day events first", () => {
    // 2026-10-14T20:00Z is the evening of the 14th in Rome and already the 15th in Shanghai.
    const now = new Date("2026-10-14T20:00:00.000Z");
    const events = [
      event("late", "Cena", "2026-10-14T21:30:00.000Z"),
      event("early", "Colazione", "2026-10-14T20:30:00.000Z"),
      event("allday", "Ferie", "2026-10-15"),
      event("gone", "Annullato", "2026-10-14T20:45:00.000Z", "cancelled"),
      event("tomorrow", "Domani", "2026-10-15T09:00:00.000Z"),
      event("bad", "Senza data", ""),
    ];
    expect(
      buildQuietBrief({ ...base, now, timeZone: "Europe/Rome", events, inbox: [] }).events,
    ).toEqual([
      { time: "22:30", summary: "Colazione" },
      { time: "23:30", summary: "Cena" },
    ]);
    expect(
      buildQuietBrief({ ...base, now, timeZone: "Asia/Shanghai", events, inbox: [] }).events,
    ).toEqual([
      { time: null, summary: "Ferie" },
      { time: "04:30", summary: "Colazione" },
      { time: "05:30", summary: "Cena" },
      { time: "17:00", summary: "Domani" },
    ]);
  });

  it("counts unread mail, highlights the unread mail about a matter, and flags a full window", () => {
    const inbox = [
      mail("1", "Newsletter"),
      mail("2", "Rossi: memoria in scadenza"),
      mail("3", "Rossi: già letta", false),
      mail("4", "Re: Rossi udienza"),
    ];
    const brief = buildQuietBrief({
      ...base,
      now: new Date("2026-10-14T05:40:00.000Z"),
      timeZone: "Europe/Rome",
      events: [],
      inbox,
    });
    expect(brief).toMatchObject({
      unreadMail: 3,
      unreadMailCapped: false,
      mailHighlights: [
        { matter: "Rossi SRL", subject: "Rossi: memoria in scadenza" },
        { matter: "Rossi SRL", subject: "Re: Rossi udienza" },
      ],
    });
    expect(
      buildQuietBrief({
        ...base,
        inboxLimit: 4,
        now: new Date("2026-10-14T05:40:00.000Z"),
        timeZone: "Europe/Rome",
        events: [],
        inbox,
      }).unreadMailCapped,
    ).toBe(true);
  });

  it("carries whether an alert already went out today, false by default", () => {
    const input = {
      ...base,
      now: new Date("2026-10-14T05:40:00.000Z"),
      timeZone: "Europe/Rome",
      events: [],
      inbox: [],
    };
    expect(buildQuietBrief(input).alertedToday).toBe(false);
    expect(buildQuietBrief({ ...input, alertedToday: true }).alertedToday).toBe(true);
  });

  it("keeps the nearest deadlines inside two weeks, at most three", () => {
    const brief = buildQuietBrief({
      ...base,
      now: new Date("2026-10-14T05:40:00.000Z"),
      timeZone: "Europe/Rome",
      events: [],
      inbox: [],
      deadlines: [
        deadline("a", -1),
        deadline("b", 0, "hearing"),
        deadline("c", 3),
        deadline("d", 7),
        deadline("e", 14),
        deadline("f", 15),
      ],
    });
    expect(brief.deadlines.map((line) => [line.daysLeft, line.type])).toEqual([
      [0, "hearing"],
      [3, "deadline"],
      [7, "deadline"],
    ]);
  });
});

describe("renderQuietBriefText", () => {
  const full: QuietBrief = {
    alertedToday: false,
    events: [
      { time: null, summary: "Ferie" },
      { time: "09:30", summary: "Udienza Rossi" },
    ],
    unreadMail: 3,
    unreadMailCapped: false,
    mailHighlights: [{ matter: "Rossi SRL", subject: "Memoria" }],
    deadlines: [{ matter: "Rossi SRL", type: "hearing", due: "2026-10-17 09:30", daysLeft: 3 }],
  };
  const empty: QuietBrief = {
    alertedToday: false,
    events: [],
    unreadMail: 0,
    unreadMailCapped: false,
    mailHighlights: [],
    deadlines: [],
  };

  it("writes the full brief in Italian, short, with the nothing-urgent line first", () => {
    expect(renderQuietBriefText(full, "it")).toBe(
      [
        "Buongiorno. Niente di urgente per oggi.",
        "Agenda di oggi:\n• tutto il giorno Ferie\n• 09:30 Udienza Rossi",
        "Posta: 3 email non lette.\n• Rossi SRL: Memoria",
        "Udienze e scadenze:\n• Rossi SRL: udienza 2026-10-17 09:30 (tra 3 giorni)",
      ].join("\n\n"),
    );
  });

  it("says there is nothing scheduled and leaves out mail and deadlines when there are none", () => {
    expect(renderQuietBriefText(empty, "it")).toBe(
      "Buongiorno. Niente di urgente per oggi.\n\nAgenda di oggi: nessun impegno.",
    );
    expect(renderQuietBriefText(empty, "en")).toBe(
      "Good morning. Nothing urgent today.\n\nToday's agenda: nothing scheduled.",
    );
  });

  it("follows the language, with plural and capped mail counts", () => {
    expect(renderQuietBriefText({ ...full, unreadMail: 1 }, "en")).toContain(
      "Mail: 1 unread email.",
    );
    expect(
      renderQuietBriefText({ ...full, unreadMailCapped: true, unreadMail: 10 }, "en"),
    ).toContain("Mail: 10+ unread emails.");
    for (const [language, intro] of [
      ["es", "Buenos días. Nada urgente para hoy."],
      ["fr", "Bonjour. Rien d'urgent aujourd'hui."],
      ["de", "Guten Morgen. Heute nichts Dringendes."],
    ] as const) {
      expect(renderQuietBriefText(full, language).startsWith(intro)).toBe(true);
    }
  });

  it("does not say nothing is urgent when an alert already went out today", () => {
    const text = renderQuietBriefText({ ...full, alertedToday: true }, "it");
    expect(text.split("\n\n")).toEqual([
      "Buongiorno. Nient'altro di nuovo da segnalare.",
      "Agenda di oggi:\n• tutto il giorno Ferie\n• 09:30 Udienza Rossi",
      "Posta: 3 email non lette.\n• Rossi SRL: Memoria",
      "Udienze e scadenze:\n• Rossi SRL: udienza 2026-10-17 09:30 (tra 3 giorni)",
    ]);
    for (const [language, intro] of [
      ["en", "Good morning. Nothing else new to report."],
      ["es", "Buenos días. Nada más nuevo que señalar."],
      ["fr", "Bonjour. Rien d'autre de nouveau à signaler."],
      ["de", "Guten Morgen. Sonst nichts Neues zu melden."],
    ] as const) {
      expect(
        renderQuietBriefText({ ...empty, alertedToday: true }, language).startsWith(intro),
      ).toBe(true);
    }
  });

  it("caps a long agenda", () => {
    const events = Array.from({ length: 9 }, (_, index) => ({
      time: `${String(8 + index).padStart(2, "0")}:00`,
      summary: `Impegno ${index + 1}`,
    }));
    const text = renderQuietBriefText({ ...empty, events }, "it");
    expect(text).toContain("• 13:00 Impegno 6");
    expect(text).not.toContain("Impegno 7");
    expect(text).toContain("• …e altri 3");
  });
});
