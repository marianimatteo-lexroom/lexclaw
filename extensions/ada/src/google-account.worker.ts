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
import {
  LEGACY_GOOGLE_ACCOUNT_ID,
  type GoogleAccountRecord,
  type GoogleAccountStamp,
  type GoogleRefreshedTokens,
  type AdaGoogleOperations,
} from "./google-account-contract.js";
import { resolveTokenCipher, type TokenCipher } from "./token-crypto.js";

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
    throw new Error(`Ada Google account worker is missing ${name}.`);
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

/*
 * Table, index and encryption-context names keep their pre-rename `vera_` prefix. They name
 * live tables on existing volumes, and the context string is bound into every stored token
 * (AES-GCM additional data), so renaming either would make saved sign-ins unreadable.
 */
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

const SCOPES_COLUMN_SQL = "ALTER TABLE vera_google_account ADD COLUMN scopes TEXT";
const PENDING_OWNER_COLUMN_SQL =
  "ALTER TABLE vera_google_pending ADD COLUMN owner TEXT NOT NULL DEFAULT ''";

type AdaGoogleDatabase = {
  vera_google_pending: { nonce: string; owner: string; expires_at_ms: number };
  vera_google_account: {
    id: string;
    email: string;
    refresh_token: string;
    access_token: string | null;
    access_expires_at_ms: number | null;
    connected_at_ms: number;
    scopes: string | null;
  };
};

const REFRESH_TOKEN_CONTEXT = "vera_google_account.refresh_token";
const ACCESS_TOKEN_CONTEXT = "vera_google_account.access_token";

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

const OWNER = /^\d{7,15}$/u;

function assertOwner(owner: string): void {
  if (!OWNER.test(owner)) {
    throw new Error("Ada Google account owner is invalid");
  }
}

function assertNonce(nonce: string): void {
  if (!NONCE.test(nonce)) {
    throw new Error("Ada Google connect nonce is invalid");
  }
}

function assertAccount(account: GoogleAccountRecord): void {
  if (!EMAIL.test(account.email) || account.email.length > 320) {
    throw new Error("Ada Google account email is invalid");
  }
  if (account.refreshToken.trim().length < 8 || account.refreshToken.length > 4096) {
    throw new Error("Ada Google refresh token is invalid");
  }
  if (!Number.isFinite(account.connectedAtMs)) {
    throw new Error("Ada Google connected time is invalid");
  }
  if (account.scopes !== null && (account.scopes.length > 2000 || /[\r\n]/u.test(account.scopes))) {
    throw new Error("Ada Google scopes are invalid");
  }
}

