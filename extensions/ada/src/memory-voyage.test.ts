import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "./memory-contract.js";
import { EMBEDDING_DIMS } from "./memory-embeddings.js";
import {
  BACKFILL_BATCH,
  createVoyageEmbedder,
  withEmbeddings,
  type VoyageEmbedder,
} from "./memory-voyage.js";
import { openAdaMemory, wrapMemoryWorker, type MemoryStore } from "./memory.js";
import { createSqliteWorkerBackend } from "./memory.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ANNA = "393331111111";
const BRUNO = "393332222222";
const MODEL = "voyage-law-2";
const SECRET_KEY = "pa-secret-key-value";

/** A unit vector along one axis, so cosine is 1 for the same axis and 0 across axes. */
function axis(index: number, tilt = 0): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  vector[index] = 1;
  vector[index + 1] = tilt;
  return vector;
}

function note(id: string, title: string, body: string, matterId = "rossi"): MemoryRecord {
  return {
    id,
    matterId,
    folder: "knowledge/facts",
    type: "fact",
    title,
    aliases: [],
    body,
    validFromMs: 1,
    validToMs: null,
    supersededBy: null,
  };
}

function realOpen(databasePath: string): MemoryStore {
  const backend = createSqliteWorkerBackend(undefined, { databasePath });
  return wrapMemoryWorker({
    execute: async (command: { type: string; input: unknown }) =>
      (backend.execute as (command: unknown) => unknown)(command),
    close: async () => backend.close(),
  } as never);
}

/** Stands in for Voyage: the vector comes from the first keyword of `axes` found in the text. */
function fakeEmbedder(axes: Array<[string, number]>, model: string | null = MODEL) {
  const embed = vi.fn(async (texts: string[], _kind: "document" | "query") =>
    texts.map((text) => {
      const hit = axes.find(([word]) => text.toLowerCase().includes(word));
      return hit ? axis(hit[1]) : axis(900);
    }),
  );
  const embedder: VoyageEmbedder = { model: () => model, embed };
  return { embedder, embed };
}

const LEASE_AXES: Array<[string, number]> = [
  ["zzfee", 7],
  ["tenancy", 0],
  ["lease", 0],
  ["dinner", 5],
  ["salary", 10],
];

async function settle(store: MemoryStore) {
  if ("settled" in store && typeof store.settled === "function") {
    await store.settled();
  }
}

function seeded() {
  const dir = tempDirs.make("ada-voyage-");
  const store = realOpen(path.join(dir, "memory", `${ANNA}.sqlite`));
  return { dir, store };
}

describe("memory embeddings schema", () => {
  it("adds the vector table to a memory file that predates it, keeping its notes", async () => {
    const dir = tempDirs.make("ada-voyage-migrate-");
    const file = path.join(dir, "old.sqlite");
    const first = realOpen(file);
    await first.upsertRecord(note("lease", "Lease", "Tenancy ended in May"), "create", 1);
    const db = new DatabaseSync(file);
    db.exec("DROP TABLE vera_record_embeddings");
    db.close();

    const reopened = realOpen(file);
    expect(await reopened.getRecord("lease", "rossi")).toMatchObject({ title: "Lease" });
    expect(await reopened.listUnembedded(MODEL, 10)).toEqual([
      { id: "lease", text: "Lease\nTenancy ended in May" },
    ]);
    expect(
      await reopened.storeEmbeddings(MODEL, [
        { id: "lease", text: "Lease\nTenancy ended in May", vector: axis(0) },
      ]),
    ).toBe(1);
  });
});

describe("embedding on write", () => {
  it("embeds a stored note as a document and keeps the vector in the same file", async () => {
    const { store } = seeded();
    const { embedder, embed } = fakeEmbedder(LEASE_AXES);
    const memory = withEmbeddings(store, { owner: ANNA, embedder });

    await memory.upsertRecord(note("lease", "Lease", "Tenancy ended in May"), "create", 1);
    await memory.settled();

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(["Lease\nTenancy ended in May"], "document");
    expect(await store.listUnembedded(MODEL, 10)).toEqual([]);
  });

  it("drops the vector when the note changes and embeds the new text", async () => {
    const { store } = seeded();
    const { embedder, embed } = fakeEmbedder(LEASE_AXES);
    const memory = withEmbeddings(store, { owner: ANNA, embedder });
    await memory.upsertRecord(note("n", "Note", "Tenancy"), "create", 1);
    await memory.settled();

    await store.upsertRecord(note("n", "Note", "Dinner"), "correction", 2);
    expect(await store.listUnembedded(MODEL, 10)).toEqual([{ id: "n", text: "Note\nDinner" }]);
    // A vector computed for the old text is refused.
    expect(
      await store.storeEmbeddings(MODEL, [{ id: "n", text: "Note\nTenancy", vector: axis(0) }]),
    ).toBe(0);

    await memory.upsertRecord(note("n", "Note", "Dinner"), "correction", 3);
    await memory.settled();
    expect(embed).toHaveBeenLastCalledWith(["Note\nDinner"], "document");
    expect(await store.listUnembedded(MODEL, 10)).toEqual([]);
  });
});

