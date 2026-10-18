import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { MEMORY_FOLDERS, type MemoryFolder } from "./memory-contract.js";
import { renderMemoryPage } from "./memory-render.js";
import { openAdaMemoryIfExistsFromApi, type MemoryStore } from "./memory.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

type ToolFailure = { ok: false; error: string };

/**
 * The owner's own memory, or null when they have none yet. Every tool here acts for the one
 * number the host says is asking; none takes a number from the model.
 */
async function openMemory(api: StoreApi, owner: string): Promise<MemoryStore | null | ToolFailure> {
  try {
    return await openAdaMemoryIfExistsFromApi(api, owner);
  } catch (error) {
    api.logger.error(
      `ada memory store failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not open the memory store." };
  }
}

function isFailure(value: unknown): value is ToolFailure {
  return Boolean(value && typeof value === "object" && "ok" in value && value.ok === false);
}

function isStore(value: MemoryStore | null | ToolFailure): value is MemoryStore {
  return value !== null && !isFailure(value);
}

export async function executeAdaMemorySearch(
  api: StoreApi,
  owner: string,
  params: { query: string; matterId: string },
) {
  const store = await openMemory(api, owner);
  if (isFailure(store)) {
    return store;
  }
  const hits = store ? await store.searchRecords(params.query, params.matterId) : [];
  return {
    ok: true as const,
    matterId: params.matterId,
    hits: hits.map((record) => ({
      id: record.id,
      title: record.title,
      folder: record.folder,
      aliases: record.aliases,
      page: renderMemoryPage(record),
    })),
  };
}

export async function executeAdaMemoryList(
  api: StoreApi,
  owner: string,
  params: { folder: MemoryFolder; matterId: string },
) {
  if (!MEMORY_FOLDERS.includes(params.folder)) {
    return { ok: false as const, error: "folder is invalid" };
  }
  const store = await openMemory(api, owner);
  if (isFailure(store)) {
    return store;
  }
  const records = store ? await store.listRecords(params.folder, params.matterId) : [];
  return {
    ok: true as const,
    matterId: params.matterId,
    folder: params.folder,
    records: records.map((record) => ({
      id: record.id,
      title: record.title,
      aliases: record.aliases,
    })),
  };
}

export async function executeAdaMemoryGet(
  api: StoreApi,
  owner: string,
  params: { id: string; matterId: string },
) {
  const store = await openMemory(api, owner);
  if (isFailure(store)) {
    return store;
  }
  const record = isStore(store) ? await store.getRecord(params.id, params.matterId) : null;
  if (!record) {
    return { ok: false as const, error: "record not found in that matter" };
  }
  return { ok: true as const, page: renderMemoryPage(record) };
}

export async function executeAdaMemoryHistory(
  api: StoreApi,
  owner: string,
  params: { id: string; matterId: string },
) {
  const store = await openMemory(api, owner);
  if (isFailure(store)) {
    return store;
  }
  const revisions = store ? await store.history(params.id, params.matterId) : [];
  return {
    ok: true as const,
    revisions: revisions.map((revision) => ({
      reason: revision.reason,
      at: new Date(revision.atMs).toISOString(),
      previousBody: revision.previousBody,
    })),
  };
}

export async function executeAdaTodoList(api: StoreApi, owner: string) {
  const store = await openMemory(api, owner);
  if (isFailure(store)) {
    return store;
  }
  const todos = store ? await store.listTodos() : [];
  return {
    ok: true as const,
    todos: todos.map((todo) => ({
      id: todo.id,
      matterId: todo.matterId,
      owner: todo.owner,
      title: todo.title,
      status: todo.status,
    })),
  };
}

export async function executeAdaTodoGet(api: StoreApi, owner: string, params: { id: string }) {
  const store = await openMemory(api, owner);
  if (isFailure(store)) {
    return store;
  }
  const todo = isStore(store) ? await store.getTodo(params.id) : null;
  if (!todo) {
    return { ok: false as const, error: "todo not found" };
  }
  return { ok: true as const, todo };
}
