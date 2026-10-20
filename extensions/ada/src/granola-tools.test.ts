import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANNA,
  BRUNO,
  newMockGranola,
  openGranolaTestDb,
  signInThroughFlow,
  testApi,
} from "./granola-test-support.js";
import {
  executeAdaGranolaCall,
  executeAdaGranolaDisconnect,
  executeAdaGranolaTools,
  clearGranolaResults,
  GRANOLA_RESULT_CHARS,
} from "./granola-tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = new Date("2026-10-20T09:00:00.000Z");

async function setup() {
  const mock = newMockGranola();
  clearGranolaResults();
  const store = openGranolaTestDb(tempDirs.make("ada-granola-tools-"));
  const api = testApi();
  const deps = { db: store.db, fetchImpl: mock.fetch, now: NOW };
  mock.meetings.set("anna", [
    {
      id: "m-anna-1",
      title: "Rossi settlement call",
      date: "2026-10-14",
      notes: "Settlement: Rossi agreed to pay by 30 November. Action: send draft to Anna.",
      transcript: "Anna: we settle. Rossi: agreed.",
    },
  ]);
  mock.meetings.set("bruno", [
    {
      id: "m-bruno-1",
      title: "Bianchi board meeting",
      date: "2026-10-15",
      notes: "Board approved the Bianchi merger.",
      transcript: "Bruno: the board approved it.",
    },
  ]);
  await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now: NOW });
  await signInThroughFlow({ mock, db: store.db, owner: BRUNO, user: "bruno", now: NOW });
  const mcpCalls = (method: string) =>
    mock.requests.filter(
      (request) =>
        new URL(request.url).pathname === "/mcp" && request.body?.includes(`"${method}"`),
    );
  return { mock, store, api, deps, mcpCalls };
}

