import { describe, expect, it } from "vitest";
import { renderDigestText, renderGoogleConnectText } from "./digest-text.js";
import type { DigestPlan, RankedDigestItem } from "./digest.js";
import type { Language } from "./research-link-outbound.js";

const LANGUAGES: Language[] = ["it", "en", "es", "fr", "de"];
const PLAN: Extract<DigestPlan, { deliver: true }> = {
  deliver: true,
  items: [
    {
      matterId: "rossi",
      matterLabel: "Rossi SRL",
      kind: "deadline",
      summary: "memoria entro domani",
      cost: 100,
      dueAt: "2026-10-12T15:00:00.000Z",
    },
  ],
  nextSteps: [
    {
      action: "research",
      matterId: "rossi",
      matterLabel: "Rossi SRL",
      instruction: "Research only the Rossi SRL matter: memoria entro domani",
    },
    {
      action: "draft_if_confirmed",
      matterId: "rossi",
      matterLabel: "Rossi SRL",
      instruction: "After the lawyer confirms, draft only for the Rossi SRL matter",
    },
  ],
  deadlines: [
    {
      id: "d1",
      no: 1,
      matterId: "rossi",
      matterLabel: "Rossi SRL",
      type: "hearing",
      title: "Udienza",
      dueAt: "2026-11-12T08:30:00.000Z",
      due: "2026-11-12 09:30",
      daysLeft: 30,
      status: "candidate",
      confidence: 0.6,
      source: "PEC",
      moved: true,
      briefReady: false,
    },
  ],
};

const TWO_MATTERS: Extract<DigestPlan, { deliver: true }> = {
  ...PLAN,
  items: [
    ...PLAN.items,
    {
      matterId: "bianchi",
      matterLabel: "Bianchi",
      kind: "overnight_email",
      summary: "memoria avversaria",
      cost: 60,
    },
  ],
  deadlines: [
    ...(PLAN.deadlines ?? []),
    {
      ...PLAN.deadlines![0]!,
      id: "d2",
      no: 2,
      matterId: "bianchi",
      matterLabel: "Bianchi",
      status: "tracked",
    },
  ],
};

