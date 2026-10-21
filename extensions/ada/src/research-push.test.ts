import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeConnectOffers } from "./connect-offers.js";
import type { LexroomFailure, ResearchOutcome } from "./lexroom-client.js";
import { extractPdfText } from "./pdf-text.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { buildResearchPdf, type ResearchPdf } from "./research-pdf.js";
import {
  clearHeldResearch,
  fitResearchText,
  livePushDeps,
  onSenderInbound,
  pushResearchResult,
  recordSenderInbound,
  releaseHeldResearch,
  researchAckText,
  researchMessage,
  RESEARCH_TEXT_LIMIT,
  sendResearchAck,
  senderNumber,
  type PushDeps,
} from "./research-push.js";

vi.mock("./research-pdf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./research-pdf.js")>();
  return { ...actual, buildResearchPdf: vi.fn(actual.buildResearchPdf) };
});

const isMediaUpload = (url: Parameters<typeof fetch>[0]) =>
  typeof url === "string" && url.endsWith("/media");
const jsonBody = (init: RequestInit | undefined) =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null");

const URL_A = "https://app.lexroom.ai/research/aaa111";
const ITALIAN =
  "Il termine per proporre opposizione a decreto ingiuntivo è di quaranta giorni dalla notifica, come previsto dalla legge, e non può essere prorogato.";
const ENGLISH =
  "The deadline for filing an opposition is forty days from the notice, as the law provides, and it is not possible to extend it.";

const outcome = (overrides: Partial<ResearchOutcome> = {}): ResearchOutcome => ({
  ok: true,
  matterId: "m",
  researchId: "aaa111",
  researchUrl: URL_A,
  status: "DONE",
  answer: `${ITALIAN} [1]`,
  sources: [
    { id: 1, title: "Cass. civ. 1/2024", court: "Suprema Corte di Cassazione", date: "01/02/2024" },
  ],
  ...overrides,
});

function makeDeps(overrides: Partial<PushDeps> = {}) {
  const sent: string[] = [];
  const log = vi.fn();
  const deps: PushDeps = {
    recipient: "390000000001",
    send: vi.fn(async (text: string) => {
      sent.push(text);
      return { ok: true as const };
    }),
    windowOpen: async () => true,
    nudge: vi.fn(async () => "sent" as const),
    log,
    now: () => 10_000,
    retryDelayMs: 0,
    ...overrides,
  };
  return { deps, sent, log };
}

beforeEach(() => {
  clearHeldResearch();
  clearInboundLanguages();
});

