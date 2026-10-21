import { describe, expect, it } from "vitest";
import {
  adaGoogleConnectDefinition,
  adaLexroomConnectDefinition,
} from "./account-tool-definitions.js";
import {
  connectOfferNote,
  noteConnectOffer,
  researchResultDetail,
  markRequestConnect,
  noteRequestConnect,
  noteResearchResult,
  takeConnectOffers,
  takeRequestConnect,
} from "./connect-offers.js";
import { googleConnectedText } from "./google-notify.js";
import { granolaConnectedText } from "./granola-text.js";
import { lexroomConnectedText } from "./lexroom-tools.js";
import { outlookConnectedText } from "./outlook-text.js";
import { adaOutlookConnectDefinition } from "./outlook-tool-definitions.js";
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
        detail: researchResultDetail([
          { query: "recesso locazione", matterId: "matter-1", researchId: "res-9" },
        ]),
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

  it("keeps every result released together, newest last, capped at five, and asks which one when unclear", () => {
    const owner = "393339990020";
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      noteResearchResult(
        owner,
        { query: `domanda ${n}`, matterId: `m${n}`, researchId: `r${n}` },
        1_000 + n,
      );
    }
    const [offer] = takeConnectOffers(owner, { runId: "run-a", inboundAtMs: 5_000, nowMs: 5_000 });
    expect(
      (JSON.parse(offer?.detail ?? "[]") as Array<{ researchId: string }>).map((n) => n.researchId),
    ).toEqual(["r3", "r4", "r5", "r6", "r7"]);
    const note = connectOfferNote([offer!]) ?? "";
    expect(note).toContain("the results of 5 Lexroom researches");
    expect(note).toContain('1. "domanda 3" with matterId "m3" and parentResearchId "r3"');
    expect(note).toContain('5. "domanda 7" with matterId "m7" and parentResearchId "r7"');
    expect(note).toContain("ask which one first");
    expect(note).toContain("cannot read it");

    // Once a run has read them they are answered: the next delivery starts a new list.
    noteResearchResult(owner, { query: "dopo", matterId: "m8", researchId: "r8" }, 6_000);
    const [fresh] = takeConnectOffers(owner, { runId: "run-b", inboundAtMs: 7_000, nowMs: 7_000 });
    expect(JSON.parse(fresh?.detail ?? "[]")).toEqual([
      { query: "dopo", matterId: "m8", researchId: "r8" },
    ]);
    expect(connectOfferNote([fresh!])).not.toContain("ask which one first");
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

  it("remembers a connect for a request in progress once, per number and account, for the life of the link", () => {
    const [anna, bruno] = ["393339990010", "393339990011"];
    noteRequestConnect(anna, "google", 1_000);
    expect(takeRequestConnect(bruno, "google", 2_000)).toBe(false);
    expect(takeRequestConnect(anna, "outlook", 2_000)).toBe(false);
    expect(takeRequestConnect(anna, "google", 2_000)).toBe(true);
    expect(takeRequestConnect(anna, "google", 2_000)).toBe(false);
    noteRequestConnect(anna, "google", 1_000);
    expect(takeRequestConnect(anna, "google", 1_000 + 36 * 60_000)).toBe(false);
  });

  it("marks a connect as request-driven only when the model says so and a link was issued", () => {
    const ask = { ok: true, connected: false, ask: { url: "https://x.test/l/1" } };
    const owner = "393339990012";
    for (const feature of ["google", "outlook", "lexroom"] as const) {
      expect(markRequestConnect(owner, feature, undefined, ask)).toBe(ask);
      expect(takeRequestConnect(owner, feature)).toBe(false);
      markRequestConnect(owner, feature, false, ask);
      expect(takeRequestConnect(owner, feature)).toBe(false);
      markRequestConnect(owner, feature, true, { ok: true, connected: true, email: "a@b.c" });
      markRequestConnect(owner, feature, true, { ok: false, error: "no" });
      expect(takeRequestConnect(owner, feature)).toBe(false);
      expect(markRequestConnect(owner, feature, true, ask)).toBe(ask);
      expect(takeRequestConnect(owner, feature)).toBe(true);
    }
  });

  it("offers forPendingRequest on the Google, Outlook and Lexroom connect tools and says what it is for", () => {
    for (const definition of [
      adaGoogleConnectDefinition,
      adaLexroomConnectDefinition,
      adaOutlookConnectDefinition,
    ]) {
      expect(Object.keys(definition.parameters.properties)).toContain("forPendingRequest");
      expect(definition.description).toContain("Set forPendingRequest true only when");
      expect(definition.description).toContain("first-look question");
    }
  });

  it("drops the first-look question from the Outlook and Lexroom confirmations for a request in progress", () => {
    for (const language of LANGUAGES) {
      for (const text of [outlookConnectedText, lexroomConnectedText]) {
        const plain = text(language, false);
        expect(plain, language).not.toContain("?");
        expect(text(language).startsWith(plain), language).toBe(true);
        expect(text(language).match(/\?/gu), language).toHaveLength(1);
      }
    }
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
