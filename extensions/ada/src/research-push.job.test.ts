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
import { clearHeldResearch } from "./research-push.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type Route = () => Response | Promise<Response>;

/** A Lexroom that answers the user-modules call and routes the rest by path. */
function lexroom(routes: Record<string, Route>) {
  return vi.fn(async (input: RequestInfo | URL) => {
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
    return await route();
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ada_research tells the lawyer and sends the result", () => {
  const research = { matterId: "m", query: "Termini per l'opposizione" };
  const LAWYER = "+39 000 000 0000";
  const lawyerApi = {
    config: { channels: { "kapso-whatsapp": { defaultTo: "+390000000000" } } },
    logger,
    runtimeSource: "/fake/index.ts",
    runtime: {},
  } as never;
  const liveAccount = () => {
    const record: LexroomAccountRecord = {
      email: "lawyer@example.com",
      accessToken: `push-${Math.random()}`,
      password: "",
      refreshToken: "",
      accessExpiresAtMs: Date.now() + 3_600_000,
      connectedAtMs: 1,
    };
    readAccount.mockResolvedValue(record);
  };

  function pushHarness() {
    const sent: string[] = [];
    const pushDeps = {
      send: vi.fn(async (text: string): Promise<{ ok: true } | { ok: false; error: string }> => {
        sent.push(text);
        return { ok: true };
      }),
      windowOpen: async () => true,
      nudge: vi.fn(async () => "sent" as const),
      log: vi.fn(),
      retryDelayMs: 0,
    };
    return { sent, pushDeps };
  }

  const answerStream = () =>
    new Response(
      `${JSON.stringify({ research: { id: "r-push", status: "DONE", answer: { text: "Quaranta giorni [1]" }, documents: [{ files: [{ citation_id: 1, title: "Cass. civ. 1/2024" }] }] } })}\n`,
    );

  beforeEach(() => {
    clearHeldResearch();
    takeResearchLinks("");
  });

  it("acknowledges before the research ends, then sends the answer without being asked", async () => {
    liveAccount();
    const finish = Promise.withResolvers<Response>();
    const server = lexroom({ "/v1/ask_me_anything": () => finish.promise });
    const { sent, pushDeps } = pushHarness();
    const started = await startAdaResearch({
      args: research,
      config: {},
      api: lawyerApi,
      requester: { senderId: LAWYER, channel: "kapso-whatsapp" },
      fetchImpl: server,
      pushDeps,
    });
    expect(started).toMatchObject({
      ok: true,
      state: "running",
      lawyerNotified: true,
      message: expect.stringContaining("NO_REPLY"),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Ho avviato la ricerca su Lexroom");

    finish.resolve(answerStream());
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toBe(
      "Quaranta giorni [1]\n\n*Fonti*\n[1] Cass. civ. 1/2024\n\nContinua su Lexroom: https://app.lexroom.ai/research/r-push",
    );
    if (!started.ok) {
      throw new Error("expected a job");
    }
    await expect(readResearchJob({ jobId: started.jobId, waitSeconds: 1 })).resolves.toMatchObject({
      ok: true,
      state: "delivered",
      delivery: "sent",
    });
    expect(takeResearchLinks("")).toEqual([]);
  });

  it("logs ack.sent and result.pushed", async () => {
    liveAccount();
    const server = lexroom({ "/v1/ask_me_anything": () => answerStream() });
    const { sent, pushDeps } = pushHarness();
    const logged: Array<[string, unknown]> = [];
    pushDeps.log.mockImplementation((event: string, fields: unknown) =>
      logged.push([event, fields]),
    );
    await startAdaResearch({
      args: research,
      config: {},
      api: lawyerApi,
      requester: { senderId: LAWYER, channel: "kapso-whatsapp" },
      fetchImpl: server,
      pushDeps,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(logged.map(([event]) => event)).toEqual(["ack.sent", "result.pushed"]);
  });

  it("sends the result even when the acknowledgement could not be sent, and says so", async () => {
    liveAccount();
    const server = lexroom({ "/v1/ask_me_anything": () => answerStream() });
    const { sent, pushDeps } = pushHarness();
    pushDeps.send.mockImplementationOnce(async () => ({ ok: false, error: "kapso down" }));
    const started = await startAdaResearch({
      args: research,
      config: {},
      api: lawyerApi,
      requester: { senderId: LAWYER },
      fetchImpl: server,
      pushDeps,
    });
    expect(started).toMatchObject({
      lawyerNotified: false,
      message: expect.stringContaining("tell them in one short line"),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain("Quaranta giorni");
  });

  it("tells the lawyer when the research fails or times out", async () => {
    liveAccount();
    const server = lexroom({ "/v1/ask_me_anything": () => json({ detail: "boom" }, 500) });
    const { sent, pushDeps } = pushHarness();
    await startAdaResearch({
      args: research,
      config: {},
      api: lawyerApi,
      requester: { senderId: LAWYER },
      fetchImpl: server,
      pushDeps,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toContain("La ricerca su Lexroom non è andata a buon fine.");
    expect(sent[1]).toContain("Lexroom returned 500: boom");
  });

  it("does nothing on WhatsApp for anyone but the configured lawyer", async () => {
    liveAccount();
    const server = lexroom({ "/v1/ask_me_anything": () => answerStream() });
    for (const requester of [
      { senderId: "+39 111 111 1111", channel: "kapso-whatsapp" },
      { senderId: LAWYER, channel: "webchat" },
      {},
    ]) {
      const { sent, pushDeps } = pushHarness();
      const started = await startAdaResearch({
        args: research,
        config: {},
        api: lawyerApi,
        requester,
        fetchImpl: server,
        pushDeps,
      });
      expect(started).toMatchObject({ ok: true, state: "running" });
      expect(started).not.toHaveProperty("lawyerNotified");
      if (!started.ok) {
        throw new Error("expected a job");
      }
      const read = await readResearchJob({ jobId: started.jobId, waitSeconds: 1 });
      expect(read).toMatchObject({ ok: true, state: "done", answer: "Quaranta giorni [1]" });
      expect(sent).toEqual([]);
    }
  });
});
