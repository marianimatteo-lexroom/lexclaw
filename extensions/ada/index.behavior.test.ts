import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAdaLexroomAccountFromApi = vi.hoisted(() => vi.fn());
const openAdaGoogleAccountFromApi = vi.hoisted(() => vi.fn());
const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn());
const recordSenderInbound = vi.hoisted(() => vi.fn());

vi.mock("./src/lexroom-account.js", () => ({ openAdaLexroomAccountFromApi }));
vi.mock("./src/google-account.js", () => ({
  openAdaGoogleAccountFromApi,
  openAdaGoogleAccountDbFromApi: vi.fn(),
}));
vi.mock("./src/memory.js", () => ({
  openAdaMemoryFromApi: vi.fn(),
  openAdaMemoryIfExistsFromApi,
  openAdaRegistryFromApi: vi.fn(),
}));
vi.mock("./src/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/service.js")>()),
  recordSenderInbound,
}));

import plugin from "./index.js";
import { markResearchLinkReady, takeResearchLinks } from "./src/research-link-outbound.js";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const KAPSO_URL = "https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/messages";
const KAPSO_KEY = "kapso_test_key";
const MESSAGE_ID = "wamid.HBgMMzkwMDAwMDAwMDAwFQIAEhgUM0IyMjUwOEJBREUwODEyNEQ2MDkA";

const PLUGIN_CONFIG = {
  baseUrl: "https://lexroom.example",
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

const LAWYER = "390000000000";
const SESSION = `agent:main:kapso-whatsapp:direct:${LAWYER}`;

const HOST_CONFIG = {
  channels: {
    "kapso-whatsapp": {
      apiKey: KAPSO_KEY,
      phoneNumberId: "100000000000000",
      defaultTo: `+${LAWYER}`,
    },
  },
};

type ToolResult = { details: unknown };
type RegisteredTool = {
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};
type RegisteredHook = {
  handler: (event: unknown, ctx: unknown) => Promise<unknown>;
  options: unknown;
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** Every text Ada sent through the fake Kapso adapter: research results go to the asking number. */
const pushed: string[] = [];
const sendText = vi.fn(async (params: { to: string; text: string }) => {
  pushed.push(params.text);
});

/** The result message of a research: the second text, after the "started" acknowledgment. */
const researchResult = (nth = 1) =>
  vi.waitFor(() => {
    const text = pushed.filter((entry) => !entry.startsWith("Ho avviato la ricerca"))[nth - 1];
    if (text === undefined) {
      throw new Error("research result not sent yet");
    }
    return text;
  });

/** What the host knows about who is asking; by default the configured lawyer in a private chat. */
type ToolContext = { requesterSenderId?: string; messageChannel?: string; sessionKey?: string };

function registerAda(
  pluginConfig: Record<string, unknown> = PLUGIN_CONFIG,
  toolContext: ToolContext = { requesterSenderId: LAWYER, messageChannel: "kapso-whatsapp" },
) {
  const tools = new Map<string, RegisteredTool>();
  const hooks = new Map<string, RegisteredHook>();
  const api = createTestPluginApi({
    id: "ada",
    logger,
    config: HOST_CONFIG as OpenClawPluginApi["config"],
    pluginConfig,
    runtimeSource: "/fake/ada/index.ts",
    runtime: {
      channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
    } as unknown as OpenClawPluginApi["runtime"],
    registerTool(tool) {
      if (typeof tool === "function") {
        const built = tool(toolContext as never);
        for (const one of Array.isArray(built) ? built : [built]) {
          if (one && "name" in one) {
            tools.set(one.name, one as unknown as RegisteredTool);
          }
        }
      } else if ("name" in tool) {
        tools.set(tool.name, tool as unknown as RegisteredTool);
      }
    },
    on: ((name: string, handler: RegisteredHook["handler"], options?: unknown) => {
      hooks.set(name, { handler, options });
    }) as OpenClawPluginApi["on"],
  });
  plugin.register?.(api);
  async function callTool(name: string, params: unknown): Promise<unknown> {
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`tool ${name} is not registered`);
    }
    return (await tool.execute("call-1", params)).details;
  }
  return {
    api,
    callTool,
    /** ada_research starts a job; this waits for it through ada_research_status. */
    async research(params: unknown): Promise<unknown> {
      const started = (await callTool("ada_research", params)) as { jobId?: string };
      if (!started.jobId) {
        return started;
      }
      return await callTool("ada_research_status", { jobId: started.jobId, waitSeconds: 5 });
    },
    hook(name: string): RegisteredHook["handler"] {
      const hook = hooks.get(name);
      if (!hook) {
        throw new Error(`hook ${name} is not registered`);
      }
      return hook.handler;
    },
  };
}

