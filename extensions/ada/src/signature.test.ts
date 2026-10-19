import { describe, expect, it } from "vitest";
import { stripTrailingSignature } from "./signature.js";

describe("stripTrailingSignature", () => {
  it.each([
    "— Ada",
    "– Ada",
    "—Ada",
    "–Ada",
    "— Ada · Lexroom",
    "– Ada, Lexroom",
    "—Ada · Lexroom",
  ])("removes a blank line and a final line that is only %j", (signature) => {
    expect(stripTrailingSignature(`Ecco la scadenza: venerdì.\n\n${signature}`)).toBe(
      "Ecco la scadenza: venerdì.",
    );
    expect(stripTrailingSignature(`Ecco la scadenza: venerdì.\n\n${signature}\n\n`)).toBe(
      "Ecco la scadenza: venerdì.",
    );
  });

  it("removes only the signature and keeps every paragraph above it", () => {
    expect(stripTrailingSignature("Prima riga.\n\nSeconda riga.\n\n— Ada")).toBe(
      "Prima riga.\n\nSeconda riga.",
    );
  });

  it.each([
    [
      "an heir at the end of a list",
      "Gli eredi indicati nel testamento sono:\n- Marco\n- Luca\n- Ada",
    ],
    ["a participant on the last line", "Partecipanti:\nMarco\nAda"],
    ["the answer to a question about a name", "Il nome della cliente è:\n*Ada*"],
    ["a draft for a client called Ada", "Cordiali saluti,\nAda"],
    [
      "a draft sign-off after a blank line",
      "Gentile Avvocato,\n\nin allegato l'atto.\n\nCordiali saluti,\n\nAda",
    ],
    ["a bare name after a blank line", "Partecipanti:\n\nAda"],
    ["a bold name after a blank line", "Il nome della cliente è:\n\n*Ada*"],
    ["a hyphen signature", "Prima riga.\n\n- Ada"],
    ["a tilde signature", "Prima riga.\n\n~ Ada"],
    ["a dash signature with no blank line before it", "Prima riga.\n— Ada"],
    ["a dash signature that is not the last line", "Prima riga.\n\n— Ada\nPoi la scadenza."],
    ["a surname", "Prima riga.\n\n— Ada Lovelace"],
    ["another separator", "Prima riga.\n\n— Ada | Lexroom"],
    ["a dash signature of a different name", "Prima riga.\n\n— Adamo"],
    ["lowercase", "Prima riga.\n\n— ada"],
    ["a sentence that mentions Ada", "Prima riga.\n\nAda ti aiuterà con la ricerca."],
    ["a name inside a final sentence", "Chiedi pure.\n\n— Ada ti risponde domani."],
  ])("keeps %s unchanged", (_label, text) => {
    expect(stripTrailingSignature(text)).toBe(text);
  });

  it("keeps a reply that is only the signature, since nothing comes before it", () => {
    expect(stripTrailingSignature("— Ada")).toBe("— Ada");
    expect(stripTrailingSignature("\n\n— Ada")).toBe("\n\n— Ada");
    expect(stripTrailingSignature("Ada")).toBe("Ada");
  });

  it("returns text without a signature unchanged, trailing whitespace included", () => {
    expect(stripTrailingSignature("Una frase che cita Ada.\n")).toBe("Una frase che cita Ada.\n");
    expect(stripTrailingSignature("")).toBe("");
  });
});