describe("Granola tool proxy", () => {
  it("discovers the real tool list for the person's plan, read-only tools only", async () => {
    const { api, deps } = await setup();
    const result = await executeAdaGranolaTools(ANNA, api, undefined, deps);
    expect(result).toMatchObject({ ok: true });
    const names = (result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "query_granola_meetings",
      "list_meetings",
      "list_meeting_folders",
      "get_meeting_transcript",
    ]);
    expect(JSON.stringify(result)).toContain('"required":["query"]');
  });

  it("calls a tool with the owner's own Granola token and returns only the owner's meetings", async () => {
    const { mock, api, deps, store } = await setup();
    const anna = await executeAdaGranolaCall(ANNA, api, { tool: "list_meetings" }, undefined, deps);
    const bruno = await executeAdaGranolaCall(
      BRUNO,
      api,
      { tool: "list_meetings" },
      undefined,
      deps,
    );
    expect(anna).toMatchObject({ ok: true, truncated: false });
    expect((anna as { text: string }).text).toContain("Rossi settlement call");
    expect((anna as { text: string }).text).not.toContain("Bianchi");
    expect((bruno as { text: string }).text).toContain("Bianchi board meeting");
    expect((bruno as { text: string }).text).not.toContain("Rossi");

    const annaToken = (await store.db.readAccount(ANNA))?.accessToken;
    const brunoToken = (await store.db.readAccount(BRUNO))?.accessToken;
    const bearers = mock.requests
      .filter(
        (request) =>
          new URL(request.url).pathname === "/mcp" && request.body?.includes("list_meetings"),
      )
      .map((request) => request.authorization);
    expect(bearers).toEqual([`Bearer ${annaToken}`, `Bearer ${brunoToken}`]);

    const question = await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "query_granola_meetings", arguments: { query: "settlement" } },
      undefined,
      deps,
    );
    expect((question as { text: string }).text).toContain("30 November");
  });

  it("serves a number that never connected nothing, and does not reach Granola for it", async () => {
    const { mock, api, deps } = await setup();
    mock.requests.length = 0;
    const carla = await executeAdaGranolaCall(
      "393333333333",
      api,
      { tool: "list_meetings" },
      undefined,
      deps,
    );
    expect(carla).toMatchObject({ ok: false, reason: "not_connected" });
    expect(await executeAdaGranolaTools("393333333333", api, undefined, deps)).toMatchObject({
      reason: "not_connected",
    });
    expect(mock.requests.filter((request) => new URL(request.url).pathname === "/mcp")).toEqual([]);
  });

  it("never lets a result or a cache entry cross from one number to another", async () => {
    const { api, deps } = await setup();
    const same = { tool: "query_granola_meetings", arguments: { query: "board" } } as const;
    await executeAdaGranolaCall(ANNA, api, same, undefined, deps);
    const bruno = await executeAdaGranolaCall(BRUNO, api, same, undefined, deps);
    expect((bruno as { text: string }).text).toContain("Board approved");
    const annaAgain = await executeAdaGranolaCall(ANNA, api, same, undefined, deps);
    expect((annaAgain as { text: string }).text).toBe("No meeting matches.");
  });

  it("cuts a long transcript to the limit, and pages the rest without fetching it again", async () => {
    const { mock, api, deps, mcpCalls } = await setup();
    const lines = Array.from(
      { length: 3000 },
      (_, index) => `Speaker ${index}: line number ${index} of the call`,
    );
    const transcript = lines.join("\n");
    mock.meetings.get("anna")![0]!.transcript = transcript;
    const first = (await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "get_meeting_transcript", arguments: { meeting_id: "m-anna-1" } },
      undefined,
      deps,
    )) as {
      text: string;
      truncated: boolean;
      nextOffset: number;
      totalChars: number;
      note: string;
    };
    expect(first.truncated).toBe(true);
    expect(first.text.length).toBeLessThanOrEqual(GRANOLA_RESULT_CHARS);
    expect(first.totalChars).toBe(transcript.length);
    expect(first.note).toContain("nextOffset");
    expect(first.text.endsWith("of the call")).toBe(true);

    let text = first.text;
    let next: number | undefined = first.nextOffset;
    while (next !== undefined) {
      const page = (await executeAdaGranolaCall(
        ANNA,
        api,
        { tool: "get_meeting_transcript", arguments: { meeting_id: "m-anna-1" }, offset: next },
        undefined,
        deps,
      )) as { text: string; truncated: boolean; nextOffset?: number };
      expect(page.text.length).toBeLessThanOrEqual(GRANOLA_RESULT_CHARS);
      text += page.text;
      next = page.truncated ? page.nextOffset : undefined;
    }
    expect(text.replaceAll("\n", "")).toBe(transcript.replaceAll("\n", ""));
    expect(mcpCalls("tools/call")).toHaveLength(1);
  });

  it("tells the model what to do when Granola says the transcript is too large", async () => {
    const { mock, api, deps } = await setup();
    mock.transcriptError = "Transcript exceeds the maximum size that can be returned.";
    const tool = { tool: "get_meeting_transcript", arguments: { meeting_id: "m-anna-1" } };
    expect(await executeAdaGranolaCall(ANNA, api, tool, undefined, deps)).toMatchObject({
      ok: false,
      reason: "too_large",
      error: expect.stringContaining("narrower"),
    });
    mock.transcriptError = null;
    mock.mcpStatusOverride = { status: 413, body: "Payload Too Large" };
    expect(await executeAdaGranolaCall(ANNA, api, tool, undefined, deps)).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });

  it("explains a free-plan limit instead of failing, and reports a tool the plan lacks", async () => {
    const { mock, api, deps } = await setup();
    mock.transcriptError =
      "This feature requires a paid Granola plan. The free plan only includes notes from the last 30 days.";
    const planned = await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "get_meeting_transcript", arguments: { meeting_id: "m-anna-1" } },
      undefined,
      deps,
    );
    expect(planned).toMatchObject({ ok: false, reason: "plan_limit" });
    expect((planned as { error: string }).error).toContain("last 30 days");
    expect((planned as { error: string }).error).toContain("naturally");

    mock.transcriptError = null;
    mock.plan = "free";
    const missing = await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "get_meeting_transcript", arguments: { meeting_id: "m-anna-1" } },
      undefined,
      deps,
    );
    expect(missing).toMatchObject({ ok: false, reason: "tool_unavailable" });
    expect((missing as { available: string[] }).available).toContain("list_meetings");
    expect((missing as { available: string[] }).available).not.toContain("get_meeting_transcript");

    mock.mcpStatusOverride = { status: 403, body: "Upgrade to a paid plan to use this tool" };
    expect(
      await executeAdaGranolaCall(ANNA, api, { tool: "list_meetings" }, undefined, deps),
    ).toMatchObject({ ok: false, reason: "plan_limit" });
  });

  it("never calls a tool that would change Granola", async () => {
    const { api, deps, mcpCalls } = await setup();
    const refused = await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "delete_meeting", arguments: { meeting_id: "m-anna-1" } },
      undefined,
      deps,
    );
    expect(refused).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(mcpCalls("tools/call")).toHaveLength(0);
    const listed = await executeAdaGranolaTools(ANNA, api, undefined, deps);
    expect(JSON.stringify(listed)).not.toContain("delete_meeting");
    expect(
      await executeAdaGranolaCall(ANNA, api, { tool: "bad name!" }, undefined, deps),
    ).toMatchObject({ ok: false, reason: "invalid_request" });
  });

  it("renews a token Granola refused and repeats the call once", async () => {
    const { mock, api, deps, store } = await setup();
    mock.expireAccessTokens("anna");
    const before = await store.db.readAccount(ANNA);
    const result = await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "list_meetings" },
      undefined,
      deps,
    );
    expect(result).toMatchObject({ ok: true });
    expect(mock.refreshes).toBe(1);
    expect((await store.db.readAccount(ANNA))?.accessToken).not.toBe(before?.accessToken);
  });
});

