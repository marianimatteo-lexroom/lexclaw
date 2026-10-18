import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  CalendarSnapshotRow,
  DeadlineCandidate,
  DeadlineItem,
  DeadlinePatch,
  DeadlineUpsertResult,
  GmailSnapshotRow,
  LawyerProfile,
  MemoryFolder,
  MemoryRecord,
  MemoryRevision,
  MemoryTodo,
  RevisionReason,
  AdaMemoryOperations,
  WakeState,
} from "./memory-contract.js";
import { isOwner, lawyerOwner } from "./owner.js";
import { adaStatePath } from "./state-paths.js";

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
  upsertDeadlines(candidates: DeadlineCandidate[], atMs: number): Promise<DeadlineUpsertResult>;
  listDeadlines(matterId?: string): Promise<DeadlineItem[]>;
  getDeadline(id: string): Promise<DeadlineItem | null>;
  updateDeadline(id: string, patch: DeadlinePatch, atMs: number): Promise<DeadlineItem | null>;
  commitDeadlineDigest(
    offers: Array<{ id: string; no: number }>,
    reminders: Array<{ id: string; steps: string[] }>,
    atMs: number,
  ): Promise<void>;
  filterUnscannedMessages(ids: string[]): Promise<string[]>;
  markMessagesScanned(ids: string[], atMs: number): Promise<void>;
  claimWelcome(number: string, atMs: number): Promise<boolean>;
  releaseWelcome(number: string): Promise<void>;
  exportSnapshot(destination: string): Promise<void>;
};

const stores = new Map<string, Promise<MemoryStore>>();

export function adaMemoryWorkerUrl(runtimeSource: string): URL {
  return new URL(`./src/memory.worker${path.extname(runtimeSource)}`, pathToFileURL(runtimeSource));
}

export function wrapMemoryWorker(worker: SqliteWorkerStore<AdaMemoryOperations>): MemoryStore {
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
    upsertDeadlines(candidates, atMs) {
      return worker.execute({ type: "upsertDeadlines", input: { candidates, atMs } });
    },
    listDeadlines(matterId) {
      return worker.execute({ type: "listDeadlines", input: { matterId } });
    },
    getDeadline(id) {
      return worker.execute({ type: "getDeadline", input: { id } });
    },
    updateDeadline(id, patch, atMs) {
      return worker.execute({ type: "updateDeadline", input: { id, patch, atMs } });
    },
    commitDeadlineDigest(offers, reminders, atMs) {
      return worker.execute({ type: "commitDeadlineDigest", input: { offers, reminders, atMs } });
    },
    filterUnscannedMessages(ids) {
      return worker.execute({ type: "filterUnscannedMessages", input: { ids } });
    },
    markMessagesScanned(ids, atMs) {
      return worker.execute({ type: "markMessagesScanned", input: { ids, atMs } });
    },
    claimWelcome(number, atMs) {
      return worker.execute({ type: "claimWelcome", input: { number, atMs } });
    },
    releaseWelcome(number) {
      return worker.execute({ type: "releaseWelcome", input: { number } });
    },
    exportSnapshot(destination) {
      return worker.execute({ type: "exportSnapshot", input: { path: destination } });
    },
  };
}

/**
 * Matter memory, profile, todos, digest state and held plans are one SQLite file per WhatsApp
 * number under `memory/`, so no query can reach another number's rows: a number has no way to
 * name any file but its own. The old single file, `memory.sqlite`, stays as the registry of who
 * was welcomed, and its contents move to the configured lawyer's number the first time that
 * number's memory is opened.
 */
const REGISTRY_FILE = "memory.sqlite";
const ADOPTED_MARKER = "memory/legacy-adopted";
const memoryFile = (owner: string) => `memory/${owner}.sqlite`;

type MemoryLocation = { runtimeSource: string; stateDir: string };

function openStoreAt(location: MemoryLocation, databasePath: string): Promise<MemoryStore> {
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<AdaMemoryOperations>({
    moduleUrl: adaMemoryWorkerUrl(location.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrapMemoryWorker);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

/** The registry file: who was welcomed. It holds no one's working memory any more. */
export function openAdaRegistry(location: MemoryLocation): Promise<MemoryStore> {
  return openStoreAt(location, adaStatePath(location.stateDir, REGISTRY_FILE));
}

/**
 * Copies the pre-per-number memory to the lawyer's own file, once. The copy is a SQLite snapshot
 * (consistent even while the registry is open), the old file is left where it is as a backup, and
 * a marker names the number that took it so a changed lawyer number never inherits it twice.
 */
async function adoptLegacyMemory(location: MemoryLocation, owner: string): Promise<void> {
  const destination = adaStatePath(location.stateDir, memoryFile(owner));
  const marker = adaStatePath(location.stateDir, ADOPTED_MARKER);
  if (
    fs.existsSync(destination) ||
    fs.existsSync(marker) ||
    !fs.existsSync(adaStatePath(location.stateDir, REGISTRY_FILE))
  ) {
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.adopting`;
  fs.rmSync(temporary, { force: true });
  await (await openAdaRegistry(location)).exportSnapshot(temporary);
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, destination);
  fs.writeFileSync(marker, owner, { mode: 0o600 });
}

/** Whether `owner` has working memory yet, so a read never creates a database for a stranger. */
export function adaMemoryExists(
  location: Pick<MemoryLocation, "stateDir">,
  owner: string,
  lawyer: string | null,
): boolean {
  if (fs.existsSync(adaStatePath(location.stateDir, memoryFile(owner)))) {
    return true;
  }
  return (
    owner === lawyer &&
    !fs.existsSync(adaStatePath(location.stateDir, ADOPTED_MARKER)) &&
    fs.existsSync(adaStatePath(location.stateDir, REGISTRY_FILE))
  );
}

export function openAdaMemory(
  params: MemoryLocation & { owner: string; lawyer?: string | null },
): Promise<MemoryStore> {
  if (!isOwner(params.owner)) {
    throw new Error("Ada memory store needs the owner's WhatsApp number");
  }
  const databasePath = adaStatePath(params.stateDir, memoryFile(params.owner));
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = (async () => {
    if (params.owner === params.lawyer) {
      await adoptLegacyMemory(params, params.owner);
    }
    return await openStoreAt(params, databasePath);
  })();
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

type MemoryApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "config">;

function locationOf(api: MemoryApi): MemoryLocation {
  if (!api.runtimeSource) {
    throw new Error("Ada memory store needs the plugin runtime source");
  }
  return {
    runtimeSource: api.runtimeSource,
    stateDir: api.runtime.state.resolveStateDir(process.env),
  };
}

/** One number's memory, created on first use. Every number sees only its own. */
export function openAdaMemoryFromApi(api: MemoryApi, owner: string): Promise<MemoryStore> {
  return openAdaMemory({ ...locationOf(api), owner, lawyer: lawyerOwner(api.config) });
}

/** One number's memory, or null when it has none yet; never creates a database. */
export async function openAdaMemoryIfExistsFromApi(
  api: MemoryApi,
  owner: string,
): Promise<MemoryStore | null> {
  const location = locationOf(api);
  const lawyer = lawyerOwner(api.config);
  if (!isOwner(owner) || !adaMemoryExists(location, owner, lawyer)) {
    return null;
  }
  return await openAdaMemory({ ...location, owner, lawyer });
}

export function openAdaRegistryFromApi(api: MemoryApi): Promise<MemoryStore> {
  return openAdaRegistry(locationOf(api));
}
