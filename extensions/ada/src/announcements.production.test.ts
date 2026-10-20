import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  appendAssistantMirrorMessageByIdentity: mocks.append,
}));
// The worker thread is the only boundary replaced: the real worker module runs in-process.
vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>()),
  openSqliteWorkerStore: async (params: {
    moduleUrl: URL;
    databasePath: string;
    input: unknown;
  }) => {
    const worker = (await import(/* @vite-ignore */ params.moduleUrl.href)) as {
      createSqliteWorkerBackend: (
        input: unknown,
        context: { databasePath: string },
      ) => { execute: (command: unknown) => unknown; close: () => void };
    };
    const backend = worker.createSqliteWorkerBackend(params.input, {
      databasePath: params.databasePath,
    });
    return {
      execute: async (command: unknown) => backend.execute(command),
      close: async () => backend.close(),
    };
  },
}));

import { registerAdaAnnouncementsAdmin } from "./announcements-http.js";
import { registerAnnouncementRelease, ANNOUNCEMENT_SETTLE_MS } from "./announcements.js";
import { ANNOUNCEMENTS_OFF_KEY } from "./memory-contract.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { clearHeldResearch, recordSenderInbound } from "./research-push.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TOKEN = "admin-token-0123456789";
const NOW = Date.parse("2026-10-20T09:00:00.000Z");
const PAOLO = "393331111111";
const ANNA = "393332222222";
const LUCA = "393333333333";
const OPTED_OUT = "393334444444";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const adaSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.ts");

type Entry = { sessionKey: string; entry: { sessionId: string; updatedAt: number } };
const direct = (agent: string, channel: string, owner: string, sessionId: string): Entry => ({
  sessionKey: `agent:${agent}:${channel}:direct:${owner}`,
  entry: { sessionId, updatedAt: NOW - 1000 },
});

/**
 * A host as strict as production: the session store is per agent and refuses a listing that names
 * none, reads of one session derive the agent from its key, and the sessions are filed by agent.
 */
function makeHost() {
  const sessions: Record<string, Entry[]> = {
    main: [
      direct("main", "kapso-whatsapp", PAOLO, "s-paolo"),
      direct("main", "kapso-whatsapp", ANNA, "s-anna"),
      direct("main", "telegram", "393339999999", "s-telegram"),
      direct("main", "kapso-whatsapp", OPTED_OUT, "s-optout"),
    ],
    second: [direct("second", "kapso-whatsapp", LUCA, "s-luca")],
  };
  const sent: Array<{ to: string; text: string }> = [];
  const stateDir = tempDirs.make("ada-announcements-production-");
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<unknown>>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const api = {
    config: {
      agents: { list: [{ id: "main", default: true }, { id: "second" }] },
      channels: { "kapso-whatsapp": { defaultTo: "+393330000000" } },
    },
    pluginConfig: {},
    logger,
    runtimeSource: adaSource,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: {
        session: {
          listSessionEntries: (params: { agentId?: string } = {}) => {
            if (!params.agentId) {
              throw new Error("Cannot resolve SQLite session scope without an agent id");
            }
            return sessions[params.agentId] ?? [];
          },
          getSessionEntryAsync: async (params: { agentId?: string; sessionKey: string }) => {
            const agentId = params.agentId ?? /^agent:([^:]+):/u.exec(params.sessionKey)?.[1];
            if (!agentId) {
              throw new Error("Cannot resolve SQLite session scope without an agent id");
            }
            return sessions[agentId]?.find((row) => row.sessionKey === params.sessionKey)?.entry;
          },
        },
      },
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (message: { to: string; text: string }) => {
              sent.push({ to: message.to, text: message.text });
            },
          }),
        },
      },
    },
    registerHttpRoute: (route: {
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
    }) => {
      routes.set(route.path, route.handler);
    },
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
      hooks.set(name, handler);
    },
  };
  registerAdaAnnouncementsAdmin(api as never);
  registerAnnouncementRelease(api as never);
  return { api, routes, hooks, sent };
}

