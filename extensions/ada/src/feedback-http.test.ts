import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdaFeedbackAdmin, readAdminToken } from "./feedback-http.js";
import type { MemoryStore } from "./memory.js";
import { realStore } from "./preference-test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TOKEN = "admin-token-0123456789";
const PAOLO = "393331111111";
const ANNA = "393332222222";
const T0 = Date.parse("2026-10-19T08:00:00.000Z");

let store: MemoryStore;

beforeEach(async () => {
  store = realStore(tempDirs.make("ada-feedback-http-"), "memory");
  await store.addFeedback({
    number: PAOLO,
    atMs: T0,
    category: "bug",
    text: "Link broken.",
    language: "it",
  });
  await store.addFeedback({
    number: ANNA,
    atMs: T0 + 1000,
    category: "missing_feature",
    text: "Add Outlook.",
    language: "en",
  });
  await store.addFeedback({
    number: PAOLO,
    atMs: T0 + 2000,
    category: "complaint",
    text: "Too slow.",
    language: "it",
  });
});

async function call(params: {
  method?: string;
  url?: string;
  authorization?: string;
  body?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const headers = new Map<string, string>();
  let body = "";
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    end: (chunk?: string) => {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const req = Object.assign(Readable.from(params.body === undefined ? [] : [params.body]), {
    method: params.method ?? "GET",
    url: params.url ?? "/ada/admin/feedback",
    headers: params.authorization ? { authorization: params.authorization } : {},
  }) as unknown as IncomingMessage;
  const log = { error: vi.fn() };
  const openRegistry = vi.fn(async () => store);
  const handled = await handleAdaFeedbackAdmin(req, res, {
    env: params.env ?? { ADA_ADMIN_TOKEN: TOKEN },
    openRegistry,
    log,
  });
  return { handled, res, headers, body: () => body, openRegistry, log };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("admin feedback endpoint: access", () => {
  it("is disabled, as a 404, when ADA_ADMIN_TOKEN is unset, blank or too short, even with a token", async () => {
    for (const env of [{}, { ADA_ADMIN_TOKEN: "  " }, { ADA_ADMIN_TOKEN: "short" }]) {
      const result = await call({ env, authorization: "Bearer short" });
      expect(result.handled).toBe(true);
      expect(result.res.statusCode).toBe(404);
      expect(result.openRegistry).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing token with 401 and opens nothing", async () => {
    const result = await call({});
    expect(result.res.statusCode).toBe(401);
    expect(result.headers.get("www-authenticate")).toBe("Bearer");
    expect(result.body()).not.toContain("Link broken");
    expect(result.openRegistry).not.toHaveBeenCalled();
  });

  it("rejects a wrong token, a token of another length, and a non-bearer scheme", async () => {
    for (const authorization of [
      "Bearer admin-token-012345678X",
      "Bearer admin-token-0123456789-extra",
      `Basic ${TOKEN}`,
      TOKEN,
    ]) {
      const result = await call({ authorization });
      expect(result.res.statusCode).toBe(401);
      expect(result.openRegistry).not.toHaveBeenCalled();
    }
  });

  it("lets the right token through on the bare path and both prefixes", async () => {
    for (const url of ["/admin/feedback", "/ada/admin/feedback", "/vera/admin/feedback"]) {
      expect((await call({ ...auth, url })).res.statusCode).toBe(200);
    }
  });

  it("does not answer other paths", async () => {
    expect((await call({ ...auth, url: "/ada/admin/other" })).res.statusCode).toBe(404);
  });

  it("reads the token only from ADA_ADMIN_TOKEN", () => {
    expect(readAdminToken({ ADA_ADMIN_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
    expect(readAdminToken({})).toBeNull();
  });
});

describe("GET /admin/feedback", () => {
  it("lists every report oldest first with a masked number, a stable hash and the language", async () => {
    const result = await call(auth);
    expect(result.res.statusCode).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const { entries } = JSON.parse(result.body()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(entries.map((entry) => entry.text)).toEqual([
      "Link broken.",
      "Add Outlook.",
      "Too slow.",
    ]);
    expect(entries[0]).toEqual({
      id: 1,
      numberLast4: "1111",
      numberHash: expect.stringMatching(/^[0-9a-f]{12}$/u),
      at: "2026-10-19T08:00:00.000Z",
      atMs: T0,
      category: "bug",
      text: "Link broken.",
      language: "it",
      status: "new",
    });
    expect(entries[0]?.numberHash).toBe(entries[2]?.numberHash);
    expect(entries[0]?.numberHash).not.toBe(entries[1]?.numberHash);
    expect(result.body()).not.toContain(PAOLO);
    expect(result.body()).not.toContain(ANNA);
    expect(result.body()).not.toContain("393");
  });

  it("returns only reports at or after since", async () => {
    const { entries } = JSON.parse(
      (await call({ ...auth, url: `/ada/admin/feedback?since=${T0 + 1000}` })).body(),
    ) as {
      entries: Array<{ text: string }>;
    };
    expect(entries.map((entry) => entry.text)).toEqual(["Add Outlook.", "Too slow."]);
    const none = JSON.parse(
      (await call({ ...auth, url: `/ada/admin/feedback?since=${T0 + 3000}` })).body(),
    );
    expect(none).toEqual({ ok: true, entries: [] });
  });

  it.each(["abc", "-5", "1.5", ""])("rejects since=%j with 400", async (since) => {
    expect(
      (await call({ ...auth, url: `/ada/admin/feedback?since=${since}` })).res.statusCode,
    ).toBe(400);
  });

  it("answers other methods with 405", async () => {
    const result = await call({ ...auth, method: "DELETE" });
    expect(result.res.statusCode).toBe(405);
    expect(result.headers.get("allow")).toBe("GET");
  });

  it("reports a store failure without its cause", async () => {
    store = {
      listFeedback: async () => {
        throw new Error("sqlite locked at /secret/path");
      },
    } as unknown as MemoryStore;
    const result = await call(auth);
    expect(result.res.statusCode).toBe(500);
    expect(result.body()).toBe("feedback unavailable");
    expect(result.log.error).toHaveBeenCalled();
  });
});

describe("POST /admin/feedback/<id>", () => {
  const post = (id: string, body: string, extra: { authorization?: string } = auth) =>
    call({ method: "POST", url: `/ada/admin/feedback/${id}`, body, ...extra });

  it("marks a report triaged and back to new, changing nothing else", async () => {
    const triaged = await post("2", '{"status":"triaged"}');
    expect(triaged.res.statusCode).toBe(200);
    expect(JSON.parse(triaged.body())).toMatchObject({
      ok: true,
      entry: { id: 2, status: "triaged", text: "Add Outlook.", numberLast4: "2222" },
    });
    const statuses = (await store.listFeedback(0)).map((entry) => entry.status);
    expect(statuses).toEqual(["new", "triaged", "new"]);
    expect(JSON.parse((await post("2", '{"status":"new"}')).body()).entry.status).toBe("new");
  });

  it("needs the token", async () => {
    expect((await post("2", '{"status":"triaged"}', {})).res.statusCode).toBe(401);
    expect(
      (await post("2", '{"status":"triaged"}', { authorization: "Bearer nope" })).res.statusCode,
    ).toBe(401);
    expect((await store.listFeedback(0)).every((entry) => entry.status === "new")).toBe(true);
  });

  it("rejects an unknown status, a bad body, a bad id and an oversized body", async () => {
    for (const [id, body] of [
      ["2", '{"status":"closed"}'],
      ["2", "not json"],
      ["2", "{}"],
      ["x", '{"status":"triaged"}'],
      ["2", `{"status":"triaged","pad":"${"x".repeat(3000)}"}`],
    ] as const) {
      expect((await post(id, body)).res.statusCode).toBe(400);
    }
    expect((await store.listFeedback(0)).every((entry) => entry.status === "new")).toBe(true);
  });

  it("answers 404 for a report that does not exist and 405 for GET on an id", async () => {
    expect((await post("99", '{"status":"triaged"}')).res.statusCode).toBe(404);
    const get = await call({ ...auth, url: "/ada/admin/feedback/2" });
    expect(get.res.statusCode).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await call({ ...auth, method: "POST" })).res.statusCode).toBe(405);
  });
});
