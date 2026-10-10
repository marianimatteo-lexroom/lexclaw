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
  openNodeSqliteDatabase as OpenNodeSqliteDatabase,
  runSqliteImmediateTransactionSync as RunSqliteImmediateTransactionSync,
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  VERA_LEXROOM_ACCOUNT_ID,
  type LexroomAccountRecord,
  type VeraLexroomOperations,
} from "./lexroom-account-contract.js";

/**
 * The installed plugin lives under the state directory, outside the OpenClaw
 * package. The SQLite worker does not inherit the gateway's import hook, so a
 * bare `openclaw/*` import fails there. Tests and in-repo runs resolve the
 * package normally; the Railway copy resolves it from the image instead.
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
    throw new Error(`Vera Lexroom account worker is missing ${name}.`);
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
CREATE TABLE IF NOT EXISTS vera_lexroom_pending (
  nonce TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_lexroom_account (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_expires_at_ms INTEGER,
  connected_at_ms INTEGER NOT NULL
) STRICT;
`;

type VeraLexroomDatabase = {
  vera_lexroom_pending: { nonce: string; expires_at_ms: number };
  vera_lexroom_account: {
    id: string;
    email: string;
    access_token: string;
    refresh_token: string;
    access_expires_at_ms: number | null;
    connected_at_ms: number;
  };
};

const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

function chmodIfExists(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function assertNonce(nonce: string): void {
  if (!NONCE.test(nonce)) {
    throw new Error("Vera Lexroom connect nonce is invalid");
  }
}

function assertAccount(account: LexroomAccountRecord): void {
  if (!EMAIL.test(account.email) || account.email.length > 320) {
    throw new Error("Vera Lexroom account email is invalid");
  }
  if (account.accessToken.trim().length < 8 || account.accessToken.length > 8192) {
    throw new Error("Vera Lexroom access token is invalid");
  }
  if (account.refreshToken.length > 8192) {
    throw new Error("Vera Lexroom refresh token is invalid");
  }
  if (!Number.isFinite(account.connectedAtMs)) {
    throw new Error("Vera Lexroom connected time is invalid");
  }
}

class VeraLexroomDatabaseStore {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: { close(): void },
  ) {
    this.query = getNodeSqliteKysely<VeraLexroomDatabase>(db);
  }

  replacePending(nonce: string, expiresAtMs: number): undefined {
    assertNonce(nonce);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("Vera Lexroom connect expiry is invalid");
    }
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_lexroom_pending").where("expires_at_ms", ">", 0),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_lexroom_pending").values({
            nonce,
            expires_at_ms: expiresAtMs,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera lexroom account",
        operationLabel: "vera.lexroom.pending.replace",
      },
    );
    return undefined;
  }

  hasPending(nonce: string, nowMs: number): boolean {
    assertNonce(nonce);
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("vera_lexroom_pending")
        .select(["expires_at_ms"])
        .where("nonce", "=", nonce),
    );
    return Boolean(row && row.expires_at_ms > nowMs);
  }

  consumePending(nonce: string, nowMs: number): boolean {
    assertNonce(nonce);
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const row = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query
            .selectFrom("vera_lexroom_pending")
            .select(["nonce", "expires_at_ms"])
            .where("nonce", "=", nonce),
        );
        if (!row) {
          return false;
        }
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_lexroom_pending").where("nonce", "=", nonce),
        );
        return row.expires_at_ms > nowMs;
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera lexroom account",
        operationLabel: "vera.lexroom.pending.consume",
      },
    );
  }

  upsertAccount(account: LexroomAccountRecord): undefined {
    assertAccount(account);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_lexroom_account").where("id", "=", VERA_LEXROOM_ACCOUNT_ID),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_lexroom_account").values({
            id: VERA_LEXROOM_ACCOUNT_ID,
            email: account.email,
            access_token: account.accessToken,
            refresh_token: account.refreshToken,
            access_expires_at_ms: account.accessExpiresAtMs,
            connected_at_ms: account.connectedAtMs,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera lexroom account",
        operationLabel: "vera.lexroom.account.upsert",
      },
    );
    return undefined;
  }

  readAccount(): LexroomAccountRecord | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("vera_lexroom_account")
        .select([
          "email",
          "access_token",
          "refresh_token",
          "access_expires_at_ms",
          "connected_at_ms",
        ])
        .where("id", "=", VERA_LEXROOM_ACCOUNT_ID),
    );
    if (!row) {
      return null;
    }
    return {
      email: row.email,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      accessExpiresAtMs: row.access_expires_at_ms,
      connectedAtMs: row.connected_at_ms,
    };
  }

  clearAccount(): undefined {
    executeSqliteQuerySync(
      this.db,
      this.query.deleteFrom("vera_lexroom_account").where("id", "=", VERA_LEXROOM_ACCOUNT_ID),
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

function openVeraLexroomDatabase(dbPath: string): VeraLexroomDatabaseStore {
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
      databaseLabel: "vera lexroom account",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(SCHEMA_SQL);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return new VeraLexroomDatabaseStore(db, maintenance);
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
): SqliteWorkerBackend<VeraLexroomOperations> {
  const database = openVeraLexroomDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<VeraLexroomOperations>) {
      switch (command.type) {
        case "replacePending":
          return database.replacePending(command.input.nonce, command.input.expiresAtMs);
        case "hasPending":
          return database.hasPending(command.input.nonce, command.input.nowMs);
        case "consumePending":
          return database.consumePending(command.input.nonce, command.input.nowMs);
        case "upsertAccount":
          return database.upsertAccount(command.input);
        case "readAccount":
          return database.readAccount();
        case "clearAccount":
          return database.clearAccount();
      }
      throw new Error("Unexpected Vera Lexroom command");
    },
    close: () => database.close(),
  };
}
