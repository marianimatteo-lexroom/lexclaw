import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  AdaOutlookOperations,
  OutlookAccountDb,
  OutlookAccountStore,
} from "./outlook-account-contract.js";
import { isOwner } from "./owner.js";
import { adaStatePath } from "./state-paths.js";

const stores = new Map<string, Promise<OutlookAccountDb>>();

export function adaOutlookWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/outlook-account.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

export function wrapOutlookWorker(
  worker: SqliteWorkerStore<AdaOutlookOperations>,
): OutlookAccountDb {
  return {
    replacePending: (owner, nonce, expiresAtMs, pending) =>
      worker.execute({ type: "replacePending", input: { owner, nonce, expiresAtMs, pending } }),
    consumePending: (owner, nonce, nowMs) =>
      worker.execute({ type: "consumePending", input: { owner, nonce, nowMs } }),
    upsertAccount: (owner, account) =>
      worker.execute({ type: "upsertAccount", input: { owner, account } }),
    readAccount: (owner) => worker.execute({ type: "readAccount", input: { owner } }),
    clearAccount: (owner) => worker.execute({ type: "clearAccount", input: { owner } }),
    updateTokensIfStill: (owner, expected, tokens) =>
      worker.execute({ type: "updateTokensIfStill", input: { owner, expected, tokens } }),
    clearAccountIfStill: (owner, expected) =>
      worker.execute({ type: "clearAccountIfStill", input: { owner, expected } }),
    claimReconnectReminder: (owner, nowMs) =>
      worker.execute({ type: "claimReconnectReminder", input: { owner, nowMs } }),
    reminderOwed: (owner, nowMs) =>
      worker.execute({ type: "reminderOwed", input: { owner, nowMs } }),
    settleReminder: (owner) => worker.execute({ type: "settleReminder", input: { owner } }),
    listOwners: () => worker.execute({ type: "listOwners", input: undefined }),
  };
}

/** The store as one number sees it: it can read, write and clear that number's account only. */
export function bindOutlookOwner(db: OutlookAccountDb, owner: string): OutlookAccountStore {
  return {
    replacePending: (nonce, expiresAtMs, pending) =>
      db.replacePending(owner, nonce, expiresAtMs, pending),
    consumePending: (nonce, nowMs) => db.consumePending(owner, nonce, nowMs),
    upsertAccount: (account) => db.upsertAccount(owner, account),
    readAccount: () => db.readAccount(owner),
    clearAccount: () => db.clearAccount(owner),
    updateTokensIfStill: (expected, tokens) => db.updateTokensIfStill(owner, expected, tokens),
    clearAccountIfStill: (expected) => db.clearAccountIfStill(owner, expected),
    claimReconnectReminder: (nowMs) => db.claimReconnectReminder(owner, nowMs),
    reminderOwed: (nowMs) => db.reminderOwed(owner, nowMs),
    settleReminder: () => db.settleReminder(owner),
  };
}

export function openAdaOutlookAccount(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<OutlookAccountDb> {
  const databasePath = adaStatePath(params.stateDir, "outlook-account.sqlite");
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<AdaOutlookOperations>({
    moduleUrl: adaOutlookWorkerUrl(params.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrapOutlookWorker);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime">;

/** The whole store, for the background collector and keep-alive that visit every connected owner. */
export async function openAdaOutlookAccountDbFromApi(api: StoreApi): Promise<OutlookAccountDb> {
  if (!api.runtimeSource) {
    throw new Error("Ada Outlook account store needs the plugin runtime source");
  }
  return openAdaOutlookAccount({
    runtimeSource: api.runtimeSource,
    stateDir: api.runtime.state.resolveStateDir(process.env),
  });
}

/** One owner's Outlook account store. */
export async function openAdaOutlookAccountFromApi(
  api: StoreApi,
  owner: string,
): Promise<OutlookAccountStore> {
  if (!isOwner(owner)) {
    throw new Error("Ada Outlook account store needs the owner's WhatsApp number");
  }
  return bindOutlookOwner(await openAdaOutlookAccountDbFromApi(api), owner);
}
