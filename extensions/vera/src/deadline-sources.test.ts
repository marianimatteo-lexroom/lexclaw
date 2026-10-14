import { describe, expect, it } from "vitest";
import { buildPdf } from "./deadline-test-support.js";
import { parseCalendarEvents, parseMessageContent } from "./google-api.js";
import { parseRawMime } from "./mime-text.js";
import { extractPdfText } from "./pdf-text.js";

const NOTICE = [
  "TRIBUNALE DI ESEMPIO - Avviso di udienza",
  "R.G. 1234/2026 Rossi Mario c. Bianchi S.r.l.",
  "L'udienza è fissata per il giorno 12 novembre 2026 ore 09:30.",
];

describe("extractPdfText", () => {
  it("reads compressed and plain content streams, including accented letters", () => {
    for (const compress of [true, false]) {
      const text = extractPdfText(buildPdf(NOTICE, { compress }));
      expect(text).toContain("L'udienza è fissata per il giorno 12 novembre 2026 ore 09:30.");
      expect(text.split("\n")).toHaveLength(3);
    }
  });

  it("joins kerned TJ fragments and escaped parentheses", () => {
    const content =
      "BT /F1 12 Tf 72 720 Td [(Hear) -20 (ing on 12 Nov) 10 (ember 2026 \\(Room 4\\))] TJ ET";
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF`,
      "latin1",
    );
    expect(extractPdfText(pdf)).toBe("Hearing on 12 November 2026 (Room 4)");
  });

  it("returns nothing for scanned, empty, or non-PDF input", () => {
    const scanned = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Length 4 >>\nstream\nabcd\nendstream\nendobj\n%%EOF",
      "latin1",
    );
    expect(extractPdfText(scanned)).toBe("");
    expect(extractPdfText(Buffer.alloc(0))).toBe("");
    expect(extractPdfText(Buffer.from("not a pdf"))).toBe("");
  });
});

describe("parseRawMime", () => {
  it("unwraps a PEC envelope: quoted-printable body plus a base64 PDF", () => {
    const pdf = buildPdf(NOTICE, { compress: true }).toString("base64");
    const raw = [
      "From: posta-certificata@pec.example.test",
      "Subject: POSTA CERTIFICATA: Comunicazione di cancelleria",
      'Content-Type: multipart/mixed; boundary="B1"',
      "",
      "--B1",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Si comunica che l'udienza =C3=A8 fissata per il 12 novembre 2026 ore 09:30.",
      "--B1",
      'Content-Type: application/pdf; name="avviso.pdf"',
      'Content-Disposition: attachment; filename="avviso.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdf,
      "--B1--",
      "",
    ].join("\r\n");
    const parsed = parseRawMime(Buffer.from(raw, "utf8"));
    expect(parsed.text).toBe(
      "Si comunica che l'udienza è fissata per il 12 novembre 2026 ore 09:30.",
    );
    expect(parsed.pdfs).toHaveLength(1);
    expect(parsed.pdfs[0]?.filename).toBe("avviso.pdf");
    expect(extractPdfText(parsed.pdfs[0]?.bytes ?? Buffer.alloc(0))).toContain("12 novembre 2026");
  });

  it("falls back to HTML text without markup or scripts", () => {
    const raw = [
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hearing on <b>12 November 2026</b></p><script>x()</script>",
    ].join("\n");
    expect(parseRawMime(Buffer.from(raw)).text.replace(/\s+/gu, " ").trim()).toBe(
      "Hearing on 12 November 2026",
    );
  });
});

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("parseMessageContent", () => {
  it("reads plain text, PDF pointers, and a PEC postacert.eml pointer", () => {
    const content = parseMessageContent({
      id: "msg-pec",
      snippet: "Comunicazione di cancelleria",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "posta-certificata@pec.example.test" },
          { name: "Subject", value: "POSTA CERTIFICATA: Comunicazione di cancelleria" },
          { name: "Date", value: "Wed, 14 Oct 2026 09:00:00 +0200" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url("Messaggio di posta certificata") } },
              { mimeType: "text/html", body: { data: b64url("<p>ignored when plain exists</p>") } },
            ],
          },
          {
            mimeType: "application/octet-stream",
            filename: "postacert.eml",
            body: { attachmentId: "att-eml", size: 2048 },
          },
          {
            mimeType: "application/pdf",
            filename: "avviso.pdf",
            body: { attachmentId: "att-pdf", size: 4096 },
          },
          { mimeType: "application/xml", filename: "daticert.xml", body: { attachmentId: "x" } },
        ],
      },
    });
    expect(content).toMatchObject({
      id: "msg-pec",
      bodyText: "Messaggio di posta certificata",
      attachments: [
        { kind: "eml", attachmentId: "att-eml", filename: "postacert.eml", size: 2048 },
        { kind: "pdf", attachmentId: "att-pdf", filename: "avviso.pdf", size: 4096 },
      ],
    });
  });

  it("uses HTML when there is no plain part and rejects payloads without an id", () => {
    const content = parseMessageContent({
      id: "msg-html",
      payload: {
        mimeType: "text/html",
        headers: [],
        body: { data: b64url("<div>Deadline<br>30 November 2026</div>") },
      },
    });
    expect(content?.bodyText).toContain("Deadline");
    expect(content?.bodyText).toContain("30 November 2026");
    expect(parseMessageContent({ payload: {} })).toBeNull();
  });
});

describe("parseCalendarEvents descriptions", () => {
  const payload = {
    items: [
      {
        id: "evt-1",
        summary: "Rossi c. Bianchi",
        description: "Prima udienza di comparizione",
        status: "confirmed",
        start: { dateTime: "2026-11-12T09:30:00+01:00" },
        end: { dateTime: "2026-11-12T10:30:00+01:00" },
      },
    ],
  };

  it("hides descriptions unless a caller asks, so other tools see no new field", () => {
    expect(parseCalendarEvents(payload)[0]).not.toHaveProperty("description");
    expect(parseCalendarEvents(payload, { includeDescription: true })[0]).toMatchObject({
      description: "Prima udienza di comparizione",
    });
  });
});