describe("researchMessage", () => {
  it("is the answer, the cited sources and the link line, last", async () => {
    expect(await researchMessage(outcome(), {})).toBe(
      `${ITALIAN} [1]\n\n*Fonti*\n[1] Cass. civ. 1/2024 - Suprema Corte di Cassazione, 01/02/2024\n\nVuoi che ne tragga una bozza?\n\nContinua su Lexroom: ${URL_A}`,
    );
  });

  it("closes a finished research with one next-step question in the answer's language", async () => {
    const english = await researchMessage(outcome({ answer: `${ENGLISH} [1]` }), {});
    expect(english).toContain("\n\nWant me to turn this into a draft?\n\nContinue in Lexroom:");
    expect(english).not.toContain("Vuoi che");
    const closing = await Promise.all(
      [ITALIAN, ENGLISH].map((answer) => researchMessage(outcome({ answer, sources: [] }), {})),
    );
    for (const text of closing) {
      expect(text.match(/\?/gu)).toHaveLength(1);
    }
  });

  it("asks nothing after a failed research", async () => {
    const text = await researchMessage({ ok: false, reason: "timeout", error: "t" } as never, {});
    expect(text).not.toContain("bozza");
  });

  it("follows the answer's language", async () => {
    const text = await researchMessage(outcome({ answer: `${ENGLISH} [1]` }), {});
    expect(text).toContain("*Sources*");
    expect(text.endsWith(`Continue in Lexroom: ${URL_A}`)).toBe(true);
  });

  it("leaves out what a research does not have", async () => {
    expect(await researchMessage(outcome({ sources: [], researchUrl: undefined }), {})).toBe(
      `${ITALIAN} [1]\n\nVuoi che ne tragga una bozza?`,
    );
  });

  it("is one message of at most the limit, ending in the whole link, for a long answer", async () => {
    const answer = Array.from({ length: 200 }, (_, i) => `${ITALIAN} Paragrafo ${i}.`).join("\n\n");
    expect(answer.length).toBeGreaterThan(RESEARCH_TEXT_LIMIT * 5);
    const text = await researchMessage(outcome({ answer }), {});
    expect(text.length).toBeLessThanOrEqual(RESEARCH_TEXT_LIMIT);
    expect(RESEARCH_TEXT_LIMIT).toBeLessThan(4096);
    expect(text.endsWith(`\n\nContinua su Lexroom: ${URL_A}`)).toBe(true);
    expect(text.split(URL_A)).toHaveLength(2);
    expect(text).toContain("…\n\n");
    expect(text).toContain("*Fonti*");
  });

  it("cuts at a paragraph first, then a sentence, then a word", () => {
    const parts = (answer: string) => ({ answer, sources: "", link: "L: https://x.test/r/1" });
    const paragraphs = fitResearchText(parts("Uno uno uno.\n\nDue due due.\n\nTre tre tre."), 60);
    expect(paragraphs).toBe("Uno uno uno.\n\nDue due due.…\n\nL: https://x.test/r/1");
    const sentences = fitResearchText(parts("Uno uno uno. Due due due. Tre tre tre quattro"), 60);
    expect(sentences).toBe("Uno uno uno. Due due due.…\n\nL: https://x.test/r/1");
    const words = fitResearchText(parts("unodueunodue tre quattrocinque sei sette"), 45);
    expect(words).toBe("unodueunodue tre…\n\nL: https://x.test/r/1");
  });

  it("sends an answer that fits unchanged", async () => {
    const answer = `${ITALIAN} [1]`.padEnd(2000, " x").trimEnd();
    const text = await researchMessage(outcome({ answer, sources: [] }), {});
    expect(text).toBe(
      `${answer}\n\nVuoi che ne tragga una bozza?\n\nContinua su Lexroom: ${URL_A}`,
    );
    expect(text).not.toContain("…");
  });

  it("drops a long sources list before the answer, because the PDF lists them", async () => {
    const sources = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      title: `Cass. civ. ${i + 1}/2024 ${"x".repeat(150)}`,
    }));
    const text = await researchMessage(
      outcome({ answer: `${ITALIAN}\n\n`.repeat(120), sources }),
      {},
    );
    expect(text.length).toBeLessThanOrEqual(RESEARCH_TEXT_LIMIT);
    expect(text).not.toContain("*Fonti*");
    expect(text.endsWith(URL_A)).toBe(true);
  });

  it("counts an emoji as two characters and never cuts one in half", () => {
    const link = "L: https://x.test/r/1";
    const limit = 100;
    for (let pad = 0; pad < 4; pad += 1) {
      const answer = `${"a".repeat(70 + pad)}${"😀".repeat(40)}`;
      const text = fitResearchText({ answer, sources: "", link }, limit);
      expect(text.length).toBeLessThanOrEqual(limit);
      expect(text.endsWith(`…\n\n${link}`)).toBe(true);
      expect(text).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,
      );
    }
    const emojiOnly = fitResearchText({ answer: "😀".repeat(100), sources: "", link }, limit);
    expect(emojiOnly.length).toBeLessThanOrEqual(limit);
    expect(emojiOnly).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it.each<[string, LexroomFailure, string]>([
    [
      "a timeout",
      {
        ok: false,
        reason: "timeout",
        message: "Lexroom did not respond within 60s; the request was abandoned.",
        error: "Lexroom did not respond within 60s; the request was abandoned.",
      },
      "Lexroom non ha risposto in tempo e la richiesta è stata interrotta.",
    ],
    [
      "a captcha Ada cannot solve",
      { ok: false, reason: "captcha_required", error: "Lexroom asked for a captcha." },
      "Lexroom ha chiesto un captcha (controllo anti-bot) che non posso risolvere. Riprova più tardi, oppure accedi prima su app.lexroom.ai.",
    ],
    [
      "another failure",
      { ok: false, error: "Lexroom ha negato la richiesta (403): permessi." },
      "Lexroom ha negato la richiesta (403): permessi.",
    ],
  ])("is one short message for %s", async (_label, failure, reason) => {
    expect(await researchMessage(failure, {})).toBe(
      `La ricerca su Lexroom non è andata a buon fine.\n${reason}\nDimmi se vuoi che riprovi.`,
    );
  });

  it("asks, as a question, whether to connect Lexroom, with no keyword and no try-again line", async () => {
    const notConnected = await researchMessage(
      {
        ok: false,
        reason: "not_connected",
        error:
          "Lexroom is not connected. Ask whether they want to connect; call ada_lexroom_connect and send the link only after they agree (or if they asked to connect).",
      },
      {},
    );
    expect(notConnected).toBe(
      "La ricerca su Lexroom non è andata a buon fine.\nLexroom non è ancora collegato al tuo numero: vuoi che ti mandi il link per collegarlo?",
    );
    const refused = await researchMessage(
      { ok: false, reason: "forbidden", error: "Lexroom answered and refused the sign-in." },
      {},
    );
    expect(refused).toBe(
      "La ricerca su Lexroom non è andata a buon fine.\nLexroom ha rifiutato l'accesso per questo account. Vuoi che ti mandi un nuovo link per ricollegarlo?",
    );
    for (const text of [notConnected, refused]) {
      expect(text).not.toMatch(/«|chiedimi|scrivimi|collega Lexroom/iu);
      expect(text).not.toContain("Dimmi se vuoi che riprovi");
    }
  });

  it("remembers the connect question for the next turn, only when it was asked", async () => {
    const { deps } = makeDeps({ offerConnect: vi.fn() });
    const base = { jobId: "rj_1", startedAtMs: 0, query: "q" };
    await pushResearchResult(
      { ...base, result: { ok: false, reason: "not_connected", error: "x" } },
      deps,
    );
    await pushResearchResult(
      { ...base, result: { ok: false, reason: "forbidden", error: "x" } },
      deps,
    );
    await pushResearchResult(
      { ...base, result: { ok: false, reason: "timeout", message: "x", error: "x" } },
      deps,
    );
    await pushResearchResult({ ...base, result: outcome() }, deps);
    expect(deps.offerConnect).toHaveBeenCalledTimes(2);
    expect(deps.offerConnect).toHaveBeenNthCalledWith(1, "lexroom");
    expect(deps.offerConnect).toHaveBeenNthCalledWith(2, "lexroom_reconnect");
  });

  it("remembers the question only once it is delivered: not when held, not when both sends fail", async () => {
    const notConnected = { ok: false as const, reason: "not_connected" as const, error: "x" };
    const base = { jobId: "rj_1", startedAtMs: 0, query: "q", result: notConnected };

    const closed = makeDeps({ windowOpen: async () => false, offerConnect: vi.fn() });
    await pushResearchResult(base, closed.deps);
    const failing = makeDeps({
      send: async () => ({ ok: false, error: "down" }),
      offerConnect: vi.fn(),
    });
    await pushResearchResult(base, failing.deps);
    expect(closed.deps.offerConnect).not.toHaveBeenCalled();
    expect(failing.deps.offerConnect).not.toHaveBeenCalled();

    const released = makeDeps({ offerConnect: vi.fn() });
    expect(await releaseHeldResearch({ ...released.deps, recipient: closed.deps.recipient })).toBe(
      2,
    );
    expect(released.deps.offerConnect).toHaveBeenCalledTimes(2);
    expect(released.deps.offerConnect).toHaveBeenCalledWith("lexroom");
  });

  it("uses the profile language when there is no text to tell it from", async () => {
    const text = await researchMessage(
      { ok: false, reason: "timeout", message: "x", error: "x" },
      { readProfileLanguage: async () => "English" },
    );
    expect(text).toContain("The Lexroom research did not complete.");
  });
});

