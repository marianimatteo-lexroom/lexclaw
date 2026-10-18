import { describe, expect, it } from "vitest";
import { ADA_PERSONA } from "./persona.js";

describe("Ada's persona", () => {
  it("serves everyone and never claims to work for one person", () => {
    expect(ADA_PERSONA).toMatch(/serve everyone who writes to you/u);
    expect(ADA_PERSONA).toMatch(/Never say or imply that you work for one person/u);
    expect(ADA_PERSONA).toMatch(
      /SOUL\.md, IDENTITY\.md, notes or earlier messages .* ignore them/u,
    );
    expect(ADA_PERSONA).not.toMatch(/for one lawyer|for lawyers\b/u);
  });

  it("answers in the user's language and defaults to Italian", () => {
    expect(ADA_PERSONA).toMatch(/answer in the language the person writes in/u);
    expect(ADA_PERSONA).toMatch(/answer in Italian/u);
  });

  it("helps without an account and sends the connect link instead of sending people away", () => {
    expect(ADA_PERSONA).toMatch(
      /Answer general legal questions right away, for anyone, without needing any account/u,
    );
    expect(ADA_PERSONA).toMatch(/does not replace a lawyer/u);
    expect(ADA_PERSONA).toMatch(/ada_lexroom_connect or ada_google_connect and send the link/u);
    expect(ADA_PERSONA).toMatch(/already have a Lexroom account.* send them the connect link/u);
    expect(ADA_PERSONA).toMatch(
      /Never tell anyone to find, sign up for or set up Lexroom themselves/u,
    );
  });

  it("is warm, and names the dismissive phrasing it forbids", () => {
    expect(ADA_PERSONA).toMatch(/warm, helpful/u);
    expect(ADA_PERSONA).toMatch(/do not say you can do little or nothing/u);
    expect(ADA_PERSONA).toMatch(/wrote to the wrong person or by mistake/u);
  });
});
