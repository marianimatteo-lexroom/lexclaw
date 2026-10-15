import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

const TOOL_NAMES = [
  "ada_plan_digest",
  "ada_research",
  "ada_draft",
  "ada_lexroom_connect",
  "ada_google_connect",
  "ada_read_inbox",
  "ada_read_calendar",
  "ada_send_email",
  "ada_deadline_list",
  "ada_deadline_reply",
  "ada_memory_search",
  "ada_memory_list",
  "ada_memory_get",
  "ada_memory_history",
  "ada_todo_list",
  "ada_todo_get",
];

it("registers digest tools, memory tools, wake service, and Google routes", () => {
  expect(getToolPluginMetadata(plugin)?.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerHttpRoute = vi.fn<OpenClawPluginApi["registerHttpRoute"]>();
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const on = vi.fn<OpenClawPluginApi["on"]>();
  plugin.register?.(
    createTestPluginApi({
      id: "ada",
      registerTool,
      registerHttpRoute,
      registerService,
      on,
    }),
  );
  expect(registerTool).toHaveBeenCalledTimes(TOOL_NAMES.length);
  expect(registerService).toHaveBeenCalledWith(
    expect.objectContaining({ id: "ada-instinct-wake", apiVersion: 2 }),
  );
  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/ada/google/callback" }),
  );
  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/ada/google/notify" }),
  );
  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/ada/lexroom/connect" }),
  );
  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/ada/status", auth: "plugin", match: "exact" }),
  );
  for (const legacy of [
    "/vera/google/callback",
    "/vera/google/notify",
    "/vera/lexroom/connect",
    "/vera/status",
  ]) {
    expect(registerHttpRoute).toHaveBeenCalledWith(expect.objectContaining({ path: legacy }));
  }
  expect(on).toHaveBeenCalledWith("message_received", expect.any(Function));
  expect(on).toHaveBeenCalledWith(
    "before_prompt_build",
    expect.any(Function),
    expect.objectContaining({ requiresToolAuthority: true }),
  );
});