describe("the language of the number's latest message", () => {
  it("writes the framing, the failure notes and the ack in that language, over the answer and the profile", async () => {
    recordInboundLanguage("393331111111", "Run a digest for me now");
    const profile = { readProfileLanguage: async () => "Italian", recipient: "393331111111" };
    expect(await researchMessage(outcome(), profile)).toContain("*Sources*");
    expect(await researchMessage(outcome(), profile)).toContain(`Continue in Lexroom: ${URL_A}`);
    expect(
      await researchMessage({ ok: false, reason: "not_connected", error: "e" }, profile),
    ).toContain("Lexroom is not connected to your number yet");
    const { deps, sent } = makeDeps({ readProfileLanguage: async () => "Italian" });
    recordInboundLanguage(deps.recipient, "Give me a new link");
    recordInboundLanguage(deps.recipient, "ok");
    await sendResearchAck({ jobId: "rj_1", query: ITALIAN }, deps);
    expect(sent).toEqual([researchAckText("en")]);
  });
});

describe("sendResearchAck", () => {
  it("tells the lawyer in the language of the question and logs ack.sent", async () => {
    const { deps, sent, log } = makeDeps();
    expect(await sendResearchAck({ jobId: "rj_1", query: ENGLISH }, deps)).toBe(true);
    expect(sent).toEqual([researchAckText("en")]);
    expect(log).toHaveBeenCalledWith("ack.sent", { job: "rj_1", language: "en", ms: 0 });
  });

  it("falls back to the profile language, then Italian", async () => {
    const withProfile = makeDeps({ readProfileLanguage: async () => "Spanish" });
    await sendResearchAck({ jobId: "rj_1", query: "Q" }, withProfile.deps);
    expect(withProfile.sent).toEqual([researchAckText("es")]);
    const bare = makeDeps();
    await sendResearchAck({ jobId: "rj_2", query: "Q" }, bare.deps);
    expect(bare.sent).toEqual([researchAckText("it")]);
  });

  it("reports a failed send without throwing, and logs it", async () => {
    const { deps, log } = makeDeps({ send: async () => ({ ok: false, error: "kapso down" }) });
    expect(await sendResearchAck({ jobId: "rj_1", query: "Q" }, deps)).toBe(false);
    expect(log).toHaveBeenCalledWith("ack.failed", { job: "rj_1", error: "kapso down" });
  });
});