describe("hybrid recall", () => {
  it("ranks a note about the same meaning above unrelated ones, with no shared word", async () => {
    const { store } = seeded();
    const { embedder } = fakeEmbedder(LEASE_AXES);
    const memory = withEmbeddings(store, { owner: ANNA, embedder });
    await memory.upsertRecord(note("a-dinner", "Dinner", "Dinner with the client"), "create", 1);
    await memory.upsertRecord(
      note("b-lease", "Landlord", "Lease terminated by the landlord"),
      "create",
      1,
    );
    await memory.upsertRecord(note("c-salary", "Pay", "Salary review"), "create", 1);
    await memory.settled();
    await memory.settled();

    const hits = await memory.searchRecords("tenancy", "rossi");
    expect(hits.map((hit) => hit.id)).toEqual(["b-lease"]);
  });

  it("blends a keyword match with similarity instead of letting either decide alone", async () => {
    const { store } = seeded();
    const { embedder } = fakeEmbedder(LEASE_AXES);
    const memory = withEmbeddings(store, { owner: ANNA, embedder });
    await memory.upsertRecord(note("a-keyword", "Tenancy fee", "zzfee"), "create", 1);
    await memory.upsertRecord(note("b-meaning", "Landlord", "Lease terminated"), "create", 1);
    await memory.settled();
    await memory.settled();

    const hits = await memory.searchRecords("tenancy", "rossi");
    expect(hits.map((hit) => hit.id)).toEqual(["b-meaning", "a-keyword"]);
  });

  it("keeps notes without a vector findable by keyword", async () => {
    const { store } = seeded();
    await store.upsertRecord(note("plain", "Rossi", "No vector yet"), "create", 1);
    const { embedder } = fakeEmbedder([["rossi", 0]]);
    const memory = withEmbeddings(store, { owner: ANNA, embedder });
    expect((await memory.searchRecords("rossi", "rossi")).map((hit) => hit.id)).toEqual(["plain"]);
    await memory.settled();
  });

  it("reads only the number's own file", async () => {
    const dir = tempDirs.make("ada-voyage-isolation-");
    const location = { runtimeSource: "/fake/index.ts", stateDir: dir };
    const { embedder } = fakeEmbedder(LEASE_AXES);
    const open = (owner: string) =>
      openAdaMemory({
        ...location,
        owner,
        embedder,
        open: async (databasePath) => realOpen(databasePath),
      });
    const anna = await open(ANNA);
    const bruno = await open(BRUNO);
    await anna.upsertRecord(note("lease", "Landlord", "Lease terminated"), "create", 1);
    await settle(anna);

    expect((await anna.searchRecords("tenancy", "rossi")).map((hit) => hit.id)).toEqual(["lease"]);
    expect(await bruno.searchRecords("tenancy", "rossi")).toEqual([]);
    expect(await bruno.listUnembedded(MODEL, 10)).toEqual([]);
    expect(await bruno.getRecord("lease", "rossi")).toBeNull();
  });
});

