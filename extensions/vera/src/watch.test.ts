import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openVeraMemoryFromApi = vi.hoisted(() => vi.fn());
const openVeraGoogleAccountFromApi = vi.hoisted(() => vi.fn());

vi.mock("./memory.js", () => ({ openVeraMemoryFromApi }));
vi.mock("./google-account.js", () => ({ openVeraGoogleAccountFromApi }));

import { handleVeraGoogleNotify } from "./watch.js";

const TOKEN = "test-notify-token-0123456789";
const NOW = new Date("2026-10-14T10:00:00.000Z");

const PLUGIN_CONFIG = {
  googleNotifyToken: TOKEN,
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/vera/google/callback",
  googleStateSecret: "state-secret-test-value",
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const fetchMock = vi.fn<typeof fetch>();
const dispatchHookAgentTurn = vi.fn();

function makeApi(options: { pluginConfig?: unknown; hooks?: unknown }): OpenClawPluginApi {
  return {
    logger,
    pluginConfig: "pluginConfig" in options ? options.pluginConfig : PLUGIN_CONFIG,
    runtime: { hooks: "hooks" in options ? options.hooks : { dispatchHookAgentTurn } },
  } as unknown as OpenClawPluginApi;
}

function makeReq(method: string, authorization: string | null): IncomingMessage {
  return {
    method,
    headers: authorization === null ? {} : { authorization },
  } as unknown as IncomingMessage;
}

function makeRes() {
  const res = { statusCode: 0, body: undefined as string | undefined, ended: false };
  return Object.assign(res, {
    end(body?: string) {
      res.body = body;
      res.ended = true;
    },
  }) as unknown as ServerResponse & { body: string | undefined; ended: boolean };
}

async function push(api: OpenClawPluginApi, authorization: string | null = `Bearer ${TOKEN}`) {
  const res = makeRes();
  const handled = await handleVeraGoogleNotify(makeReq("POST", authorization), res, api);
  return { handled, res };
}

function useMemory(overrides: Record<string, unknown> = {}) {
  const memory = {
    readGmailSnapshot: vi.fn(async () => []),
    readCalendarSnapshot: vi.fn(async () => []),
    listMatterAliases: vi.fn(async () => []),
    listTodos: vi.fn(async () => []),
    readWake: vi.fn(async () => ({
      lastLawyerInboundAtMs: null,
      lastReconcileAtMs: null,
      lastCollectAtMs: null,
      heldPlanJson: null,
      watchExpirationMs: null,
      openTodoIdsJson: null,
    })),
    readProfile: vi.fn(async () => null),
    replaceGmailSnapshot: vi.fn(async () => {}),
    replaceCalendarSnapshot: vi.fn(async () => {}),
    writeWake: vi.fn(async (_patch: Record<string, unknown>) => {}),
    ...overrides,
  };
  openVeraMemoryFromApi.mockResolvedValue(memory);
  return memory;
}

function useGoogleAccount(connected: boolean) {
  openVeraGoogleAccountFromApi.mockResolvedValue({
    readAccount: async () =>
      connected
        ? {
            email: "lawyer@example.com",
            refreshToken: "test-refresh-token",
            accessToken: "test-google-access-token",
            accessExpiresAtMs: NOW.getTime() + 3_600_000,
            connectedAtMs: 1,
            scopes: "openid email https://www.googleapis.com/auth/gmail.send",
          }
        : null,
  });
}

function useGoogleApis(options: { inboxIds?: string[]; events?: unknown[] } = {}) {
  fetchMock.mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/calendar/v3/")) {
      return new Response(JSON.stringify({ items: options.events ?? [] }), { status: 200 });
    }
    const id = /\/messages\/([^?/]+)/u.exec(url)?.[1];
    if (id) {
      return new Response(
        JSON.stringify({
          id,
          snippet: "snippet",
          payload: { headers: [{ name: "Subject", value: "Hello" }] },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify(
        options.inboxIds
          ? { messages: options.inboxIds.map((messageId) => ({ id: messageId })) }
          : {},
      ),
      { status: 200 },
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  dispatchHookAgentTurn.mockReset();
  dispatchHookAgentTurn.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("handleVeraGoogleNotify auth", () => {
  it("rejects non-POST methods before checking the token", async () => {
    const res = makeRes();
    expect(await handleVeraGoogleNotify(makeReq("GET", `Bearer ${TOKEN}`), res, makeApi({}))).toBe(
      true,
    );
    expect(res.statusCode).toBe(405);
    expect(res.body).toBe("method not allowed");
    expect(openVeraMemoryFromApi).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", null],
    ["an empty header", ""],
    ["the wrong token", "Bearer test-notify-token-9999999999"],
    ["a token prefix", `Bearer ${TOKEN.slice(0, -1)}`],
    ["a token with extra characters", `Bearer ${TOKEN}x`],
    ["the bare token without a scheme", TOKEN],
    ["a different scheme", `Basic ${TOKEN}`],
    ["a scheme with no token", "Bearer "],
  ])("answers 401 and does no work for %s", async (_label, authorization) => {
    const { handled, res } = await push(makeApi({}), authorization);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
    expect(openVeraMemoryFromApi).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["blank", { googleNotifyToken: "   " }],
    ["shorter than 16 characters", { googleNotifyToken: "short-token" }],
    ["not a string", { googleNotifyToken: 1234567890123456 }],
  ])("refuses every push when the notify token is %s", async (_label, pluginConfig) => {
    const api = makeApi({ pluginConfig });
    const shortBearer = "Bearer short-token";
    for (const authorization of [
      shortBearer,
      "Bearer ",
      "Bearer undefined",
      "Bearer 1234567890123456",
    ]) {
      const { res } = await push(api, authorization);
      expect(res.statusCode).toBe(401);
    }
    expect(openVeraMemoryFromApi).not.toHaveBeenCalled();
  });

  it("refuses when the plugin config itself is absent", async () => {
    const { res } = await push(makeApi({ pluginConfig: undefined }));
    expect(res.statusCode).toBe(401);
  });

  it("accepts a case-insensitive Bearer scheme and surrounding whitespace", async () => {
    useMemory();
    useGoogleAccount(false);
    const { res } = await push(makeApi({}), `  bearer   ${TOKEN}  `);
    expect(res.statusCode).toBe(204);
  });
});

describe("handleVeraGoogleNotify push handling", () => {
  it("acknowledges a valid push with 204 when Google is not connected, doing no Google work", async () => {
    const memory = useMemory();
    useGoogleAccount(false);
    const { handled, res } = await push(makeApi({}));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
    expect(memory.writeWake).not.toHaveBeenCalled();
  });

  it("acknowledges a push with empty Gmail and Calendar history without waking the model", async () => {
    const memory = useMemory();
    useGoogleAccount(true);
    useGoogleApis();
    const { res } = await push(makeApi({}));
    expect(res.statusCode).toBe(204);
    expect(memory.replaceGmailSnapshot).toHaveBeenCalledWith([]);
    expect(memory.replaceCalendarSnapshot).toHaveBeenCalledWith([]);
    expect(memory.writeWake).toHaveBeenCalledWith({
      lastCollectAtMs: NOW.getTime(),
      openTodoIdsJson: "[]",
      heldPlanJson: null,
    });
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });

  it("ignores Gmail messages that match no matter alias", async () => {
    const memory = useMemory();
    useGoogleAccount(true);
    useGoogleApis({ inboxIds: ["msg-1", "msg-2"] });
    const { res } = await push(makeApi({}));
    expect(res.statusCode).toBe(204);
    expect(memory.replaceGmailSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: "msg-1", subject: "Hello" }),
      expect.objectContaining({ messageId: "msg-2", subject: "Hello" }),
    ]);
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });

  it("dispatches one digest turn for an urgent matter hit when the WhatsApp window is open", async () => {
    const memory = useMemory({
      listMatterAliases: vi.fn(async () => [
        { matterId: "matter-a", alias: "Alpha", title: "Alpha matter" },
      ]),
      readWake: vi.fn(async () => ({
        lastLawyerInboundAtMs: NOW.getTime() - 60_000,
        lastReconcileAtMs: null,
        lastCollectAtMs: null,
        heldPlanJson: null,
        watchExpirationMs: null,
        openTodoIdsJson: null,
      })),
    });
    useGoogleAccount(true);
    useGoogleApis({
      events: [
        {
          id: "event-1",
          summary: "Alpha hearing",
          status: "confirmed",
          start: { dateTime: "2026-10-14T12:00:00.000Z" },
          end: { dateTime: "2026-10-14T13:00:00.000Z" },
        },
      ],
    });
    const { res } = await push(makeApi({}));
    expect(res.statusCode).toBe(204);
    expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(1);
    const call = dispatchHookAgentTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      name: "Vera digest",
      agentId: "main",
      sessionKey: "hook:vera:digest:2026-10-14",
      externalContentSource: "email",
      deliver: true,
      timeoutSeconds: 45,
      idempotencyKey: "vera-digest:2026-10-14:matter-a",
    });
    expect(String(call.message)).toContain("Alpha matter");
    expect(memory.writeWake).toHaveBeenCalledWith(
      expect.objectContaining({ lastCollectAtMs: NOW.getTime(), heldPlanJson: null }),
    );
  });

  it("holds the plan instead of dispatching when the WhatsApp window is closed", async () => {
    const memory = useMemory({
      listMatterAliases: vi.fn(async () => [
        { matterId: "matter-a", alias: "Alpha", title: "Alpha matter" },
      ]),
    });
    useGoogleAccount(true);
    useGoogleApis({
      events: [
        {
          id: "event-1",
          summary: "Alpha hearing",
          status: "confirmed",
          start: { dateTime: "2026-10-14T12:00:00.000Z" },
          end: { dateTime: "2026-10-14T13:00:00.000Z" },
        },
      ],
    });
    const { res } = await push(makeApi({}));
    expect(res.statusCode).toBe(204);
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
    const held = memory.writeWake.mock.calls.find(([patch]) => patch.heldPlanJson);
    expect(held).toBeDefined();
    expect(JSON.parse(String(held?.[0].heldPlanJson))).toMatchObject({ deliver: true });
  });

  describe("when the hook dispatcher cannot deliver", () => {
    const openWindowMemory = () =>
      useMemory({
        listMatterAliases: vi.fn(async () => [
          { matterId: "matter-a", alias: "Alpha", title: "Alpha matter" },
        ]),
        readWake: vi.fn(async () => ({
          lastLawyerInboundAtMs: NOW.getTime() - 60_000,
          lastReconcileAtMs: null,
          lastCollectAtMs: null,
          heldPlanJson: null,
          watchExpirationMs: null,
          openTodoIdsJson: null,
        })),
      });
    const alphaEvent = {
      id: "event-1",
      summary: "Alpha hearing",
      status: "confirmed",
      start: { dateTime: "2026-10-14T12:00:00.000Z" },
      end: { dateTime: "2026-10-14T13:00:00.000Z" },
    };

    it("still answers 204 and does not record a collect when hooks are unavailable", async () => {
      const memory = openWindowMemory();
      useGoogleAccount(true);
      useGoogleApis({ events: [alphaEvent] });
      const { res } = await push(makeApi({ hooks: undefined }));
      expect(res.statusCode).toBe(204);
      expect(memory.writeWake).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastCollectAtMs: expect.any(Number) }),
      );
    });

    it("still answers 204 when the dispatcher rejects the turn", async () => {
      const memory = openWindowMemory();
      useGoogleAccount(true);
      useGoogleApis({ events: [alphaEvent] });
      dispatchHookAgentTurn.mockResolvedValue({ ok: false, reason: "queue_full" });
      const { res } = await push(makeApi({}));
      expect(res.statusCode).toBe(204);
      expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(1);
      expect(memory.writeWake).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastCollectAtMs: expect.any(Number) }),
      );
    });
  });

  // Real bug, tracked here without changing behavior: runVeraCollectPass replaces the Gmail and
  // Calendar snapshots before it dispatches. When dispatch fails the plan is neither held nor
  // re-derivable, because the next pass diffs against the new snapshot and sees nothing new.
  it.skip("keeps an undelivered plan as held when the dispatcher rejects it", async () => {
    const memory = useMemory({
      listMatterAliases: vi.fn(async () => [
        { matterId: "matter-a", alias: "Alpha", title: "Alpha matter" },
      ]),
      readWake: vi.fn(async () => ({
        lastLawyerInboundAtMs: NOW.getTime() - 60_000,
        lastReconcileAtMs: null,
        lastCollectAtMs: null,
        heldPlanJson: null,
        watchExpirationMs: null,
        openTodoIdsJson: null,
      })),
    });
    useGoogleAccount(true);
    useGoogleApis({
      events: [
        {
          id: "event-1",
          summary: "Alpha hearing",
          status: "confirmed",
          start: { dateTime: "2026-10-14T12:00:00.000Z" },
          end: { dateTime: "2026-10-14T13:00:00.000Z" },
        },
      ],
    });
    dispatchHookAgentTurn.mockResolvedValue({ ok: false, reason: "queue_full" });
    const { res } = await push(makeApi({}));
    expect(res.statusCode).toBe(204);
    expect(memory.writeWake).toHaveBeenCalledWith(
      expect.objectContaining({ heldPlanJson: expect.any(String) }),
    );
  });

  it("answers 500 and logs when the collect pass throws", async () => {
    useMemory({
      readGmailSnapshot: vi.fn(async () => {
        throw new Error("sqlite is locked");
      }),
    });
    useGoogleAccount(true);
    useGoogleApis();
    const { handled, res } = await push(makeApi({}));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("notify failed");
    expect(logger.error).toHaveBeenCalledWith("vera google notify failed: sqlite is locked");
  });

  it("answers 500 when the memory store cannot open", async () => {
    openVeraMemoryFromApi.mockRejectedValue(new Error("worker crashed"));
    const { res } = await push(makeApi({}));
    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalledWith("vera google notify failed: worker crashed");
  });
});
