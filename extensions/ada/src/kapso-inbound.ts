import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openSqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { AdaKapsoInboundOperations, KapsoInboundDb } from "./kapso-inbound-contract.js";
import { adaStatePath } from "./state-paths.js";

const stores = new Map<string, Promise<KapsoInboundDb>>();

export function adaKapsoInboundWorkerUrl(runtimeSource: string): URL {
  return new URL(
    `./src/kapso-inbound.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

/** The spool of acknowledged Kapso webhooks that were not handled to the end yet. */
export function openAdaKapsoInboundFromApi(
  api: Pick<OpenClawPluginApi, "runtimeSource" | "runtime">,
): Promise<KapsoInboundDb> {
  if (!api.runtimeSource) {
    throw new Error("Ada Kapso inbound spool needs the plugin runtime source");
  }
  const databasePath = adaStatePath(
    api.runtime.state.resolveStateDir(process.env),
    "kapso-inbound.sqlite",
  );
  const cached = stores.get(databasePath);
  if (cached) {
    return cached;
  }
  const opening = openSqliteWorkerStore<AdaKapsoInboundOperations>({
    moduleUrl: adaKapsoInboundWorkerUrl(api.runtimeSource),
    databasePath,
    input: undefined,
  }).then((worker): KapsoInboundDb => ({
    spool: (entry) => worker.execute({ type: "spool", input: { entry } }),
    listSpooled: () => worker.execute({ type: "listSpooled", input: undefined }),
    noteAttempt: (id) => worker.execute({ type: "noteAttempt", input: { id } }),
    unspool: (id) => worker.execute({ type: "unspool", input: { id } }),
  }));
  stores.set(databasePath, opening);
  opening.catch(() => {
    stores.delete(databasePath);
  });
  return opening;
}
