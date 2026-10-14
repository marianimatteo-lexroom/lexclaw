import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openVeraLexroomAccountFromApi = vi.hoisted(() => vi.fn());
const openVeraGoogleAccountFromApi = vi.hoisted(() => vi.fn());
const openVeraMemoryFromApi = vi.hoisted(() => vi.fn());
const recordLawyerInbound = vi.hoisted(() => vi.fn());

vi.mock("./src/lexroom-account.js", () => ({ openVeraLexroomAccountFromApi }));
vi.mock("./src/google-account.js", () => ({ openVeraGoogleAccountFromApi }));
vi.mock("./src/memory.js", () => ({ openVeraMemoryFromApi }));
vi.mock("./src/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/service.js")>()),
  recordLawyerInbound,
}));

import plugin from "./index.js";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const KAPSO_URL = "https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/messages";
const KAPSO_KEY = "kapso_test_key";
const MESSAGE_ID = "wamid.HBgMMzkwMDAwMDAwMDAwFQIAEhgUM0IyMjUwOEJBREUwODEyNEQ2MDkA";

const PLUGIN_CONFIG = {
  baseUrl: "https://lexroom.example",
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/vera/google/callback",
  googleStateSecret: "state-secret-test-value",
};

const HOST_CONFIG = {
  channels: {
    "kapso-whatsapp": { apiKey: KAPSO_KEY, phoneNumberId: "100000000000000" },
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

function registerVera(pluginConfig: Record<string, unknown> = PLUGIN_CONFIG) {
  const tools = new Map<string, RegisteredTool>();
  const hooks = new Map<string, RegisteredHook>();
  const api = createTestPluginApi({
    id: "vera",
    logger,
    config: HOST_CONFIG as OpenClawPluginApi["config"],
    pluginConfig,
    runtimeSource: "/fake/vera/index.ts",
    registerTool(tool) {
      if (typeof tool !== "function" && "name" in tool) {
        tools.set(tool.name, tool as unknown as RegisteredTool);
      }
    },
    on: ((name: string, handler: RegisteredHook["handler"], options?: unknown) => {
      hooks.set(name, { handler, options });
    }) as OpenClawPluginApi["on"],
  });
  plugin.register?.(api);
  return {
    api,
    async callTool(name: string, params: unknown): Promise<unknown> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`tool ${name} is not registered`);
      }
      return (await tool.execute("call-1", params)).details;
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
  openVeraLexroomAccountFromApi.mockResolvedValue({ readAccount: async () => account });
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
  openVeraGoogleAccountFromApi.mockResolvedValue(store);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  recordLawyerInbound.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("vera_draft confirmation gate", () => {
  const draft = { matterId: "matter-a", prompt: "Reply to opposing counsel" };

  it.each([
    ["false", false],
    ["missing", undefined],
    ["null", null],
    ["zero", 0],
    ["empty string", ""],
  ])("never calls Lexroom or opens an account when confirmed is %s", async (_label, confirmed) => {
    const { callTool } = registerVera();
    const result = await callTool("vera_draft", { ...draft, confirmed });
    expect(result).toEqual({
      ok: true,
      drafted: false,
      reason: "confirmation_required",
      matterId: "matter-a",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openVeraLexroomAccountFromApi).not.toHaveBeenCalled();
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
    const { callTool } = registerVera();
    expect(await callTool("vera_draft", { ...draft, confirmed: true })).toEqual({
      ok: true,
      drafted: true,
      matterId: "matter-a",
      researchId: "draft-1",
      status: "DONE",
      title: "Lettera",
      content: "Gentile collega,",
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
    const { callTool } = registerVera();
    await callTool("vera_draft", { ...draft, confirmed: true, modules: ["Lavoro"] });
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
    const { callTool } = registerVera({ baseUrl: "https://lexroom.example" });
    expect(await callTool("vera_draft", { ...draft, confirmed: true })).toEqual({
      ok: false,
      reason: "not_connected",
      error: "Lexroom is not connected. Call vera_lexroom_connect and send that link.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an expired linked account instead of drafting", async () => {
    useLexroomAccount(lexroomAccount({ accessExpiresAtMs: Date.now() - 5000 }));
    const { callTool } = registerVera();
    expect(await callTool("vera_draft", { ...draft, confirmed: true })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "401",
      () => json({ detail: "expired" }, 401),
      "Lexroom rejected the access token. Sign in again and update Vera's access token.",
    ],
    [
      "MFA step-up",
      () => json({ detail: "mfa_step_up_required" }, 403),
      "Lexroom requires a verified sign-in. Complete MFA, then refresh the Vera access token.",
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
    const { callTool } = registerVera();
    expect(await callTool("vera_draft", { ...draft, confirmed: true })).toEqual({
      ok: false,
      error,
    });
  });

  it("fails when Lexroom selects no drafting module", async () => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockImplementation(async () => json({ modules: [] }));
    const { callTool } = registerVera();
    expect(await callTool("vera_draft", { ...draft, confirmed: true })).toEqual({
      ok: false,
      error: "Lexroom did not select a drafting module for this prompt",
    });
  });

  it("fails when the draft stream ends before DONE", async () => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockImplementation(async () =>
      ndjson({ research: { id: "draft-3", status: "RUNNING" } }),
    );
    const { callTool } = registerVera();
    expect(
      await callTool("vera_draft", { ...draft, confirmed: true, modules: ["Civile"] }),
    ).toEqual({ ok: false, error: "Lexroom research stream ended before DONE or FAILED" });
  });

  it("returns a network failure as an error result", async () => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const { callTool } = registerVera();
    expect(
      await callTool("vera_draft", { ...draft, confirmed: true, modules: ["Civile"] }),
    ).toEqual({ ok: false, error: "socket hang up" });
  });
});

describe("vera_research", () => {
  it("runs research with the linked account token and replaces citation ids", async () => {
    useLexroomAccount(lexroomAccount());
    const seen: Array<{ url: string; method?: string; auth: string | null; body?: unknown }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = urlOf(input);
      seen.push({
        url,
        method: init?.method,
        auth: headerOf(init, "Authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init?.method === "POST") {
        return ndjson({
          research: {
            id: "res-1",
            status: "DONE",
            answer: { text: "Il datore prova il fatto [1]." },
            documents: [{ files: [{ citation_id: 1, title: "Cass. civ. 1/2024" }] }],
          },
        });
      }
      return new Response(null, { status: 204 });
    });
    const { callTool } = registerVera();
    expect(
      await callTool("vera_research", {
        matterId: "matter-a",
        query: "Onere della prova",
        libraryDocumentIds: ["doc-1"],
      }),
    ).toEqual({
      ok: true,
      matterId: "matter-a",
      researchId: "res-1",
      status: "DONE",
      answer: "Il datore prova il fatto [Cass. civ. 1/2024].",
      sources: [{ title: "Cass. civ. 1/2024" }],
    });
    expect(seen[0]).toMatchObject({
      url: "https://lexroom.example/v1/ask_me_anything",
      method: "POST",
      auth: "Bearer test-account-token",
      body: {
        query: "Onere della prova",
        search_on_user_data: true,
        library_documents: [{ document_ids: ["doc-1"] }],
      },
    });
    expect(seen[1]).toMatchObject({
      url: "https://lexroom.example/v1/ask_me_anything/res-1",
      method: "GET",
    });
  });

  it("does not search the private library without document ids", async () => {
    useLexroomAccount(lexroomAccount());
    fetchMock.mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? ndjson({ research: { id: "res-2", status: "DONE", answer: "ok" } })
        : new Response(null, { status: 204 }),
    );
    const { callTool } = registerVera();
    await callTool("vera_research", { matterId: "matter-a", query: "Question" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.search_on_user_data).toBe(false);
    expect(body).not.toHaveProperty("library_documents");
  });

  it("falls back to the static config token when no account is linked", async () => {
    useLexroomAccount(null);
    fetchMock.mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? ndjson({ research: { id: "res-3", status: "DONE", answer: "ok" } })
        : new Response(null, { status: 204 }),
    );
    const { callTool } = registerVera({ ...PLUGIN_CONFIG, accessToken: "test-config-token" });
    await callTool("vera_research", { matterId: "matter-a", query: "Question" });
    expect(headerOf(fetchMock.mock.calls[0]?.[1], "Authorization")).toBe(
      "Bearer test-config-token",
    );
  });

  it("returns not_connected without a request when no token exists", async () => {
    useLexroomAccount(null);
    const { callTool } = registerVera();
    expect(
      await callTool("vera_research", { matterId: "matter-a", query: "Question" }),
    ).toMatchObject({ ok: false, reason: "not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank matter id", { matterId: "  ", query: "Question" }, "matterId is required"],
    ["a blank query", { matterId: "matter-a", query: "  " }, "query is required"],
  ])("rejects %s before any request", async (_label, params, error) => {
    useLexroomAccount(lexroomAccount());
    const { callTool } = registerVera();
    expect(await callTool("vera_research", params)).toEqual({ ok: false, error });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an HTTP failure and a stream error as error results", async () => {
    useLexroomAccount(lexroomAccount());
    const { callTool } = registerVera();
    fetchMock.mockImplementationOnce(async () => json({ detail: "boom" }, 500));
    expect(await callTool("vera_research", { matterId: "matter-a", query: "Q" })).toEqual({
      ok: false,
      error: "Lexroom returned 500: boom",
    });
    fetchMock.mockImplementationOnce(async () =>
      ndjson({ research: { id: "res-4", status: "RUNNING", error: "model unavailable" } }),
    );
    expect(await callTool("vera_research", { matterId: "matter-a", query: "Q" })).toEqual({
      ok: false,
      error: "model unavailable",
    });
  });
});

describe("vera_send_email confirmation gate", () => {
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
      const { callTool } = registerVera();
      const result = await callTool("vera_send_email", { ...email, confirmed });
      expect(result).toMatchObject({ ok: false, reason: "confirmation_required" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.readAccount).not.toHaveBeenCalled();
    },
  );

  it("stays blocked for an unconfirmed call even when Google is not connected", async () => {
    const store = useGoogleAccount(null);
    const { callTool } = registerVera();
    expect(await callTool("vera_send_email", { ...email, confirmed: false })).toMatchObject({
      reason: "confirmation_required",
    });
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends exactly one message through Gmail once confirmed", async () => {
    useGoogleAccount(googleAccount());
    fetchMock.mockImplementation(async () => json({ id: "gmail-msg-1" }));
    const { callTool } = registerVera();
    expect(await callTool("vera_send_email", { ...email, confirmed: true })).toEqual({
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
    const { callTool } = registerVera();
    expect(await callTool("vera_send_email", { ...email, confirmed: true })).toMatchObject({
      ok: false,
      reason: "needs_send_scope",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send when Google is not connected", async () => {
    useGoogleAccount(null);
    const { callTool } = registerVera();
    expect(await callTool("vera_send_email", { ...email, confirmed: true })).toMatchObject({
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
    const { callTool } = registerVera();
    expect(
      await callTool("vera_send_email", { ...email, ...override, confirmed: true }),
    ).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { reason: "not_connected" }, true],
    [403, { reason: "needs_send_scope" }, false],
    [500, { error: "Vera could not send the email. Try again shortly." }, false],
  ])("maps a Gmail %i response without claiming success", async (status, expected, clears) => {
    const store = useGoogleAccount(googleAccount());
    fetchMock.mockImplementation(async () => json({ error: { message: "nope" } }, status));
    const { callTool } = registerVera();
    const result = await callTool("vera_send_email", { ...email, confirmed: true });
    expect(result).toMatchObject({ ok: false, ...expected });
    expect(store.clearAccount).toHaveBeenCalledTimes(clears ? 1 : 0);
  });

  it("reports a Gmail network failure without claiming success", async () => {
    useGoogleAccount(googleAccount());
    fetchMock.mockRejectedValue(new Error("offline"));
    const { callTool } = registerVera();
    expect(await callTool("vera_send_email", { ...email, confirmed: true })).toEqual({
      ok: false,
      error: "Vera could not send the email. Try again shortly.",
    });
  });
});

describe("message_received hook", () => {
  const inbound = { channelId: "kapso-whatsapp", messageId: MESSAGE_ID };

  it("marks the message read through Kapso and records the inbound wake", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T09:00:00.000Z"));
    fetchMock.mockImplementation(async () => json({ success: true }));
    const { hook } = registerVera();
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
    expect(recordLawyerInbound).toHaveBeenCalledWith({
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
    const { hook } = registerVera();
    await hook("message_received")({ channel: "kapso-whatsapp", messageId: MESSAGE_ID }, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordLawyerInbound).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "kapso-whatsapp" }),
    );
  });

  it("does not call Kapso for other channels or synthetic message ids", async () => {
    const { hook } = registerVera();
    await hook("message_received")({}, { channelId: "telegram", messageId: MESSAGE_ID });
    await hook("message_received")(
      {},
      { channelId: "kapso-whatsapp", messageId: "390000000000:1791674081" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordLawyerInbound).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([400, 401, 404, 429, 500, 502, 503])(
    "logs a warning, still records the wake, and does not throw on Kapso HTTP %i",
    async (status) => {
      fetchMock.mockImplementation(async () => json({ error: "nope" }, status));
      const { hook } = registerVera();
      await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        `vera whatsapp read receipt failed: kapso read receipt returned HTTP ${status}`,
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(KAPSO_KEY);
      expect(logger.error).not.toHaveBeenCalled();
      expect(recordLawyerInbound).toHaveBeenCalledTimes(1);
    },
  );

  it("logs a warning when the Kapso request fails at the network layer", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const { hook } = registerVera();
    await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "vera whatsapp read receipt failed: kapso read receipt request failed",
    );
    expect(recordLawyerInbound).toHaveBeenCalledTimes(1);
  });

  it("gives up after the 10 second read-receipt timeout without blocking the wake record", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { hook } = registerVera();
    const settled = vi.fn();
    const pending = hook("message_received")({}, inbound).then(settled);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();
    expect(recordLawyerInbound).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(logger.warn).toHaveBeenCalledWith(
      "vera whatsapp read receipt failed: kapso read receipt timed out",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("still sends the read receipt when recording the wake fails", async () => {
    fetchMock.mockImplementation(async () => json({ success: true }));
    recordLawyerInbound.mockRejectedValue(new Error("sqlite is locked"));
    const { hook } = registerVera();
    await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("vera inbound wake record failed: sqlite is locked");
  });

  it("logs both failures when Kapso and the wake record fail together", async () => {
    fetchMock.mockImplementation(async () => json({}, 500));
    recordLawyerInbound.mockRejectedValue("not an error object");
    const { hook } = registerVera();
    await expect(hook("message_received")({}, inbound)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("vera inbound wake record failed: unknown");
  });
});

describe("before_prompt_build hook", () => {
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
    openVeraMemoryFromApi.mockResolvedValue(memory);
    return memory;
  }

  it("requires tool authority at registration", () => {
    const registered = new Map<string, RegisteredHook>();
    const api = createTestPluginApi({
      id: "vera",
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
    const { hook } = registerVera();
    const result = await hook("before_prompt_build")(
      {},
      { toolAuthority, sessionKey: "session-123" },
    );
    expect(toolAuthority.allows).toHaveBeenCalledWith("vera_memory_search");
    expect(memory.readProfile).toHaveBeenCalledTimes(1);
    const { prependContext } = result as { prependContext: string };
    const blocks = prependContext.split("\n\n");
    expect(blocks[0]).toMatch(/^# Lawyer profile/u);
    expect(blocks[1]).toBe(
      "# Open loops\n- [todo-1] matter-a / lawyer / pending: Confirm hearing date",
    );
    expect(blocks[2]).toBe("# Session\n- id: session-123");
    expect(prependContext).not.toContain("# Matter ");
  });

  it("still injects an empty open-loop index when there is no profile or todo", async () => {
    useMemory({ readProfile: async () => null, listTodos: async () => [] });
    const { hook } = registerVera();
    expect(await hook("before_prompt_build")({}, { toolAuthority: authority(true) })).toEqual({
      prependContext: "# Open loops\n(none)",
    });
  });

  it("injects nothing and never opens memory without tool authority", async () => {
    useMemory();
    const { hook } = registerVera();
    expect(await hook("before_prompt_build")({}, {})).toBeUndefined();
    expect(openVeraMemoryFromApi).not.toHaveBeenCalled();
  });

  it("injects nothing when the turn is not allowed to use memory tools", async () => {
    useMemory();
    const { hook } = registerVera();
    expect(
      await hook("before_prompt_build")({}, { toolAuthority: authority(false) }),
    ).toBeUndefined();
    expect(openVeraMemoryFromApi).not.toHaveBeenCalled();
  });

  it("drops the brief when authority is revoked while memory was being read", async () => {
    useMemory();
    const toolAuthority = authority(true);
    toolAuthority.assertActive.mockImplementation(() => {
      throw new Error("authority revoked");
    });
    const { hook } = registerVera();
    expect(await hook("before_prompt_build")({}, { toolAuthority })).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("vera brief inject failed: authority revoked");
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
    const { hook } = registerVera();
    await hook("before_prompt_build")({}, { toolAuthority });
    expect(order.at(-1)).toBe("assertActive");
    expect(order).toHaveLength(3);
  });

  it("fails open with a logged error when the memory store cannot be opened", async () => {
    openVeraMemoryFromApi.mockRejectedValue(new Error("worker crashed"));
    const { hook } = registerVera();
    expect(
      await hook("before_prompt_build")({}, { toolAuthority: authority(true) }),
    ).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("vera brief inject failed: worker crashed");
  });
});
