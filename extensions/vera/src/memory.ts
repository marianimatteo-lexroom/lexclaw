import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  CalendarSnapshotRow,
  GmailSnapshotRow,
  LawyerProfile,
  MemoryFolder,
  MemoryRecord,
  MemoryRevision,
  MemoryTodo,
  RevisionReason,
  VeraMemoryOperations,
  WakeState,
} from "./memory-contract.js";

export type MemoryStore = {
  upsertProfile(profile: LawyerProfile): Promise<void>;
  readProfile(): Promise<LawyerProfile | null>;
  upsertRecord(record: MemoryRecord, reason: RevisionReason, atMs: number): Promise<void>;
  searchRecords(query: string, matterId: string): Promise<MemoryRecord[]>;
  listRecords(folder: MemoryFolder, matterId: string): Promise<MemoryRecord[]>;
  getRecord(id: string, matterId: string): Promise<MemoryRecord | null>;
  history(id: string, matterId: string): Promise<MemoryRevision[]>;
  upsertTodo(todo: MemoryTodo): Promise<void>;
  listTodos(matterId?: string): Promise<MemoryTodo[]>;
  getTodo(id: string): Promise<MemoryTodo | null>;
  replaceGmailSnapshot(rows: GmailSnapshotRow[]): Promise<void>;
  readGmailSnapshot(): Promise<GmailSnapshotRow[]>;
  replaceCalendarSnapshot(rows: CalendarSnapshotRow[]): Promise<void>;
  readCalendarSnapshot(): Promise<CalendarSnapshotRow[]>;
  readWake(): Promise<WakeState>;
  writeWake(patch: Partial<WakeState>): Promise<void>;
  listMatterAliases(): Promise<Array<{ matterId: string; alias: string; title: string }>>;
};

const stores = new Map<string, Promise<MemoryStore>>();

export function veraMemoryWorkerUrl(runtimeSource: string): URL {
  return new URL(`./src/memory.worker${path.extname(runtimeSource)}`, pathToFileURL(runtimeSource));
}

function wrap(worker: SqliteWorkerStore<VeraMemoryOperations>): MemoryStore {
  return {
    upsertProfile(profile) {
      return worker.execute({ type: "upsertProfile", input: profile });
    },
    readProfile() {
      return worker.execute({ type: "readProfile", input: undefined });
    },
    upsertRecord(record, reason, atMs) {
      return worker.execute({ type: "upsertRecord", input: { record, reason, atMs } });
    },
    searchRecords(query, matterId) {
      return worker.execute({ type: "searchRecords", input: { query, matterId } });
    },
    listRecords(folder, matterId) {
      return worker.execute({ type: "listRecords", input: { folder, matterId } });
    },
    getRecord(id, matterId) {
      return worker.execute({ type: "getRecord", input: { id, matterId } });
    },
    history(id, matterId) {
      return worker.execute({ type: "history", input: { id, matterId } });
    },
    upsertTodo(todo) {
      return worker.execute({ type: "upsertTodo", input: todo });
    },
    listTodos(matterId) {
      return worker.execute({ type: "listTodos", input: { matterId } });
    },
    getTodo(id) {
      return worker.execute({ type: "getTodo", input: { id } });
    },
    replaceGmailSnapshot(rows) {
      return worker.execute({ type: "replaceGmailSnapshot", input: { rows } });
    },
    readGmailSnapshot() {
      return worker.execute({ type: "readGmailSnapshot", input: undefined });
    },
    replaceCalendarSnapshot(rows) {
      return worker.execute({ type: "replaceCalendarSnapshot", input: { rows } });
    },
    readCalendarSnapshot() {
      return worker.execute({ type: "readCalendarSnapshot", input: undefined });
    },
    readWake() {
      return worker.execute({ type: "readWake", input: undefined });
    },
    writeWake(patch) {
      return worker.execute({ type: "writeWake", input: patch });
    },
    listMatterAliases() {
      return worker.execute({ type: "listMatterAliases", input: undefined });
    },
  };
}

export function openVeraMemory(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<MemoryStore> {
  const databasePath = path.join(params.stateDir, "vera", "memory.sqlite");
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<VeraMemoryOperations>({
    moduleUrl: veraMemoryWorkerUrl(params.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrap);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

export function openVeraMemoryFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime">,
): Promise<MemoryStore> {
  if (!api.runtimeSource) {
    throw new Error("Vera memory store needs the plugin runtime source");
  }
  return openVeraMemory({
    runtimeSource: api.runtimeSource,
    stateDir: api.runtime.state.resolveStateDir(process.env),
  });
}
