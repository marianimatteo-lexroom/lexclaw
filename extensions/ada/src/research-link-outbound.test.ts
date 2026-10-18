import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectLanguage,
  markResearchLinkReady,
  registerResearchLinkHooks,
  takeResearchLinks,
  withResearchLinks,
} from "./research-link-outbound.js";

const URL_A = "https://app.lexroom.ai/research/aaa111";
const URL_B = "https://app.lexroom.ai/research/bbb222";
const ITALIAN =
  "Il termine per proporre opposizione a decreto ingiuntivo è di quaranta giorni dalla notifica, come previsto dalla legge, e non può essere prorogato.";
const ENGLISH =
  "The deadline for filing an opposition is forty days from the notice, as the law provides, and it is not possible to extend it.";

beforeEach(() => {
  takeResearchLinks("");
});

describe("ready research links", () => {
  it("are returned once, then gone", () => {
    markResearchLinkReady(URL_A);
    expect(takeResearchLinks("Risposta")).toEqual([URL_A]);
    expect(takeResearchLinks("Risposta")).toEqual([]);
  });

  it("are dropped without being returned when the text already carries them", () => {
    markResearchLinkReady(URL_A);
    expect(takeResearchLinks(`Risposta\n${URL_A}`)).toEqual([]);
    expect(takeResearchLinks("Risposta")).toEqual([]);
  });

  it("expire after 30 minutes, so they never land on an unrelated message", () => {
    markResearchLinkReady(URL_A, 1_000);
    expect(takeResearchLinks("Risposta", 1_000 + 30 * 60_000 + 1)).toEqual([]);
    markResearchLinkReady(URL_A, 1_000);
    expect(takeResearchLinks("Risposta", 1_000 + 30 * 60_000)).toEqual([URL_A]);
  });

  it("keep one entry per link and a bounded number of them", () => {
    markResearchLinkReady(URL_A);
    markResearchLinkReady(URL_A);
    expect(takeResearchLinks("x")).toEqual([URL_A]);
    for (let index = 0; index < 30; index += 1) {
      markResearchLinkReady(`https://app.lexroom.ai/research/r${index}`);
    }
    expect(takeResearchLinks("x")).toHaveLength(20);
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
  });
});

describe("withResearchLinks", () => {
  it("appends the localized label and link as the last line", async () => {
    markResearchLinkReady(URL_A);
    expect(await withResearchLinks(ITALIAN)).toBe(`${ITALIAN}\n\nContinua su Lexroom: ${URL_A}`);
    markResearchLinkReady(URL_A);
    expect(await withResearchLinks(`${ENGLISH}\n`)).toBe(
      `${ENGLISH}\n\nContinue in Lexroom: ${URL_A}`,
    );
  });

  it("adds one line per link", async () => {
    markResearchLinkReady(URL_A);
    markResearchLinkReady(URL_B);
    expect(await withResearchLinks(ITALIAN)).toBe(
      `${ITALIAN}\n\nContinua su Lexroom: ${URL_A}\nContinua su Lexroom: ${URL_B}`,
    );
  });

  it("uses the profile language for a reply too short to tell, then Italian", async () => {
    markResearchLinkReady(URL_A);
    expect(await withResearchLinks("Ok [1]", { readProfileLanguage: async () => "English" })).toBe(
      `Ok [1]\n\nContinue in Lexroom: ${URL_A}`,
    );
    markResearchLinkReady(URL_A);
    expect(await withResearchLinks("Ok [1]")).toBe(`Ok [1]\n\nContinua su Lexroom: ${URL_A}`);
  });

  it("still appends the link when reading the profile fails", async () => {
    markResearchLinkReady(URL_A);
    const text = await withResearchLinks("Ok [1]", {
      readProfileLanguage: async () => {
        throw new Error("store down");
      },
    });
    expect(text).toContain(URL_A);
  });

  it("leaves the text alone when there is nothing to add or the model already wrote the link", async () => {
    expect(await withResearchLinks(ITALIAN)).toBe(ITALIAN);
    markResearchLinkReady(URL_A);
    const written = `${ITALIAN}\n${URL_A}`;
    expect(await withResearchLinks(written)).toBe(written);
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
      (await handlers.get("reply_payload_sending")?.({ kind, payload: { text } }, {})) as
        | { payload?: { text?: string } }
        | undefined;
    const sending = async (content: string) =>
      (await handlers.get("message_sending")?.({ to: "+39", content }, {})) as
        | { content?: string }
        | undefined;
    return { reply, sending, logger };
  }

  it("ends the final reply with the link, once, and logs it", async () => {
    const { reply, logger } = register();
    markResearchLinkReady(URL_A);
    const first = await reply("final", ITALIAN);
    expect(first?.payload?.text).toBe(`${ITALIAN}\n\nContinua su Lexroom: ${URL_A}`);
    expect(await reply("final", ITALIAN)).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("ada lexroom link.appended via=reply_payload_sending");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("aaa111");
  });

  it("keeps the rest of the payload as it was", async () => {
    const handlers = new Map<string, Handler>();
    registerResearchLinkHooks({
      on: ((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    markResearchLinkReady(URL_A);
    const result = (await handlers.get("reply_payload_sending")?.(
      {
        kind: "final",
        payload: { text: ITALIAN, replyToId: "wamid.1", mediaUrl: "https://x/y.pdf" },
      },
      {},
    )) as { payload: Record<string, unknown> };
    expect(result.payload).toMatchObject({ replyToId: "wamid.1", mediaUrl: "https://x/y.pdf" });
  });

  it("does not touch tool or block payloads, and keeps the link for the final one", async () => {
    const { reply } = register();
    markResearchLinkReady(URL_A);
    expect(await reply("tool", ITALIAN)).toBeUndefined();
    expect(await reply("block", ITALIAN)).toBeUndefined();
    expect((await reply("final", ITALIAN))?.payload?.text).toContain(URL_A);
  });

  it("does not turn a silent or empty reply into a message", async () => {
    const { reply, sending } = register();
    markResearchLinkReady(URL_A);
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
    markResearchLinkReady(URL_A);
    expect((await fallback.sending(ITALIAN))?.content).toBe(
      `${ITALIAN}\n\nContinua su Lexroom: ${URL_A}`,
    );

    const owner = register();
    await owner.reply("tool", "x");
    markResearchLinkReady(URL_B);
    expect(await owner.sending(ITALIAN)).toBeUndefined();
    expect((await owner.reply("final", ITALIAN))?.payload?.text).toContain(URL_B);
  });

  it("does not add a second link when both hooks see the same reply", async () => {
    const { reply, sending } = register();
    markResearchLinkReady(URL_A);
    const hooked = (await reply("final", ITALIAN))?.payload?.text ?? "";
    expect(await sending(hooked)).toBeUndefined();
    expect(hooked.split(URL_A)).toHaveLength(2);
  });
});
