import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { GoogleAccountStore, AdaGoogleOperations } from "./google-account-contract.js";
import { adaStatePath } from "./state-paths.js";

const stores = new Map<string, Promise<GoogleAccountStore>>();

export function adaGoogleWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/google-account.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

function wrap(worker: SqliteWorkerStore<AdaGoogleOperations>): GoogleAccountStore {
  return {
    replacePending(nonce, expiresAtMs) {
      return worker.execute({ type: "replacePending", input: { nonce, expiresAtMs } });
    },
    consumePending(nonce, nowMs) {
      return worker.execute({ type: "consumePending", input: { nonce, nowMs } });
    },
    upsertAccount(account) {
      return worker.execute({ type: "upsertAccount", input: account });
    },
    readAccount() {
      return worker.execute({ type: "readAccount", input: undefined });
    },
    clearAccount() {
      return worker.execute({ type: "clearAccount", input: undefined });
    },
  };
}

export function openAdaGoogleAccount(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<GoogleAccountStore> {
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

export function openAdaGoogleAccountFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime">,
): Promise<GoogleAccountStore> {
  if (!api.runtimeSource) {
    throw new Error("Ada Google account store needs the plugin runtime source");
  }
  return openAdaGoogleAccount({
    runtimeSource: api.runtimeSource,
    stateDir: api.runtime.state.resolveStateDir(process.env),
  });
}