describe("fallback to keyword search", () => {
  it("answers from keywords when the embedder returns nothing, without failing", async () => {
    const { store } = seeded();
    await store.upsertRecord(note("rossi", "Rossi", "Settlement"), "create", 1);
    const embed = vi.fn(async () => null);
    const memory = withEmbeddings(store, { owner: ANNA, embedder: { model: () => MODEL, embed } });

    expect((await memory.searchRecords("rossi", "rossi")).map((hit) => hit.id)).toEqual(["rossi"]);
    await memory.upsertRecord(note("other", "Other", "Body"), "create", 2);
    await memory.settled();
    expect(await store.listUnembedded(MODEL, 10)).toHaveLength(2);
  });

  it("survives a store that cannot list or save vectors", async () => {
    const { store } = seeded();
    await store.upsertRecord(note("rossi", "Rossi", "Settlement"), "create", 1);
    const broken: MemoryStore = {
      ...store,
      listUnembedded: async () => {
        throw new Error("disk");
      },
    };
    const log = vi.fn();
    const { embedder } = fakeEmbedder([]);
    const memory = withEmbeddings(broken, { owner: ANNA, embedder, log });
    expect((await memory.searchRecords("rossi", "rossi")).map((hit) => hit.id)).toEqual(["rossi"]);
    await memory.settled();
    expect(log).toHaveBeenCalledWith("ada memory embeddings failed error=Error owner=+39…1111");
  });

  it("gives up after backoff on 429 for documents, and quietly pauses further requests", async () => {
    let clock = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    const embedder = createVoyageEmbedder({
      env: { VOYAGE_API_KEY: SECRET_KEY },
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      now: () => clock,
    });

    expect(await embedder.embed(["a"], "document")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000]);

    expect(await embedder.embed(["a"], "query")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clock += 61_000;
    expect(await embedder.embed(["a"], "query")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("honors Retry-After, and tries a search only once", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "7" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: axis(3) }] }));
    const embedder = createVoyageEmbedder({
      env: { VOYAGE_API_KEY: SECRET_KEY },
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });
    expect(await embedder.embed(["a"], "document")).toEqual([axis(3)]);
    expect(sleep).toHaveBeenCalledWith(7_000);

    const limited = vi.fn(async () => new Response("", { status: 429 }));
    const query = createVoyageEmbedder({
      env: { VOYAGE_API_KEY: SECRET_KEY },
      fetch: limited as unknown as typeof fetch,
      sleep,
    });
    expect(await query.embed(["a"], "query")).toBeNull();
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it("returns null on a timeout, a network error, a server error or a malformed answer", async () => {
    for (const failure of [
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.resolve(new Response("", { status: 503 })),
      () => Promise.resolve(Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] })),
      () => Promise.resolve(Response.json({})),
    ]) {
      const embedder = createVoyageEmbedder({
        env: { VOYAGE_API_KEY: SECRET_KEY },
        fetch: vi.fn(failure) as unknown as typeof fetch,
      });
      expect(await embedder.embed(["a"], "query")).toBeNull();
    }
  });

  it("sends the documented request, with the model from the environment", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        data: [
          { index: 1, embedding: axis(2) },
          { index: 0, embedding: axis(1) },
        ],
      }),
    );
    const embedder = createVoyageEmbedder({
      env: { VOYAGE_API_KEY: SECRET_KEY, ADA_MEMORY_EMBEDDING_MODEL: "voyage-3" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(embedder.model()).toBe("voyage-3");
    expect(await embedder.embed(["one", "two"], "document")).toEqual([axis(1), axis(2)]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toEqual({
      input: ["one", "two"],
      model: "voyage-3",
      input_type: "document",
    });
  });
});

describe("lazy backfill", () => {
  it("embeds a number's old notes a small batch per pass and logs only counts", async () => {
    const { store } = seeded();
    for (let index = 0; index < 20; index += 1) {
      const id = `note-${String(index).padStart(2, "0")}`;
      await store.upsertRecord(note(id, `Title ${index}`, "Private client detail"), "create", 1);
    }
    const { embedder, embed } = fakeEmbedder(LEASE_AXES);
    const log = vi.fn();
    const memory = withEmbeddings(store, { owner: ANNA, embedder, log });

    await memory.searchRecords("anything", "rossi");
    await memory.settled();
    expect(
      embed.mock.calls.filter(([, kind]) => kind === "document").map(([texts]) => texts.length),
    ).toEqual([BACKFILL_BATCH]);
    expect(await store.listUnembedded(MODEL, 50)).toHaveLength(20 - BACKFILL_BATCH);

    await memory.searchRecords("anything", "rossi");
    await memory.settled();
    await memory.searchRecords("anything", "rossi");
    await memory.settled();
    expect(await store.listUnembedded(MODEL, 50)).toEqual([]);

    const logged = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logged).toContain(`ada memory embeddings stored=${BACKFILL_BATCH} owner=+39…1111`);
    expect(logged).not.toContain("Private client detail");
    expect(logged).not.toContain(ANNA);
    expect(logged).not.toContain(SECRET_KEY);
  });

  it("does not make a reply wait for the backfill", async () => {
    const { store } = seeded();
    await store.upsertRecord(note("rossi", "Rossi", "Settlement"), "create", 1);
    const pendingDocuments = Promise.withResolvers<number[][] | null>();
    const embed = vi.fn(async (_texts: string[], kind: "document" | "query") =>
      kind === "query" ? [axis(0)] : await pendingDocuments.promise,
    );
    const memory = withEmbeddings(store, { owner: ANNA, embedder: { model: () => MODEL, embed } });

    expect((await memory.searchRecords("rossi", "rossi")).map((hit) => hit.id)).toEqual(["rossi"]);
    pendingDocuments.resolve(null);
    await memory.settled();
  });
});

describe("without VOYAGE_API_KEY", () => {
  it("makes no network call and behaves as keyword-only memory", async () => {
    const fetchMock = vi.fn();
    const embedder = createVoyageEmbedder({ env: {}, fetch: fetchMock as unknown as typeof fetch });
    const { store } = seeded();
    const memory = withEmbeddings(store, { owner: ANNA, embedder });

    await memory.upsertRecord(note("rossi", "Rossi", "Settlement"), "create", 1);
    expect((await memory.searchRecords("rossi", "rossi")).map((hit) => hit.id)).toEqual(["rossi"]);
    await memory.settled();

    expect(embedder.model()).toBeNull();
    expect(await embedder.embed(["x"], "query")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.listUnembedded(MODEL, 10)).toHaveLength(1);
  });
});