describe("pushResearchResult", () => {
  const push = (deps: PushDeps, result: ResearchOutcome | LexroomFailure = outcome()) =>
    pushResearchResult({ jobId: "rj_1", startedAtMs: 4_000, query: "q", result }, deps);

  it("sends the result as a new message and logs result.pushed", async () => {
    const { deps, sent, log } = makeDeps();
    expect(await push(deps)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(URL_A);
    expect(log).toHaveBeenCalledWith("result.pushed", {
      job: "rj_1",
      outcome: "done",
      chars: expect.any(Number),
      via: "live",
      ms: 6000,
    });
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it("sends a failed research too, so the lawyer is not left waiting", async () => {
    const { deps, sent, log } = makeDeps();
    expect(await push(deps, { ok: false, reason: "timeout", message: "m", error: "m" })).toBe(
      "sent",
    );
    expect(sent[0]).toContain("Lexroom non ha risposto in tempo");
    expect(log).toHaveBeenCalledWith(
      "result.pushed",
      expect.objectContaining({ outcome: "timeout" }),
    );
  });

  it("tries to send when the window is unknown, because no inbound message is on record", async () => {
    const { deps, sent } = makeDeps({ windowOpen: async () => null });
    expect(await push(deps)).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("holds the result and nudges, without sending, when the 24-hour window is closed", async () => {
    const { deps, sent, log } = makeDeps({ windowOpen: async () => false });
    expect(await push(deps)).toBe("held");
    expect(sent).toEqual([]);
    expect(deps.nudge).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("result.held", {
      job: "rj_1",
      reason: "window_closed",
      outcome: "done",
      nudge: "sent",
    });
  });

  it("retries a failed send once, then holds the result", async () => {
    const send = vi.fn(async () => ({ ok: false as const, error: "kapso 500" }));
    const { deps, log } = makeDeps({ send });
    expect(await push(deps)).toBe("held");
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "result.push_failed",
      expect.objectContaining({ job: "rj_1", error: "kapso 500" }),
    );
    expect(log).toHaveBeenCalledWith(
      "result.held",
      expect.objectContaining({ reason: "send_failed" }),
    );
  });

  it("succeeds when the retry does", async () => {
    const send = vi
      .fn<PushDeps["send"]>()
      .mockResolvedValueOnce({ ok: false, error: "blip" })
      .mockResolvedValueOnce({ ok: true });
    const { deps } = makeDeps({ send });
    expect(await push(deps)).toBe("sent");
  });

  it("says when the nudge could not be sent", async () => {
    const { deps, log } = makeDeps({
      windowOpen: async () => false,
      nudge: async () => {
        throw new Error("template broke");
      },
    });
    await push(deps);
    expect(log).toHaveBeenCalledWith("result.held", expect.objectContaining({ nudge: "failed" }));
    const unset = makeDeps({ windowOpen: async () => false, nudge: async () => "unset" });
    await push(unset.deps);
    expect(unset.log).toHaveBeenCalledWith(
      "result.held",
      expect.objectContaining({ nudge: "unset" }),
    );
  });
});

describe("releaseHeldResearch", () => {
  const hold = async (
    jobId: string,
    result: ResearchOutcome = outcome(),
    recipient = "390000000001",
  ) => {
    const closed = makeDeps({ windowOpen: async () => false, recipient });
    await pushResearchResult({ jobId, startedAtMs: 0, query: "q", result }, closed.deps);
  };

  it("sends every held result, oldest first, when the lawyer writes", async () => {
    await hold("rj_1", outcome({ answer: `${ITALIAN} uno` }));
    await hold("rj_2", outcome({ answer: `${ITALIAN} due` }));
    const { deps, sent, log } = makeDeps({ now: () => 50_000 });
    expect(await releaseHeldResearch(deps)).toBe(2);
    expect(sent[0]).toContain("uno");
    expect(sent[1]).toContain("due");
    expect(log).toHaveBeenCalledWith(
      "result.pushed",
      expect.objectContaining({ job: "rj_1", via: "released" }),
    );
    expect(await releaseHeldResearch(deps)).toBe(0);
  });

  it("keeps a result that still cannot be sent, for the next message", async () => {
    await hold("rj_1");
    const failing = makeDeps({ send: async () => ({ ok: false, error: "down" }) });
    expect(await releaseHeldResearch(failing.deps)).toBe(0);
    const working = makeDeps();
    expect(await releaseHeldResearch(working.deps)).toBe(1);
  });

  it("forgets a held result after three days, and holds at most five", async () => {
    await hold("rj_old");
    const { deps, sent } = makeDeps({ now: () => 10_000 + 72 * 3600_000 + 1 });
    expect(await releaseHeldResearch(deps)).toBe(0);
    expect(sent).toEqual([]);
    for (let n = 0; n < 7; n += 1) {
      await hold(`rj_${n}`);
    }
    expect(await releaseHeldResearch(makeDeps().deps)).toBe(5);
  });
});

describe("one queue and one window per number", () => {
  const A = "390000000001";
  const B = "390000000002";

  it("releases a number's held results to that number only", async () => {
    await pushResearchResult(
      {
        jobId: "rj_a",
        startedAtMs: 0,
        query: "q",
        result: outcome({ answer: `${ITALIAN} per A` }),
      },
      makeDeps({ windowOpen: async () => false, recipient: A }).deps,
    );
    await pushResearchResult(
      {
        jobId: "rj_b",
        startedAtMs: 0,
        query: "q",
        result: outcome({ answer: `${ITALIAN} per B` }),
      },
      makeDeps({ windowOpen: async () => false, recipient: B }).deps,
    );

    const toB = makeDeps({ recipient: B });
    expect(await releaseHeldResearch(toB.deps)).toBe(1);
    expect(toB.sent).toHaveLength(1);
    expect(toB.sent[0]).toContain("per B");
    expect(toB.sent.join("")).not.toContain("per A");

    const toA = makeDeps({ recipient: A });
    expect(await releaseHeldResearch(toA.deps)).toBe(1);
    expect(toA.sent[0]).toContain("per A");
    expect(toA.sent.join("")).not.toContain("per B");
    expect(await releaseHeldResearch(toA.deps)).toBe(0);
  });

  it("holds at most five per number without crowding out another number", async () => {
    const holdFor = (jobId: string, recipient: string) =>
      pushResearchResult(
        { jobId, startedAtMs: 0, query: "q", result: outcome() },
        makeDeps({ windowOpen: async () => false, recipient }).deps,
      );
    for (let n = 0; n < 7; n += 1) {
      await holdFor(`rj_a${n}`, A);
    }
    await holdFor("rj_b", B);
    expect(await releaseHeldResearch(makeDeps({ recipient: A }).deps)).toBe(5);
    expect(await releaseHeldResearch(makeDeps({ recipient: B }).deps)).toBe(1);
  });

  it("nudges the number whose result is held", async () => {
    const a = makeDeps({ windowOpen: async () => false, recipient: A });
    const b = makeDeps({ windowOpen: async () => false, recipient: B });
    await pushResearchResult(
      { jobId: "rj_a", startedAtMs: 0, query: "q", result: outcome() },
      a.deps,
    );
    expect(a.deps.nudge).toHaveBeenCalledTimes(1);
    expect(b.deps.nudge).not.toHaveBeenCalled();
  });

  it("reads a sender's number from a Kapso sender id, and nothing from a group or a name", () => {
    expect(senderNumber("+39 000 000 0001")).toBe(A);
    expect(senderNumber("whatsapp:+390000000001")).toBe(A);
    expect(senderNumber("390000000001@s.whatsapp.net")).toBe(A);
    expect(senderNumber("120363025@g.us", "Mario Rossi", undefined)).toBeNull();
    expect(senderNumber("group", "+39 000 000 0002")).toBe(B);
    expect(senderNumber(undefined)).toBeNull();
  });
});

describe("the live window check", () => {
  const A = "390000000001";
  const B = "390000000002";
  const api = {
    config: { channels: { "kapso-whatsapp": { defaultTo: "+390000000009" } } },
    runtime: {
      channel: { outbound: { loadAdapter: async () => ({ sendText: async () => undefined }) } },
    },
    runtimeSource: "/fake/index.ts",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginConfig: {},
  } as unknown as Parameters<typeof livePushDeps>[0];

  it("is tracked per number from its own last inbound message", async () => {
    const now = Date.now();
    recordSenderInbound(A, now - 60_000);
    recordSenderInbound(B, now - 25 * 3600_000);
    expect(await livePushDeps(api, vi.fn(), A).windowOpen()).toBe(true);
    expect(await livePushDeps(api, vi.fn(), B).windowOpen()).toBe(false);
  });

  it("is unknown for a number Ada has not heard from, so the send is tried", async () => {
    expect(await livePushDeps(api, vi.fn(), "390000000077").windowOpen()).toBeNull();
  });

  it("goes to the number that asked, as a plus number", async () => {
    const sendText = vi.fn(async () => undefined);
    const live = livePushDeps(
      {
        ...api,
        runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText }) } } },
      } as unknown as Parameters<typeof livePushDeps>[0],
      vi.fn(),
      A,
    );
    await live.send("ciao");
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ to: `+${A}`, text: "ciao" }));
  });

  it("records an inbound from any Kapso sender, and not from another channel or a group", async () => {
    const atMs = Date.now();
    onSenderInbound({ api, channelId: "kapso-whatsapp", senders: ["+39 000 000 0042"], atMs });
    expect(await livePushDeps(api, vi.fn(), "390000000042").windowOpen()).toBe(true);
    onSenderInbound({ api, channelId: "telegram", senders: ["+39 000 000 0043"], atMs });
    onSenderInbound({ api, channelId: "kapso-whatsapp", senders: ["120363025@g.us"], atMs });
    expect(await livePushDeps(api, vi.fn(), "390000000043").windowOpen()).toBeNull();
  });

  it("nudges a held result with the utility template, and with the digest template when that is all there is", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "w" }] })));
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const withTemplates = (pluginConfig: unknown) =>
        livePushDeps(
          {
            ...api,
            config: {
              channels: {
                "kapso-whatsapp": {
                  apiKey: "kapso_test_key",
                  phoneNumberId: "100000000000000",
                  baseUrl: "https://api.kapso.ai/meta/whatsapp/",
                },
              },
            },
            pluginConfig,
          } as unknown as Parameters<typeof livePushDeps>[0],
          vi.fn(),
          A,
        );
      const names = () =>
        fetchImpl.mock.calls.map(
          (call) => JSON.parse(String((call[1] as RequestInit).body)).template.name,
        );
      const digest = { name: "ada_digest_ready", language: "it" };
      const request = { name: "ada_request_ready", language: "it" };

      expect(
        await withTemplates({ digestReadyTemplate: digest, requestReadyTemplate: request }).nudge(),
      ).toBe("sent");
      expect(await withTemplates({ digestReadyTemplate: digest }).nudge()).toBe("sent");
      expect(await withTemplates({}).nudge()).toBe("unset");
      expect(names()).toEqual(["ada_request_ready", "ada_digest_ready"]);

      fetchImpl.mockImplementation(async () => new Response("{}", { status: 400 }));
      expect(await withTemplates({ requestReadyTemplate: request }).nudge()).toBe("failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("remembers every result released together for the next turn, not only the last", async () => {
    const owner = "390000000088";
    const sendText = vi.fn(async (_params: { to: string; text: string }) => undefined);
    const live = {
      ...api,
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText }) } } },
    } as unknown as Parameters<typeof livePushDeps>[0];
    for (const [jobId, query, matterId, researchId] of [
      ["rj1", "recesso locazione", "m-1", "res-1"],
      ["rj2", "caparra", "m-2", "res-2"],
    ] as const) {
      await pushResearchResult(
        {
          jobId,
          startedAtMs: 0,
          query,
          matterId,
          result: outcome({
            researchId,
            researchUrl: `https://app.lexroom.ai/research/${researchId}`,
          }),
        },
        makeDeps({ windowOpen: async () => false, recipient: owner, now: Date.now }).deps,
      );
    }
    expect(await releaseHeldResearch(livePushDeps(live, vi.fn(), owner))).toBe(2);
    const [offer] = takeConnectOffers(owner, { inboundAtMs: Date.now() + 1_000 });
    expect(offer?.kind).toBe("research_result");
    expect(JSON.parse(offer?.detail ?? "[]")).toEqual([
      { query: "recesso locazione", matterId: "m-1", researchId: "res-1" },
      { query: "caparra", matterId: "m-2", researchId: "res-2" },
    ]);
  });

  it("releases the held results of the sender who wrote, and only theirs", async () => {
    const sendText = vi.fn(async (_params: { to: string; text: string }) => undefined);
    const live = {
      ...api,
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText }) } } },
    } as unknown as Parameters<typeof livePushDeps>[0];
    for (const recipient of [A, B]) {
      await pushResearchResult(
        {
          jobId: `rj_${recipient}`,
          startedAtMs: 0,
          query: "q",
          result: outcome({ answer: `${ITALIAN} ${recipient}` }),
        },
        makeDeps({ windowOpen: async () => false, recipient, now: Date.now }).deps,
      );
    }
    onSenderInbound({
      api: live,
      channelId: "kapso-whatsapp",
      senders: ["+39 000 000 0002"],
      atMs: Date.now(),
    });
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(sendText.mock.calls[0]?.[0]).toMatchObject({ to: `+${B}` });
    expect(sendText.mock.calls[0]?.[0].text).toContain(B);
    expect(sendText.mock.calls[0]?.[0].text).not.toContain(A);
  });
});

