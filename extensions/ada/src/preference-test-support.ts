import path from "node:path";
import { wrapMemoryWorker, type MemoryStore } from "./memory.js";
import { createSqliteWorkerBackend } from "./memory.worker.js";

/** The real SQLite memory backend behind the store interface, one file per call. */
export function realStore(dir: string, name: string): MemoryStore {
  const backend = createSqliteWorkerBackend(undefined, {
    databasePath: path.join(dir, `${name}.sqlite`),
  });
  return wrapMemoryWorker({
    execute: async (command: { type: string; input: unknown }) =>
      (backend.execute as (command: unknown) => unknown)(command),
    close: async () => backend.close(),
  } as never);
}
