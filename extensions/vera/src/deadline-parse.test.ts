import { describe, expect, it } from "vitest";
import { classifyDeadlineText, parseDeadlines, type ParsedDeadline } from "./deadline-parse.js";

const ROME = "Europe/Rome";
// Wednesday 14 October 2026, 12:00 in Rome.
const REFERENCE_MS = Date.parse("2026-10-14T10:00:00.000Z");

function parse(text: string, referenceMs = REFERENCE_MS): ParsedDeadline[] {
  return parseDeadlines(text, { referenceMs, timeZone: ROME });
}

function summary(found: readonly ParsedDeadline[]) {
  return found.map((entry) => `${entry.type} ${entry.dueDate} ${entry.dueTime ?? "-"}`);
}

describe("parseDeadlines in Italian", () => {
  it("reads a court notice with date and time and converts Rome time to UTC", () => {
    const [hearing, ...rest] = parse(
      "Si comunica che l'udienza di comparizione è fissata per il giorno 12 novembre 2026 alle ore 09:30 dinanzi al Giudice, R.G. 1234/2026.",
    );
    expect(rest).toEqual([]);
    expect(hearing).toMatchObject({ type: "hearing", dueDate: "2026-11-12", dueTime: "09:30" });
    expect(new Date(hearing?.dueAtMs ?? 0).toISOString()).toBe("2026-11-12T08:30:00.000Z");
    expect(hearing?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("splits a hearing and a filing term that share one sentence", () => {
    const found = parse(
      "Il termine per il deposito delle memorie scade il 5 novembre 2026 e l'udienza è fissata per il 20 novembre 2026 alle ore 10:00.",
    );
    expect(summary(found)).toEqual(["deadline 2026-11-05 -", "hearing 2026-11-20 10:00"]);
  });

  it("reads separate clauses and the dotted time form", () => {
    const found = parse(
      "Termine per il deposito delle memorie: 5 novembre 2026; udienza: 20/11/2026 ore 11.00",
    );
    expect(summary(found)).toEqual(["deadline 2026-11-05 -", "hearing 2026-11-20 11:00"]);
  });

  it("gives a deadline without a time the end of the Rome day", () => {
    const [deadline] = parse("Scadenza: 30/11/2026");
    expect(deadline).toMatchObject({ type: "deadline", dueDate: "2026-11-30", dueTime: null });
    expect(new Date(deadline?.dueAtMs ?? 0).toISOString()).toBe("2026-11-30T22:59:00.000Z");
  });

  it("uses the hour before and after the October clock change", () => {
    const [summer] = parse("Udienza il 24 ottobre 2026 ore 9");
    const [winter] = parse("Udienza il 26 ottobre 2026 ore 9");
    expect(new Date(summer?.dueAtMs ?? 0).toISOString()).toBe("2026-10-24T07:00:00.000Z");
    expect(new Date(winter?.dueAtMs ?? 0).toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("accepts numeric, abbreviated, and ordinal dates", () => {
    expect(summary(parse("Scadenza 12.11.26"))).toEqual(["deadline 2026-11-12 -"]);
    expect(summary(parse("Scadenza 1° dicembre 2026"))).toEqual(["deadline 2026-12-01 -"]);
    expect(summary(parse("Il pagamento va fatto entro il 30 nov. 2026"))).toEqual([
      "deadline 2026-11-30 -",
    ]);
  });

  it("resolves a missing year to the next occurrence and scores it lower", () => {
    const [implied] = parse("Udienza il 3 dicembre alle ore 10:00");
    const [explicit] = parse("Udienza il 3 dicembre 2026 alle ore 10:00");
    expect(implied?.dueDate).toBe("2026-12-03");
    expect(implied?.confidence).toBeLessThan(explicit?.confidence ?? 0);

    const december = Date.parse("2026-12-20T09:00:00.000Z");
    expect(parse("Udienza il 10 gennaio", december)[0]?.dueDate).toBe("2027-01-10");
  });

  it("rejects impossible dates and accepts a leap day", () => {
    expect(parse("Scadenza 31 febbraio 2027")).toEqual([]);
    expect(parse("Udienza 29/02/2027")).toEqual([]);
    expect(parse("Scadenza 29 febbraio 2028")[0]?.dueDate).toBe("2028-02-29");
  });

  it("ignores dates that record the past or name another document", () => {
    expect(
      parse(
        "Sentenza del 5 marzo 2026 depositata il 3 aprile 2026; termine per l'appello: 3 maggio 2027",
      ),
    ).toHaveLength(1);
    expect(
      summary(
        parse("Il termine per impugnare la sentenza del 5 marzo 2026 scade il 5 novembre 2026."),
      ),
    ).toEqual(["deadline 2026-11-05 -"]);
    expect(parse("Atto notificato il 12 ottobre 2026 presso lo studio.")).toEqual([]);
  });

  it("does not split on abbreviations such as Dott. and art.", () => {
    const found = parse(
      "Il Dott. Verdi comunica che ex art. 183 c.p.c. l'udienza è fissata al 12 novembre 2026.",
    );
    expect(summary(found)).toEqual(["hearing 2026-11-12 -"]);
  });

  it("follows a postponement to the new date and remembers the old one", () => {
    const [hearing] = parse(
      "L'udienza del 12 novembre 2026 è rinviata al 14 gennaio 2027 ore 9.30.",
    );
    expect(hearing).toMatchObject({
      type: "hearing",
      dueDate: "2027-01-14",
      dueTime: "09:30",
      rescheduled: true,
      movedFromDate: "2026-11-12",
    });
  });

  it("flags a postponement that names only the new date", () => {
    const [hearing] = parse("Udienza rinviata al 14 gennaio 2027.");
    expect(hearing).toMatchObject({ dueDate: "2027-01-14", rescheduled: true });
    expect(hearing?.movedFromDate).toBeUndefined();
  });

  it("computes a term counted from the notice date", () => {
    const [calendar] = parse("Si assegna termine: entro 30 giorni dalla notifica della presente.");
    expect(calendar).toMatchObject({ type: "deadline", dueDate: "2026-11-13" });
    const [working] = parse("Entro 10 giorni lavorativi dalla ricezione della presente.");
    expect(working?.dueDate).toBe("2026-10-28");
    expect(working?.confidence).toBeLessThan(0.6);
  });

  it("lowers confidence when the weekday contradicts the date", () => {
    const [right] = parse("Udienza giovedì 12 novembre 2026 ore 9:30");
    const [wrong] = parse("Udienza venerdì 12 novembre 2026 ore 9:30");
    expect(right?.dueDate).toBe("2026-11-12");
    expect((right?.confidence ?? 0) - (wrong?.confidence ?? 0)).toBeCloseTo(0.25, 2);
  });

  it("takes the end of a from-to range as the deadline", () => {
    const found = parse("Termine dal 3 novembre al 17 novembre 2026 per le osservazioni.");
    expect(summary(found)).toEqual(["deadline 2026-11-17 -"]);
  });

  it("does not read postponement into unrelated words", () => {
    const [hearing] = parse("L'udienza del 12 novembre 2026 non è rinviabile; calendario aggiornato.");
    expect(hearing).toMatchObject({ dueDate: "2026-11-12" });
    expect(hearing?.rescheduled).toBeUndefined();
  });

  it("finds nothing without a hearing or deadline term", () => {
    expect(parse("Ferie dello studio dal 1 agosto al 31 agosto 2027.")).toEqual([]);
    expect(parse("Riunione di studio il 12 novembre 2026 alle ore 15:00.")).toEqual([]);
  });
});

describe("parseDeadlines in English", () => {
  it("reads a hearing with an ordinal date and a 12-hour time", () => {
    const [hearing] = parse(
      "The hearing is scheduled for November 12th, 2026 at 10:30 AM before Judge Example.",
    );
    expect(hearing).toMatchObject({ type: "hearing", dueDate: "2026-11-12", dueTime: "10:30" });
    expect(new Date(hearing?.dueAtMs ?? 0).toISOString()).toBe("2026-11-12T09:30:00.000Z");
  });

  it("converts PM and keeps month-first numeric dates unambiguous", () => {
    const [hearing] = parse("Hearing on 11/25/2026 at 2:30 PM");
    expect(hearing).toMatchObject({ dueDate: "2026-11-25", dueTime: "14:30" });
    const [european] = parse("Hearing on 25/11/2026 at 2:30 PM");
    expect(hearing?.confidence).toBeLessThan(european?.confidence ?? 0);
  });

  it("reads no-later-than deadlines and ISO dates", () => {
    expect(summary(parse("Please file the reply no later than 30 November 2026."))).toEqual([
      "deadline 2026-11-30 -",
    ]);
    expect(summary(parse("Filing deadline: 2026-11-30"))).toEqual(["deadline 2026-11-30 -"]);
  });

  it("reads a postponement with both dates", () => {
    const [hearing] = parse(
      "The hearing has been postponed from 12 November 2026 to 14 January 2027.",
    );
    expect(hearing).toMatchObject({
      dueDate: "2027-01-14",
      rescheduled: true,
      movedFromDate: "2026-11-12",
    });
  });

  it("counts days from receipt", () => {
    const [deadline] = parse("You must respond within 20 days of receipt of this notice.");
    expect(deadline).toMatchObject({ type: "deadline", dueDate: "2026-11-03" });
  });

  it("ignores dates that are not obligations", () => {
    expect(parse("Thanks for your email sent on 3 October 2026.")).toEqual([]);
    expect(parse("Meeting on 12 November 2026 about the invoice.")).toEqual([]);
  });

  it("merges the same hearing mentioned twice and keeps the time", () => {
    const found = parse("Hearing on 12 November 2026. Reminder: hearing 12 November 2026 at 9am.");
    expect(summary(found)).toEqual(["hearing 2026-11-12 09:00"]);
  });
});

describe("classifyDeadlineText", () => {
  it("prefers hearing over deadline and returns null for other titles", () => {
    expect(classifyDeadlineText("Udienza Rossi c. Bianchi")).toBe("hearing");
    expect(classifyDeadlineText("Scadenza memorie Rossi")).toBe("deadline");
    expect(classifyDeadlineText("Hearing and filing deadline")).toBe("hearing");
    expect(classifyDeadlineText("Lunch with Mario")).toBeNull();
  });
});
