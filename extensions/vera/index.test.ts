import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

const TOOL_NAMES = [
  "vera_plan_digest",
  "vera_research",
  "vera_draft",
  "vera_google_connect",
  "vera_read_inbox",
  "vera_read_calendar",
  "vera_send_email",
  "vera_memory_search",
  "vera_memory_list",
  "vera_memory_get",
  "vera_memory_history",
  "vera_todo_list",
  "vera_todo_get",
];

it("registers digest tools, memory tools, wake service, and Google routes", () => {
  expect(getToolPluginMetadata(plugin)?.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerHttpRoute = vi.fn<OpenClawPluginApi["registerHttpRoute"]>();
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const on = vi.fn<OpenClawPluginApi["on"]>();
  plugin.register?.(
    createTestPluginApi({
      id: "vera",
      registerTool,
      registerHttpRoute,
      registerService,
      on,
    }),
  );
  expect(registerTool).toHaveBeenCalledTimes(TOOL_NAMES.length);
  expect(registerService).toHaveBeenCalledWith(
    expect.objectContaining({ id: "vera-instinct-wake", apiVersion: 2 }),
  );
  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/vera/google/callback" }),
  );
  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/vera/google/notify" }),
  );
  expect(on).toHaveBeenCalledWith("message_received", expect.any(Function));
  expect(on).toHaveBeenCalledWith(
    "before_prompt_build",
    expect.any(Function),
    expect.objectContaining({ requiresToolAuthority: true }),
  );
});
