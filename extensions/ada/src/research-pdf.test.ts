import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdfText } from "./pdf-text.js";
import { buildResearchPdf, researchPdfFilename, type ResearchPdfInput } from "./research-pdf.js";

const URL = "https://app.lexroom.ai/research/aaa111";
const NOW = new Date("2026-10-17T08:00:00Z");

const input = (overrides: Partial<ResearchPdfInput> = {}): ResearchPdfInput => ({
  query: "Termine per l'opposizione a decreto ingiuntivo",
  answer: [
    "Il termine per proporre opposizione a decreto ingiuntivo è di quaranta giorni dalla notifica [1]. Il giudice può concedere un termine più breve solo in casi di particolare urgenza.",
    "*Punti principali*",
    "- Il termine decorre dalla notifica del decreto [1].",
    "- Se il debitore è all'estero il termine è di sessanta giorni [2].",
    "- L'opposizione si propone con atto di citazione.",
  ].join("\n"),
  sources: [
    { id: 1, title: "Codice di procedura civile, art. 641" },
    { id: 2, title: "Cass. civ. 1/2024", court: "Suprema Corte di Cassazione", date: "01/02/2024" },
  ],
  researchUrl: URL,
  language: "it",
  now: NOW,
  ...overrides,
});

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe("buildResearchPdf", () => {
  it("makes one A4 page with the title, date, summary, key points, sources and link", async () => {
    const { bytes, filename } = await buildResearchPdf(input());
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const size = pdf.getPage(0).getSize();
    expect(size.width).toBeCloseTo(595.28, 1);
    expect(size.height).toBeCloseTo(841.89, 1);

    const text = extractPdfText(bytes);
    expect(text).toContain("Lexroom");
    expect(text).toContain("Termine per l'opposizione a decreto ingiuntivo");
    expect(text).toContain("17 ottobre 2026");
    expect(text).toContain("Sintesi");
    expect(text).toContain("quaranta giorni dalla notifica");
    expect(text).toContain("Punti chiave");
    expect(text).toContain("sessanta giorni");
    expect(text).toContain("Fonti principali");
    expect(text).toContain("[1] Codice di procedura civile, art. 641");
    expect(text).toContain("[2] Cass. civ. 1/2024 - Suprema Corte di Cassazione, 01/02/2024");
    expect(text).toContain(URL);
    expect(text).not.toContain("Punti principali");
    expect(filename).toBe("lexroom-ricerca-termine-per-lopposizione-a-decreto-2026-10-17.pdf");
  });

  it("links the Lexroom address so it can be tapped", async () => {
    const { bytes } = await buildResearchPdf(input());
    expect(Buffer.from(bytes).toString("latin1")).toContain(`/URI (${URL})`);
  });

  it("condenses a long answer onto one page instead of shrinking it, and points to the link", async () => {
    const sentence = "La giurisprudenza di legittimità ha chiarito la portata della norma [1].";
    const answer = [
      Array.from({ length: 80 }, () => sentence).join(" "),
      ...Array.from({ length: 40 }, (_, i) => `- Punto numero ${i + 1}: ${sentence}`),
    ].join("\n");
    const sources = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      title: `Cass. civ. ${i + 1}/2024`,
      court: "Suprema Corte di Cassazione",
      date: "01/02/2024",
    }));
    const { bytes } = await buildResearchPdf(
      input({ query: "Domanda lunga ".repeat(60), answer, sources }),
    );
    expect(await pageCount(bytes)).toBe(1);
    const text = extractPdfText(bytes);
    expect(text).toContain("Sintesi");
    expect(text).toContain("Punti chiave");
    expect(text).toContain("Punto numero 1:");
    expect(text).not.toContain("Punto numero 40:");
    expect(text).toContain("[1] Cass. civ. 1/2024");
    expect(text).not.toContain("[30] Cass. civ. 30/2024");
    expect(text).toContain("il testo integrale della ricerca è al link");
    expect(text).toContain(URL);
  });

  it("keeps the summary and the sources when the answer has no bullets", async () => {
    const { bytes } = await buildResearchPdf(
      input({
        answer:
          "Il termine è di quaranta giorni. La notifica avviene a mani del debitore. L'opposizione si propone con citazione. Il giudice fissa l'udienza.",
      }),
    );
    const text = extractPdfText(bytes);
    expect(text).toContain("Sintesi");
    expect(text).toContain("Fonti principali");
    expect(await pageCount(bytes)).toBe(1);
  });

  it("writes the page in the language of the answer", async () => {
    const { bytes } = await buildResearchPdf(
      input({
        language: "en",
        query: "Opposition deadline",
        answer: "The deadline is forty days.",
      }),
    );
    const text = extractPdfText(bytes);
    expect(text).toContain("Summary");
    expect(text).toContain("Main sources");
    expect(text).toContain("Full research in Lexroom:");
    expect(text).toContain("17 October 2026");
  });

  it("omits the link block when the research has no web address", async () => {
    const { bytes } = await buildResearchPdf(input({ researchUrl: undefined }));
    expect(extractPdfText(bytes)).not.toContain("app.lexroom.ai");
  });

  it("draws characters Helvetica lacks as a placeholder instead of failing", async () => {
    const { bytes } = await buildResearchPdf(
      input({ query: "Soglia ≥ 5 ✓ 日本", answer: "Importo ≥ 5.000 euro ✓ [1]." }),
    );
    expect(await pageCount(bytes)).toBe(1);
  });
});

describe("researchPdfFilename", () => {
  it("is ASCII, short, and dated", () => {
    expect(
      researchPdfFilename("Può il giudice d'appello rilevare d'ufficio la nullità?", "2026-10-17"),
    ).toBe("lexroom-ricerca-puo-il-giudice-dappello-rilevare-2026-10-17.pdf");
    expect(researchPdfFilename("???", "2026-10-17")).toBe("lexroom-ricerca-2026-10-17.pdf");
  });
});