describe("Granola tool safety", () => {
  it("lets through only tools that are read-only by annotation or by a read verb", async () => {
    const { mock, api, deps } = await setup();
    mock.extraTools = [
      { name: "note_update", description: "x", inputSchema: { type: "object" } },
      { name: "delete", description: "x", inputSchema: { type: "object" } },
      { name: "export_all", description: "x", inputSchema: { type: "object" } },
      {
        name: "weird_name",
        description: "x",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_and_rewrite",
        description: "x",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false },
      },
    ];
    const listed = (await executeAdaGranolaTools(ANNA, api, undefined, deps)) as {
      tools: Array<{ name: string }>;
    };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("weird_name");
    for (const refused of ["note_update", "delete", "export_all", "get_and_rewrite"]) {
      expect(names).not.toContain(refused);
      expect(
        await executeAdaGranolaCall(ANNA, api, { tool: refused }, undefined, deps),
      ).toMatchObject({ ok: false, reason: "invalid_request" });
    }
    expect(
      await executeAdaGranolaCall(ANNA, api, { tool: "weird_name" }, undefined, deps),
    ).toMatchObject({
      ok: true,
      text: "ok",
    });
  });

  it("reads the answer to its own request, not a server request in the same event stream", async () => {
    const { mock, api, deps } = await setup();
    mock.sseNoise = true;
    const result = await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "list_meetings" },
      undefined,
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      text: expect.stringContaining("Rossi settlement call"),
    });
  });

  it("reads the plan before the size, and a refusal that is not about the plan is not a plan limit", async () => {
    const { mock, api, deps } = await setup();
    const call = () =>
      executeAdaGranolaCall(
        ANNA,
        api,
        { tool: "get_meeting_transcript", arguments: { meeting_id: "m-anna-1" } },
        undefined,
        deps,
      );
    mock.transcriptError = "You have exceeded the free plan limit for transcripts.";
    expect(await call()).toMatchObject({ reason: "plan_limit" });
    mock.transcriptError = "Rate limit exceeded, try again later.";
    expect(await call()).toMatchObject({ reason: "unavailable" });
    mock.transcriptError = null;
    mock.mcpStatusOverride = { status: 403, body: "Forbidden" };
    expect(await call()).toMatchObject({ reason: "unavailable" });
  });

  it("serves a cached result only to the sign-in that fetched it", async () => {
    const { mock, api, deps, store } = await setup();
    const first = await executeAdaGranolaCall(
      ANNA,
      api,
      { tool: "list_meetings" },
      undefined,
      deps,
    );
    expect((first as { text: string }).text).toContain("Rossi");
    mock.meetings.set("anna-two", [
      {
        id: "x1",
        title: "Another account's call",
        date: "2026-10-16",
        notes: "n",
        transcript: "t",
      },
    ]);
    await signInThroughFlow({
      mock,
      db: store.db,
      owner: ANNA,
      user: "anna-two",
      now: new Date(NOW.getTime() + 1000),
    });
    const second = await executeAdaGranolaCall(ANNA, api, { tool: "list_meetings" }, undefined, {
      ...deps,
      now: new Date(NOW.getTime() + 2000),
    });
    expect((second as { text: string }).text).toContain("Another account's call");
    expect((second as { text: string }).text).not.toContain("Rossi");
  });

  it("keeps a sign-in made while Granola was refusing the old one", async () => {
    const { mock, api, deps, store } = await setup();
    mock.expireAccessTokens("anna");
    mock.refreshFailure = "server_error";
    expect(
      await executeAdaGranolaCall(ANNA, api, { tool: "list_meetings" }, undefined, deps),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await store.db.readAccount(ANNA)).not.toBeNull();
  });
});

