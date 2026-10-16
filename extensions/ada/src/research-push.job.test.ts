import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomAccountRecord } from "./lexroom-account-contract.js";

const readAccount = vi.hoisted(() => vi.fn());

vi.mock("./lexroom-account.js", () => ({
  openAdaLexroomAccountFromApi: async () => ({
    readAccount,
    upsertAccount: vi.fn(async () => {}),
    clearAccount: vi.fn(async () => {}),
  }),
}));

import { readResearchJob } from "./lexroom-jobs.js";
import { startAdaResearch } from "./lexroom-tools.js";
import { takeResearchLinks } from "./research-link-outbound.js";
import {
  clearHeldResearch,
  releaseHeldResearch,
  senderNumber,
  type PushDeps,
} from "./research-push.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const api = { config: {}, logger, runtimeSource: "/fake/index.ts", runtime: {} } as never;

const A = { senderId: "+39 000 000 0001", channel: "kapso-whatsapp" };
const B = { senderId: "+39 000 000 0002", channel: "kapso-whatsapp" };
const NUMBER_A = "390000000001";
const NUMBER_B = "390000000002";

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A Lexroom that answers the user-modules call and routes the rest by path. */
function lexroom(routes: Record<string, Route>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    if (path === "/v1/user/modules") {
      return json(["Civile"]);
    }
    const route = routes[path];
    if (!route) {
      throw new Error(`unexpected request ${path}`);
    }
    return await route(init);
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const answerStream = (id: string, text: string) =>
  new Response(
    `${JSON.stringify({ research: { id, status: "DONE", answer: { text }, documents: [] } })}\n`,
  );

/** Everything Ada sends, per recipient, with a window each number can have open or closed. */
function whatsapp(windows: Record<string, boolean | null> = {}) {
  const sent = new Map<string, string[]>();
  const nudged: string[] = [];
  const log = vi.fn();
  const failNextSendTo = new Set<string>();
  const depsFor = (recipient: string): PushDeps => ({
    recipient,
    send: async (text) => {
      if (failNextSendTo.delete(recipient)) {
        return { ok: false, error: "kapso down" };
      }
      sent.set(recipient, [...(sent.get(recipient) ?? []), text]);
      return { ok: true };
    },
    windowOpen: async () => windows[recipient] ?? true,
    nudge: async () => {
      nudged.push(recipient);
      return "sent";
    },
    log,
    now: Date.now,
    retryDelayMs: 0,
  });
  return { sent, nudged, log, depsFor, failNextSendTo, to: (r: string) => sent.get(r) ?? [] };
}

beforeEach(() => {
  clearHeldResearch();
  takeResearchLinks("");
  const record: LexroomAccountRecord = {
    email: "lawyer@example.com",
    accessToken: `push-${Math.random()}`,
    password: "",
    refreshToken: "",
    accessExpiresAtMs: Date.now() + 3_600_000,
    connectedAtMs: 1,
  };
  readAccount.mockResolvedValue(record);
});

describe("ada_research tells the requester and sends the result", () => {
  const research = { matterId: "m", query: "Termini per l'opposizione" };
  const start = (
    requester: { senderId?: string; channel?: string; conversationId?: string },
    wa: ReturnType<typeof whatsapp>,
    fetchImpl: typeof fetch,
    query = research.query,
  ) =>
    startAdaResearch({
      args: { ...research, query },
      config: {},
      api,
      requester,
      fetchImpl,
      pushDepsFor: wa.depsFor,
    });

  it("acknowledges the requester before the research ends, then sends them the answer", async () => {
    const finish = Promise.withResolvers<Response>();
    const server = lexroom({ "/v1/ask_me_anything": () => finish.promise });
    const wa = whatsapp();
    const started = await start(A, wa, server);
    expect(started).toMatchObject({
      ok: true,
      state: "running",
      requesterNotified: true,
      message: expect.stringContaining("NO_REPLY"),
    });
    expect(wa.to(NUMBER_A)).toHaveLength(1);
    expect(wa.to(NUMBER_A)[0]).toContain("Ho avviato la ricerca su Lexroom");

    finish.resolve(answerStream("r-push", "Quaranta giorni [1]"));
    await vi.waitFor(() => expect(wa.to(NUMBER_A)).toHaveLength(2));
    expect(wa.to(NUMBER_A)[1]).toBe(
      "Quaranta giorni [1]\n\nContinua su Lexroom: https://app.lexroom.ai/research/r-push",
    );
    if (!started.ok) {
      throw new Error("expected a job");
    }
    await expect(
      readResearchJob({ jobId: started.jobId, requester: NUMBER_A, waitSeconds: 1 }),
    ).resolves.toMatchObject({ ok: true, state: "delivered", delivery: "sent" });
    expect(takeResearchLinks("")).toEqual([]);
  });

  it("gives two different senders only their own acknowledgement and their own result", async () => {
    const server = lexroom({
      "/v1/ask_me_anything": (init) => {
        const query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return answerStream(`r-${query.includes("alfa") ? "a" : "b"}`, `Risposta su ${query}`);
      },
    });
    const wa = whatsapp();
    const [startedA, startedB] = await Promise.all([
      start(A, wa, server, "il caso alfa"),
      start(B, wa, server, "il caso beta"),
    ]);
    await vi.waitFor(() => {
      expect(wa.to(NUMBER_A)).toHaveLength(2);
      expect(wa.to(NUMBER_B)).toHaveLength(2);
    });
    expect(wa.to(NUMBER_A)[1]).toContain("Risposta su il caso alfa");
    expect(wa.to(NUMBER_A).join("\n")).not.toContain("beta");
    expect(wa.to(NUMBER_A).join("\n")).toContain("research/r-a");
    expect(wa.to(NUMBER_B)[1]).toContain("Risposta su il caso beta");
    expect(wa.to(NUMBER_B).join("\n")).not.toContain("alfa");
    expect(wa.to(NUMBER_B).join("\n")).toContain("research/r-b");
    expect([...wa.sent.keys()].toSorted()).toEqual([NUMBER_A, NUMBER_B]);

    // One sender cannot read the other's job, even with its id.
    if (!startedA.ok || !startedB.ok) {
      throw new Error("expected two jobs");
    }
    expect(
      await readResearchJob({ jobId: startedA.jobId, requester: NUMBER_B, waitSeconds: 0 }),
    ).toMatchObject({ ok: false, reason: "unknown_job" });
    expect(
      await readResearchJob({ jobId: startedA.jobId, requester: undefined, waitSeconds: 0 }),
    ).toMatchObject({ ok: false, reason: "unknown_job" });
    expect(
      await readResearchJob({ jobId: startedB.jobId, requester: NUMBER_B, waitSeconds: 0 }),
    ).toMatchObject({ ok: true, state: "delivered" });
  });

  it("holds a closed window's result under that sender only, and sends the other at once", async () => {
    const server = lexroom({
      "/v1/ask_me_anything": (init) =>
        answerStream(
          "r-x",
          `Risposta su ${(JSON.parse(String(init?.body)) as { query: string }).query}`,
        ),
    });
    const wa = whatsapp({ [NUMBER_B]: false });
    await Promise.all([start(A, wa, server, "il caso alfa"), start(B, wa, server, "il caso beta")]);
    await vi.waitFor(() => expect(wa.nudged).toEqual([NUMBER_B]));
    await vi.waitFor(() => expect(wa.to(NUMBER_A)).toHaveLength(2));
    expect(wa.to(NUMBER_B).join("\n")).not.toContain("Risposta su il caso beta");

    // A writing again releases nothing of B's; B writing releases B's, and only B's.
    expect(await releaseHeldResearch(wa.depsFor(NUMBER_A))).toBe(0);
    expect(await releaseHeldResearch(wa.depsFor(NUMBER_B))).toBe(1);
    expect(wa.to(NUMBER_B).join("\n")).toContain("Risposta su il caso beta");
    expect(wa.to(NUMBER_A).join("\n")).not.toContain("beta");
  });

  it("logs ack.sent and result.pushed", async () => {
    const server = lexroom({ "/v1/ask_me_anything": () => answerStream("r1", "ok") });
    const wa = whatsapp();
    await start(A, wa, server);
    await vi.waitFor(() => expect(wa.to(NUMBER_A)).toHaveLength(2));
    expect(wa.log.mock.calls.map(([event]) => event)).toEqual(["ack.sent", "result.pushed"]);
  });

  it("sends the result even when the acknowledgement could not be sent, and says so", async () => {
    const server = lexroom({ "/v1/ask_me_anything": () => answerStream("r1", "Quaranta giorni") });
    const wa = whatsapp();
    wa.failNextSendTo.add(NUMBER_A);
    const started = await start(A, wa, server);
    expect(started).toMatchObject({
      requesterNotified: false,
      message: expect.stringContaining("tell them in one short line"),
    });
    await vi.waitFor(() => expect(wa.to(NUMBER_A)).toHaveLength(1));
    expect(wa.to(NUMBER_A)[0]).toContain("Quaranta giorni");
  });

  it("tells the requester when the research fails or times out", async () => {
    const server = lexroom({ "/v1/ask_me_anything": () => json({ detail: "boom" }, 500) });
    const wa = whatsapp();
    await start(B, wa, server);
    await vi.waitFor(() => expect(wa.to(NUMBER_B)).toHaveLength(2));
    expect(wa.to(NUMBER_B)[1]).toContain("La ricerca su Lexroom non è andata a buon fine.");
    expect(wa.to(NUMBER_B)[1]).toContain("Lexroom returned 500: boom");
    expect(wa.to(NUMBER_A)).toEqual([]);
  });

  it.each<[string, { senderId?: string; channel?: string; conversationId?: string }, string]>([
    ["an unknown sender", {}, "sender_unknown"],
    ["a sender id that is not a phone number", { senderId: "webchat-user-7" }, "sender_unknown"],
    ["another channel", { senderId: A.senderId, channel: "telegram" }, "other_channel"],
    ["a group chat", { ...A, conversationId: "120363025246125486@g.us" }, "group_chat"],
  ])(
    "falls back to reading the result with the status tool for %s",
    async (_label, requester, reason) => {
      const server = lexroom({
        "/v1/ask_me_anything": () => answerStream("r1", "Quaranta giorni [1]"),
      });
      const wa = whatsapp();
      const started = await start(requester, wa, server);
      expect(started).toMatchObject({ ok: true, state: "running" });
      expect(started).not.toHaveProperty("requesterNotified");
      if (!started.ok) {
        throw new Error("expected a job");
      }
      const read = await readResearchJob({
        jobId: started.jobId,
        requester: senderNumber(requester.senderId) ?? undefined,
        waitSeconds: 1,
      });
      expect(read).toMatchObject({ ok: true, state: "done", answer: "Quaranta giorni [1]" });
      expect(wa.sent.size).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(`ack.skipped reason=${reason}`),
      );
    },
  );
});