async function request(
  host: ReturnType<typeof makeHost>,
  params: { method: string; path?: string; body?: unknown; token?: string },
) {
  const route = host.routes.get(params.path ?? "/ada/admin/announcements");
  let body = "";
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (chunk?: string) => {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const req = Object.assign(
    Readable.from(params.body === undefined ? [] : [JSON.stringify(params.body)]),
    {
      method: params.method,
      url: params.path ?? "/ada/admin/announcements",
      headers: { authorization: `Bearer ${params.token ?? TOKEN}` },
    },
  ) as unknown as IncomingMessage;
  await route?.(req, res);
  return { status: res.statusCode, json: JSON.parse(body) as Record<string, any> };
}

const announcement = {
  id: "granola-2026-10",
  feature: "granola",
  texts: { it: "Novità: Granola. Vuoi il link?", en: "New: Granola. Want the link?" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADA_ADMIN_TOKEN", TOKEN);
  clearInboundLanguages();
  clearHeldResearch();
  mocks.append.mockResolvedValue({ ok: true, messageId: "m1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("announcements through the registered production routes", () => {
  it("lists the recipients of every configured agent, WhatsApp direct chats only, on GET", async () => {
    const host = makeHost();
    const empty = await request(host, { method: "GET" });
    expect(empty).toEqual({ status: 200, json: { ok: true, announcements: [] } });

    const created = await request(host, {
      method: "POST",
      body: { ...announcement, dryRun: false },
    });
    expect(created.status).toBe(201);
    const listed = await request(host, { method: "GET", path: "/vera/admin/announcements" });
    expect(listed.status).toBe(200);
    const [row] = listed.json.announcements as Array<{
      recipients: Array<{ numberLast4: string }>;
    }>;
    expect(row?.recipients.map((recipient) => recipient.numberLast4)).toEqual([
      "1111",
      "2222",
      "3333",
      "4444",
    ]);
  });

  it("answers a dry run from the real stores: window, opt-out, feature probe and language", async () => {
    const host = makeHost();
    recordSenderInbound(PAOLO, NOW - 60_000);
    recordSenderInbound(LUCA, NOW - 60_000);
    recordSenderInbound(OPTED_OUT, NOW - 60_000);
    recordInboundLanguage(
      PAOLO,
      "Hello Ada, could you please check what is on my calendar tomorrow?",
    );
    await (
      await openAdaMemoryFromApi(host.api as never, OPTED_OUT)
    ).setPreference(ANNOUNCEMENTS_OFF_KEY, "No product news.", NOW);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const result = await request(host, { method: "POST", body: { ...announcement, dryRun: true } });
    expect(result.status).toBe(200);
    expect(
      (result.json.recipients as Array<Record<string, unknown>>).map((row) => [
        row.numberLast4,
        row.status,
        row.reason,
        row.language,
        row.text,
      ]),
    ).toEqual([
      ["1111", "would_send", null, "en", announcement.texts.en],
      ["2222", "pending", "window_closed", "it", announcement.texts.it],
      ["3333", "would_send", null, "it", announcement.texts.it],
      ["4444", "skipped", "announcements_off", null, null],
    ]);
    expect(host.sent).toEqual([]);
    expect(mocks.append).not.toHaveBeenCalled();
    expect((await request(host, { method: "GET" })).json.announcements).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("delivers on POST and after the next answer, naming the agent for every session access", async () => {
    const host = makeHost();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    recordSenderInbound(PAOLO, NOW - 60_000);
    const created = await request(host, { method: "POST", body: announcement });
    expect(created.status).toBe(201);
    expect(host.sent).toEqual([{ to: `+${PAOLO}`, text: announcement.texts.it }]);
    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionId: "s-paolo" }),
    );

    recordSenderInbound(LUCA, NOW);
    await host.hooks.get("message_sent")?.(
      {
        to: `+${LUCA}`,
        content: "answer",
        success: true,
        runId: "run-1",
        sessionKey: `agent:second:kapso-whatsapp:direct:${LUCA}`,
      },
      { channelId: "kapso-whatsapp" },
    );
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_SETTLE_MS);
    expect(host.sent.map((message) => message.to)).toEqual([`+${PAOLO}`, `+${LUCA}`]);
    expect(mocks.append).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "second", sessionId: "s-luca" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
