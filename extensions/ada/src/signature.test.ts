import { describe, expect, it } from "vitest";
import { stripTrailingSignature } from "./signature.js";

describe("stripTrailingSignature", () => {
  it.each([
    "— Ada",
    "- Ada",
    "– Ada",
    "~ Ada",
    "Ada",
    "*Ada*",
    "_Ada_",
    "— *Ada*",
    "Ada · Lexroom",
    "— Ada, Lexroom",
    "Ada | Lexroom",
    "Ada di Lexroom",
    "Ada at Lexroom",
    "  — Ada  ",
  ])("removes a final line that is only %j", (signature) => {
    expect(stripTrailingSignature(`Ecco la scadenza: venerdì.\n\n${signature}`)).toBe(
      "Ecco la scadenza: venerdì.",
    );
    expect(stripTrailingSignature(`Ecco la scadenza: venerdì.\n${signature}\n\n`)).toBe(
      "Ecco la scadenza: venerdì.",
    );
  });

  it("removes only the last line and keeps the lines above it", () => {
    expect(stripTrailingSignature("Prima riga.\n\nSeconda riga.\n\n— Ada")).toBe(
      "Prima riga.\n\nSeconda riga.",
    );
  });

  it.each([
    "Ada ti aiuterà domani.",
    "Ti scrive Ada",
    "Ciao, sono Ada.",
    "Ada, la scadenza è venerdì.",
    "— Ada Lovelace",
    "Adamo",
    "Ada Lexroom",
    "ada",
    "ADA",
    "— ada",
    "Ada!",
    "Ada ·",
    "Chiedi ad Ada",
  ])("keeps a final line such as %j", (last) => {
    const text = `Prima riga.\n\n${last}`;
    expect(stripTrailingSignature(text)).toBe(text);
  });

  it("keeps a signature-like line that is not the last one", () => {
    const text = "Prima riga.\n— Ada\nPoi la scadenza è venerdì.";
    expect(stripTrailingSignature(text)).toBe(text);
  });

  it("keeps a reply that is only the name, such as the answer to who is there", () => {
    expect(stripTrailingSignature("Ada")).toBe("Ada");
    expect(stripTrailingSignature("— Ada")).toBe("— Ada");
    expect(stripTrailingSignature("\n\nAda\n")).toBe("\n\nAda\n");
  });

  it("returns text without a signature unchanged, trailing whitespace included", () => {
    expect(stripTrailingSignature("Una frase che cita Ada.\n")).toBe("Una frase che cita Ada.\n");
    expect(stripTrailingSignature("")).toBe("");
  });
});
