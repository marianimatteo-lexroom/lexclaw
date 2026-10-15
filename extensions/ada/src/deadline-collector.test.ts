import { describe, expect, it } from "vitest";
import { collectDeadlineCandidates, collectDigest, type DeadlineScanMessage } from "./collector.js";
import type { DigestDeadlineInput } from "./digest.js";

const NOW = new Date("2026-10-14T05:40:00.000Z");
const ROME = "Europe/Rome";
const ALIASES = [
  { matterId: "rossi", alias: "Rossi", title: "Rossi c. Bianchi" },
  { matterId: "verdi", alias: "Verdi", title: "Verdi" },
];

function message(overrides: Partial<DeadlineScanMessage>): DeadlineScanMessage {
  return {
    id: "msg-1",
    from: "Cancelleria <cancelleria@pec.example.test>",
    subject: "",
    date: "Wed, 14 Oct 2026 09:00:00 +0200",
    snippet: "",
    bodyText: "",
    attachmentTexts: [],
    ...overrides,
  };
}

function collect(
  messages: DeadlineScanMessage[],
  events: Parameters<typeof collectDeadlineCandidates>[0]["events"] = [],
) {
  return collectDeadlineCandidates({
    now: NOW,
    timeZone: ROME,
    messages,
    events,
    aliases: ALIASES,
  });
}

describe("collectDeadlineCandidates from mail", () => {
  it("reads a PEC court notice and strips the PEC prefix from the title", () => {
    const [candidate, ...rest] = collect([
      message({
        subject: "POSTA CERTIFICATA: Comunicazione di cancelleria - Rossi c. Bianchi RG 1234/2026",
        bodyText:
          "Si comunica che l'udienza di comparizione è fissata per il 12 novembre 2026 alle ore 09:30.",
      }),
    ]);
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      matterId: "rossi",
      type: "hearing",
      dueDate: "2026-11-12",
      dueTime: "09:30",
      timeZone: ROME,
      title: "Comunicazione di cancelleria - Rossi c. Bianchi RG 1234/2026",
      source: { kind: "email", ref: "msg-1" },
    });
    expect(candidate?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(new Date(candidate?.dueAtMs ?? 0).toISOString()).toBe("2026-11-12T08:30:00.000Z");
  });

  it("reads PDF attachment text as a separate, slightly weaker source", () => {
    const candidates = collect([
      message({
        id: "msg-2",
        subject: "Rossi: atti di causa",
        bodyText: "In allegato l'avviso.",
        attachmentTexts: [
          {
            filename: "avviso.pdf",
            text: "Termine per il deposito della comparsa conclusionale: 7 dicembre 2026",
          },
        ],
      }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "deadline",
      dueDate: "2026-12-07",
      source: { kind: "pdf", ref: "msg-2#avviso.pdf" },
    });
    expect(candidates[0]?.source.label).toContain("avviso.pdf");
  });

  it("reads English mail from counsel and attributes it by the sender or subject", () => {
    const candidates = collect([
      message({
        id: "msg-3",
        from: "Counsel <counsel@example.com>",
        subject: "Verdi matter: hearing date",
        bodyText: "The hearing is scheduled for November 20th, 2026 at 2:00 PM.",
      }),
    ]);
    expect(candidates[0]).toMatchObject({
      matterId: "verdi",
      type: "hearing",
      dueDate: "2026-11-20",
      dueTime: "14:00",
    });
  });

  it("falls back to the body for the matter and drops mail about unknown matters", () => {
    const fromBody = collect([
      message({
        id: "msg-4",
        from: "noreply@example.com",
        subject: "Avviso",
        bodyText: "Causa Verdi: scadenza deposito 30/11/2026.",
      }),
    ]);
    expect(fromBody[0]).toMatchObject({ matterId: "verdi", dueDate: "2026-11-30" });
    expect(
      collect([
        message({
          id: "msg-5",
          subject: "Newsletter",
          bodyText: "Scadenza offerta 30/11/2026, udienza gratuita il 12 novembre 2026.",
        }),
      ]),
    ).toEqual([]);
  });

  it("carries a postponement's old date so memory can move the item", () => {
    const [candidate] = collect([
      message({
        id: "msg-6",
        subject: "Rossi: rinvio",
        bodyText: "L'udienza del 12 novembre 2026 è rinviata al 14 gennaio 2027 ore 9.30.",
      }),
    ]);
    expect(candidate).toMatchObject({
      dueDate: "2027-01-14",
      rescheduled: true,
      movesFrom: { dueDate: "2026-11-12" },
    });
  });

  it("counts a relative term from the mail's own date, not from now", () => {
    const [candidate] = collect([
      message({
        id: "msg-7",
        date: "Mon, 12 Oct 2026 10:00:00 +0200",
        subject: "Rossi: termine",
        bodyText: "Entro 30 giorni dalla notifica della presente.",
      }),
    ]);
    expect(candidate?.dueDate).toBe("2026-11-11");
  });
});

