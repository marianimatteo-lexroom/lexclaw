import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  AdaGranolaOperations,
  GranolaAccountDb,
  GranolaAccountStore,
} from "./granola-account-contract.js";
import { isOwner } from "./owner.js";
import { adaStatePath } from "./state-paths.js";

const stores = new Map<string, Promise<GranolaAccountDb>>();

export function adaGranolaWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/granola-account.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

export function wrapGranolaWorker(
  worker: SqliteWorkerStore<AdaGranolaOperations>,
): GranolaAccountDb {
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
    listOwners: () => worker.execute({ type: "listOwners", input: undefined }),
    readClient: () => worker.execute({ type: "readClient", input: undefined }),
    saveClient: (client) => worker.execute({ type: "saveClient", input: { client } }),
    clearClientIfStill: (clientId) =>
      worker.execute({ type: "clearClientIfStill", input: { clientId } }),
  };
}

/** The store as one number sees it: it can read, write and clear that number's account only. */
export function bindGranolaOwner(db: GranolaAccountDb, owner: string): GranolaAccountStore {
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
  };
}

export function openAdaGranolaAccount(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<GranolaAccountDb> {
  const databasePath = adaStatePath(params.stateDir, "granola-account.sqlite");
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<AdaGranolaOperations>({
    moduleUrl: adaGranolaWorkerUrl(params.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrapGranolaWorker);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime">;

/** The whole store, for the OAuth client registration and the background keep-alive. */
export async function openAdaGranolaAccountDbFromApi(api: StoreApi): Promise<GranolaAccountDb> {
  if (!api.runtimeSource) {
    throw new Error("Ada Granola account store needs the plugin runtime source");
  }
  return openAdaGranolaAccount({
    runtimeSource: api.runtimeSource,
    stateDir: api.runtime.state.resolveStateDir(process.env),
  });
}

/** One owner's Granola account store. */
export async function openAdaGranolaAccountFromApi(
  api: StoreApi,
  owner: string,
): Promise<GranolaAccountStore> {
  if (!isOwner(owner)) {
    throw new Error("Ada Granola account store needs the owner's WhatsApp number");
  }
  return bindGranolaOwner(await openAdaGranolaAccountDbFromApi(api), owner);
}
