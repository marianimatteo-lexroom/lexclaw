import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("./granola-account.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./granola-account.js")>()),
  openAdaGranolaAccountDbFromApi: async () => store.db,
}));

import plugin from "../index.js";
import {
  ANNA,
  BRUNO,
  GRANOLA_PLUGIN_CONFIG,
  newMockGranola,
  openGranolaTestDb,
  signInThroughFlow,
  type MockGranola,
} from "./granola-test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CARLA = "393333333333";
const direct = (number: string) => `agent:main:kapso-whatsapp:direct:${number}`;

type ToolContext = {
  requesterSenderId?: string;
  messageChannel?: string;
  sessionKey?: string;
  nativeChannelId?: string;
};
type Tool = { execute: (id: string, params: unknown) => Promise<{ details: unknown }> };

function registerAda(toolContext: ToolContext) {
  const tools = new Map<string, Tool>();
  plugin.register?.(
    createTestPluginApi({
      id: "ada",
      config: {} as OpenClawPluginApi["config"],
      pluginConfig: GRANOLA_PLUGIN_CONFIG,
      runtimeSource: "/fake/ada/index.ts",
      registerTool(tool) {
        const built = typeof tool === "function" ? tool(toolContext as never) : tool;
        for (const one of Array.isArray(built) ? built : [built]) {
          if (one && "name" in one) {
            tools.set(one.name, one as unknown as Tool);
          }
        }
      },
    }),
  );
  return {
    call: async (name: string, params: unknown = {}) =>
      (await tools.get(name)?.execute("call-1", params))?.details,
  };
}

const privateChat = (number: string): ToolContext => ({
  requesterSenderId: number,
  messageChannel: "kapso-whatsapp",
  sessionKey: direct(number),
});

let mock: MockGranola;

beforeEach(async () => {
  mock = newMockGranola();
  const opened = openGranolaTestDb(tempDirs.make("ada-granola-isolation-"));
  store.db = opened.db;
  vi.stubGlobal("fetch", mock.fetch);
  vi.stubEnv("ADA_STATUS_REACTIONS", "false");
  mock.meetings.set("anna", [
    {
      id: "a1",
      title: "Anna's privileged call",
      date: "2026-10-14",
      notes: "secret of Anna",
      transcript: "t",
    },
  ]);
  mock.meetings.set("bruno", [
    {
      id: "b1",
      title: "Bruno's call",
      date: "2026-10-15",
      notes: "secret of Bruno",
      transcript: "t",
    },
  ]);
  await signInThroughFlow({ mock, db: opened.db, owner: ANNA, user: "anna", now: new Date() });
});

describe("one number's Granola never serves another", () => {
  it("answers each number from its own account, and Bruno, who never connected, gets nothing", async () => {
    const anna = registerAda(privateChat(ANNA));
    const bruno = registerAda(privateChat(BRUNO));
    expect(await anna.call("ada_granola_call", { tool: "list_meetings" })).toMatchObject({
      ok: true,
      text: expect.stringContaining("Anna's privileged call"),
    });
    expect(await bruno.call("ada_granola_call", { tool: "list_meetings" })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
    expect(await bruno.call("ada_granola_tools")).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
  });

  it("ignores any attempt to name another number in the arguments", async () => {
    const bruno = registerAda(privateChat(BRUNO));
    for (const attempt of [
      { tool: "list_meetings", owner: ANNA, number: ANNA },
      { tool: "list_meetings", arguments: { owner: ANNA, user: "anna", number: ANNA } },
    ]) {
      const result = await bruno.call("ada_granola_call", attempt);
      expect(result).toMatchObject({ ok: false, reason: "not_connected" });
      expect(JSON.stringify(result)).not.toContain("privileged");
    }
    expect(mock.requests.filter((request) => new URL(request.url).pathname === "/mcp")).toEqual([]);
    expect(await bruno.call("ada_granola_disconnect", { owner: ANNA })).toMatchObject({
      ok: true,
      disconnected: false,
    });
    const anna = registerAda(privateChat(ANNA));
    expect(await anna.call("ada_granola_call", { tool: "list_meetings" })).toMatchObject({
      ok: true,
    });
  });

  it("refuses groups, other channels and a sender that contradicts its session", async () => {
    const contexts: ToolContext[] = [
      {
        ...privateChat(ANNA),
        sessionKey: "agent:main:kapso-whatsapp:group:120363@g.us",
        nativeChannelId: "120363@g.us",
      },
      { ...privateChat(ANNA), messageChannel: "telegram" },
      { requesterSenderId: ANNA, messageChannel: "kapso-whatsapp", sessionKey: direct(BRUNO) },
      { messageChannel: "kapso-whatsapp" },
    ];
    for (const context of contexts) {
      const result = await registerAda(context).call("ada_granola_call", { tool: "list_meetings" });
      expect(result).toMatchObject({ ok: false, reason: "private_chat_required" });
    }
    expect(mock.requests.filter((request) => new URL(request.url).pathname === "/mcp")).toEqual([]);
  });

  it("gives each number its own connect link, which connects that number only", async () => {
    const bruno = registerAda(privateChat(CARLA));
    const result = (await bruno.call("ada_granola_connect")) as { ask: { url: string } };
    expect(result.ask.url).toMatch(/^https:\/\/vera\.example\/gr\//u);
    const anna = registerAda(privateChat(ANNA));
    expect(await anna.call("ada_granola_connect")).toMatchObject({ ok: true, connected: true });
  });

  it("disconnects only the number that asked, in conversation", async () => {
    const anna = registerAda(privateChat(ANNA));
    expect(await anna.call("ada_granola_disconnect")).toMatchObject({
      ok: true,
      disconnected: true,
    });
    expect(await anna.call("ada_granola_call", { tool: "list_meetings" })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
  });
});
