import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInboundLanguages,
  detectLanguage,
  inboundLanguage,
  markResearchLinkReady,
  recordInboundLanguage,
  registerResearchLinkHooks,
  resolveLanguage,
  takeResearchLinks,
  withResearchLinks,
} from "./research-link-outbound.js";

const OWNER = "393331111111";
const OTHER = "393332222222";
const SESSION = `agent:main:kapso-whatsapp:direct:${OWNER}`;
const URL_A = "https://app.lexroom.ai/research/aaa111";
const URL_B = "https://app.lexroom.ai/research/bbb222";
const ITALIAN =
  "Il termine per proporre opposizione a decreto ingiuntivo è di quaranta giorni dalla notifica, come previsto dalla legge, e non può essere prorogato.";
const ENGLISH =
  "The deadline for filing an opposition is forty days from the notice, as the law provides, and it is not possible to extend it.";

beforeEach(() => {
  takeResearchLinks("", OWNER);
  clearInboundLanguages();
});

describe("ready research links", () => {
  it("are returned once, then gone", () => {
    markResearchLinkReady(URL_A, OWNER);
    expect(takeResearchLinks("Risposta", OWNER)).toEqual([URL_A]);
    expect(takeResearchLinks("Risposta", OWNER)).toEqual([]);
  });

  it("are dropped without being returned when the text already carries them", () => {
    markResearchLinkReady(URL_A, OWNER);
    expect(takeResearchLinks(`Risposta\n${URL_A}`, OWNER)).toEqual([]);
    expect(takeResearchLinks("Risposta", OWNER)).toEqual([]);
  });

  it("expire after 30 minutes, so they never land on an unrelated message", () => {
    markResearchLinkReady(URL_A, OWNER, 1_000);
    expect(takeResearchLinks("Risposta", OWNER, 1_000 + 30 * 60_000 + 1)).toEqual([]);
    markResearchLinkReady(URL_A, OWNER, 1_000);
    expect(takeResearchLinks("Risposta", OWNER, 1_000 + 30 * 60_000)).toEqual([URL_A]);
  });

  it("keep one entry per link and a bounded number of them", () => {
    markResearchLinkReady(URL_A, OWNER);
    markResearchLinkReady(URL_A, OWNER);
    expect(takeResearchLinks("x", OWNER)).toEqual([URL_A]);
    for (let index = 0; index < 30; index += 1) {
      markResearchLinkReady(`https://app.lexroom.ai/research/r${index}`, OWNER);
    }
    expect(takeResearchLinks("x", OWNER)).toHaveLength(20);
  });
});

describe("detectLanguage", () => {
  it.each([
    [ITALIAN, "it"],
    [ENGLISH, "en"],
    [
      "El plazo para presentar la oposición es de cuarenta días, como establece la ley, y no es posible prorrogarlo para los que no.",
      "es",
    ],
    [
      "Le délai pour former opposition est de quarante jours, comme le prévoit la loi, et il ne peut pas être prorogé dans les cas où.",
      "fr",
    ],
    [
      "Die Frist für den Einspruch beträgt vierzig Tage, wie das Gesetz es vorsieht, und sie ist nicht verlängerbar für den Fall von.",
      "de",
    ],
  ])("tells %#", (text, language) => {
    expect(detectLanguage(text)).toBe(language);
  });

  it("does not guess from a short or neutral text", () => {
    expect(detectLanguage("Ok")).toBeUndefined();
    expect(detectLanguage("Cass. 1/2024 [1]")).toBeUndefined();
    expect(detectLanguage("👍")).toBeUndefined();
    expect(detectLanguage("https://app.lexroom.ai/research/aaa111")).toBeUndefined();
  });

  it.each([
    ["Give me a new link", "en"],
    ["Run a digest for me now", "en"],
    ["Ok e Google?", "it"],
    ["Ciao chi sei?", "it"],
    ["Mandami un nuovo link", "it"],
    ["Dame un enlace nuevo, gracias", "es"],
    ["Bonjour, envoie-moi un nouveau lien", "fr"],
    ["Schick mir bitte einen neuen Link", "de"],
    ["In tribunale", "it"],
    ["in udienza", "it"],
    ["In ufficio", "it"],
    ["in arrivo", "it"],
    ["Ok in ritardo", "it"],
    ["In bocca al lupo", "it"],
    ["Do atto", "it"],
    ["Prima udienza in Corte d'Appello", "it"],
    ["fai il recap del meeting", "it"],
    ["controlla la governing law del contratto", "it"],
    ["Check the SPA", "en"],
  ])("tells the short message %j", (text, language) => {
    expect(detectLanguage(text)).toBe(language);
  });

  it.each([
    ["File a lien", undefined],
    ["Lien release deadline?", undefined],
    ["Do me a favor", undefined],
    ["Any hearings Mon?", undefined],
    ["E-mail him", undefined],
    ["Dove Ltd contract", undefined],
    ["Was will er?", undefined],
    ["Manda una e-mail al cliente", undefined],
  ])("never takes the wrong language from the single word in %j", (text, language) => {
    expect(detectLanguage(text)).toBe(language);
  });

  it("still tells a short message that carries real evidence next to those words", () => {
    expect(detectLanguage("E-mail him the new link please")).toBe("en");
    expect(detectLanguage("Mandami una e-mail con il nuovo link")).toBe("it");
  });

  it.each(["in", "In", "do", "ok in", "on", "am", "has", "me", "a", "la", "il", "una", "corte"])(
    "does not take the word %j that other languages use for evidence of any language",
    (text) => {
      expect(detectLanguage(text)).toBeUndefined();
    },
  );
});

