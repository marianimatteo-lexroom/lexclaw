import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("replies in the language of the latest message, as a hard rule that overrides every other source", () => {
    expect(ADA_PERSONA).toMatch(
      /hard rule: always reply in the language of the person's most recent message/u,
    );
    expect(ADA_PERSONA).toMatch(
      /overrides the language of earlier messages in the conversation, the language in their profile, notes and memory, and the language of tool results, the digest and Lexroom data/u,
    );
    expect(ADA_PERSONA).toMatch(/switch with them in that very reply/u);
    expect(ADA_PERSONA).toMatch(/keep the language of the conversation so far/u);
  });

  it("uses Italian only when there is no message to go by, and never as a default for an English writer", () => {
    expect(ADA_PERSONA).toMatch(/Use Italian only when there is no message from them to go by/u);
    expect(ADA_PERSONA).toMatch(/Never answer in Italian just because Lexroom/u);
    expect(ADA_PERSONA).toMatch(
      /Italian message that contains borrowed English legal or business terms .* is Italian/u,
    );
    expect(ADA_PERSONA).not.toMatch(/when (it is )?not clear[^.]*Italian|Italian when unclear/iu);
  });

  it("is not contradicted by a skill telling the model to default to Italian", () => {
    const dir = join(import.meta.dirname, "..", "skills");
    const skills = readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name === "SKILL.md")
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill).not.toMatch(
        /Italian when unclear|default to Italian|always (use|reply in) Italian/iu,
      );
    }
  });

  it("helps without an account and sends the connect link instead of sending people away", () => {
    expect(ADA_PERSONA).toMatch(
      /Answer general legal questions right away, for anyone, without needing any account/u,
    );
    expect(ADA_PERSONA).toMatch(/does not replace a lawyer/u);
    expect(ADA_PERSONA).toMatch(/already have a Lexroom account.* send the link straight away/u);
    expect(ADA_PERSONA).toMatch(
      /Never tell anyone to find, sign up for or set up Lexroom themselves/u,
    );
  });

  it("asks naturally before connecting, understands yes in any form, and never teaches a command", () => {
    expect(ADA_PERSONA).toMatch(
      /Never tell anyone to type a command, a keyword or a special phrase/u,
    );
    expect(ADA_PERSONA).toMatch(/ask whether they want to connect it/u);
    expect(ADA_PERSONA).toMatch(/do not call the connect tool yet/u);
    expect(ADA_PERSONA).toMatch(/yes in any form \(sì, ok, certo, vai, yes, 👍/u);
    expect(ADA_PERSONA).toMatch(
      /call ada_lexroom_connect or ada_google_connect and send the link it returns/u,
    );
    expect(ADA_PERSONA).toMatch(/When they say no, carry on without it and do not ask again/u);
    expect(ADA_PERSONA).toMatch(/Question you just asked/u);
    expect(ADA_PERSONA).not.toMatch(/collega|«/iu);
  });

  it("is warm, and names the dismissive phrasing it forbids", () => {
    expect(ADA_PERSONA).toMatch(/warm, helpful/u);
    expect(ADA_PERSONA).toMatch(/do not say you can do little or nothing/u);
    expect(ADA_PERSONA).toMatch(/wrote to the wrong person or by mistake/u);
  });
});