class AdaGoogleDatabaseStore {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: { close(): void },
    private readonly cipher: TokenCipher,
  ) {
    this.query = getNodeSqliteKysely<AdaGoogleDatabase>(db);
  }

  /** Re-writes rows saved before encryption existed. A no-op without a key. */
  migrateLegacyTokens(): void {
    if (!this.cipher.encrypting) {
      return;
    }
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const rows = Array.from(
          iterateSqliteQuerySync(
            this.db,
            this.query
              .selectFrom("vera_google_account")
              .select(["id", "refresh_token", "access_token"]),
          ),
        );
        for (const row of rows) {
          const refresh = this.cipher.open(row.refresh_token, REFRESH_TOKEN_CONTEXT);
          const access =
            row.access_token === null
              ? null
              : this.cipher.open(row.access_token, ACCESS_TOKEN_CONTEXT);
          if (!refresh.legacy && !access?.legacy) {
            continue;
          }
          executeSqliteQuerySync(
            this.db,
            this.query
              .updateTable("vera_google_account")
              .set({
                refresh_token: this.cipher.seal(refresh.value, REFRESH_TOKEN_CONTEXT),
                access_token:
                  access === null ? null : this.cipher.seal(access.value, ACCESS_TOKEN_CONTEXT),
              })
              .where("id", "=", row.id),
          );
        }
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "ada google account",
        operationLabel: "ada.google.account.encrypt-legacy",
      },
    );
  }

  /**
   * Accounts used to be one row for the whole install, stored under a fixed id. Moves it to the
   * configured lawyer's number so the current owner keeps working without reconnecting. A row
   * the number already has wins, and the old one is dropped so it cannot belong to anyone else.
   */
  adoptLegacy(owner: string): boolean {
    assertOwner(owner);
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const legacy = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query
            .selectFrom("vera_google_account")
            .select("id")
            .where("id", "=", LEGACY_GOOGLE_ACCOUNT_ID),
        );
        if (!legacy) {
          return false;
        }
        const existing = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query.selectFrom("vera_google_account").select("id").where("id", "=", owner),
        );
        if (existing) {
          executeSqliteQuerySync(
            this.db,
            this.query.deleteFrom("vera_google_account").where("id", "=", LEGACY_GOOGLE_ACCOUNT_ID),
          );
          return false;
        }
        executeSqliteQuerySync(
          this.db,
          this.query
            .updateTable("vera_google_account")
            .set({ id: owner })
            .where("id", "=", LEGACY_GOOGLE_ACCOUNT_ID),
        );
        return true;
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "ada google account",
        operationLabel: "ada.google.account.adopt-legacy",
      },
    );
  }

  listOwners(): string[] {
    return Array.from(
      iterateSqliteQuerySync(
        this.db,
        this.query.selectFrom("vera_google_account").select("id").orderBy("id"),
      ),
      (row) => row.id,
    ).filter((id) => OWNER.test(id));
  }

  replacePending(owner: string, nonce: string, expiresAtMs: number): undefined {
    assertOwner(owner);
    assertNonce(nonce);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("Ada Google connect expiry is invalid");
    }
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_google_pending").where("owner", "=", owner),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_google_pending").values({
            nonce,
            owner,
            expires_at_ms: expiresAtMs,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "ada google account",
        operationLabel: "ada.google.pending.replace",
      },
    );
    return undefined;
  }

  consumePending(owner: string, nonce: string, nowMs: number): boolean {
    assertOwner(owner);
    assertNonce(nonce);
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const row = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query
            .selectFrom("vera_google_pending")
            .select(["nonce", "owner", "expires_at_ms"])
            .where("nonce", "=", nonce),
        );
        if (!row || row.owner !== owner) {
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
        databaseLabel: "ada google account",
        operationLabel: "ada.google.pending.consume",
      },
    );
  }

  upsertAccount(owner: string, account: GoogleAccountRecord): undefined {
    assertOwner(owner);
    assertAccount(account);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_google_account").where("id", "=", owner),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_google_account").values({
            id: owner,
            email: account.email,
            refresh_token: this.cipher.seal(account.refreshToken, REFRESH_TOKEN_CONTEXT),
            access_token:
              account.accessToken === null
                ? null
                : this.cipher.seal(account.accessToken, ACCESS_TOKEN_CONTEXT),
            access_expires_at_ms: account.accessExpiresAtMs,
            connected_at_ms: account.connectedAtMs,
            scopes: account.scopes,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "ada google account",
        operationLabel: "ada.google.account.upsert",
      },
    );
    return undefined;
  }

  readAccount(owner: string): GoogleAccountRecord | null {
    assertOwner(owner);
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
          "scopes",
        ])
        .where("id", "=", owner),
    );
    if (!row) {
      return null;
    }
    return {
      email: row.email,
      refreshToken: this.cipher.open(row.refresh_token, REFRESH_TOKEN_CONTEXT).value,
      accessToken:
        row.access_token === null
          ? null
          : this.cipher.open(row.access_token, ACCESS_TOKEN_CONTEXT).value,
      accessExpiresAtMs: row.access_expires_at_ms,
      connectedAtMs: row.connected_at_ms,
      scopes: row.scopes,
    };
  }

  clearAccount(owner: string): undefined {
    assertOwner(owner);
    executeSqliteQuerySync(
      this.db,
      this.query.deleteFrom("vera_google_account").where("id", "=", owner),
    );
    return undefined;
  }

  /** Runs `write` in one transaction, only while the row still holds `expected`. */
  private ifStill(
    owner: string,
    expected: GoogleAccountStamp,
    operationLabel: string,
    write: () => void,
  ): boolean {
    assertOwner(owner);
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const current = this.readAccount(owner);
        if (
          !current ||
          current.refreshToken !== expected.refreshToken ||
          current.connectedAtMs !== expected.connectedAtMs
        ) {
          return false;
        }
        write();
        return true;
      },
      { busyTimeoutMs: 5000, databaseLabel: "ada google account", operationLabel },
    );
  }

  updateTokensIfStill(
    owner: string,
    expected: GoogleAccountStamp,
    tokens: GoogleRefreshedTokens,
  ): boolean {
    return this.ifStill(owner, expected, "ada.google.account.refresh", () => {
      executeSqliteQuerySync(
        this.db,
        this.query
          .updateTable("vera_google_account")
          .set({
            ...(tokens.refreshToken
              ? { refresh_token: this.cipher.seal(tokens.refreshToken, REFRESH_TOKEN_CONTEXT) }
              : {}),
            access_token: this.cipher.seal(tokens.accessToken, ACCESS_TOKEN_CONTEXT),
            access_expires_at_ms: tokens.accessExpiresAtMs,
          })
          .where("id", "=", owner),
      );
    });
  }

  clearAccountIfStill(owner: string, expected: GoogleAccountStamp): boolean {
    return this.ifStill(owner, expected, "ada.google.account.clear_if_still", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("vera_google_account").where("id", "=", owner),
      );
    });
  }

  close(): void {
    try {
      this.maintenance.close();
    } finally {
      this.db.close();
    }
  }
}

