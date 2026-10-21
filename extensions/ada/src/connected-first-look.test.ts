import { describe, expect, it } from "vitest";
import {
  connectOfferNote,
  noteConnectOffer,
  researchResultDetail,
  noteRequestConnect,
  takeConnectOffers,
  takeRequestConnect,
} from "./connect-offers.js";
import { googleConnectedText } from "./google-notify.js";
import { granolaConnectedText } from "./granola-text.js";
import { lexroomConnectedText } from "./lexroom-tools.js";
import { outlookConnectedText } from "./outlook-text.js";
import type { Language } from "./research-link-outbound.js";

const LANGUAGES: Language[] = ["it", "en", "es", "fr", "de"];
const CONFIRMATIONS = {
  google: googleConnectedText,
  outlook: outlookConnectedText,
  granola: granolaConnectedText,
  lexroom: lexroomConnectedText,
};

describe("a connected confirmation", () => {
  for (const [account, text] of Object.entries(CONFIRMATIONS)) {
    it.each(LANGUAGES)(
      `for ${account} in %s ends with one question that offers a first look`,
      (language) => {
        const message = text(language);
        expect(message.match(/\?/gu)).toHaveLength(1);
        expect(message).toMatch(/\?$/u);
        expect(message).not.toMatch(/Ada\s*$/u);
      },
    );
  }

  it("gives the model the note to act on a yes, for each account and for a research result", () => {
    for (const [detail, tool] of [
      ["google", "ada_read_inbox"],
      ["outlook", "ada_outlook_read_inbox"],
      ["granola", "ada_granola_call"],
      ["lexroom", "ada_research"],
    ] as const) {
      const note = connectOfferNote([{ kind: "first_look", detail }]) ?? "";
      expect(note).toContain("Question you just asked");
      expect(note).toContain(tool);
    }
    expect(connectOfferNote([{ kind: "first_look", detail: "unknown" }])).toBeUndefined();
    const result = connectOfferNote([
      {
        kind: "research_result",
        detail: researchResultDetail({
          query: "recesso locazione",
          matterId: "matter-1",
          researchId: "res-9",
        }),
      },
    ]);
    expect(result).toContain('Lexroom research on "recesso locazione"');
    expect(result).toContain(
      'call ada_draft with matterId "matter-1" and parentResearchId "res-9"',
    );
    expect(result).toContain(
      'call ada_research with matterId "matter-1" and parentResearchId "res-9"',
    );
    expect(result).toContain("cannot read it");
    expect(result).not.toContain("in the conversation or from");
    expect(result).toContain("never research without a question");
  });

  it("still reads a research note that has no ids or a plain-text detail", () => {
    const bare = connectOfferNote([{ kind: "research_result", detail: "caparra" }]) ?? "";
    expect(bare).toContain("call ada_draft, with confirmed true");
    expect(connectOfferNote([{ kind: "research_result" }])).toContain("call ada_draft,");
  });

  it("tells the model a pending request outranks the first look", () => {
    for (const detail of ["google", "outlook", "granola", "lexroom"]) {
      expect(connectOfferNote([{ kind: "first_look", detail }])).toContain(
        "carry that request out instead and ignore the first look",
      );
    }
  });

  it("remembers a connect for a request in progress once, for the life of the link, per number", () => {
    const [anna, bruno] = ["393339990010", "393339990011"];
    noteRequestConnect(anna, 1_000);
    expect(takeRequestConnect(bruno, 2_000)).toBe(false);
    expect(takeRequestConnect(anna, 2_000)).toBe(true);
    expect(takeRequestConnect(anna, 2_000)).toBe(false);
    noteRequestConnect(anna, 1_000);
    expect(takeRequestConnect(anna, 1_000 + 36 * 60_000)).toBe(false);
  });

  it("drops the first-look question from the Google confirmation for a request in progress", () => {
    for (const language of LANGUAGES) {
      expect(googleConnectedText(language).match(/\?/gu), language).toHaveLength(1);
      const plain = googleConnectedText(language, false);
      expect(plain, language).not.toContain("?");
      expect(googleConnectedText(language).startsWith(plain), language).toBe(true);
    }
  });

  it("keeps only the latest connect's first look when two connect close together", () => {
    const owner = "393339990001";
    noteConnectOffer(owner, "first_look", 1_000, "google");
    noteConnectOffer(owner, "first_look", 2_000, "granola");
    const taken = takeConnectOffers(owner, { inboundAtMs: 3_000, nowMs: 3_000 });
    expect(taken).toEqual([{ kind: "first_look", detail: "granola" }]);
  });
});
