import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openAdaLexroomAccountFromApi = vi.hoisted(() => vi.fn());
const openAdaGoogleAccountFromApi = vi.hoisted(() => vi.fn());
const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn());

vi.mock("./lexroom-account.js", () => ({ openAdaLexroomAccountFromApi }));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi,
  openAdaGoogleAccountDbFromApi: vi.fn(),
}));
vi.mock("./memory.js", () => ({
  openAdaMemoryFromApi: vi.fn(),
  openAdaMemoryIfExistsFromApi,
  openAdaRegistryFromApi: vi.fn(),
}));

import plugin from "../index.js";
import { markResearchLinkReady, takeResearchLinks } from "./research-link-outbound.js";

/** Anna is the configured lawyer and has connected everything; Bruno has connected nothing. */
const ANNA = "393331111111";
const BRUNO = "393332222222";
const CARLA = "393333333333";
const direct = (number: string) => `agent:main:kapso-whatsapp:direct:${number}`;

const HOST_CONFIG = {
  channels: {
    "kapso-whatsapp": {
      apiKey: "kapso_test_key",
      phoneNumberId: "100000000000000",
      defaultTo: `+${ANNA}`,
    },
  },
};
const PLUGIN_CONFIG = {
  baseUrl: "https://lexroom.example",
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

type ToolContext = {
  requesterSenderId?: string;
  messageChannel?: string;
  sessionKey?: string;
  nativeChannelId?: string;
};
type Tool = { execute: (id: string, params: unknown) => Promise<{ details: unknown }> };
type Hook = (event: unknown, ctx: unknown) => Promise<unknown>;

const fetchMock = vi.fn<typeof fetch>();
const pushed: Array<{ to: string; text: string }> = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const GOOGLE_ACCOUNT = {
  email: "anna@example.com",
  refreshToken: "anna-refresh-token",
  accessToken: "anna-google-access-token",
  accessExpiresAtMs: Date.now() + 3_600_000,
  connectedAtMs: 1,
  scopes: "openid email https://www.googleapis.com/auth/gmail.send",
};
const LEXROOM_ACCOUNT = {
  email: "anna@lexroom.ai",
  accessToken: "anna-lexroom-token",
  refreshToken: "",
  password: "",
  accessExpiresAtMs: Date.now() + 3_600_000,
  connectedAtMs: 1,
};

/** One store per number, as the real stores hand them out; only Anna has accounts. */
function useAccounts() {
  const googleStores = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const lexroomStores = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  openAdaGoogleAccountFromApi.mockImplementation(async (_api: unknown, owner: string) => {
    let store = googleStores.get(owner);
    if (!store) {
      store = {
        readAccount: vi.fn(async () => (owner === ANNA ? GOOGLE_ACCOUNT : null)),
        clearAccount: vi.fn(async () => {}),
        upsertAccount: vi.fn(async () => {}),
        replacePending: vi.fn(async () => {}),
        consumePending: vi.fn(async () => false),
      };
      googleStores.set(owner, store);
    }
    return store;
  });
  openAdaLexroomAccountFromApi.mockImplementation(async (_api: unknown, owner: string) => {
    let store = lexroomStores.get(owner);
    if (!store) {
      store = {
        readAccount: vi.fn(async () => (owner === ANNA ? LEXROOM_ACCOUNT : null)),
        clearAccount: vi.fn(async () => {}),
        upsertAccount: vi.fn(async () => {}),
        replacePending: vi.fn(async () => {}),
        hasPending: vi.fn(async () => false),
        consumePending: vi.fn(async () => false),
      };
      lexroomStores.set(owner, store);
    }
    return store;
  });
  return { googleStores, lexroomStores };
}

function registerAda(toolContext: ToolContext) {
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook>();
  const api = createTestPluginApi({
    id: "ada",
    config: HOST_CONFIG as OpenClawPluginApi["config"],
    pluginConfig: PLUGIN_CONFIG,
    runtimeSource: "/fake/ada/index.ts",
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (params: { to: string; text: string }) => {
              pushed.push({ to: params.to, text: params.text });
            },
          }),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"],
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
    call: async (name: string, params: unknown = {}) =>
      (await tools.get(name)?.execute("call-1", params))?.details,
    hook: (name: string) => hooks.get(name) as Hook,
  };
}