function ndjson(...lines: unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
    status: 200,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

const fetchMock = vi.fn<typeof fetch>();

/** Lexroom's module lookup, answered with the modules the linked user may search. */
function modulesRoute(input: RequestInfo | URL, modules: string[] = ["Civile", "Societario"]) {
  return urlOf(input).endsWith("/v1/user/modules") ? json(modules) : undefined;
}

function askBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input]) => urlOf(input).endsWith("/v1/ask_me_anything"));
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

function lexroomAccount(overrides: Record<string, unknown> = {}) {
  return {
    email: "lawyer@example.com",
    accessToken: "test-account-token",
    refreshToken: "",
    accessExpiresAtMs: Date.now() + 3_600_000,
    connectedAtMs: 1,
    ...overrides,
  };
}

function useLexroomAccount(account: ReturnType<typeof lexroomAccount> | null) {
  openAdaLexroomAccountFromApi.mockResolvedValue({ readAccount: async () => account });
}

function googleAccount(overrides: Record<string, unknown> = {}) {
  return {
    email: "lawyer@example.com",
    refreshToken: "test-refresh-token",
    accessToken: "test-google-access-token",
    accessExpiresAtMs: Date.now() + 3_600_000,
    connectedAtMs: 1,
    scopes: "openid email https://www.googleapis.com/auth/gmail.send",
    ...overrides,
  };
}

function useGoogleAccount(account: ReturnType<typeof googleAccount> | null) {
  const store = {
    readAccount: vi.fn(async () => account),
    clearAccount: vi.fn(async () => {}),
    upsertAccount: vi.fn(async () => {}),
  };
  openAdaGoogleAccountFromApi.mockResolvedValue(store);
  return store;
}

