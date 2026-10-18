import { describe, expect, it } from "vitest";
import { renderDigestText, renderGoogleConnectText } from "./digest-text.js";
import type { DigestPlan } from "./digest.js";
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
      replyHint: "reply 1 to run research",
      skipHint: "reply skip 1 to dismiss",
    },
  ],
};

describe("renderDigestText", () => {
  it.each(LANGUAGES)(
    "lays out the plan in %s: items, deadline lines, then the two next steps",
    (language) => {
      const text = renderDigestText(PLAN, language, "Europe/Rome");
      expect(text).toContain("Rossi SRL: memoria entro domani");
      expect(text).toContain("1. Rossi SRL");
      expect(text).toContain("2026-11-12 09:30");
      expect(text).toMatch(/\n1\. .*\n2\. /u);
      expect(text.indexOf("memoria entro domani")).toBeLessThan(text.indexOf("2026-11-12 09:30"));
      expect(text).not.toMatch(/vera/iu);
    },
  );

  it("tells the person the date moved and that the date is uncertain, and how to reply", () => {
    const text = renderDigestText(PLAN, "it", "Europe/Rome");
    expect(text).toContain("La data è cambiata.");
    expect(text).toContain("Non sono sicura della data");
    expect(text).toContain('Rispondi 1 per avviare la ricerca su Lexroom, oppure "salta 1"');
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
    expect(text).toContain("It is on your watch list.");
    expect(text).toContain('write "brief 1"');
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
    for (const purpose of ["connect", "send"] as const) {
      const text = renderGoogleConnectText(language, url, purpose);
      expect(text.split("\n")).toContain(url);
      expect(text).not.toMatch(/vera/iu);
    }
  });
});