describe("the language of a number's latest message", () => {
  it("follows the latest message that carries a language, and keeps it through one that does not", () => {
    expect(inboundLanguage(OWNER)).toBeUndefined();
    recordInboundLanguage(OWNER, "Give me a new link");
    expect(inboundLanguage(OWNER)).toBe("en");
    for (const ambiguous of ["ok", "👍", "https://example.com/neu", "1"]) {
      recordInboundLanguage(OWNER, ambiguous);
    }
    expect(inboundLanguage(OWNER)).toBe("en");
    recordInboundLanguage(OWNER, "Ok e Google?");
    expect(inboundLanguage(OWNER)).toBe("it");
    recordInboundLanguage(OWNER, "Run a digest for me now");
    expect(inboundLanguage(OWNER)).toBe("en");
  });

  it("is kept per number", () => {
    recordInboundLanguage(OWNER, "Give me a new link");
    expect(inboundLanguage(OTHER)).toBeUndefined();
  });

  it("wins over the answer's words and the profile language, and those still apply to a number never heard from", async () => {
    const profile = async () => "Spanish";
    expect(await resolveLanguage(ITALIAN, profile, OWNER)).toBe("it");
    recordInboundLanguage(OWNER, "Run a digest for me now");
    expect(await resolveLanguage(ITALIAN, profile, OWNER)).toBe("en");
    expect(await resolveLanguage("", profile, OWNER)).toBe("en");
    expect(await resolveLanguage("", profile, OTHER)).toBe("es");
    expect(await resolveLanguage("", undefined, OTHER)).toBe("it");
  });

  it("sets the language of the link label appended to a reply", async () => {
    recordInboundLanguage(OWNER, "Give me a new link");
    markResearchLinkReady(URL_A, OWNER);
    expect(await withResearchLinks(ITALIAN, { owner: OWNER })).toBe(
      `${ITALIAN}\n\nContinue in Lexroom: ${URL_A}`,
    );
  });
});

describe("ready research links belong to one number each", () => {
  it("are only ever returned to the number they were made ready for", () => {
    markResearchLinkReady(URL_A, OWNER);
    markResearchLinkReady(URL_B, OTHER);
    expect(takeResearchLinks("x", OTHER)).toEqual([URL_B]);
    expect(takeResearchLinks("x", OTHER)).toEqual([]);
    expect(takeResearchLinks("x", OWNER)).toEqual([URL_A]);
  });
});