beforeEach(() => {
  pushed.length = 0;
  takeResearchLinks("", LAWYER);
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ADA_STATUS_REACTIONS", "false");
  recordSenderInbound.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ada_draft confirmation gate", () => {
  const draft = { matterId: "matter-a", prompt: "Reply to opposing counsel" };

  it.each([
    ["false", false],
    ["missing", undefined],
    ["null", null],
    ["zero", 0],
    ["empty string", ""],
  ])("never calls Lexroom or opens an account when confirmed is %s", async (_label, confirmed) => {
    const { callTool } = registerAda();
    const result = await callTool("ada_draft", { ...draft, confirmed });
    expect(result).toEqual({
      ok: true,
      drafted: false,
      reason: "confirmation_required",
      matterId: "matter-a",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openAdaLexroomAccountFromApi).not.toHaveBeenCalled();
  });

  it("selects a module and drafts with the linked account token once confirmed", async () => {
    useLexroomAccount(lexroomAccount());
    const calls: Array<{ url: string; auth: string | null }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      calls.push({ url, auth: headerOf(init, "Authorization") });
      if (url.endsWith("/v2/ai/drafting/selectors")) {
        return json({ modules: [{ name: "Civile" }] });
      }
      return ndjson({
        research: {
          id: "draft-1",
          status: "DONE",
          draft: { title: "Lettera", content: "Gentile collega," },
        },
      });
    });
    const { callTool } = registerAda();
    expect(await callTool("ada_draft", { ...draft, confirmed: true })).toEqual({
      ok: true,
      drafted: true,
      matterId: "matter-a",
      researchId: "draft-1",
      status: "DONE",
      title: "Lettera",
      content: "Gentile collega,",
      sources: [],
    });
    expect(calls).toEqual([
      {
        url: "https://lexroom.example/v2/ai/drafting/selectors",
        auth: "Bearer test-account-token",
      },
      { url: "https://lexroom.example/v2/ai/drafting", auth: "Bearer test-account-token" },
    ]);
  });

  it("skips module selection when the caller names modules", async () => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockImplementation(async () =>
      ndjson({ research: { id: "draft-2", status: "DONE", draft: { content: "Bozza" } } }),
    );
    const { callTool } = registerAda();
    await callTool("ada_draft", { ...draft, confirmed: true, modules: ["Lavoro"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "https://lexroom.example/v2/ai/drafting",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      modules: ["Lavoro"],
    });
  });

  it("returns not_connected without any request when confirmed but no token exists", async () => {
    useLexroomAccount(null);
    const { callTool } = registerAda({ baseUrl: "https://lexroom.example" });
    expect(await callTool("ada_draft", { ...draft, confirmed: true })).toEqual({
      ok: false,
      reason: "not_connected",
      error: "Lexroom is not connected. Call ada_lexroom_connect and send that link.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an expired linked account instead of drafting", async () => {
    useLexroomAccount(lexroomAccount({ accessExpiresAtMs: Date.now() - 5000 }));
    const { callTool } = registerAda();
    expect(await callTool("ada_draft", { ...draft, confirmed: true })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "401",
      () => json({ detail: "expired" }, 401),
      "Lexroom rejected the saved sign-in. Call ada_lexroom_connect and send that link.",
    ],
    [
      "MFA step-up",
      () => json({ detail: "mfa_step_up_required" }, 403),
      "Lexroom requires a verified sign-in. Complete MFA, then refresh the Ada access token.",
    ],
    [
      "500 with detail",
      () => json({ detail: "overloaded" }, 500),
      "Lexroom returned 500: overloaded",
    ],
    ["503 without a body", () => new Response("", { status: 503 }), "Lexroom returned 503"],
  ])("returns a Lexroom %s failure from module selection", async (_label, respond, error) => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockImplementation(async () => respond());
    const { callTool } = registerAda();
    expect(await callTool("ada_draft", { ...draft, confirmed: true })).toMatchObject({
      ok: false,
      error,
    });
  });

  it("drafts with the user's modules when Lexroom selects none", async () => {
    useLexroomAccount(lexroomAccount({ accessToken: "draft-modules-token" }));
    const bodies: unknown[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const modules = modulesRoute(input, ["Tributario"]);
      if (modules) {
        return modules;
      }
      if (urlOf(input).endsWith("/v2/ai/drafting/selectors")) {
        return json({ modules: [] });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return ndjson({ research: { id: "draft-4", status: "DONE", draft: { content: "Bozza" } } });
    });
    const { callTool } = registerAda();
    expect(await callTool("ada_draft", { ...draft, confirmed: true })).toMatchObject({
      ok: true,
      drafted: true,
    });
    expect(bodies[0]).toMatchObject({ modules: ["Tributario"] });
  });

  it("fails when the draft stream ends before DONE", async () => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockImplementation(async () =>
      ndjson({ research: { id: "draft-3", status: "RUNNING" } }),
    );
    const { callTool } = registerAda();
    expect(await callTool("ada_draft", { ...draft, confirmed: true, modules: ["Civile"] })).toEqual(
      { ok: false, error: "Lexroom research stream ended before DONE" },
    );
  });

  it("returns a network failure as an error result", async () => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const { callTool } = registerAda();
    expect(await callTool("ada_draft", { ...draft, confirmed: true, modules: ["Civile"] })).toEqual(
      { ok: false, error: "socket hang up" },
    );
  });
});

