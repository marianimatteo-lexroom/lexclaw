import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openAdaLexroomAccountFromApi = vi.hoisted(() => vi.fn());
const openAdaMemoryFromApi = vi.hoisted(() => vi.fn());
const recordLawyerInbound = vi.hoisted(() => vi.fn());

vi.mock("./src/lexroom-account.js", () => ({ openAdaLexroomAccountFromApi }));
vi.mock("./src/memory.js", () => ({ openAdaMemoryFromApi }));
vi.mock("./src/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/service.js")>()),
  recordLawyerInbound,
}));

import plugin from "./index.js";
import { takeResearchLinks } from "./src/research-link-outbound.js";
import { clearHeldResearch, recordSenderInbound } from "./src/research-push.js";

const LAWYER_CONFIG = {
  channels: {
    "kapso-whatsapp": {
      apiKey: "kapso_test_key",
      phoneNumberId: "100000000000000",
      defaultTo: "+390000000000",
    },
  },
};
const PLUGIN_CONFIG = { googleStateSecret: "state-secret-test-value" };

type Tool = { execute: (id: string, params: unknown) => Promise<{ details: unknown }> };
type Hook = (event: unknown, ctx: unknown) => Promise<unknown>;

const fetchMock = vi.fn<typeof fetch>();

/** Every text any Ada instance asked the Kapso adapter to send, with its destination. */
const sent: Array<{ to: string; text: string }> = [];
const textsTo = (to: string) => sent.filter((entry) => entry.to === to).map((entry) => entry.text);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ndjson = (...lines: unknown[]) =>
  new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { status: 200 });
const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
const modulesRoute = (input: RequestInfo | URL) =>
  urlOf(input).endsWith("/v1/user/modules") ? json(["Civile"]) : undefined;

/** Ada registered against a host with a fake Kapso adapter that records what it is asked to send. */
function registerAda(toolContext: { requesterSenderId?: string; messageChannel?: string }) {
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook>();
  const api = createTestPluginApi({
    id: "ada",
    config: LAWYER_CONFIG as OpenClawPluginApi["config"],
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (params: { to: string; text: string }) => {
              sent.push({ to: params.to, text: params.text });
            },
          }),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"],
    pluginConfig: PLUGIN_CONFIG,
    runtimeSource: "/fake/ada/index.ts",
    registerTool(tool) {
      const built = typeof tool === "function" ? tool(toolContext as never) : tool;
      for (const one of Array.isArray(built) ? built : [built]) {
        if (one && "name" in one) {
          tools.set(one.name, one as unknown as Tool);
        }
      }
    },
    on: ((name: string, handler: Hook) => {
      hooks.set(name, handler);
    }) as OpenClawPluginApi["on"],
  });
  plugin.register?.(api);
  return {
    callTool: async (name: string, params: unknown) =>
      (await tools.get(name)?.execute("call-1", params))?.details,
    hook: (name: string) => {
      const hook = hooks.get(name);
      if (!hook) {
        throw new Error(`hook ${name} is not registered`);
      }
      return hook;
    },
  };
}

beforeEach(() => {
  takeResearchLinks("");
  clearHeldResearch();
  sent.length = 0;
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ADA_STATUS_REACTIONS", "false");
  recordLawyerInbound.mockResolvedValue(undefined);
  openAdaMemoryFromApi.mockRejectedValue(new Error("no memory store in this test"));
  openAdaLexroomAccountFromApi.mockResolvedValue({
    readAccount: async () => ({
      email: "lawyer@example.com",
      accessToken: "push-e2e-token",
      password: "",
      refreshToken: "",
      accessExpiresAtMs: Date.now() + 3_600_000,
      connectedAtMs: 1,
    }),
  });
});

const CLIENT_A = { requesterSenderId: "+39 000 000 0001", messageChannel: "kapso-whatsapp" };
const CLIENT_B = { requesterSenderId: "+39 000 000 0002", messageChannel: "kapso-whatsapp" };

/** Lexroom answers each question with an answer that names it, under an id of its own. */
function answerByQuestion() {
  fetchMock.mockImplementation(async (input, init) => {
    const modules = modulesRoute(input);
    if (modules) {
      return modules;
    }
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    return ndjson({
      research: {
        id: `res-${query.includes("alfa") ? "a" : "b"}`,
        status: "DONE",
        answer: { text: `Il termine per ${query} è di quaranta giorni [1].` },
        documents: [{ files: [{ citation_id: 1, title: "Cass. civ. 1/2024" }] }],
      },
    });
  });
}

