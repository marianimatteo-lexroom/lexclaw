import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("registers the Google connect link and the read-only Gmail and Calendar tools", () => {
  expect(getToolPluginMetadata(plugin)?.tools.map((tool) => tool.name)).toEqual([
    "vera_plan_digest",
    "vera_research",
    "vera_draft",
    "vera_google_connect",
    "vera_read_inbox",
    "vera_read_calendar",
  ]);
  expect(getToolPluginMetadata(plugin)?.configSchema).toMatchObject({
    properties: {
      googleClientId: { type: "string" },
      googleClientSecret: { type: "string" },
      googleRedirectUri: { type: "string" },
      googleStateSecret: { type: "string" },
    },
  });
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerHttpRoute = vi.fn<OpenClawPluginApi["registerHttpRoute"]>();
  plugin.register?.(
    createTestPluginApi({
      id: "vera",
      registerTool,
      registerHttpRoute,
    }),
  );
  expect(registerTool).toHaveBeenCalledTimes(6);
  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/vera/google/callback",
      auth: "plugin",
      match: "exact",
    }),
  );
});
