import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { LexroomAccountStore, VeraLexroomOperations } from "./lexroom-account-contract.js";

const stores = new Map<string, Promise<LexroomAccountStore>>();

export function veraLexroomWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/lexroom-account.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

function wrap(worker: SqliteWorkerStore<VeraLexroomOperations>): LexroomAccountStore {
  return {
    replacePending(nonce, expiresAtMs) {
      return worker.execute({ type: "replacePending", input: { nonce, expiresAtMs } });
    },
    hasPending(nonce, nowMs) {
      return worker.execute({ type: "hasPending", input: { nonce, nowMs } });
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

export function openVeraLexroomAccount(params: {
  runtimeSource: string;
  stateDir: string;
}): Promise<LexroomAccountStore> {
  const databasePath = path.join(params.stateDir, "vera", "lexroom-account.sqlite");
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<VeraLexroomOperations>({
    moduleUrl: veraLexroomWorkerUrl(params.runtimeSource),
    databasePath,
    input: undefined,
  }).then(wrap);
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}

export function openVeraLexroomAccountFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime">,
): Promise<LexroomAccountStore> {
  if (!api.runtimeSource) {
    throw new Error("Vera Lexroom account store needs the plugin runtime source");
  }
  return openVeraLexroomAccount({
    runtimeSource: api.runtimeSource,
    stateDir: api.runtime.state.resolveStateDir(process.env),
  });
}