describe("ada_research", () => {
  it("runs research with the linked account token and replaces citation ids", async () => {
    useLexroomAccount(lexroomAccount({ accessToken: "research-token" }));
    const seen: Array<{ url: string; method?: string; auth: string | null; body?: unknown }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      seen.push({
        url,
        method: init?.method,
        auth: headerOf(init, "Authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return (
        modulesRoute(input) ??
        ndjson({
          research: {
            id: "res-1",
            status: "DONE",
            answer: { text: "Il datore prova il fatto [1]." },
            documents: [{ files: [{ citation_id: 1, title: "Cass. civ. 1/2024" }] }],
          },
        })
      );
    });
    const { research } = registerAda();
    expect(
      await research({
        matterId: "matter-a",
        query: "Onere della prova",
        libraryDocumentIds: ["doc-1"],
      }),
    ).toMatchObject({ ok: true, state: "delivered", matterId: "matter-a", researchId: "res-1" });
    const text = await researchResult();
    expect(text).toContain("Il datore prova il fatto [1].");
    expect(text).toContain("[1] Cass. civ. 1/2024");
    expect(seen.map((call) => call.url)).toEqual([
      "https://lexroom.example/v1/user/modules",
      "https://lexroom.example/v1/ask_me_anything",
    ]);
    expect(seen[1]).toMatchObject({
      method: "POST",
      auth: "Bearer research-token",
      body: {
        query: "Onere della prova",
        search_on_user_data: true,
        library_documents: [{ document_ids: ["doc-1"] }],
        search_on_modules: ["Civile", "Societario"],
      },
    });
    expect(seen[1]?.body).not.toHaveProperty("documents");
  });

  it("sends the finished research with its link to the Lexroom app to the asking number", async () => {
    useLexroomAccount(lexroomAccount({ accessToken: "research-link-token" }));
    fetchMock.mockImplementation(
      async (input) =>
        modulesRoute(input) ??
        ndjson({ research: { id: "res-link", status: "DONE", answer: "ok" } }),
    );
    const { research } = registerAda({ ...PLUGIN_CONFIG, baseUrl: undefined });
    expect(await research({ matterId: "matter-a", query: "Question" })).toMatchObject({
      ok: true,
      state: "delivered",
      researchId: "res-link",
    });
    expect(await researchResult()).toContain(
      "Continua su Lexroom: https://app.lexroom.ai/research/res-link",
    );
  });

  describe("the final reply", () => {
    const ITALIAN =
      "Il termine per proporre opposizione a decreto ingiuntivo è di quaranta giorni dalla notifica, come previsto dalla legge, e non può essere prorogato.";

    /** A research result the model read (a deadline brief): its link waits for the next reply. */
    async function researchWith(config: Record<string, unknown>, _token: string, id: string) {
      const ada = registerAda(config);
      markResearchLinkReady(`https://app.lexroom.ai/research/${id}`, LAWYER);
      return ada;
    }

    const finalReply = async (ada: ReturnType<typeof registerAda>, text: string) =>
      (await ada.hook("reply_payload_sending")(
        { kind: "final", channel: "kapso-whatsapp", payload: { text } },
        { channelId: "kapso-whatsapp", sessionKey: SESSION },
      )) as { payload?: { text?: string } } | undefined;

    it("ends with the research link even though the model never wrote one", async () => {
      const ada = await researchWith(
        { ...PLUGIN_CONFIG, baseUrl: undefined },
        "final-link-1",
        "res-final-1",
      );
      expect((await finalReply(ada, ITALIAN))?.payload?.text).toBe(
        `${ITALIAN}\n\nContinua su Lexroom: https://app.lexroom.ai/research/res-final-1`,
      );
      expect(await finalReply(ada, ITALIAN)).toBeUndefined();
    });

    it("does not repeat a link the model did write", async () => {
      const ada = await researchWith(
        { ...PLUGIN_CONFIG, baseUrl: undefined },
        "final-link-2",
        "res-final-2",
      );
      const written = `${ITALIAN}\nhttps://app.lexroom.ai/research/res-final-2`;
      expect(await finalReply(ada, written)).toBeUndefined();
    });

    it("adds nothing when no research result reached the model", async () => {
      const ada = registerAda({ ...PLUGIN_CONFIG, baseUrl: undefined });
      expect(await finalReply(ada, ITALIAN)).toBeUndefined();
    });

    it("links a follow-up to the page of the thread it continues", async () => {
      useLexroomAccount(lexroomAccount({ accessToken: "final-link-3" }));
      let n = 0;
      fetchMock.mockImplementation(
        async (input) =>
          modulesRoute(input) ??
          ndjson({ research: { id: `thread-${(n += 1)}`, status: "DONE", answer: "ok" } }),
      );
      const ada = registerAda({ ...PLUGIN_CONFIG, baseUrl: undefined });
      await ada.research({ matterId: "matter-a", query: "First" });
      await researchResult(1);
      await ada.research({ matterId: "matter-a", query: "Second", parentResearchId: "thread-1" });
      expect(await researchResult(2)).toContain("https://app.lexroom.ai/research/thread-1");
    });
  });

  it("searches the configured research modules the user may search", async () => {
    useLexroomAccount(lexroomAccount({ accessToken: "configured-modules-token" }));
    fetchMock.mockImplementation(
      async (input) =>
        modulesRoute(input) ?? ndjson({ research: { id: "res-5", status: "DONE", answer: "ok" } }),
    );
    const { research } = registerAda({ ...PLUGIN_CONFIG, researchModules: ["Societario"] });
    await research({ matterId: "matter-a", query: "Question" });
    expect(askBody()).toMatchObject({ search_on_modules: ["Societario"] });
  });

  it("does not search the private library without document ids", async () => {
    useLexroomAccount(lexroomAccount({ accessToken: "no-library-token" }));
    fetchMock.mockImplementation(
      async (input) =>
        modulesRoute(input) ?? ndjson({ research: { id: "res-2", status: "DONE", answer: "ok" } }),
    );
    const { research } = registerAda();
    await research({ matterId: "matter-a", query: "Question" });
    const body = askBody();
    expect(body.search_on_user_data).toBe(false);
    expect(body).not.toHaveProperty("library_documents");
  });

  it("falls back to the static config token when no account is linked", async () => {
    useLexroomAccount(null);
    fetchMock.mockImplementation(
      async (input) =>
        modulesRoute(input) ?? ndjson({ research: { id: "res-3", status: "DONE", answer: "ok" } }),
    );
    const { research } = registerAda({ ...PLUGIN_CONFIG, accessToken: "test-config-token" });
    await research({ matterId: "matter-a", query: "Question" });
    const asked = fetchMock.mock.calls.find(([input]) =>
      urlOf(input).endsWith("/v1/ask_me_anything"),
    );
    expect(headerOf(asked?.[1], "Authorization")).toBe("Bearer test-config-token");
  });

  it("returns not_connected without a request when no token exists", async () => {
    useLexroomAccount(null);
    const { research } = registerAda();
    expect(await research({ matterId: "matter-a", query: "Question" })).toMatchObject({
      ok: true,
      state: "delivered",
    });
    expect(await researchResult()).toContain("Lexroom non è collegato");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank matter id", { matterId: "  ", query: "Question" }, "matterId is required"],
    ["a blank query", { matterId: "matter-a", query: "  " }, "query is required"],
  ])("rejects %s before any request", async (_label, params, error) => {
    useLexroomAccount(lexroomAccount());
    const { callTool } = registerAda();
    expect(await callTool("ada_research", params)).toEqual({ ok: false, error });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an HTTP failure and a stream error as error results", async () => {
    useLexroomAccount(lexroomAccount());
    const { research } = registerAda();
    fetchMock.mockImplementation(
      async (input) => modulesRoute(input) ?? json({ detail: "boom" }, 500),
    );
    expect(await research({ matterId: "matter-a", query: "Q" })).toMatchObject({
      ok: true,
      state: "delivered",
    });
    expect(await researchResult()).toContain("Lexroom returned 500: boom");
    pushed.length = 0;
    fetchMock.mockImplementation(
      async (input) =>
        modulesRoute(input) ??
        ndjson({ research: { id: "res-4", status: "RUNNING", error: "model unavailable" } }),
    );
    expect(await research({ matterId: "matter-a", query: "Q" })).toMatchObject({
      ok: true,
      state: "delivered",
    });
    expect(await researchResult()).toContain("model unavailable");
  });
});

