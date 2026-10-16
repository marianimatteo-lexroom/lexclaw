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
import { clearHeldResearch, pushResearchResult } from "./src/research-push.js";

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
  const texts: string[] = [];
  const api = createTestPluginApi({
    id: "ada",
    config: LAWYER_CONFIG as OpenClawPluginApi["config"],
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (params: { to: string; text: string }) => {
              expect(params.to).toBe("+390000000000");
              texts.push(params.text);
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
    texts,
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

describe("ada_research for the lawyer", () => {
  it("acknowledges at once, sends the answer with its link, and leaves the model nothing to repeat", async () => {
    const release = Promise.withResolvers<Response>();
    fetchMock.mockImplementation(async (input) => modulesRoute(input) ?? (await release.promise));
    const ada = registerAda({
      requesterSenderId: "+39 000 000 0000",
      messageChannel: "kapso-whatsapp",
    });
    const { texts } = ada;
    const started = (await ada.callTool("ada_research", {
      matterId: "matter-a",
      query: "Quanto dura il termine per proporre opposizione a decreto ingiuntivo?",
    })) as { jobId: string; lawyerNotified: boolean; message: string };
    expect(started).toMatchObject({ ok: true, state: "running", lawyerNotified: true });
    expect(started.message).toContain("NO_REPLY");
    expect(texts).toEqual([
      "Ho avviato la ricerca su Lexroom. Va avanti in background e ci vorrà circa un minuto o due: ti scrivo io appena è pronta.",
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
    await vi.waitFor(() => expect(texts).toHaveLength(2));
    expect(texts[1]).toBe(
      "Il termine è di quaranta giorni dalla notifica [1].\n\n*Fonti*\n[1] Cass. civ. 1/2024\n\nContinua su Lexroom: https://app.lexroom.ai/research/res-e2e",
    );

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

  it("holds a result the closed window cannot take, and sends it when the lawyer next writes", async () => {
    clearHeldResearch();
    const ada = registerAda({});
    const { texts } = ada;
    await pushResearchResult(
      {
        jobId: "rj_held",
        startedAtMs: 0,
        result: {
          ok: true,
          matterId: "m",
          researchId: "res-held",
          researchUrl: "https://app.lexroom.ai/research/res-held",
          status: "DONE",
          answer: "Il termine è di quaranta giorni dalla notifica [1].",
          sources: [],
        },
      },
      {
        send: async () => ({ ok: true }),
        windowOpen: async () => false,
        nudge: async () => "sent",
        log: vi.fn(),
      },
    );
    expect(texts).toEqual([]);

    await ada.hook("message_received")(
      { from: "+39 111 111 1111" },
      { channelId: "kapso-whatsapp", senderId: "391111111111" },
    );
    await Promise.resolve();
    expect(texts).toEqual([]);

    await ada.hook("message_received")(
      { from: "+390000000000" },
      { channelId: "kapso-whatsapp", senderId: "390000000000" },
    );
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain("quaranta giorni");
    expect(texts[0]?.endsWith("https://app.lexroom.ai/research/res-held")).toBe(true);
  });
});