function openAdaGoogleDatabase(dbPath: string): AdaGoogleDatabaseStore {
  const cipher = resolveTokenCipher();
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
      databaseLabel: "ada google account",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(SCHEMA_SQL);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('vera_google_account')")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "scopes")) {
      db.exec(SCOPES_COLUMN_SQL);
    }
    const pendingColumns = db
      .prepare("SELECT name FROM pragma_table_info('vera_google_pending')")
      .all() as Array<{ name: string }>;
    if (!pendingColumns.some((column) => column.name === "owner")) {
      db.exec(PENDING_OWNER_COLUMN_SQL);
    }
    // A link issued before links named a number cannot be bound to anyone, so it is dropped.
    db.exec("DELETE FROM vera_google_pending WHERE owner = ''");
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    const store = new AdaGoogleDatabaseStore(db, maintenance, cipher);
    store.migrateLegacyTokens();
    return store;
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
): SqliteWorkerBackend<AdaGoogleOperations> {
  const database = openAdaGoogleDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<AdaGoogleOperations>) {
      switch (command.type) {
        case "replacePending":
          return database.replacePending(
            command.input.owner,
            command.input.nonce,
            command.input.expiresAtMs,
          );
        case "consumePending":
          return database.consumePending(
            command.input.owner,
            command.input.nonce,
            command.input.nowMs,
          );
        case "upsertAccount":
          return database.upsertAccount(command.input.owner, command.input.account);
        case "readAccount":
          return database.readAccount(command.input.owner);
        case "clearAccount":
          return database.clearAccount(command.input.owner);
        case "updateTokensIfStill":
          return database.updateTokensIfStill(
            command.input.owner,
            command.input.expected,
            command.input.tokens,
          );
        case "clearAccountIfStill":
          return database.clearAccountIfStill(command.input.owner, command.input.expected);
        case "listOwners":
          return database.listOwners();
        case "adoptLegacy":
          return database.adoptLegacy(command.input.owner);
      }
      throw new Error("Unexpected Ada Google command");
    },
    close: () => database.close(),
  };
}