describe("withResearchLinks", () => {
  it("appends the localized label and link as the last line", async () => {
    markResearchLinkReady(URL_A, OWNER);
    expect(await withResearchLinks(ITALIAN, { owner: OWNER })).toBe(
      `${ITALIAN}\n\nContinua su Lexroom: ${URL_A}`,
    );
    markResearchLinkReady(URL_A, OWNER);
    expect(await withResearchLinks(`${ENGLISH}\n`, { owner: OWNER })).toBe(
      `${ENGLISH}\n\nContinue in Lexroom: ${URL_A}`,
    );
  });

  it("adds one line per link", async () => {
    markResearchLinkReady(URL_A, OWNER);
    markResearchLinkReady(URL_B, OWNER);
    expect(await withResearchLinks(ITALIAN, { owner: OWNER })).toBe(
      `${ITALIAN}\n\nContinua su Lexroom: ${URL_A}\nContinua su Lexroom: ${URL_B}`,
    );
  });

  it("uses the profile language for a reply too short to tell, then Italian", async () => {
    markResearchLinkReady(URL_A, OWNER);
    expect(
      await withResearchLinks("Ok [1]", {
        owner: OWNER,
        readProfileLanguage: async () => "English",
      }),
    ).toBe(`Ok [1]\n\nContinue in Lexroom: ${URL_A}`);
    markResearchLinkReady(URL_A, OWNER);
    expect(await withResearchLinks("Ok [1]", { owner: OWNER })).toBe(
      `Ok [1]\n\nContinua su Lexroom: ${URL_A}`,
    );
  });

  it("still appends the link when reading the profile fails", async () => {
    markResearchLinkReady(URL_A, OWNER);
    const text = await withResearchLinks("Ok [1]", {
      owner: OWNER,
      readProfileLanguage: async () => {
        throw new Error("store down");
      },
    });
    expect(text).toContain(URL_A);
  });

  it("leaves the text alone when there is nothing to add or the model already wrote the link", async () => {
    expect(await withResearchLinks(ITALIAN, { owner: OWNER })).toBe(ITALIAN);
    markResearchLinkReady(URL_A, OWNER);
    expect(await withResearchLinks(ITALIAN, { owner: null })).toBe(ITALIAN);
    const written = `${ITALIAN}\n${URL_A}`;
    expect(await withResearchLinks(written, { owner: OWNER })).toBe(written);
  });
});

