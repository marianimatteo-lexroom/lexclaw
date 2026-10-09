import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { MEMORY_FOLDERS, type MemoryFolder } from "./memory-contract.js";
import { openVeraMemoryFromApi } from "./memory.js";
import { renderMemoryPage } from "./memory-render.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger">;

type ToolFailure = { ok: false; error: string };

async function openMemory(api: StoreApi) {
  try {
    return await openVeraMemoryFromApi(api);
  } catch (error) {
    api.logger.error(
      `vera memory store failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Vera could not open the memory store." };
  }
}

function isFailure(value: unknown): value is ToolFailure {
  return Boolean(value && typeof value === "object" && "ok" in value && value.ok === false);
}

export async function executeVeraMemorySearch(
  api: StoreApi,
  params: { query: string; matterId: string },
) {
  const store = await openMemory(api);
  if (isFailure(store)) {
    return store;
  }
  const hits = await store.searchRecords(params.query, params.matterId);
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

export async function executeVeraMemoryList(
  api: StoreApi,
  params: { folder: MemoryFolder; matterId: string },
) {
  if (!MEMORY_FOLDERS.includes(params.folder)) {
    return { ok: false as const, error: "folder is invalid" };
  }
  const store = await openMemory(api);
  if (isFailure(store)) {
    return store;
  }
  const records = await store.listRecords(params.folder, params.matterId);
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

export async function executeVeraMemoryGet(
  api: StoreApi,
  params: { id: string; matterId: string },
) {
  const store = await openMemory(api);
  if (isFailure(store)) {
    return store;
  }
  const record = await store.getRecord(params.id, params.matterId);
  if (!record) {
    return { ok: false as const, error: "record not found in that matter" };
  }
  return { ok: true as const, page: renderMemoryPage(record) };
}

export async function executeVeraMemoryHistory(
  api: StoreApi,
  params: { id: string; matterId: string },
) {
  const store = await openMemory(api);
  if (isFailure(store)) {
    return store;
  }
  const revisions = await store.history(params.id, params.matterId);
  return {
    ok: true as const,
    revisions: revisions.map((revision) => ({
      reason: revision.reason,
      at: new Date(revision.atMs).toISOString(),
      previousBody: revision.previousBody,
    })),
  };
}

export async function executeVeraTodoList(api: StoreApi) {
  const store = await openMemory(api);
  if (isFailure(store)) {
    return store;
  }
  const todos = await store.listTodos();
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

export async function executeVeraTodoGet(api: StoreApi, params: { id: string }) {
  const store = await openMemory(api);
  if (isFailure(store)) {
    return store;
  }
  const todo = await store.getTodo(params.id);
  if (!todo) {
    return { ok: false as const, error: "todo not found" };
  }
  return { ok: true as const, todo };
}
