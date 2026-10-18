import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  AdaGoogleOperations,
  GoogleAccountDb,
  GoogleAccountStore,
} from "./google-account-contract.js";
import { maskNumber } from "./inbound-log.js";
import { isOwner, lawyerOwner } from "./owner.js";
import { adaStatePath } from "./state-paths.js";

const stores = new Map<string, Promise<GoogleAccountDb>>();
const adopted = new Map<string, Promise<void>>();

export function adaGoogleWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/google-account.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

function wrap(worker: SqliteWorkerStore<AdaGoogleOperations>): GoogleAccountDb {
  return {
    replacePending(owner, nonce, expiresAtMs) {
      return worker.execute({ type: "replacePending", input: { owner, nonce, expiresAtMs } });
    },
    consumePending(owner, nonce, nowMs) {
      return worker.execute({ type: "consumePending", input: { owner, nonce, nowMs } });
    },
    upsertAccount(owner, account) {
      return worker.execute({ type: "upsertAccount", input: { owner, account } });
    },
    readAccount(owner) {
      return worker.execute({ type: "readAccount", input: { owner } });
    },
    clearAccount(owner) {
      return worker.execute({ type: "clearAccount", input: { owner } });
    },
    updateTokensIfStill(owner, expected, tokens) {
      return worker.execute({ type: "updateTokensIfStill", input: { owner, expected, tokens } });
    },
    clearAccountIfStill(owner, expected) {
      return worker.execute({ type: "clearAccountIfStill", input: { owner, expected } });
    },
    listOwners() {
      return worker.execute({ type: "listOwners", input: undefined });
    },
    adoptLegacy(owner) {
      return worker.execute({ type: "adoptLegacy", input: { owner } });
    },
  };
}

/** The store as one number sees it: it can read, write and clear that number's account only. */
export function bindGoogleOwner(db: GoogleAccountDb, owner: string): GoogleAccountStore {
  return {
    replacePending: (nonce, expiresAtMs) => db.replacePending(owner, nonce, expiresAtMs),
    consumePending: (nonce, nowMs) => db.consumePending(owner, nonce, nowMs),
    upsertAccount: (account) => db.upsertAccount(owner, account),
    readAccount: () => db.readAccount(owner),
    clearAccount: () => db.clearAccount(owner),
    updateTokensIfStill: (expected, tokens) => db.updateTokensIfStill(owner, expected, tokens),
    clearAccountIfStill: (expected) => db.clearAccountIfStill(owner, expected),
  };
}

export function openAdaGoogleAccount(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<GoogleAccountDb> {
  const databasePath = adaStatePath(params.stateDir, "google-account.sqlite");
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<AdaGoogleOperations>({
    moduleUrl: adaGoogleWorkerUrl(params.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrap);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

/** The whole store, for the background collector that visits every connected owner. */
export async function openAdaGoogleAccountDbFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">,
): Promise<GoogleAccountDb> {
  if (!api.runtimeSource) {
    throw new Error("Ada Google account store needs the plugin runtime source");
  }
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const db = await openAdaGoogleAccount({ runtimeSource: api.runtimeSource, stateDir });
  const lawyer = lawyerOwner(api.config);
  if (lawyer) {
    const key = `${adaStatePath(stateDir, "google-account.sqlite")}:${lawyer}`;
    let moving = adopted.get(key);
    if (!moving) {
      moving = db.adoptLegacy(lawyer).then((moved) => {
        if (moved) {
          api.logger.info(`ada google store.legacy_adopted owner=${maskNumber(lawyer)}`);
        }
      });
      adopted.set(key, moving);
      moving.catch(() => adopted.delete(key));
    }
    await moving;
  }
  return db;
}

/**
 * One owner's Google account store. The first open moves the account saved before accounts
 * belonged to a number to the configured lawyer's number, so that owner keeps working.
 */
export async function openAdaGoogleAccountFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">,
  owner: string,
): Promise<GoogleAccountStore> {
  if (!isOwner(owner)) {
    throw new Error("Ada Google account store needs the owner's WhatsApp number");
  }
  return bindGoogleOwner(await openAdaGoogleAccountDbFromApi(api), owner);
}
