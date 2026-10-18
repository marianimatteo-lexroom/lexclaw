import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord, MemoryRevision, MemoryTodo } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";

const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn());

vi.mock("./memory.js", () => ({ openAdaMemoryIfExistsFromApi }));

import {
  executeAdaMemoryGet,
  executeAdaMemoryHistory,
  executeAdaMemoryList,
  executeAdaMemorySearch,
  executeAdaTodoGet,
  executeAdaTodoList,
} from "./memory-tools.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const api = { logger, runtimeSource: "/fake/index.ts", runtime: {} } as never;
const OWNER = "393331111111";
const OTHER = "393332222222";

const RECORD: MemoryRecord = {
  id: "dining",
  matterId: "matter-a",
  folder: "knowledge/preferences",
  type: "preference",
  title: "Dining",
  aliases: ["lunch", "pasta"],
  body: "- Prefers a quiet table.",
  validFromMs: 1,
  validToMs: null,
  supersededBy: null,
};

const TODO: MemoryTodo = {
  id: "todo-1",
  matterId: "matter-a",
  owner: "lawyer",
  title: "Confirm hearing date",
  status: "pending",
  detail: "Ask the clerk by Friday.",
  updatedAtMs: 5,
};

function useStore(store: Partial<MemoryStore>) {
  openAdaMemoryIfExistsFromApi.mockResolvedValue(store);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memory tools: store failure", () => {
  it("returns one generic error and logs the cause when the store cannot open", async () => {
    openAdaMemoryIfExistsFromApi.mockRejectedValue(new Error("sqlite is locked at /secret/path"));
    const results = await Promise.all([
      executeAdaMemorySearch(api, OWNER, { query: "pasta", matterId: "matter-a" }),
      executeAdaMemoryList(api, OWNER, { folder: "knowledge/facts", matterId: "matter-a" }),
      executeAdaMemoryGet(api, OWNER, { id: "dining", matterId: "matter-a" }),
      executeAdaMemoryHistory(api, OWNER, { id: "dining", matterId: "matter-a" }),
      executeAdaTodoList(api, OWNER),
      executeAdaTodoGet(api, OWNER, { id: "todo-1" }),
    ]);
    for (const result of results) {
      expect(result).toEqual({ ok: false, error: "Ada could not open the memory store." });
    }
    expect(logger.error).toHaveBeenCalledWith(
      "ada memory store failed: sqlite is locked at /secret/path",
    );
  });
});

describe("executeAdaMemorySearch", () => {
  it("scopes the search to the matter and returns rendered pages", async () => {
    const searchRecords = vi.fn(async () => [RECORD]);
    useStore({ searchRecords });
    const result = await executeAdaMemorySearch(api, OWNER, {
      query: "pasta",
      matterId: "matter-a",
    });
    expect(searchRecords).toHaveBeenCalledWith("pasta", "matter-a");
    expect(result).toMatchObject({
      ok: true,
      matterId: "matter-a",
      hits: [{ id: "dining", title: "Dining", folder: "knowledge/preferences" }],
    });
    const [hit] = (result as { hits: Array<{ page: string; aliases: string[] }> }).hits;
    expect(hit?.aliases).toEqual(["lunch", "pasta"]);
    expect(hit?.page).toContain("id: dining");
    expect(hit?.page).toContain("matter: matter-a");
    expect(hit?.page).toContain("Prefers a quiet table.");
  });

  it("returns an empty hit list when nothing matches", async () => {
    useStore({ searchRecords: vi.fn(async () => []) });
    expect(
      await executeAdaMemorySearch(api, OWNER, { query: "nothing", matterId: "matter-a" }),
    ).toEqual({
      ok: true,
      matterId: "matter-a",
      hits: [],
    });
  });
});

describe("executeAdaMemoryList", () => {
  it("rejects an unknown folder without opening the store", async () => {
    const result = await executeAdaMemoryList(api, OWNER, {
      folder: "../etc" as never,
      matterId: "matter-a",
    });
    expect(result).toEqual({ ok: false, error: "folder is invalid" });
    expect(openAdaMemoryIfExistsFromApi).not.toHaveBeenCalled();
  });

  it("lists id, title, and aliases without page bodies", async () => {
    const listRecords = vi.fn(async () => [RECORD]);
    useStore({ listRecords });
    const result = await executeAdaMemoryList(api, OWNER, {
      folder: "knowledge/preferences",
      matterId: "matter-a",
    });
    expect(listRecords).toHaveBeenCalledWith("knowledge/preferences", "matter-a");
    expect(result).toEqual({
      ok: true,
      matterId: "matter-a",
      folder: "knowledge/preferences",
      records: [{ id: "dining", title: "Dining", aliases: ["lunch", "pasta"] }],
    });
  });
});