describe("renderDigestText", () => {
  it.each(LANGUAGES)(
    "lays out the plan in %s: items, deadline lines, then one closing question",
    (language) => {
      const text = renderDigestText(PLAN, language, "Europe/Rome");
      expect(text).toContain("Rossi SRL: memoria entro domani");
      expect(text).toContain("1. Rossi SRL");
      expect(text).toContain("2026-11-12 09:30");
      expect(text.indexOf("memoria entro domani")).toBeLessThan(text.indexOf("2026-11-12 09:30"));
      const paragraphs = text.split("\n\n");
      expect(paragraphs.at(-1)).toContain("Rossi SRL");
      expect(paragraphs.at(-1)).toMatch(/\?$/u);
      expect(text.match(/\?/gu)).toHaveLength(1);
      expect(text).not.toMatch(/vera/iu);
    },
  );

  it("states the date change and doubt, tags a candidate, and asks one question without a reply line", () => {
    const text = renderDigestText(PLAN, "it", "Europe/Rome");
    expect(text).toContain("La data è cambiata.");
    expect(text).toContain("Non sono sicura della data");
    expect(text).toContain("Da confermare.");
    expect(text).not.toMatch(/Rispondimi|saltare la \d|Posso fare subito|bozza per/u);
    expect(text.split("\n\n").at(-1)).toBe(
      "Partirei dalla ricerca su Lexroom per Rossi SRL: la avvio?",
    );
  });

  it("asks once for several matters, with a single hint to pick another, not one per deadline", () => {
    for (const language of LANGUAGES) {
      const text = renderDigestText(TWO_MATTERS, language, "Europe/Rome");
      const lines = text.split("\n");
      expect(
        lines.filter((line) => /^\d\. /u.test(line)),
        language,
      ).toHaveLength(2);
      expect(text.match(/\?/gu), language).toHaveLength(1);
      const closing = text.split("\n\n").at(-1) ?? "";
      expect(closing, language).toContain("Rossi SRL");
      expect(closing.length, language).toBeGreaterThan(60);
    }
    const italian = renderDigestText(TWO_MATTERS, "it", "Europe/Rome");
    expect(italian).toContain("la avvio? Se preferisci un'altra voce, o saltarla, dimmelo.");
    expect(italian.match(/Rispondimi|dimmelo/gu)).toHaveLength(1);
  });

  it("offers the stored brief for a tracked item whose research is ready", () => {
    const [line] = PLAN.deadlines ?? [];
    const text = renderDigestText(
      {
        ...PLAN,
        deadlines: [
          { ...line!, status: "tracked", briefReady: true, confidence: 0.9, moved: false },
        ],
      },
      "en",
      "Europe/Rome",
    );
    expect(text).toContain("Research already done.");
    expect(text).not.toContain("watch list");
    expect(text.split("\n\n").at(-1)).toBe(
      "Shall I send you the research already done for Rossi SRL?",
    );
  });

  describe("items written by the collector", () => {
    const phrased = (phrase: NonNullable<RankedDigestItem["phrase"]>, summary: string) => ({
      ...PLAN,
      deadlines: undefined,
      items: [
        {
          matterId: "rossi",
          matterLabel: "Rossi SRL",
          kind: "deadline" as const,
          summary,
          phrase,
          cost: 100,
        },
      ],
    });
    const FRAGMENTS = /moved earlier|is due|New email|Hearing|Deadline|Confirm tracking/u;

    it.each([
      ["it", "Visita medica: anticipato"],
      ["en", "Visita medica: moved earlier"],
      ["es", "Visita medica: adelantado"],
      ["fr", "Visita medica : avancé"],
      ["de", "Visita medica: vorverlegt"],
    ] as const)("moved calendar item in %s", (language, expected) => {
      const text = renderDigestText(
        phrased({ id: "calendar_moved", text: "Visita medica" }, "Visita medica moved earlier"),
        language,
        "Europe/Rome",
      );
      expect(text).toContain(`• Rossi SRL: ${expected}`);
      if (language !== "en") {
        expect(text).not.toMatch(FRAGMENTS);
      }
    });

    it.each([
      ["it", "Nuova email"],
      ["es", "Correo nuevo"],
      ["fr", "Nouvel e-mail"],
      ["de", "Neue E-Mail"],
    ] as const)("mail without a subject in %s", (language, expected) => {
      const text = renderDigestText(
        phrased({ id: "new_email" }, "New email"),
        language,
        "Europe/Rome",
      );
      expect(text).toContain(`• Rossi SRL: ${expected}`);
      expect(text).not.toMatch(FRAGMENTS);
    });

    it("renders a deadline item with its tags in the person's language", () => {
      const plan = phrased(
        {
          id: "tracked_deadline",
          type: "hearing",
          due: "2026-11-12 09:30",
          title: "Udienza di comparizione",
          confirm: true,
          moved: true,
        },
        "Confirm tracking Hearing 2026-11-12 09:30: Udienza di comparizione",
      );
      expect(renderDigestText(plan, "it", "Europe/Rome")).toContain(
        "• Rossi SRL: udienza 2026-11-12 09:30: Udienza di comparizione (da confermare, data cambiata)",
      );
      expect(renderDigestText(plan, "de", "Europe/Rome")).not.toMatch(FRAGMENTS);
    });

    it("keeps the stored summary of a plan held before phrases existed", () => {
      const text = renderDigestText(
        {
          ...PLAN,
          deadlines: undefined,
          items: [{ ...PLAN.items[0]!, summary: "Visita moved earlier" }],
        },
        "it",
        "Europe/Rome",
      );
      expect(text).toContain("• Rossi SRL: Visita moved earlier");
    });
  });

  it("teaches no command phrase in any language", () => {
    const [line] = PLAN.deadlines ?? [];
    for (const language of LANGUAGES) {
      for (const status of ["candidate", "tracked"] as const) {
        const text = renderDigestText(
          { ...PLAN, deadlines: [{ ...line!, status, briefReady: status === "tracked" }] },
          language,
          "Europe/Rome",
        );
        expect(text).not.toMatch(/["«“]/u);
      }
    }
  });

  it("is a single message that fits WhatsApp", () => {
    for (const language of LANGUAGES) {
      expect(renderDigestText(PLAN, language, "Europe/Rome").length).toBeLessThan(3000);
    }
  });
});

describe("renderGoogleConnectText", () => {
  it.each(LANGUAGES)("carries the link on its own line in %s", (language) => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=abc";
    for (const purpose of ["connect", "send", "expired"] as const) {
      const text = renderGoogleConnectText(language, url, purpose);
      expect(text.split("\n")).toContain(url);
      expect(text).not.toMatch(/vera/iu);
    }
  });
});