const asPrivateChat = (number: string): ToolContext => ({
  requesterSenderId: number,
  messageChannel: "kapso-whatsapp",
  sessionKey: direct(number),
});

beforeEach(() => {
  vi.clearAllMocks();
  pushed.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ADA_STATUS_REACTIONS", "false");
  openAdaMemoryIfExistsFromApi.mockResolvedValue(null);
  takeResearchLinks("", ANNA);
  takeResearchLinks("", BRUNO);
});

describe("sender B cannot reach sender A's Gmail and Calendar", () => {
  it("reads only the asking number's inbox, calendar and mail account, and finds Bruno has none", async () => {
    useAccounts();
    const bruno = registerAda(asPrivateChat(BRUNO));
    expect(await bruno.call("ada_read_inbox", { max: 5 })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
    expect(await bruno.call("ada_read_calendar", { hours: 24 })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
    expect(
      await bruno.call("ada_send_email", {
        to: "someone@example.com",
        subject: "Hi",
        text: "Hello",
        confirmed: true,
      }),
    ).toMatchObject({ ok: false, reason: "not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openAdaGoogleAccountFromApi.mock.calls.map(([, owner]) => owner)).toEqual([
      BRUNO,
      BRUNO,
      BRUNO,
    ]);
  });

  it("serves Anna her own inbox from her own account", async () => {
    useAccounts();
    fetchMock.mockImplementation(async (input) =>
      urlOf(input).includes("/messages?") ? json({ messages: [] }) : json({}),
    );
    const anna = registerAda(asPrivateChat(ANNA));
    expect(await anna.call("ada_read_inbox", { max: 5 })).toMatchObject({
      ok: true,
      email: "anna@example.com",
    });
    expect(openAdaGoogleAccountFromApi.mock.calls.map(([, owner]) => owner)).toEqual([ANNA]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer anna-google-access-token");
  });

  it("ignores any number the model puts in the arguments", async () => {
    useAccounts();
    const bruno = registerAda(asPrivateChat(BRUNO));
    for (const extra of [
      { number: ANNA },
      { owner: ANNA },
      { to: `+${ANNA}`, sender: ANNA, requesterSenderId: ANNA, accountId: ANNA },
    ]) {
      expect(await bruno.call("ada_read_inbox", { max: 3, ...extra })).toMatchObject({
        ok: false,
        reason: "not_connected",
      });
    }
    expect(new Set(openAdaGoogleAccountFromApi.mock.calls.map(([, owner]) => owner))).toEqual(
      new Set([BRUNO]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives each sender's connect link to that sender, naming only that sender", async () => {
    useAccounts();
    const stateOf = (result: unknown) => {
      const ask = (result as { ask: { url: string } }).ask;
      const state = new URL(ask.url).searchParams.get("state") ?? "";
      return JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString());
    };
    const bruno = registerAda(asPrivateChat(BRUNO));
    expect(stateOf(await bruno.call("ada_google_connect"))).toMatchObject({ owner: BRUNO });
    const carla = registerAda(asPrivateChat(CARLA));
    expect(stateOf(await carla.call("ada_google_connect"))).toMatchObject({ owner: CARLA });
    const lexroomState = (await bruno.call("ada_lexroom_connect")) as { ask: { url: string } };
    const state = new URL(lexroomState.ask.url).searchParams.get("state") ?? "";
    expect(
      JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString()),
    ).toMatchObject({ owner: BRUNO });
  });
});

describe("sender B cannot use or learn about sender A's Lexroom", () => {
  it("runs a research with Bruno's own (missing) account, never Anna's, and says he is not connected", async () => {
    useAccounts();
    const bruno = registerAda(asPrivateChat(BRUNO));
    const started = (await bruno.call("ada_research", {
      matterId: "m",
      query: "Termini opposizione",
    })) as { jobId: string };
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThanOrEqual(2));
    expect(pushed.every((entry) => entry.to === `+${BRUNO}`)).toBe(true);
    expect(pushed.at(-1)?.text).toContain(
      "Lexroom non è ancora collegato al tuo numero: vuoi che ti mandi il link",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new Set(openAdaLexroomAccountFromApi.mock.calls.map(([, owner]) => owner))).toEqual(
      new Set([BRUNO]),
    );

    // Anna cannot read Bruno's job either, and a draft by Bruno never reaches Lexroom.
    const anna = registerAda(asPrivateChat(ANNA));
    expect(await anna.call("ada_research_status", { jobId: started.jobId })).toMatchObject({
      ok: false,
      reason: "unknown_job",
    });
    expect(
      await bruno.call("ada_draft", { matterId: "m", prompt: "Lettera", confirmed: true }),
    ).toMatchObject({ ok: false, reason: "not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not use the static config token for anyone but the configured lawyer", async () => {
    useAccounts();
    const config = { ...PLUGIN_CONFIG, accessToken: "static-token-for-the-lawyer" };
    const tools = new Map<string, Tool>();
    const api = createTestPluginApi({
      id: "ada",
      config: HOST_CONFIG as OpenClawPluginApi["config"],
      pluginConfig: config,
      runtimeSource: "/fake/ada/index.ts",
      registerTool(tool) {
        const built = typeof tool === "function" ? tool(asPrivateChat(BRUNO) as never) : tool;
        for (const one of Array.isArray(built) ? built : [built]) {
          if (one && "name" in one) {
            tools.set(one.name, one as unknown as Tool);
          }
        }
      },
    });
    plugin.register?.(api);
    expect(
      (await tools.get("ada_draft")?.execute("c", { matterId: "m", prompt: "x", confirmed: true }))
        ?.details,
    ).toMatchObject({ ok: false, reason: "not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a tool call that is not a private chat with a known sender is refused", () => {
  const ACCOUNT_TOOLS: Array<[string, unknown]> = [
    ["ada_google_connect", {}],
    ["ada_lexroom_connect", {}],
    ["ada_read_inbox", {}],
    ["ada_read_calendar", {}],
    ["ada_send_email", { to: "a@b.co", subject: "s", text: "t", confirmed: true }],
    ["ada_draft", { matterId: "m", prompt: "p", confirmed: true }],
    ["ada_deadline_list", {}],
    ["ada_deadline_reply", { ref: "1", action: "track" }],
    ["ada_memory_search", { query: "q", matterId: "m" }],
    ["ada_memory_list", { folder: "knowledge/facts", matterId: "m" }],
    ["ada_memory_get", { id: "i", matterId: "m" }],
    ["ada_memory_history", { id: "i", matterId: "m" }],
    ["ada_todo_list", {}],
    ["ada_todo_get", { id: "i" }],
  ];

  it.each<[string, ToolContext]>([
    ["a group chat", { ...asPrivateChat(ANNA), nativeChannelId: "120363025246125486@g.us" }],
    [
      "a group session",
      {
        requesterSenderId: ANNA,
        messageChannel: "kapso-whatsapp",
        sessionKey: "agent:main:kapso-whatsapp:group:120363025246125486",
      },
    ],
    ["another channel", { ...asPrivateChat(ANNA), messageChannel: "telegram" }],
    ["no sender at all", {}],
    ["a sender that is not a phone number", { requesterSenderId: "webchat-user-7" }],
    [
      "a sender that contradicts its own session",
      {
        requesterSenderId: BRUNO,
        messageChannel: "kapso-whatsapp",
        sessionKey: direct(ANNA),
      },
    ],
  ])("refuses every account tool in %s, without opening any store", async (_label, context) => {
    useAccounts();
    const ada = registerAda(context);
    for (const [name, params] of ACCOUNT_TOOLS) {
      expect(await ada.call(name, params), name).toMatchObject({
        ok: false,
        reason: "private_chat_required",
      });
    }
    expect(openAdaGoogleAccountFromApi).not.toHaveBeenCalled();
    expect(openAdaLexroomAccountFromApi).not.toHaveBeenCalled();
    expect(openAdaMemoryIfExistsFromApi).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes the number from the session key when the host sends no sender id", async () => {
    useAccounts();
    const ada = registerAda({ messageChannel: "kapso-whatsapp", sessionKey: direct(BRUNO) });
    expect(await ada.call("ada_read_inbox")).toMatchObject({ reason: "not_connected" });
    expect(openAdaGoogleAccountFromApi.mock.calls.map(([, owner]) => owner)).toEqual([BRUNO]);
  });
});

describe("sender B cannot see sender A's memory, brief or research links", () => {
  const authority = { allows: vi.fn(() => true), assertActive: vi.fn() };

  it("opens only the asking number's memory for tools and for the brief", async () => {
    const memories: Record<string, unknown> = {
      [ANNA]: {
        readProfile: async () => ({
          name: "Anna",
          timezone: "Europe/Rome",
          email: null,
          language: "it",
          jurisdiction: "IT",
          autonomy: "ask-first",
          channelStyle: "short",
          generatedAtMs: 1,
        }),
        listTodos: async () => [
          {
            id: "todo-secret",
            matterId: "rossi",
            owner: "lawyer",
            title: "Rossi: transazione riservata",
            status: "pending",
            detail: "",
            updatedAtMs: 1,
          },
        ],
        getTodo: async () => ({ id: "todo-secret", title: "Rossi: transazione riservata" }),
      },
    };
    openAdaMemoryIfExistsFromApi.mockImplementation(
      async (_api: unknown, owner: string) => memories[owner] ?? null,
    );

    const bruno = registerAda(asPrivateChat(BRUNO));
    expect(await bruno.call("ada_todo_list")).toEqual({ ok: true, todos: [] });
    expect(await bruno.call("ada_todo_get", { id: "todo-secret" })).toMatchObject({ ok: false });
    expect(
      await bruno.hook("before_prompt_build")(
        {},
        {
          senderId: BRUNO,
          channelId: "kapso-whatsapp",
          sessionKey: direct(BRUNO),
          toolAuthority: authority,
        },
      ),
    ).toBeUndefined();
    expect(new Set(openAdaMemoryIfExistsFromApi.mock.calls.map(([, owner]) => owner))).toEqual(
      new Set([BRUNO]),
    );

    const anna = registerAda(asPrivateChat(ANNA));
    const brief = (await anna.hook("before_prompt_build")(
      {},
      {
        senderId: ANNA,
        channelId: "kapso-whatsapp",
        sessionKey: direct(ANNA),
        toolAuthority: authority,
      },
    )) as { prependContext: string };
    expect(brief.prependContext).toContain("Rossi: transazione riservata");
  });

  it("injects nothing for a turn whose sender and session disagree", async () => {
    openAdaMemoryIfExistsFromApi.mockResolvedValue({
      readProfile: async () => null,
      listTodos: async () => [],
    });
    const ada = registerAda(asPrivateChat(BRUNO));
    expect(
      await ada.hook("before_prompt_build")(
        {},
        {
          senderId: BRUNO,
          channelId: "kapso-whatsapp",
          sessionKey: direct(ANNA),
          toolAuthority: authority,
        },
      ),
    ).toBeUndefined();
    expect(openAdaMemoryIfExistsFromApi).not.toHaveBeenCalled();
  });

  it("appends a research link only to the reply of the number it belongs to", async () => {
    const link = "https://app.lexroom.ai/research/anna-1";
    markResearchLinkReady(link, ANNA);
    const ada = registerAda(asPrivateChat(BRUNO));
    const reply = async (number: string) =>
      (await ada.hook("reply_payload_sending")(
        { kind: "final", payload: { text: "Ecco." } },
        { channelId: "kapso-whatsapp", sessionKey: direct(number) },
      )) as { payload?: { text?: string } } | undefined;
    expect(await reply(BRUNO)).toBeUndefined();
    expect((await reply(ANNA))?.payload?.text).toContain(link);
  });
});
