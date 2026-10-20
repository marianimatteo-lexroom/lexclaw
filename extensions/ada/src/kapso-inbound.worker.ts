import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { configureSqliteConnectionPragmas as ConfigureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  enableNodeSqliteKyselyStatementCache as EnableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync as ExecuteSqliteQuerySync,
  executeSqliteQueryTakeFirstSync as ExecuteSqliteQueryTakeFirstSync,
  getNodeSqliteKysely as GetNodeSqliteKysely,
  iterateSqliteQuerySync as IterateSqliteQuerySync,
  openNodeSqliteDatabase as OpenNodeSqliteDatabase,
  runSqliteImmediateTransactionSync as RunSqliteImmediateTransactionSync,
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  AdaKapsoInboundOperations,
  NewSpooledWebhook,
  SpooledWebhook,
} from "./kapso-inbound-contract.js";

/**
 * The installed plugin lives under the state directory, outside the OpenClaw package, and the
 * SQLite worker does not inherit the gateway's import hook, so a bare `openclaw/*` import fails
 * there; the Railway copy resolves it from the image instead (same as the other Ada workers).
 */
async function importOpenClawSdk(specifier: string): Promise<Record<string, unknown>> {
  try {
    return await import(specifier);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    const anchor = ["/app/openclaw.mjs", path.join(process.cwd(), "openclaw.mjs")].find((file) =>
      fs.existsSync(file),
    );
    if (!anchor) {
      throw error;
    }
    return await import(pathToFileURL(createRequire(anchor).resolve(specifier)).href);
  }
}

function sdkFunction<T extends (...args: never[]) => unknown>(
  module: Record<string, unknown>,
  name: string,
): T {
  const value = module[name];
  if (typeof value !== "function") {
    throw new Error(`Ada Kapso inbound worker is missing ${name}.`);
  }
  return value as T;
}

const pluginState = await importOpenClawSdk("openclaw/plugin-sdk/plugin-state-runtime");
const sqliteRuntime = await importOpenClawSdk("openclaw/plugin-sdk/sqlite-worker-runtime");
const configureSqliteConnectionPragmas = sdkFunction<typeof ConfigureSqliteConnectionPragmas>(
  pluginState,
  "configureSqliteConnectionPragmas",
);
const enableNodeSqliteKyselyStatementCache = sdkFunction<
  typeof EnableNodeSqliteKyselyStatementCache
