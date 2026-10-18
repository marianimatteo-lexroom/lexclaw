import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAdaMemoryFromApi = vi.hoisted(() => vi.fn());
const openAdaGoogleAccountFromApi = vi.hoisted(() => vi.fn());

vi.mock("./memory.js", () => ({
  openAdaMemoryFromApi,
  openAdaMemoryIfExistsFromApi: (...args: unknown[]) => openAdaMemoryFromApi(...args),
}));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi,
  openAdaGoogleAccountDbFromApi: async () => ({
    listOwners: async () => [OWNER],
    readAccount: async () => ({ email: "lawyer@example.com" }),
  }),
}));

import { clearSentDigests } from "./dispatch-digest.js";
import { createNotifyState, handleAdaGoogleNotify, type NotifyDeps } from "./watch.js";

const OWNER = "393331111111";

const TOKEN = "test-notify-token-0123456789";
const NOW = new Date("2026-10-14T10:00:00.000Z");

const PLUGIN_CONFIG = {
  googleNotifyToken: TOKEN,
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const fetchMock = vi.fn<typeof fetch>();
const sendText = vi.fn();

function makeApi(options: { pluginConfig?: unknown; adapter?: boolean }): OpenClawPluginApi {
  return {
    logger,
    config: { channels: { "kapso-whatsapp": { defaultTo: "+390000000000" } } },
    pluginConfig: "pluginConfig" in options ? options.pluginConfig : PLUGIN_CONFIG,
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => (options.adapter === false ? undefined : { sendText }),
        },
      },
    },
  } as unknown as OpenClawPluginApi;
}

function pushBody(historyId: number): string {
  const data = JSON.stringify({ emailAddress: "lawyer@example.com", historyId });
  return JSON.stringify({ message: { data: Buffer.from(data).toString("base64") } });
}

function makeReq(method: string, authorization: string | null): IncomingMessage {
  const req = Readable.from([Buffer.from(pushBody(100))]) as unknown as IncomingMessage;
  req.method = method;
  req.headers = authorization === null ? {} : { authorization };
  return req;
}

let notifyState = createNotifyState();
const notifyDeps = (): NotifyDeps => ({
  certs: { getKey: vi.fn(async () => null) },
  now: Date.now,
  state: notifyState,
});

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
  const handled = await handleAdaGoogleNotify(
    makeReq("POST", authorization),
    res,
    api,
    notifyDeps(),
  );
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
      heldPlanAtMs: null,
      heldPlanAttempts: 0,
      heldPlanNextAttemptAtMs: null,
      heldPlanTemplateAttemptedAtMs: null,
      watchExpirationMs: null,
      openTodoIdsJson: null,
    })),
    readProfile: vi.fn(async () => null),
    replaceGmailSnapshot: vi.fn(async () => {}),
    replaceCalendarSnapshot: vi.fn(async () => {}),
    writeWake: vi.fn(async (_patch: Record<string, unknown>) => {}),
    ...overrides,
  };
  openAdaMemoryFromApi.mockResolvedValue(memory);
  return memory;
}

