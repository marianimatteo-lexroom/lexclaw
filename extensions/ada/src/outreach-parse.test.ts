import { describe, expect, it } from "vitest";
import {
  firstName,
  isOptOutText,
  maskPhone,
  maskPhonesInText,
  normalizePhone,
  parseRecipientList,
} from "./outreach-parse.js";

describe("normalizePhone", () => {
  it.each([
    ["333 123 4567", "+393331234567"],
    ["333-123-4567", "+393331234567"],
    ["333.123.4567", "+393331234567"],
    ["+39 333 123 4567", "+393331234567"],
    ["0039 333 123 4567", "+393331234567"],
    ["393331234567", "+393331234567"],
    ["06 1234 5678", "+390612345678"],
    ["3931234567", "+393931234567"],
    ["+44 7911 123456", "+447911123456"],
    ["0044 7911 123456", "+447911123456"],
    ["+1 (415) 555-0132", "+14155550132"],
  ])("turns %s into %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(["", "abc", "12345", "+39 12", "+0 333 1234567", "333 123 4567 89012", "+39 333 x 4567"])(
    "rejects %s",
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );
});

describe("masking and names", () => {
  it("keeps only the country code and the last two digits", () => {
    expect(maskPhone("+393331234567")).toBe("+39********67");
    expect(maskPhone("+393331234567")).not.toContain("333");
  });

  it("masks every phone-like number inside a text and leaves short numbers alone", () => {
    expect(
      maskPhonesInText("to +393331234567 and 39 340 111 2222 failed (HTTP 400, code 131026)"),
    ).toBe("to +39********67 and +39********22 failed (HTTP 400, code 131026)");
  });

  it("takes a safe first word as the first name", () => {
    expect(firstName("  Mario   Rossi ")).toBe("Mario");
    expect(firstName("D'Angelo")).toBe("D'Angelo");
    expect(firstName("{{1}}\n")).toBeUndefined();
    expect(firstName(undefined)).toBeUndefined();
  });

  it("recognizes opt-out replies and nothing longer", () => {
    for (const text of ["STOP", "stop.", " Basta! ", "Annulla  iscrizione"]) {
      expect(isOptOutText(text)).toBe(true);
    }
    for (const text of ["/annulla", "annulla", "non fermarti", "stop the research", ""]) {
      expect(isOptOutText(text)).toBe(false);
    }
  });
});

describe("parseRecipientList", () => {
  it("reads one number per line, with an optional name", () => {
    const parsed = parseRecipientList("333 123 4567\n+39 340 111 2222, Anna Verdi\n\n");
    expect(parsed).toEqual({
      recipients: [{ phone: "+393331234567" }, { phone: "+393401112222", name: "Anna" }],
      invalid: 0,
      duplicates: 0,
    });
  });

  it("uses the phone and name columns of a header row, in any order and delimiter", () => {
    const parsed = parseRecipientList(
      "\uFEFFnome;Telefono;citta\r\nMario;333 123 4567;Roma\r\nLuisa;0039 340 111 2222;Milano\r\n",
    );
    expect(parsed.recipients).toEqual([
      { phone: "+393331234567", name: "Mario" },
      { phone: "+393401112222", name: "Luisa" },
    ]);
  });

  it("reads a header with only a phone column", () => {
    const parsed = parseRecipientList("phone\n3331234567");
    expect(parsed.recipients).toEqual([{ phone: "+393331234567" }]);
  });

  it("counts invalid and repeated numbers once, and keeps the first occurrence", () => {
    const parsed = parseRecipientList(
      ["333 123 4567,Mario", "not a number", "+393331234567,Altro", "00393331234567", "12"].join(
        "\n",
      ),
    );
    expect(parsed.recipients).toEqual([{ phone: "+393331234567", name: "Mario" }]);
    expect(parsed.invalid).toBe(2);
    expect(parsed.duplicates).toBe(2);
  });

  it("reads quoted cells and finds no recipients in an empty file", () => {
    expect(parseRecipientList('"333 123 4567","Mario, jr"').recipients).toEqual([
      { phone: "+393331234567", name: "Mario" },
    ]);
    expect(parseRecipientList("  \n")).toEqual({ recipients: [], invalid: 0, duplicates: 0 });
  });
});