describe("noting a delivered research for the next turn", () => {
  it("notes the question of a finished research once it reaches the person, live or released", async () => {
    const noteResult = vi.fn();
    const live = makeDeps({ noteResult });
    await pushResearchResult(
      {
        jobId: "j1",
        startedAtMs: 0,
        query: "recesso locazione",
        matterId: "matter-1",
        result: outcome(),
      },
      live.deps,
    );
    expect(noteResult).toHaveBeenCalledExactlyOnceWith({
      query: "recesso locazione",
      matterId: "matter-1",
      researchId: "aaa111",
    });

    const held = makeDeps({ noteResult: vi.fn(), windowOpen: async () => false });
    await pushResearchResult(
      { jobId: "j2", startedAtMs: 0, query: "caparra", matterId: "matter-2", result: outcome() },
      held.deps,
    );
    expect(held.deps.noteResult).not.toHaveBeenCalled();
    const released = makeDeps({ noteResult: vi.fn() });
    await releaseHeldResearch(released.deps);
    expect(released.deps.noteResult).toHaveBeenCalledExactlyOnceWith({
      query: "caparra",
      matterId: "matter-2",
      researchId: "aaa111",
    });
  });

  it("notes nothing for a failed research", async () => {
    const noteResult = vi.fn();
    const { deps } = makeDeps({ noteResult });
    await pushResearchResult(
      {
        jobId: "j3",
        startedAtMs: 0,
        query: "q",
        result: { ok: false, reason: "timeout", error: "t" } as LexroomFailure,
      },
      deps,
    );
    expect(noteResult).not.toHaveBeenCalled();
  });
});

