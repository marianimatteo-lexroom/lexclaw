import { describe, expect, it } from "vitest";
import { connectOfferNote, noteConnectOffer, takeConnectOffers } from "./connect-offers.js";
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
    const result = connectOfferNote([{ kind: "research_result", detail: "recesso locazione" }]);
    expect(result).toContain('Lexroom research on "recesso locazione"');
    expect(result).toContain("ada_draft");
    expect(result).not.toContain("run ada_research again");
    expect(result).toContain("start a new research only when they ask a new question");
  });

  it("keeps only the latest connect's first look when two connect close together", () => {
    const owner = "393339990001";
    noteConnectOffer(owner, "first_look", 1_000, "google");
    noteConnectOffer(owner, "first_look", 2_000, "granola");
    const taken = takeConnectOffers(owner, { inboundAtMs: 3_000, nowMs: 3_000 });
    expect(taken).toEqual([{ kind: "first_look", detail: "granola" }]);
  });
});