describe("ada_research for whoever asked on WhatsApp", () => {
  it("acknowledges at once and sends the answer with its link to the number that asked", async () => {
    const release = Promise.withResolvers<Response>();
    fetchMock.mockImplementation(async (input) => modulesRoute(input) ?? (await release.promise));
    const ada = registerAda(CLIENT_A);
    const started = (await ada.callTool("ada_research", {
      matterId: "matter-a",
      query: "Quanto dura il termine per proporre opposizione a decreto ingiuntivo?",
    })) as { jobId: string; requesterNotified: boolean; message: string };
    expect(started).toMatchObject({ ok: true, state: "running", requesterNotified: true });
    expect(started.message).toContain("NO_REPLY");
    expect(sent).toEqual([
      {
        to: "+390000000001",
        text: "Ho avviato la ricerca su Lexroom. Va avanti in background e ci vorrà circa un minuto o due: ti scrivo io appena è pronta.",
      },
    ]);

    release.resolve(
      ndjson({
        research: {
          id: "res-e2e",
          status: "DONE",
          answer: { text: "Il termine è di quaranta giorni dalla notifica [1]." },
          documents: [{ files: [{ citation_id: 1, title: "Cass. civ. 1/2024" }] }],
        },
      }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({
      to: "+390000000001",
      text: "Il termine è di quaranta giorni dalla notifica [1].\n\n*Fonti*\n[1] Cass. civ. 1/2024\n\nContinua su Lexroom: https://app.lexroom.ai/research/res-e2e",
    });

    // A model that polls anyway gets no answer to say a second time, and no link to append.
    const polled = await ada.callTool("ada_research_status", {
      jobId: started.jobId,
      waitSeconds: 0,
    });
    expect(polled).toMatchObject({ ok: true, state: "delivered", delivery: "sent" });
    expect(JSON.stringify(polled)).not.toContain("quaranta giorni");
    expect(
      await ada.hook("reply_payload_sending")(
        { kind: "final", channel: "kapso-whatsapp", payload: { text: "Fatto." } },
        { channelId: "kapso-whatsapp" },
      ),
    ).toBeUndefined();
  });

  it("gives two senders only their own acknowledgement and result, never the configured number", async () => {
    answerByQuestion();
    const [a, b] = [registerAda(CLIENT_A), registerAda(CLIENT_B)];
    const [startedA, startedB] = (await Promise.all([
      a.callTool("ada_research", { matterId: "m-a", query: "il caso alfa" }),
      b.callTool("ada_research", { matterId: "m-b", query: "il caso beta" }),
    ])) as Array<{ jobId: string }>;
    await vi.waitFor(() => {
      expect(textsTo("+390000000001")).toHaveLength(2);
      expect(textsTo("+390000000002")).toHaveLength(2);
    });
    expect(textsTo("+390000000001")[1]).toContain("il caso alfa");
    expect(textsTo("+390000000001").join("\n")).not.toContain("beta");
    expect(textsTo("+390000000002")[1]).toContain("il caso beta");
    expect(textsTo("+390000000002").join("\n")).not.toContain("alfa");
    expect(sent.map((entry) => entry.to).filter((to) => to === "+390000000000")).toEqual([]);

    // Each sender's model can read only its own job.
    expect(
      await b.callTool("ada_research_status", { jobId: startedA?.jobId, waitSeconds: 0 }),
    ).toMatchObject({ ok: false, reason: "unknown_job" });
    expect(
      await b.callTool("ada_research_status", { jobId: startedB?.jobId, waitSeconds: 0 }),
    ).toMatchObject({ ok: true, state: "delivered" });
  });

  it("holds the result of a sender whose window is closed, and sends it when that sender next writes", async () => {
    answerByQuestion();
    recordSenderInbound("390000000002", Date.now() - 25 * 3600_000);
    const [a, b] = [registerAda(CLIENT_A), registerAda(CLIENT_B)];
    await a.hook("message_received")(
      { from: "+39 000 000 0001" },
      { channelId: "kapso-whatsapp", senderId: "390000000001" },
    );
    await Promise.all([
      a.callTool("ada_research", { matterId: "m-a", query: "il caso alfa" }),
      b.callTool("ada_research", { matterId: "m-b", query: "il caso beta" }),
    ]);
    await vi.waitFor(() => expect(textsTo("+390000000001")).toHaveLength(2));
    // B's window is closed: the acknowledgement is sent (it is cheap to try) but the answer waits.
    expect(textsTo("+390000000002").join("\n")).not.toContain("il caso beta");

    // A writing again releases nothing of B's.
    await a.hook("message_received")(
      { from: "+39 000 000 0001" },
      { channelId: "kapso-whatsapp", senderId: "390000000001" },
    );
    await Promise.resolve();
    expect(textsTo("+390000000002").join("\n")).not.toContain("il caso beta");

    await b.hook("message_received")(
      { from: "+39 000 000 0002" },
      { channelId: "kapso-whatsapp", senderId: "390000000002" },
    );
    await vi.waitFor(() => expect(textsTo("+390000000002").join("\n")).toContain("il caso beta"));
    expect(textsTo("+390000000001").join("\n")).not.toContain("beta");
  });
});