describe("collectDeadlineCandidates from calendar", () => {
  it("extracts hearings and deadlines by title, with all-day events getting default times", () => {
    const candidates = collect(
      [],
      [
        {
          id: "evt-hearing",
          summary: "Udienza Rossi c. Bianchi",
          start: "2026-11-12T09:30:00+01:00",
          end: "2026-11-12T11:00:00+01:00",
          status: "confirmed",
        },
        {
          id: "evt-deadline",
          summary: "Scadenza memorie Verdi",
          start: "2026-12-01",
          end: "2026-12-02",
          status: "confirmed",
        },
        {
          id: "evt-lunch",
          summary: "Pranzo con Rossi",
          start: "2026-11-13T13:00:00+01:00",
          end: "2026-11-13T14:00:00+01:00",
          status: "confirmed",
        },
        {
          id: "evt-cancelled",
          summary: "Udienza Verdi",
          start: "2026-11-14T09:00:00+01:00",
          end: "2026-11-14T10:00:00+01:00",
          status: "cancelled",
        },
        {
          id: "evt-unknown",
          summary: "Udienza Neri",
          start: "2026-11-15T09:00:00+01:00",
          end: "2026-11-15T10:00:00+01:00",
          status: "confirmed",
        },
      ],
    );
    expect(
      candidates.map(
        (candidate) => `${candidate.type} ${candidate.dueDate} ${candidate.dueTime ?? "-"}`,
      ),
    ).toEqual(["hearing 2026-11-12 09:30", "deadline 2026-12-01 -"]);
    expect(candidates[0]).toMatchObject({
      matterId: "rossi",
      confidence: 0.9,
      source: { kind: "calendar", ref: "evt-hearing" },
      movesFrom: { sourceRef: "evt-hearing" },
    });
    expect(new Date(candidates[1]?.dueAtMs ?? 0).toISOString()).toBe("2026-12-01T22:59:00.000Z");
  });

  it("reads the Rome date of an event stored in UTC across the clock change", () => {
    const [candidate] = collect(
      [],
      [
        {
          id: "evt-dst",
          summary: "Udienza Verdi",
          start: "2026-10-25T23:30:00.000Z",
          end: "2026-10-26T00:30:00.000Z",
          status: "confirmed",
        },
      ],
    );
    expect(candidate).toMatchObject({ dueDate: "2026-10-26", dueTime: "00:30" });
  });

  it("falls back to the description only for events of a known matter", () => {
    const [candidate] = collect(
      [],
      [
        {
          id: "evt-desc",
          summary: "Rossi c. Bianchi",
          description: "Prima udienza di comparizione",
          start: "2026-11-12T10:00:00+01:00",
          end: "2026-11-12T11:00:00+01:00",
          status: "confirmed",
        },
        {
          id: "evt-other",
          summary: "Chiamata cliente",
          description: "Parlare dell'udienza",
          start: "2026-11-12T10:00:00+01:00",
          end: "2026-11-12T11:00:00+01:00",
          status: "confirmed",
        },
      ],
    );
    expect(candidate).toMatchObject({ type: "hearing", confidence: 0.8 });
  });
});

describe("collectDigest with deadline intake", () => {
  const line: DigestDeadlineInput = {
    id: "dl-1",
    matterId: "rossi",
    matterLabel: "Rossi c. Bianchi",
    type: "hearing",
    title: "Comunicazione di cancelleria",
    dueAt: "2026-11-12T08:30:00.000Z",
    due: "2026-11-12 09:30",
    daysLeft: 29,
    status: "candidate",
    confidence: 0.95,
    source: "Cancelleria: comunicazione",
    briefReady: false,
  };

  function run(deadlines?: Parameters<typeof collectDigest>[0]["deadlines"]) {
    return collectDigest({
      now: NOW,
      forceMorning: true,
      inbox: [],
      events: [],
      previousGmail: [],
      previousCalendar: [],
      aliases: ALIASES,
      todos: [],
      deadlines,
    });
  }

  it("changes nothing when intake supplies no deadlines", () => {
    expect(run()).toMatchObject({ plan: { deliver: false } });
    expect(run({ signals: [], lines: [] }).plan).toEqual({
      deliver: false,
      reason: "nothing_cleared_the_bar",
    });
  });

  it("delivers a candidate that needs confirmation and numbers it for the reply", () => {
    const { plan } = run({
      signals: [
        {
          matterId: "rossi",
          matterLabel: "Rossi c. Bianchi",
          kind: "decision_waiting",
          summary: "Confirm tracking Hearing 2026-11-12 09:30",
          dueAt: line.dueAt,
          needsDecision: true,
        },
      ],
      lines: [line],
    });
    expect(plan.deliver).toBe(true);
    if (plan.deliver) {
      expect(plan.deadlines).toEqual([
        expect.objectContaining({
          id: "dl-1",
          no: 1,
          replyHint: "reply 1 to run research",
          skipHint: "reply skip 1 to dismiss",
        }),
      ]);
    }
  });
});