describe("executeAdaMemoryGet", () => {
  it("renders the page for the owning matter", async () => {
    const getRecord = vi.fn(async () => RECORD);
    useStore({ getRecord });
    const result = await executeAdaMemoryGet(api, OWNER, { id: "dining", matterId: "matter-a" });
    expect(getRecord).toHaveBeenCalledWith("dining", "matter-a");
    expect(result).toMatchObject({ ok: true });
    expect((result as { page: string }).page).toContain("type: preference");
  });

  it("reports a missing record, including one owned by another matter", async () => {
    useStore({ getRecord: vi.fn(async () => null) });
    expect(await executeAdaMemoryGet(api, OWNER, { id: "dining", matterId: "matter-b" })).toEqual({
      ok: false,
      error: "record not found in that matter",
    });
  });
});

describe("executeAdaMemoryHistory", () => {
  it("returns revisions with ISO timestamps and previous bodies", async () => {
    const revision: MemoryRevision = {
      recordId: "dining",
      matterId: "matter-a",
      previousBody: "- Prefers a loud table.",
      reason: "correction",
      atMs: Date.parse("2026-10-01T10:00:00.000Z"),
    };
    useStore({ history: vi.fn(async () => [revision]) });
    expect(
      await executeAdaMemoryHistory(api, OWNER, { id: "dining", matterId: "matter-a" }),
    ).toEqual({
      ok: true,
      revisions: [
        {
          reason: "correction",
          at: "2026-10-01T10:00:00.000Z",
          previousBody: "- Prefers a loud table.",
        },
      ],
    });
  });
});

describe("todo tools", () => {
  it("lists todos without their detail text", async () => {
    useStore({ listTodos: vi.fn(async () => [TODO]) });
    expect(await executeAdaTodoList(api, OWNER)).toEqual({
      ok: true,
      todos: [
        {
          id: "todo-1",
          matterId: "matter-a",
          owner: "lawyer",
          title: "Confirm hearing date",
          status: "pending",
        },
      ],
    });
  });

  it("returns one todo with detail, or not found", async () => {
    const getTodo = vi.fn(async (id: string) => (id === "todo-1" ? TODO : null));
    useStore({ getTodo });
    expect(await executeAdaTodoGet(api, OWNER, { id: "todo-1" })).toEqual({ ok: true, todo: TODO });
    expect(await executeAdaTodoGet(api, OWNER, { id: "missing" })).toEqual({
      ok: false,
      error: "todo not found",
    });
  });
});

describe("memory belongs to one number each", () => {
  it("opens only the asking number's memory, and shows nothing to a number with none", async () => {
    const memories: Record<string, Partial<MemoryStore> | null> = {
      [OWNER]: {
        searchRecords: vi.fn(async () => [RECORD]),
        listTodos: vi.fn(async () => [TODO]),
        getTodo: vi.fn(async () => TODO),
        getRecord: vi.fn(async () => RECORD),
      },
      [OTHER]: null,
    };
    openAdaMemoryIfExistsFromApi.mockImplementation(async (_api: unknown, owner: string) => {
      return memories[owner] ?? null;
    });

    expect(await executeAdaTodoList(api, OTHER)).toEqual({ ok: true, todos: [] });
    expect(await executeAdaTodoGet(api, OTHER, { id: "todo-1" })).toEqual({
      ok: false,
      error: "todo not found",
    });
    expect(
      await executeAdaMemorySearch(api, OTHER, { query: "pasta", matterId: "matter-a" }),
    ).toMatchObject({ ok: true, hits: [] });
    expect(await executeAdaMemoryGet(api, OTHER, { id: "dining", matterId: "matter-a" })).toEqual({
      ok: false,
      error: "record not found in that matter",
    });
    expect(openAdaMemoryIfExistsFromApi).toHaveBeenCalledWith(api, OTHER);
    expect(openAdaMemoryIfExistsFromApi).not.toHaveBeenCalledWith(api, OWNER);

    expect(await executeAdaTodoList(api, OWNER)).toMatchObject({
      ok: true,
      todos: [{ id: "todo-1" }],
    });
  });

  it("takes the number from the host, so an argument naming another number changes nothing", async () => {
    const store = { listTodos: vi.fn(async () => [TODO]), getTodo: vi.fn(async () => TODO) };
    openAdaMemoryIfExistsFromApi.mockResolvedValue(store);
    await executeAdaTodoGet(api, OTHER, { id: "todo-1", owner: OWNER, number: OWNER } as never);
    expect(openAdaMemoryIfExistsFromApi).toHaveBeenCalledExactlyOnceWith(api, OTHER);
    expect(store.getTodo).toHaveBeenCalledWith("todo-1");
  });
});
