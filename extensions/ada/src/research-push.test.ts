import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomFailure, ResearchOutcome } from "./lexroom-client.js";
import {
  chunkMessage,
  clearHeldResearch,
  pushResearchResult,
  releaseHeldResearch,
  researchAckText,
  researchMessages,
  sendResearchAck,
  type PushDeps,
} from "./research-push.js";

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
});

describe("chunkMessage", () => {
  it("keeps a short text whole", () => {
    expect(chunkMessage("ciao")).toEqual(["ciao"]);
    expect(chunkMessage("  ")).toEqual([]);
  });

  it("splits at paragraphs, then lines, then words, never past the limit", () => {
    const paragraph = (n: number) => `${"parola ".repeat(40).trim()} ${n}`;
    const text = [1, 2, 3, 4].map(paragraph).join("\n\n");
    const chunks = chunkMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 500)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/gu, " ")).toBe(text.replace(/\s+/gu, " "));
    expect(chunkMessage("x".repeat(1200), 500).map((chunk) => chunk.length)).toEqual([
      500, 500, 200,
    ]);
  });
});

describe("researchMessages", () => {
  it("is the answer, the cited sources and the link line, last", async () => {
    expect(await researchMessages(outcome(), {})).toEqual([
      `${ITALIAN} [1]\n\n*Fonti*\n[1] Cass. civ. 1/2024 - Suprema Corte di Cassazione, 01/02/2024\n\nContinua su Lexroom: ${URL_A}`,
    ]);
  });

  it("follows the answer's language", async () => {
    const [text] = await researchMessages(outcome({ answer: `${ENGLISH} [1]` }), {});
    expect(text).toContain("*Sources*");
    expect(text?.endsWith(`Continue in Lexroom: ${URL_A}`)).toBe(true);
  });

  it("leaves out what a research does not have", async () => {
    expect(await researchMessages(outcome({ sources: [], researchUrl: undefined }), {})).toEqual([
      `${ITALIAN} [1]`,
    ]);
  });

  it("keeps the link in the last message of a long answer", async () => {
    const messages = await researchMessages(outcome({ answer: `${ITALIAN}\n\n`.repeat(120) }), {});
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 3500)).toBe(true);
    expect(messages.at(-1)?.endsWith(URL_A)).toBe(true);
    expect(messages.slice(0, -1).join("")).not.toContain(URL_A);
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
      "a missing connection, without the instruction meant for the model",
      {
        ok: false,
        reason: "not_connected",
        error: "Lexroom is not connected. Call ada_lexroom_connect and send that link.",
      },
      "Lexroom non è collegato: chiedimi di collegarlo e ti mando il link.",
    ],
    [
      "another failure",
      { ok: false, error: "Lexroom ha negato la richiesta (403): permessi." },
      "Lexroom ha negato la richiesta (403): permessi.",
    ],
  ])("is one short message for %s", async (_label, failure, reason) => {
    expect(await researchMessages(failure, {})).toEqual([
      `La ricerca su Lexroom non è andata a buon fine.\n${reason}\nDimmi se vuoi che riprovi.`,
    ]);
  });

  it("uses the profile language when there is no text to tell it from", async () => {
    const [text] = await researchMessages(
      { ok: false, reason: "timeout", message: "x", error: "x" },
      { readProfileLanguage: async () => "English" },
    );
    expect(text).toContain("The Lexroom research did not complete.");
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
    pushResearchResult({ jobId: "rj_1", startedAtMs: 4_000, result }, deps);

  it("sends the result as a new message and logs result.pushed", async () => {
    const { deps, sent, log } = makeDeps();
    expect(await push(deps)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(URL_A);
    expect(log).toHaveBeenCalledWith("result.pushed", {
      job: "rj_1",
      outcome: "done",
      chunks: 1,
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

  it("sends in order when the answer takes several messages", async () => {
    const { deps, sent } = makeDeps();
    await push(deps, outcome({ answer: `${ITALIAN}\n\n`.repeat(120) }));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.at(-1)).toContain(URL_A);
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
  const hold = async (jobId: string, result: ResearchOutcome = outcome()) => {
    const closed = makeDeps({ windowOpen: async () => false });
    await pushResearchResult({ jobId, startedAtMs: 0, result }, closed.deps);
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

  it("does not resend messages of a result that were already delivered", async () => {
    const sentBefore: string[] = [];
    let calls = 0;
    const flaky = makeDeps({
      send: async (text) => {
        calls += 1;
        if (calls >= 2) {
          return { ok: false, error: "down" };
        }
        sentBefore.push(text);
        return { ok: true };
      },
    });
    await pushResearchResult(
      { jobId: "rj_1", startedAtMs: 0, result: outcome({ answer: `${ITALIAN}\n\n`.repeat(120) }) },
      flaky.deps,
    );
    const rest = makeDeps();
    await releaseHeldResearch(rest.deps);
    expect(sentBefore).toHaveLength(1);
    expect(rest.sent.length).toBeGreaterThan(0);
    expect(rest.sent).not.toContain(sentBefore[0]);
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