describe("the outbound hooks", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

  function register() {
    const handlers = new Map<string, Handler>();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    registerResearchLinkHooks({
      on: ((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }) as never,
      logger,
    });
    const reply = async (kind: string, text: string | undefined) =>
      (await handlers.get("reply_payload_sending")?.(
        { kind, payload: { text } },
        { sessionKey: SESSION },
      )) as { payload?: { text?: string } } | undefined;
    const sending = async (content: string) =>
      (await handlers.get("message_sending")?.({ to: `+${OWNER}`, content }, {})) as
        | { content?: string }
        | undefined;
    const replyTo = async (sessionKey: string | undefined, text: string) =>
      (await handlers.get("reply_payload_sending")?.(
        { kind: "final", payload: { text } },
        { sessionKey },
      )) as { payload?: { text?: string } } | undefined;
    return { reply, sending, replyTo, logger };
  }

  it("ends the final reply with the link, once, and logs it", async () => {
    const { reply, logger } = register();
    markResearchLinkReady(URL_A, OWNER);
    const first = await reply("final", ITALIAN);
    expect(first?.payload?.text).toBe(`${ITALIAN}\n\nContinua su Lexroom: ${URL_A}`);
    expect(await reply("final", ITALIAN)).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("ada lexroom link.appended via=reply_payload_sending");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("aaa111");
  });

  it("never puts one number's research link on another number's reply", async () => {
    const { replyTo, sending } = register();
    markResearchLinkReady(URL_A, OWNER);
    expect(await replyTo(`agent:main:kapso-whatsapp:direct:${OTHER}`, ITALIAN)).toBeUndefined();
    expect(await replyTo(undefined, ITALIAN)).toBeUndefined();
    expect(await replyTo("agent:main:main", ITALIAN)).toBeUndefined();
    expect(takeResearchLinks("x", OTHER)).toEqual([]);
    expect((await replyTo(SESSION, ITALIAN))?.payload?.text).toContain(URL_A);
    markResearchLinkReady(URL_B, OWNER);
    expect(await sending(ITALIAN)).toBeUndefined();
    void sending;
  });

  it("keeps the rest of the payload as it was", async () => {
    const handlers = new Map<string, Handler>();
    registerResearchLinkHooks({
      on: ((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    markResearchLinkReady(URL_A, OWNER);
    const result = (await handlers.get("reply_payload_sending")?.(
      {
        kind: "final",
        payload: { text: ITALIAN, replyToId: "wamid.1", mediaUrl: "https://x/y.pdf" },
      },
      { sessionKey: SESSION },
    )) as { payload: Record<string, unknown> };
    expect(result.payload).toMatchObject({ replyToId: "wamid.1", mediaUrl: "https://x/y.pdf" });
  });

  it("does not touch tool or block payloads, and keeps the link for the final one", async () => {
    const { reply } = register();
    markResearchLinkReady(URL_A, OWNER);
    expect(await reply("tool", ITALIAN)).toBeUndefined();
    expect(await reply("block", ITALIAN)).toBeUndefined();
    expect((await reply("final", ITALIAN))?.payload?.text).toContain(URL_A);
  });

  it("does not turn a silent or empty reply into a message", async () => {
    const { reply, sending } = register();
    markResearchLinkReady(URL_A, OWNER);
    expect(await reply("final", "NO_REPLY")).toBeUndefined();
    expect(await reply("final", "  ")).toBeUndefined();
    expect(await reply("final", undefined)).toBeUndefined();
    expect(await sending("NO_REPLY")).toBeUndefined();
    expect((await reply("final", ITALIAN))?.payload?.text).toContain(URL_A);
  });

  it("logs a model NO_REPLY with a masked sender, so a silent turn is never silent in the log", async () => {
    const handlers = new Map<string, Handler>();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    registerResearchLinkHooks({
      on: ((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }) as never,
      logger,
    });
    await handlers.get("reply_payload_sending")?.(
      { kind: "final", payload: { text: "NO_REPLY" } },
      { sessionKey: "agent:main:kapso-whatsapp:direct:393331234567" },
    );
    const lines = logger.info.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      "ada inbound skipped stage=reply reason=model_answered_no_reply sender=+39…4567",
    ]);
  });

  it("falls back to message_sending only while the host has never run reply_payload_sending", async () => {
    const fallback = register();
    markResearchLinkReady(URL_A, OWNER);
    expect((await fallback.sending(ITALIAN))?.content).toBe(
      `${ITALIAN}\n\nContinua su Lexroom: ${URL_A}`,
    );

    const owner = register();
    await owner.reply("tool", "x");
    markResearchLinkReady(URL_B, OWNER);
    expect(await owner.sending(ITALIAN)).toBeUndefined();
    expect((await owner.reply("final", ITALIAN))?.payload?.text).toContain(URL_B);
  });

  it("does not add a second link when both hooks see the same reply", async () => {
    const { reply, sending } = register();
    markResearchLinkReady(URL_A, OWNER);
    const hooked = (await reply("final", ITALIAN))?.payload?.text ?? "";
    expect(await sending(hooked)).toBeUndefined();
    expect(hooked.split(URL_A)).toHaveLength(2);
  });

  it("drops a trailing signature from the final reply even when no link is waiting", async () => {
    const { reply } = register();
    const result = await reply("final", `${ITALIAN}\n\n— Ada`);
    expect(result?.payload?.text).toBe(ITALIAN);
    expect(await reply("final", ITALIAN)).toBeUndefined();
  });

  it("drops the signature before it adds the research link, so the link stays last", async () => {
    const { reply } = register();
    markResearchLinkReady(URL_A, OWNER);
    expect((await reply("final", `${ITALIAN}\nAda · Lexroom`))?.payload?.text).toBe(
      `${ITALIAN}\n\nContinua su Lexroom: ${URL_A}`,
    );
    const fallback = register();
    markResearchLinkReady(URL_B, OWNER);
    expect((await fallback.sending(`${ITALIAN}\n\nAda`))?.content).toBe(
      `${ITALIAN}\n\nContinua su Lexroom: ${URL_B}`,
    );
  });

  it("leaves a reply that only mentions Ada untouched", async () => {
    const { reply, sending } = register();
    expect(await reply("final", "Ada ti aiuterà con la ricerca.\nChiedi pure.")).toBeUndefined();
    expect(await reply("final", "Mi chiamo Ada")).toBeUndefined();
    expect(await reply("final", "Ada")).toBeUndefined();
    expect(await sending("Prima riga.\nRisponde Ada.")).toBeUndefined();
  });
});
