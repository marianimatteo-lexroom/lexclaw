import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  VERA_GOOGLE_ACCOUNT_ID,
  type GoogleAccountRecord,
  type VeraGoogleOperations,
} from "./google-account-contract.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vera_google_pending (
  nonce TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_google_account (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_expires_at_ms INTEGER,
  connected_at_ms INTEGER NOT NULL
) STRICT;
`;

type VeraGoogleDatabase = {
  vera_google_pending: { nonce: string; expires_at_ms: number };
  vera_google_account: {
    id: string;
    email: string;
    refresh_token: string;
    access_token: string | null;
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
    throw new Error("Vera Google connect nonce is invalid");
  }
}

function assertAccount(account: GoogleAccountRecord): void {
  if (!EMAIL.test(account.email) || account.email.length > 320) {
    throw new Error("Vera Google account email is invalid");
  }
  if (account.refreshToken.trim().length < 8 || account.refreshToken.length > 4096) {
    throw new Error("Vera Google refresh token is invalid");
  }
  if (!Number.isFinite(account.connectedAtMs)) {
    throw new Error("Vera Google connected time is invalid");
  }
}

class VeraGoogleDatabaseStore {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: { close(): void },
  ) {
    this.query = getNodeSqliteKysely<VeraGoogleDatabase>(db);
  }

  replacePending(nonce: string, expiresAtMs: number): undefined {
    assertNonce(nonce);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("Vera Google connect expiry is invalid");
    }
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_google_pending").where("expires_at_ms", ">", 0),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_google_pending").values({
            nonce,
            expires_at_ms: expiresAtMs,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera google account",
        operationLabel: "vera.google.pending.replace",
      },
    );
    return undefined;
  }

  consumePending(nonce: string, nowMs: number): boolean {
    assertNonce(nonce);
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const row = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query
            .selectFrom("vera_google_pending")
            .select(["nonce", "expires_at_ms"])
            .where("nonce", "=", nonce),
        );
        if (!row) {
          return false;
        }
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_google_pending").where("nonce", "=", nonce),
        );
        return row.expires_at_ms > nowMs;
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera google account",
        operationLabel: "vera.google.pending.consume",
      },
    );
  }

  upsertAccount(account: GoogleAccountRecord): undefined {
    assertAccount(account);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_google_account").where("id", "=", VERA_GOOGLE_ACCOUNT_ID),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_google_account").values({
            id: VERA_GOOGLE_ACCOUNT_ID,
            email: account.email,
            refresh_token: account.refreshToken,
            access_token: account.accessToken,
            access_expires_at_ms: account.accessExpiresAtMs,
            connected_at_ms: account.connectedAtMs,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera google account",
        operationLabel: "vera.google.account.upsert",
      },
    );
    return undefined;
  }

  readAccount(): GoogleAccountRecord | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("vera_google_account")
        .select([
          "email",
          "refresh_token",
          "access_token",
          "access_expires_at_ms",
          "connected_at_ms",
        ])
        .where("id", "=", VERA_GOOGLE_ACCOUNT_ID),
    );
    if (!row) {
      return null;
    }
    return {
      email: row.email,
      refreshToken: row.refresh_token,
      accessToken: row.access_token,
      accessExpiresAtMs: row.access_expires_at_ms,
      connectedAtMs: row.connected_at_ms,
    };
  }

  clearAccount(): undefined {
    executeSqliteQuerySync(
      this.db,
      this.query.deleteFrom("vera_google_account").where("id", "=", VERA_GOOGLE_ACCOUNT_ID),
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

function openVeraGoogleDatabase(dbPath: string): VeraGoogleDatabaseStore {
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
      databaseLabel: "vera google account",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(SCHEMA_SQL);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return new VeraGoogleDatabaseStore(db, maintenance);
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
): SqliteWorkerBackend<VeraGoogleOperations> {
  const database = openVeraGoogleDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<VeraGoogleOperations>) {
      switch (command.type) {
        case "replacePending":
          return database.replacePending(command.input.nonce, command.input.expiresAtMs);
        case "consumePending":
          return database.consumePending(command.input.nonce, command.input.nowMs);
        case "upsertAccount":
          return database.upsertAccount(command.input);
        case "readAccount":
          return database.readAccount();
        case "clearAccount":
          return database.clearAccount();
      }
      throw new Error("Unexpected Vera Google command");
    },
    close: () => database.close(),
  };
}