describe("ada_send_email confirmation gate", () => {
  const email = { to: "paolo@example.com", subject: "Update", text: "Ciao Paolo." };

  it.each([
    ["false", false],
    ["missing", undefined],
    ["null", null],
    ["zero", 0],
    ["empty string", ""],
  ])(
    "never sends, reads the account, or touches the network when confirmed is %s",
    async (_label, confirmed) => {
      const store = useGoogleAccount(googleAccount());
      const { callTool } = registerAda();
      const result = await callTool("ada_send_email", { ...email, confirmed });
      expect(result).toMatchObject({ ok: false, reason: "confirmation_required" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.readAccount).not.toHaveBeenCalled();
    },
  );

  it("stays blocked for an unconfirmed call even when Google is not connected", async () => {
    const store = useGoogleAccount(null);
    const { callTool } = registerAda();
    expect(await callTool("ada_send_email", { ...email, confirmed: false })).toMatchObject({
      reason: "confirmation_required",
    });
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends exactly one message through Gmail once confirmed", async () => {
    useGoogleAccount(googleAccount());
    fetchMock.mockImplementation(async () => json({ id: "gmail-msg-1" }));
    const { callTool } = registerAda();
    expect(await callTool("ada_send_email", { ...email, confirmed: true })).toEqual({
      ok: true,
      email: "lawyer@example.com",
      id: "gmail-msg-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url as RequestInfo)).toBe(GMAIL_SEND_URL);
    expect(init?.method).toBe("POST");
    expect(headerOf(init, "authorization")).toBe("Bearer test-google-access-token");
    const raw = Buffer.from(
      (JSON.parse(String(init?.body)) as { raw: string }).raw,
      "base64url",
    ).toString("utf8");
    expect(raw).toContain("To: paolo@example.com");
    expect(raw).toContain("Subject: Update");
    expect(raw).toContain("Ciao Paolo.");
  });

  it("does not send when the saved connection lacks the send scope", async () => {
    useGoogleAccount(googleAccount({ scopes: "openid email" }));
    const { callTool } = registerAda();
    expect(await callTool("ada_send_email", { ...email, confirmed: true })).toMatchObject({
      ok: false,
      reason: "needs_send_scope",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send when Google is not connected", async () => {
    useGoogleAccount(null);
    const { callTool } = registerAda();
    expect(await callTool("ada_send_email", { ...email, confirmed: true })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["multiple recipients", { to: "a@example.com, b@example.com" }],
    ["a header-injecting recipient", { to: "a@example.com\r\nBcc: x@example.com" }],
    ["a multi-line subject", { subject: "Hi\r\nBcc: x@example.com" }],
    ["a blank body", { text: "  " }],
    ["an oversized body", { text: "x".repeat(20_001) }],
  ])("rejects %s even when confirmed", async (_label, override) => {
    useGoogleAccount(googleAccount());
    const { callTool } = registerAda();
    expect(
      await callTool("ada_send_email", { ...email, ...override, confirmed: true }),
    ).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { reason: "not_connected" }, true],
    [403, { reason: "needs_send_scope" }, false],
    [500, { error: "Ada could not send the email. Try again shortly." }, false],
  ])("maps a Gmail %i response without claiming success", async (status, expected, clears) => {
    const store = useGoogleAccount(googleAccount());
    fetchMock.mockImplementation(async () => json({ error: { message: "nope" } }, status));
    const { callTool } = registerAda();
    const result = await callTool("ada_send_email", { ...email, confirmed: true });
    expect(result).toMatchObject({ ok: false, ...expected });
    expect(store.clearAccount).toHaveBeenCalledTimes(clears ? 1 : 0);
  });

  it("reports a Gmail network failure without claiming success", async () => {
    useGoogleAccount(googleAccount());
    fetchMock.mockRejectedValue(new Error("offline"));
    const { callTool } = registerAda();
    expect(await callTool("ada_send_email", { ...email, confirmed: true })).toEqual({
      ok: false,
      error: "Ada could not send the email. Try again shortly.",
    });
  });
});

describe("message_received hook", () => {
  const inbound = { channelId: "kapso-whatsapp", messageId: MESSAGE_ID };

  it("marks the message read through Kapso and records the inbound wake", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T09:00:00.000Z"));
    fetchMock.mockImplementation(async () => json({ success: true }));
    const { hook } = registerAda();
    await hook("message_received")(
      { from: "+390000000000" },
      { ...inbound, senderId: "390000000000" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url as RequestInfo)).toBe(KAPSO_URL);
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: MESSAGE_ID,
    });
    expect(recordSenderInbound).toHaveBeenCalledWith({
      api: expect.anything(),
      atMs: Date.parse("2026-10-10T09:00:00.000Z"),
      channelId: "kapso-whatsapp",
      senders: ["+390000000000", "390000000000"],
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("reads channel and message ids from the event when the context has none", async () => {
    fetchMock.mockImplementation(async () => json({ success: true }));
    const { hook } = registerAda();
    await hook("message_received")({ channel: "kapso-whatsapp", messageId: MESSAGE_ID }, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordSenderInbound).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "kapso-whatsapp" }),
    );
  });

  it("does not call Kapso for other channels or synthetic message ids", async () => {
    const { hook } = registerAda();
    await hook("message_received")({}, { channelId: "telegram", messageId: MESSAGE_ID });
    await hook("message_received")(
      {},
      { channelId: "kapso-whatsapp", messageId: "390000000000:1791674081" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSenderInbound).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([400, 401, 404, 429, 500, 502, 503])(
    "logs a warning, still records the wake, and does not throw on Kapso HTTP %i",
    async (status) => {
      fetchMock.mockImplementation(async () => json({ error: "nope" }, status));
      const { hook } = registerAda();
      await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        `ada whatsapp read receipt failed: kapso read receipt returned HTTP ${status}`,
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(KAPSO_KEY);
      expect(logger.error).not.toHaveBeenCalled();
      expect(recordSenderInbound).toHaveBeenCalledTimes(1);
    },
  );

  it("logs a warning when the Kapso request fails at the network layer", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const { hook } = registerAda();
    await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "ada whatsapp read receipt failed: kapso read receipt request failed",
    );
    expect(recordSenderInbound).toHaveBeenCalledTimes(1);
  });

  it("gives up after the 10 second read-receipt timeout without blocking the wake record", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { hook } = registerAda();
    const settled = vi.fn();
    const pending = hook("message_received")({}, inbound).then(settled);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();
    expect(recordSenderInbound).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(logger.warn).toHaveBeenCalledWith(
      "ada whatsapp read receipt failed: kapso read receipt timed out",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("still sends the read receipt when recording the wake fails", async () => {
    fetchMock.mockImplementation(async () => json({ success: true }));
    recordSenderInbound.mockRejectedValue(new Error("sqlite is locked"));
    const { hook } = registerAda();
    await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("ada inbound wake record failed: sqlite is locked");
  });

  it("logs both failures when Kapso and the wake record fail together", async () => {
    fetchMock.mockImplementation(async () => json({}, 500));
    recordSenderInbound.mockRejectedValue("not an error object");
    const { hook } = registerAda();
    await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("ada inbound wake record failed: unknown");
  });
});

describe("before_prompt_build hook", () => {
  const TURN = { senderId: LAWYER, channelId: "kapso-whatsapp", sessionKey: SESSION };
  const PROFILE = {
    name: "Test Lawyer",
    timezone: "Europe/Rome",
    email: null,
    language: "it",
    jurisdiction: "IT",
    autonomy: "ask-first",
    channelStyle: "short",
    generatedAtMs: Date.parse("2026-10-10T08:30:00.000Z"),
  };
  const TODO = {
    id: "todo-1",
    matterId: "matter-a",
    owner: "lawyer",
    title: "Confirm hearing date",
    status: "pending",
    detail: "",
    updatedAtMs: 1,
  };

  function authority(allowed: boolean) {
    return { allows: vi.fn(() => allowed), assertActive: vi.fn() };
  }

  function useMemory(overrides: Record<string, unknown> = {}) {
    const memory = {
      readProfile: vi.fn(async () => PROFILE),
      listTodos: vi.fn(async () => [TODO]),
      ...overrides,
    };
    openAdaMemoryIfExistsFromApi.mockResolvedValue(memory);
    return memory;
  }

  it("requires tool authority at registration", () => {
    const registered = new Map<string, RegisteredHook>();
    const api = createTestPluginApi({
      id: "ada",
      on: ((name: string, handler: RegisteredHook["handler"], options?: unknown) => {
        registered.set(name, { handler, options });
      }) as OpenClawPluginApi["on"],
    });
    plugin.register?.(api);
    expect(registered.get("before_prompt_build")?.options).toEqual({
      requiresToolAuthority: true,
    });
  });

  it("injects the profile, open loops, and session id for an authorized turn", async () => {
    const memory = useMemory();
    const toolAuthority = authority(true);
    const { hook } = registerAda();
    const result = await hook("before_prompt_build")(
      {},
      { ...TURN, toolAuthority, sessionKey: SESSION },
    );
    expect(toolAuthority.allows).toHaveBeenCalledWith("ada_memory_search");
    expect(memory.readProfile).toHaveBeenCalledTimes(1);
    const { prependContext } = result as { prependContext: string };
    const blocks = prependContext.split("\n\n");
    expect(blocks[0]).toMatch(/^# Profile/u);
    expect(blocks[1]).toBe(
      "# Open loops\n- [todo-1] matter-a / lawyer / pending: Confirm hearing date",
    );
    expect(blocks[2]).toBe(`# Session\n- id: ${SESSION}`);
    expect(prependContext).not.toContain("# Matter ");
  });

  it("still injects an empty open-loop index when there is no profile or todo", async () => {
    useMemory({ readProfile: async () => null, listTodos: async () => [] });
    const { hook } = registerAda();
    expect(
      await hook("before_prompt_build")(
        {},
        { senderId: LAWYER, channelId: "kapso-whatsapp", toolAuthority: authority(true) },
      ),
    ).toEqual({ prependContext: "# Open loops\n(none)" });
  });

  it("injects nothing and never opens memory without tool authority", async () => {
    useMemory();
    const { hook } = registerAda();
    expect(await hook("before_prompt_build")({}, {})).toBeUndefined();
    expect(openAdaMemoryIfExistsFromApi).not.toHaveBeenCalled();
  });

  it("injects nothing when the turn is not allowed to use memory tools", async () => {
    useMemory();
    const { hook } = registerAda();
    expect(
      await hook("before_prompt_build")({}, { toolAuthority: authority(false) }),
    ).toBeUndefined();
    expect(openAdaMemoryIfExistsFromApi).not.toHaveBeenCalled();
  });

  it("drops the brief when authority is revoked while memory was being read", async () => {
    useMemory();
    const toolAuthority = authority(true);
    toolAuthority.assertActive.mockImplementation(() => {
      throw new Error("authority revoked");
    });
    const { hook } = registerAda();
    expect(await hook("before_prompt_build")({}, { ...TURN, toolAuthority })).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("ada brief inject failed: authority revoked");
  });

  it("revalidates authority only after memory has been read", async () => {
    const order: string[] = [];
    useMemory({
      readProfile: async () => {
        order.push("readProfile");
        return PROFILE;
      },
      listTodos: async () => {
        order.push("listTodos");
        return [];
      },
    });
    const toolAuthority = authority(true);
    toolAuthority.assertActive.mockImplementation(() => {
      order.push("assertActive");
    });
    const { hook } = registerAda();
    await hook("before_prompt_build")({}, { ...TURN, toolAuthority });
    expect(order.at(-1)).toBe("assertActive");
    expect(order).toHaveLength(3);
  });

  it("fails open with a logged error when the memory store cannot be opened", async () => {
    openAdaMemoryIfExistsFromApi.mockRejectedValue(new Error("worker crashed"));
    const { hook } = registerAda();
    expect(
      await hook("before_prompt_build")({}, { ...TURN, toolAuthority: authority(true) }),
    ).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("ada brief inject failed: worker crashed");
  });
});

describe("status reaction hooks", () => {
  it("reacts 👀 on the inbound message and removes it at agent_end, with no ⏳ or ✅", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ADA_STATUS_REACTIONS", "true");
    fetchMock.mockImplementation(async () => json({ success: true }));
    const { hook } = registerAda();
    const sessionKey = "agent:main:kapso-whatsapp:direct:390000000000";
    await hook("message_received")(
      { from: "+390000000000" },
      { channelId: "kapso-whatsapp", messageId: MESSAGE_ID, senderId: "390000000000", sessionKey },
    );
    await hook("llm_input")({ runId: "run-1" }, { sessionKey, trigger: "user" });
    await hook("before_tool_call")({ toolName: "ada_todo_list", runId: "run-1" }, { sessionKey });
    await vi.advanceTimersByTimeAsync(1_000);
    await hook("agent_end")(
      { runId: "run-1", success: true, messages: [] },
      { sessionKey, trigger: "user" },
    );
    await vi.advanceTimersByTimeAsync(0);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.filter((body) => body.type === "reaction").map((body) => body.reaction)).toEqual([
      { message_id: MESSAGE_ID, emoji: "👀" },
      { message_id: MESSAGE_ID, emoji: "" },
    ]);
  });
});