describe("Granola disconnect", () => {
  it("revokes and deletes one number's sign-in and leaves every other number alone", async () => {
    const { mock, api, deps, store } = await setup();
    await executeAdaGranolaCall(ANNA, api, { tool: "list_meetings" }, undefined, deps);
    const annaRefresh = (await store.db.readAccount(ANNA))?.refreshToken;
    const result = await executeAdaGranolaDisconnect(ANNA, api, undefined, deps);
    expect(result).toEqual({ ok: true, disconnected: true, revoked: true });
    const revocation = mock.requests.find((request) => request.url.endsWith("/oauth2/revoke"));
    expect(new URLSearchParams(revocation?.body).get("token")).toBe(annaRefresh);
    expect(await store.db.readAccount(ANNA)).toBeNull();
    expect(await store.db.listOwners()).toEqual([BRUNO]);

    expect(
      await executeAdaGranolaCall(ANNA, api, { tool: "list_meetings" }, undefined, deps),
    ).toMatchObject({ ok: false, reason: "not_connected" });
    expect(
      await executeAdaGranolaCall(BRUNO, api, { tool: "list_meetings" }, undefined, deps),
    ).toMatchObject({ ok: true });
    expect(await executeAdaGranolaDisconnect(ANNA, api, undefined, deps)).toEqual({
      ok: true,
      disconnected: false,
      revoked: false,
    });
  });

  it("deletes the tokens even when Granola cannot revoke them", async () => {
    const { mock, api, deps, store } = await setup();
    const failing = {
      ...deps,
      fetchImpl: ((input, init) =>
        String(input).endsWith("/oauth2/revoke")
          ? Promise.reject(new Error("offline"))
          : mock.fetch(input, init)) as typeof fetch,
    };
    expect(await executeAdaGranolaDisconnect(BRUNO, api, undefined, failing)).toEqual({
      ok: true,
      disconnected: true,
      revoked: false,
    });
    expect(await store.db.readAccount(BRUNO)).toBeNull();
  });
});
