import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { maskNumber } from "./inbound-log.js";
import {
  type LexroomAccountDb,
  type LexroomAccountRecord,
  type LexroomAccountStore,
  type AdaLexroomOperations,
} from "./lexroom-account-contract.js";
import { accessTokenExpiresAtMs } from "./lexroom-connect.js";
import { lexroomLogger, runtimeIdentity, type LexroomLog } from "./lexroom-log.js";
import { isOwner, lawyerOwner } from "./owner.js";
import { adaStatePath } from "./state-paths.js";

const stores = new Map<string, Promise<LexroomAccountDb>>();
const adopted = new Map<string, Promise<void>>();
const announced = new Set<string>();
/** Differs per loaded copy of this module, so a route and a tool on separate copies show up. */
const MODULE_INSTANCE = randomUUID().slice(0, 8);

export function adaLexroomWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/lexroom-account.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

function wrap(worker: SqliteWorkerStore<AdaLexroomOperations>): LexroomAccountDb {
  return {
    replacePending(owner, nonce, expiresAtMs) {
      return worker.execute({ type: "replacePending", input: { owner, nonce, expiresAtMs } });
    },
    hasPending(owner, nonce, nowMs) {
      return worker.execute({ type: "hasPending", input: { owner, nonce, nowMs } });
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
    adoptLegacy(owner) {
      return worker.execute({ type: "adoptLegacy", input: { owner } });
    },
  };
}

/** The store as one number sees it: it can read, write and clear that number's account only. */
export function bindLexroomOwner(db: LexroomAccountDb, owner: string): LexroomAccountStore {
  return {
    replacePending: (nonce, expiresAtMs) => db.replacePending(owner, nonce, expiresAtMs),
    hasPending: (nonce, nowMs) => db.hasPending(owner, nonce, nowMs),
    consumePending: (nonce, nowMs) => db.consumePending(owner, nonce, nowMs),
    upsertAccount: (account) => db.upsertAccount(owner, account),
    readAccount: () => db.readAccount(owner),
    clearAccount: () => db.clearAccount(owner),
  };
}

export function openAdaLexroomAccount(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<LexroomAccountDb> {
  const databasePath = adaStatePath(params.stateDir, "lexroom-account.sqlite");
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<AdaLexroomOperations>({
    moduleUrl: adaLexroomWorkerUrl(params.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrap);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

function expiresInSec(account: Pick<LexroomAccountRecord, "accessToken" | "accessExpiresAtMs">) {
  const expiresAtMs = account.accessExpiresAtMs ?? accessTokenExpiresAtMs(account.accessToken);
  return expiresAtMs === null ? -1 : Math.round((expiresAtMs - Date.now()) / 1000);
}

/**
 * Logs every credential write, read and clear with where it happened. The storage key is the
 * owner's number (masked), never derived from the email, so a write and a read cannot disagree
 * on it; the identity fields exist to prove they reached the same file from the same process.
 * Token values are never logged, only whether one is present and when it expires.
 */
export function withLexroomStoreLogging(
  store: LexroomAccountStore,
  context: { log: LexroomLog; databasePath: string; owner: string },
): LexroomAccountStore {
  const where = () => ({
    storageKey: maskNumber(context.owner),
    backend: "sqlite-worker",
    db: context.databasePath,
    ...runtimeIdentity(),
    instance: MODULE_INSTANCE,
  });
  const failed = (op: string, error: unknown): never => {
    context.log("store.op_failed", {
      op,
      error: (error instanceof Error ? error.message : "unknown").slice(0, 160),
      ...where(),
    });
    throw error;
  };
  return {
    ...store,
    async upsertAccount(account) {
      try {
        await store.upsertAccount(account);
      } catch (error) {
        return failed("write", error);
      }
      context.log("store.write", {
        email: account.email,
        tokenPresent: account.accessToken.length > 0,
        hasRefreshToken: account.refreshToken.length > 0,
        hasPassword: account.password.length > 0,
        tokenExpiresInSec: expiresInSec(account),
        ...where(),
      });
    },
    async readAccount() {
      let account: LexroomAccountRecord | null;
      try {
        account = await store.readAccount();
      } catch (error) {
        return failed("read", error);
      }
      context.log("store.read", {
        found: account !== null,
        ...(account
          ? {
              email: account.email,
              tokenExpiresInSec: expiresInSec(account),
              connectedAgoSec: Math.round((Date.now() - account.connectedAtMs) / 1000),
            }
          : {}),
        ...where(),
      });
      return account;
    },
    async clearAccount() {
      try {
        await store.clearAccount();
      } catch (error) {
        return failed("clear", error);
      }
      context.log("store.clear", where());
    },
  };
}

/**
 * One owner's Lexroom account store. The first open moves the account saved before accounts
 * belonged to a number to the configured lawyer's number, so that owner keeps working.
 */
export async function openAdaLexroomAccountFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">,
  owner: string,
): Promise<LexroomAccountStore> {
  if (!isOwner(owner)) {
    throw new Error("Ada Lexroom account store needs the owner's WhatsApp number");
  }
  if (!api.runtimeSource) {
    throw new Error("Ada Lexroom account store needs the plugin runtime source");
  }
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const databasePath = adaStatePath(stateDir, "lexroom-account.sqlite");
  const log = lexroomLogger(api.logger);
  const db = await openAdaLexroomAccount({ runtimeSource: api.runtimeSource, stateDir });
  if (!announced.has(databasePath)) {
    announced.add(databasePath);
    log("store.opened", {
      backend: "sqlite-worker",
      db: databasePath,
      ...runtimeIdentity(),
      instance: MODULE_INSTANCE,
    });
  }
  const lawyer = lawyerOwner(api.config);
  if (lawyer) {
    const key = `${databasePath}:${lawyer}`;
    let moving = adopted.get(key);
    if (!moving) {
      moving = db.adoptLegacy(lawyer).then((moved) => {
        if (moved) {
          log("store.legacy_adopted", { owner: maskNumber(lawyer) });
        }
      });
      adopted.set(key, moving);
      moving.catch(() => adopted.delete(key));
    }
    await moving;
  }
  return withLexroomStoreLogging(bindLexroomOwner(db, owner), { log, databasePath, owner });
}
