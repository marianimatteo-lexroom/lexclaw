import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { GoogleAccountStore, VeraGoogleOperations } from "./google-account-contract.js";

const stores = new Map<string, Promise<GoogleAccountStore>>();

export function veraGoogleWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/google-account.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

function wrap(worker: SqliteWorkerStore<VeraGoogleOperations>): GoogleAccountStore {
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

export function openVeraGoogleAccount(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<GoogleAccountStore> {
  const databasePath = path.join(params.stateDir, "vera", "google-account.sqlite");
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<VeraGoogleOperations>({
    moduleUrl: veraGoogleWorkerUrl(params.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrap);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

export function openVeraGoogleAccountFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime">,
): Promise<GoogleAccountStore> {
  if (!api.runtimeSource) {
    throw new Error("Vera Google account store needs the plugin runtime source");
  }
  return openVeraGoogleAccount({
    runtimeSource: api.runtimeSource,
    stateDir: api.runtime.state.resolveStateDir(process.env),
  });
}