function useGoogleAccount(connected: boolean) {
  openAdaGoogleAccountFromApi.mockResolvedValue({
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
  notifyState = createNotifyState();
  vi.clearAllMocks();
  fetchMock.mockReset();
  sendText.mockReset();
  sendText.mockResolvedValue(undefined);
  clearSentDigests();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("handleAdaGoogleNotify auth", () => {
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
    expect(openAdaMemoryFromApi).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
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
    expect(openAdaMemoryFromApi).not.toHaveBeenCalled();
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

describe("handleAdaGoogleNotify push handling", () => {
  it("acknowledges a valid push with 204 when Google is not connected, doing no Google work", async () => {
    const memory = useMemory();
    useGoogleAccount(false);
    const { handled, res } = await push(makeApi({}));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
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
      heldPlanAtMs: null,
      heldPlanAttempts: 0,
      heldPlanNextAttemptAtMs: null,
      heldPlanTemplateAttemptedAtMs: null,
    });
    expect(sendText).not.toHaveBeenCalled();
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
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sends one digest to the owner for an urgent matter hit when the WhatsApp window is open", async () => {
    const memory = useMemory({
      listMatterAliases: vi.fn(async () => [
        { matterId: "matter-a", alias: "Alpha", title: "Alpha matter" },
      ]),
      readWake: vi.fn(async () => ({
        lastLawyerInboundAtMs: NOW.getTime() - 60_000,
        lastReconcileAtMs: null,
        lastCollectAtMs: null,
        heldPlanJson: null,
        heldPlanAtMs: null,
        heldPlanAttempts: 0,
        heldPlanNextAttemptAtMs: null,
        heldPlanTemplateAttemptedAtMs: null,
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
    expect(sendText).toHaveBeenCalledTimes(1);
    const call = sendText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({ to: `+${OWNER}` });
    expect(String(call.text)).toContain("Alpha matter");
    expect(memory.writeWake).toHaveBeenCalledWith(
      expect.objectContaining({
        lastCollectAtMs: NOW.getTime(),
        lastDigestAtMs: NOW.getTime(),
        heldPlanJson: null,
      }),
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
    expect(sendText).not.toHaveBeenCalled();
    const held = memory.writeWake.mock.calls.find(([patch]) => patch.heldPlanJson);
    expect(held).toBeDefined();
    expect(JSON.parse(String(held?.[0].heldPlanJson))).toMatchObject({ deliver: true });
    expect(held?.[0].heldPlanAtMs).toBe(NOW.getTime());
  });

  describe("when the digest cannot be sent", () => {
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
          heldPlanAtMs: null,
          heldPlanAttempts: 0,
          heldPlanNextAttemptAtMs: null,
          heldPlanTemplateAttemptedAtMs: null,
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

    it("still answers 204, holds the plan for retry, and records no digest when WhatsApp is unavailable", async () => {
      const memory = openWindowMemory();
      useGoogleAccount(true);
      useGoogleApis({ events: [alphaEvent] });
      const { res } = await push(makeApi({ adapter: false }));
      expect(res.statusCode).toBe(204);
      expect(memory.writeWake).toHaveBeenCalledTimes(1);
      expect(memory.writeWake).toHaveBeenCalledWith(
        expect.objectContaining({
          lastCollectAtMs: NOW.getTime(),
          heldPlanJson: expect.any(String),
          heldPlanAttempts: 1,
        }),
      );
      expect(memory.writeWake.mock.calls[0]?.[0]).not.toHaveProperty("lastDigestAtMs");
      expect(memory.replaceGmailSnapshot).not.toHaveBeenCalled();
      expect(memory.replaceCalendarSnapshot).not.toHaveBeenCalled();
    });

    it("still answers 204, holds the plan for retry, and records no digest when the send fails", async () => {
      const memory = openWindowMemory();
      useGoogleAccount(true);
      useGoogleApis({ events: [alphaEvent] });
      sendText.mockRejectedValue(new Error("queue_full"));
      const { res } = await push(makeApi({}));
      expect(res.statusCode).toBe(204);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(memory.writeWake).toHaveBeenCalledTimes(1);
      expect(memory.writeWake).toHaveBeenCalledWith(
        expect.objectContaining({
          lastCollectAtMs: NOW.getTime(),
          heldPlanJson: expect.any(String),
          heldPlanAttempts: 1,
        }),
      );
      expect(memory.writeWake.mock.calls[0]?.[0]).not.toHaveProperty("lastDigestAtMs");
      expect(memory.replaceGmailSnapshot).not.toHaveBeenCalled();
      expect(memory.replaceCalendarSnapshot).not.toHaveBeenCalled();
    });
  });

  it("keeps an undelivered plan as held when the send fails", async () => {
    const memory = useMemory({
      listMatterAliases: vi.fn(async () => [
        { matterId: "matter-a", alias: "Alpha", title: "Alpha matter" },
      ]),
      readWake: vi.fn(async () => ({
        lastLawyerInboundAtMs: NOW.getTime() - 60_000,
        lastReconcileAtMs: null,
        lastCollectAtMs: null,
        heldPlanJson: null,
        heldPlanAtMs: null,
        heldPlanAttempts: 0,
        heldPlanNextAttemptAtMs: null,
        heldPlanTemplateAttemptedAtMs: null,
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
    sendText.mockRejectedValue(new Error("queue_full"));
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
    expect(logger.error).toHaveBeenCalledWith("ada google notify failed: sqlite is locked");
  });

  it("answers 500 when the memory store cannot open", async () => {
    openAdaMemoryFromApi.mockRejectedValue(new Error("worker crashed"));
    const { res } = await push(makeApi({}));
    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalledWith("ada google notify failed: worker crashed");
  });
});