>(sqliteRuntime, "enableNodeSqliteKyselyStatementCache");
const executeSqliteQuerySync = sdkFunction<typeof ExecuteSqliteQuerySync>(
  sqliteRuntime,
  "executeSqliteQuerySync",
);
const executeSqliteQueryTakeFirstSync = sdkFunction<typeof ExecuteSqliteQueryTakeFirstSync>(
  sqliteRuntime,
  "executeSqliteQueryTakeFirstSync",
);
const iterateSqliteQuerySync = sdkFunction<typeof IterateSqliteQuerySync>(
  sqliteRuntime,
  "iterateSqliteQuerySync",
);
const getNodeSqliteKysely = sdkFunction<typeof GetNodeSqliteKysely>(
  sqliteRuntime,
  "getNodeSqliteKysely",
);
const openNodeSqliteDatabase = sdkFunction<typeof OpenNodeSqliteDatabase>(
  sqliteRuntime,
  "openNodeSqliteDatabase",
);
const runSqliteImmediateTransactionSync = sdkFunction<typeof RunSqliteImmediateTransactionSync>(
  sqliteRuntime,
  "runSqliteImmediateTransactionSync",
);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ada_kapso_inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_key TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  body_base64 TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  answered_at_ms INTEGER
) STRICT;
`;

type AdaKapsoInboundDatabase = {
  // `id` and `attempts` are nullable only in type: SQLite fills both, so an insert may leave them out.
  ada_kapso_inbound: {
    id: number | null;
    sender_key: string;
    headers_json: string;
    body_base64: string;
    received_at_ms: number;
    attempts: number | null;
    answered_at_ms: number | null;
  };
};

const MAX_BODY_BASE64_CHARS = 3_000_000;
const SENDER_KEY = /^(?:\d{7,15}|unknown)$/u;

function chmodIfExists(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function readHeaders(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  const headers: Record<string, string> = {};
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        headers[name] = value;
      }
    }
  }
  return headers;
}

class AdaKapsoInboundStore {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: { close(): void },
  ) {
    this.query = getNodeSqliteKysely<AdaKapsoInboundDatabase>(db);
  }

  spool(entry: NewSpooledWebhook): number {
    if (!SENDER_KEY.test(entry.senderKey)) {
      throw new Error("Ada Kapso inbound sender is invalid");
    }
    if (entry.bodyBase64.length > MAX_BODY_BASE64_CHARS || !Number.isFinite(entry.receivedAtMs)) {
      throw new Error("Ada Kapso inbound webhook is invalid");
    }
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .insertInto("ada_kapso_inbound")
        .values({
          sender_key: entry.senderKey,
          headers_json: JSON.stringify(entry.headers),
          body_base64: entry.bodyBase64,
          received_at_ms: entry.receivedAtMs,
        })
        .returning("id"),
    );
    if (row?.id === null || row?.id === undefined) {
      throw new Error("Ada Kapso inbound webhook was not saved");
    }
    return row.id;
  }

  listSpooled(): SpooledWebhook[] {
    return Array.from(
      iterateSqliteQuerySync(
        this.db,
        this.query.selectFrom("ada_kapso_inbound").selectAll().orderBy("id"),
      ),
      (row) => ({
        id: row.id ?? 0,
        senderKey: row.sender_key,
        headers: readHeaders(row.headers_json),
        bodyBase64: row.body_base64,
        receivedAtMs: row.received_at_ms,
        attempts: row.attempts ?? 0,
        answeredAtMs: row.answered_at_ms,
      }),
    );
  }

  noteAttempt(id: number): number {
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const row = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query.selectFrom("ada_kapso_inbound").select("attempts").where("id", "=", id),
        );
        const attempts = (row?.attempts ?? 0) + 1;
        executeSqliteQuerySync(
          this.db,
          this.query.updateTable("ada_kapso_inbound").set({ attempts }).where("id", "=", id),
        );
        return attempts;
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "ada kapso inbound",
        operationLabel: "ada.kapso.inbound.attempt",
      },
    );
  }

  markAnswered(id: number, atMs: number): undefined {
    executeSqliteQuerySync(
      this.db,
      this.query
        .updateTable("ada_kapso_inbound")
        .set({ answered_at_ms: atMs })
        .where("id", "=", id),
    );
    return undefined;
  }

  unspool(id: number): undefined {
    executeSqliteQuerySync(
      this.db,
      this.query.deleteFrom("ada_kapso_inbound").where("id", "=", id),
    );
    return undefined;
  }

  close(): void {
    try {
      this.maintenance.close();
    } finally {
      this.db.close();
    }
  }
}

function openAdaKapsoInboundDatabase(dbPath: string): AdaKapsoInboundStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dbPath), 0o700);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", 0o600));
  }
  const db = openNodeSqliteDatabase(dbPath);
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  try {
    enableNodeSqliteKyselyStatementCache(db);
    maintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 5000,
      checkpointIntervalMs: 0,
      databaseLabel: "ada kapso inbound",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(SCHEMA_SQL);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return new AdaKapsoInboundStore(db, maintenance);
  } catch (error) {
    try {
      maintenance?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<AdaKapsoInboundOperations> {
  const database = openAdaKapsoInboundDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<AdaKapsoInboundOperations>) {
      switch (command.type) {
        case "spool":
          return database.spool(command.input.entry);
        case "listSpooled":
          return database.listSpooled();
        case "noteAttempt":
          return database.noteAttempt(command.input.id);
        case "markAnswered":
          return database.markAnswered(command.input.id, command.input.atMs);
        case "unspool":
          return database.unspool(command.input.id);
      }
      throw new Error("Unexpected Ada Kapso inbound command");
    },
    close: () => database.close(),
  };
}