describe("the research PDF", () => {
  const SECRET_ANSWER = "contenuto riservato della risposta";

  function pdfDeps(overrides: Partial<PushDeps> = {}) {
    const events: string[] = [];
    const documents: ResearchPdf[] = [];
    const made = makeDeps({
      send: vi.fn(async (text: string) => {
        events.push(`text:${text.slice(0, 12)}`);
        return { ok: true as const };
      }),
      sendDocument: vi.fn(async (document: ResearchPdf) => {
        events.push("document");
        documents.push(document);
        return { ok: true as const };
      }),
      ...overrides,
    });
    return { ...made, events, documents };
  }

  const push = (deps: PushDeps, result: ResearchOutcome | LexroomFailure = outcome()) =>
    pushResearchResult(
      { jobId: "rj_1", startedAtMs: 0, query: "Termine per l'opposizione", result },
      deps,
    );

  afterEach(() => {
    vi.mocked(buildResearchPdf).mockClear();
  });

  it("follows the text answer as a document with the summary, sources and link", async () => {
    const { deps, events, documents, log } = pdfDeps();
    expect(await push(deps)).toBe("sent");
    expect(events).toEqual([expect.stringMatching(/^text:/), "document"]);
    expect(documents).toHaveLength(1);
    const [document] = documents;
    expect(document?.filename).toMatch(
      /^lexroom-ricerca-termine-per-lopposizione-\d{4}-\d{2}-\d{2}\.pdf$/,
    );
    const text = extractPdfText(document?.bytes ?? new Uint8Array());
    expect(text).toContain("Termine per l'opposizione");
    expect(text).toContain("quaranta giorni dalla notifica");
    expect(text).toContain("[1] Cass. civ. 1/2024");
    expect(text).toContain(URL_A);
    expect(log).toHaveBeenCalledWith(
      "result.pdf_sent",
      expect.objectContaining({ job: "rj_1", bytes: document?.bytes.byteLength }),
    );
  });

  it("still delivers the text, and logs a warning, when the PDF cannot be built", async () => {
    vi.mocked(buildResearchPdf).mockRejectedValueOnce(new Error(SECRET_ANSWER));
    const { deps, events, log } = pdfDeps();
    expect(await push(deps, outcome({ answer: `${ITALIAN} ${SECRET_ANSWER}` }))).toBe("sent");
    expect(events).toEqual([expect.stringMatching(/^text:/)]);
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("result.pdf_failed", {
      job: "rj_1",
      step: "build",
      error: "Error",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET_ANSWER);
  });

  it("still reports the delivery as sent when the document upload fails or throws", async () => {
    const failing = pdfDeps({
      sendDocument: async () => ({ ok: false, error: "kapso document upload returned HTTP 400" }),
    });
    expect(await push(failing.deps)).toBe("sent");
    expect(failing.log).toHaveBeenCalledWith(
      "result.pdf_failed",
      expect.objectContaining({
        job: "rj_1",
        step: "send",
        error: "kapso document upload returned HTTP 400",
      }),
    );
    expect(failing.log).toHaveBeenCalledWith(
      "result.pushed",
      expect.objectContaining({ via: "live" }),
    );

    const throwing = pdfDeps({
      sendDocument: async () => {
        throw new Error(SECRET_ANSWER);
      },
    });
    expect(await push(throwing.deps)).toBe("sent");
    expect(throwing.log).toHaveBeenCalledWith(
      "result.pdf_failed",
      expect.objectContaining({ step: "send" }),
    );
    expect(JSON.stringify(throwing.log.mock.calls)).not.toContain(SECRET_ANSWER);
  });

  const longOutcome = () =>
    outcome({
      answer: Array.from({ length: 150 }, (_, i) => `${ITALIAN} Paragrafo ${i}.`).join("\n\n"),
    });

  it("sends a long answer as one text message, then the PDF with the full content", async () => {
    const { deps, events, documents } = pdfDeps();
    expect(await push(deps, longOutcome())).toBe("sent");
    expect(events).toEqual([expect.stringMatching(/^text:/), "document"]);
    const sentTexts = vi.mocked(deps.send).mock.calls.map(([text]) => text);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]?.length).toBeLessThanOrEqual(RESEARCH_TEXT_LIMIT);
    expect(sentTexts[0]?.endsWith(`Continua su Lexroom: ${URL_A}`)).toBe(true);
    expect(sentTexts[0]).not.toContain("Paragrafo 149.");
    expect(documents).toHaveLength(1);
  });

  it("releases a held long answer as one message, then its PDF", async () => {
    const A = "390000000001";
    const closed = pdfDeps({ recipient: A, windowOpen: async () => false });
    await push(closed.deps, longOutcome());
    const reopened = pdfDeps({ recipient: A });
    expect(await releaseHeldResearch(reopened.deps)).toBe(1);
    const sentTexts = vi.mocked(reopened.deps.send).mock.calls.map(([text]) => text);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]?.length).toBeLessThanOrEqual(RESEARCH_TEXT_LIMIT);
    expect(sentTexts[0]?.endsWith(URL_A)).toBe(true);
    expect(reopened.events).toEqual([expect.stringMatching(/^text:/), "document"]);
  });

  it("sends no PDF for a failed or timed-out research, or an empty answer", async () => {
    const { deps } = pdfDeps();
    await push(deps, { ok: false, reason: "timeout", message: "m", error: "m" });
    await push(deps, { ok: false, error: "boom" });
    await push(deps, outcome({ answer: "  " }));
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(buildResearchPdf).not.toHaveBeenCalled();
  });

  it("sends no PDF when the recipient cannot be sent documents", async () => {
    const { deps, sent } = makeDeps();
    expect(await push(deps)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(buildResearchPdf).not.toHaveBeenCalled();
  });

  it("waits with the text for the window, then goes to the same number only", async () => {
    const A = "390000000001";
    const B = "390000000002";
    const forA = pdfDeps({ recipient: A, windowOpen: async () => false });
    const forB = pdfDeps({ recipient: B });
    await push(forA.deps);
    expect(forA.events).toEqual([]);
    expect(forA.deps.nudge).toHaveBeenCalled();
    await releaseHeldResearch(forB.deps);
    expect(forB.events).toEqual([]);

    const reopened = pdfDeps({ recipient: A });
    expect(await releaseHeldResearch(reopened.deps)).toBe(1);
    expect(reopened.events).toEqual([expect.stringMatching(/^text:/), "document"]);
    expect(forA.deps.sendDocument).not.toHaveBeenCalled();
    expect(forB.deps.sendDocument).not.toHaveBeenCalled();
  });

  it("sends the document to the number that asked through Kapso", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      isMediaUpload(url)
        ? new Response(JSON.stringify({ id: "media-1" }))
        : new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = {
        config: {
          channels: {
            "kapso-whatsapp": {
              apiKey: "kapso_test_key",
              phoneNumberId: "100000000000000",
              defaultTo: "+390000000009",
            },
          },
        },
        runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
        runtimeSource: "/fake/index.ts",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        pluginConfig: {},
      } as unknown as Parameters<typeof livePushDeps>[0];
      const live = livePushDeps(api, vi.fn(), "390000000001");
      const document = await buildResearchPdf({
        query: "q",
        answer: ITALIAN,
        sources: [],
        language: "it",
      });
      expect(await live.sendDocument?.(document)).toEqual({ ok: true, messageId: "wamid.1" });
      const body = jsonBody(fetchMock.mock.calls[1]?.[1]);
      expect(body).toMatchObject({ to: "390000000001", type: "document" });
      expect(body.document).toEqual({ id: "media-1", filename: document.filename });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
