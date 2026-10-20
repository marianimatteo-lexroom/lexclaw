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
  OUTLOOK_REMINDER_INTERVAL_MS,
  OUTLOOK_REMINDER_OWED_MS,
  type AdaOutlookOperations,
  type OutlookAccountRecord,
  type OutlookAccountStamp,
  type OutlookPending,
  type OutlookRefreshedTokens,
} from "./outlook-account-contract.js";
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
    throw new Error(`Ada Outlook account worker is missing ${name}.`);
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
 * Outlook sign-ins are new, so these tables carry the plain `ada_` prefix. Everything here is
 * created with IF NOT EXISTS and nothing existing is altered. The encryption contexts are bound
 * into every stored secret (AES-GCM additional data), so they must never be renamed.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ada_outlook_pending (
  nonce TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  code_verifier TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ada_outlook_account (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_expires_at_ms INTEGER NOT NULL,
  scope TEXT,
  connected_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ada_outlook_reminder (
  id TEXT PRIMARY KEY,
  last_reminded_at_ms INTEGER NOT NULL,
  owed INTEGER NOT NULL
) STRICT;
`;

type AdaOutlookDatabase = {
  ada_outlook_pending: {
    nonce: string;
    owner: string;
    expires_at_ms: number;
    code_verifier: string;
  };
  ada_outlook_account: {
    id: string;
    email: string;
    access_token: string;
    refresh_token: string;
    access_expires_at_ms: number;
    scope: string | null;
    connected_at_ms: number;
  };
  ada_outlook_reminder: { id: string; last_reminded_at_ms: number; owed: number };
};

const ACCESS_TOKEN_CONTEXT = "ada_outlook_account.access_token";
const REFRESH_TOKEN_CONTEXT = "ada_outlook_account.refresh_token";
const CODE_VERIFIER_CONTEXT = "ada_outlook_pending.code_verifier";

const OWNER = /^\d{7,15}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const DB_LABEL = "ada outlook account";

function chmodIfExists(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function assertOwner(owner: string): void {
  if (!OWNER.test(owner)) {
    throw new Error("Ada Outlook account owner is invalid");
  }
}

function assertNonce(nonce: string): void {
  if (!NONCE.test(nonce)) {
    throw new Error("Ada Outlook connect nonce is invalid");
  }
}

function assertAccount(account: OutlookAccountRecord): void {
  if (!EMAIL.test(account.email) || account.email.length > 320) {
    throw new Error("Ada Outlook account email is invalid");
  }
  if (account.accessToken.trim().length < 8 || account.accessToken.length > 16_384) {
    throw new Error("Ada Outlook access token is invalid");
  }
  if (account.refreshToken.trim().length < 8 || account.refreshToken.length > 16_384) {
    throw new Error("Ada Outlook refresh token is invalid");
  }
  if (!Number.isFinite(account.accessExpiresAtMs) || !Number.isFinite(account.connectedAtMs)) {
    throw new Error("Ada Outlook account time is invalid");
  }
  if (account.scope !== null && (account.scope.length > 2000 || /[\r\n]/u.test(account.scope))) {
    throw new Error("Ada Outlook scope is invalid");
  }
}

class AdaOutlookDatabaseStore {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: { close(): void },
    private readonly cipher: TokenCipher,
  ) {
    this.query = getNodeSqliteKysely<AdaOutlookDatabase>(db);
  }

  private transaction<T>(operationLabel: string, run: () => T): T {
    return runSqliteImmediateTransactionSync(this.db, run, {
      busyTimeoutMs: 5000,
      databaseLabel: DB_LABEL,
      operationLabel,
    });
  }

  listOwners(): string[] {
    return Array.from(
      iterateSqliteQuerySync(
        this.db,
        this.query.selectFrom("ada_outlook_account").select("id").orderBy("id"),
      ),
      (row) => row.id,
    ).filter((id) => OWNER.test(id));
  }

  replacePending(owner: string, nonce: string, expiresAtMs: number, pending: OutlookPending) {
    assertOwner(owner);
    assertNonce(nonce);
    if (!Number.isFinite(expiresAtMs) || !pending.codeVerifier) {
      throw new Error("Ada Outlook connect state is invalid");
    }
    this.transaction("ada.outlook.pending.replace", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_outlook_pending").where("owner", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("ada_outlook_pending").values({
          nonce,
          owner,
          expires_at_ms: expiresAtMs,
          code_verifier: this.cipher.seal(pending.codeVerifier, CODE_VERIFIER_CONTEXT),
        }),
      );
    });
    return undefined;
  }

  consumePending(owner: string, nonce: string, nowMs: number): OutlookPending | null {
    assertOwner(owner);
    assertNonce(nonce);
    return this.transaction("ada.outlook.pending.consume", () => {
      const row = executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("ada_outlook_pending")
          .select(["owner", "expires_at_ms", "code_verifier"])
          .where("nonce", "=", nonce),
      );
      if (!row || row.owner !== owner) {
        return null;
      }
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_outlook_pending").where("nonce", "=", nonce),
      );
      if (row.expires_at_ms <= nowMs) {
        return null;
      }
      return { codeVerifier: this.cipher.open(row.code_verifier, CODE_VERIFIER_CONTEXT).value };
    });
  }

  upsertAccount(owner: string, account: OutlookAccountRecord) {
    assertOwner(owner);
    assertAccount(account);
    this.transaction("ada.outlook.account.upsert", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_outlook_account").where("id", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("ada_outlook_account").values({
          id: owner,
          email: account.email,
          access_token: this.cipher.seal(account.accessToken, ACCESS_TOKEN_CONTEXT),
          refresh_token: this.cipher.seal(account.refreshToken, REFRESH_TOKEN_CONTEXT),
          access_expires_at_ms: account.accessExpiresAtMs,
          scope: account.scope,
          connected_at_ms: account.connectedAtMs,
        }),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.updateTable("ada_outlook_reminder").set({ owed: 0 }).where("id", "=", owner),
      );
    });
    return undefined;
  }

  readAccount(owner: string): OutlookAccountRecord | null {
    assertOwner(owner);
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("ada_outlook_account")
        .select([
          "email",
          "access_token",
          "refresh_token",
          "access_expires_at_ms",
          "scope",
          "connected_at_ms",
        ])
        .where("id", "=", owner),
    );
    if (!row) {
      return null;
    }
    return {
      email: row.email,
      accessToken: this.cipher.open(row.access_token, ACCESS_TOKEN_CONTEXT).value,
      refreshToken: this.cipher.open(row.refresh_token, REFRESH_TOKEN_CONTEXT).value,
      accessExpiresAtMs: row.access_expires_at_ms,
      scope: row.scope,
      connectedAtMs: row.connected_at_ms,
    };
  }

  clearAccount(owner: string) {
    assertOwner(owner);
    this.transaction("ada.outlook.account.clear", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_outlook_account").where("id", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_outlook_pending").where("owner", "=", owner),
      );
    });
    return undefined;
  }

  /** Runs `write` in one transaction, only while the row still holds `expected`. */
  private ifStill(
    owner: string,
    expected: OutlookAccountStamp,
    operationLabel: string,
    write: () => void,
  ): boolean {
    assertOwner(owner);
    return this.transaction(operationLabel, () => {
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
    });
  }

  updateTokensIfStill(
    owner: string,
    expected: OutlookAccountStamp,
    tokens: OutlookRefreshedTokens,
  ): boolean {
    return this.ifStill(owner, expected, "ada.outlook.account.refresh", () => {
      executeSqliteQuerySync(
        this.db,
        this.query
          .updateTable("ada_outlook_account")
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

  clearAccountIfStill(owner: string, expected: OutlookAccountStamp): boolean {
    return this.ifStill(owner, expected, "ada.outlook.account.clear_if_still", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_outlook_account").where("id", "=", owner),
      );
    });
  }

  claimReconnectReminder(owner: string, nowMs: number): boolean {
    assertOwner(owner);
    return this.transaction("ada.outlook.reminder.claim", () => {
      const row = executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("ada_outlook_reminder")
          .select("last_reminded_at_ms")
          .where("id", "=", owner),
      );
      if (row && nowMs - row.last_reminded_at_ms < OUTLOOK_REMINDER_INTERVAL_MS) {
        return false;
      }
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_outlook_reminder").where("id", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query
          .insertInto("ada_outlook_reminder")
          .values({ id: owner, last_reminded_at_ms: nowMs, owed: 1 }),
      );
      return true;
    });
  }

  reminderOwed(owner: string, nowMs: number): boolean {
    assertOwner(owner);
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("ada_outlook_reminder")
        .select(["last_reminded_at_ms", "owed"])
        .where("id", "=", owner),
    );
    return row?.owed === 1 && nowMs - row.last_reminded_at_ms <= OUTLOOK_REMINDER_OWED_MS;
  }

  settleReminder(owner: string) {
    assertOwner(owner);
    executeSqliteQuerySync(
      this.db,
      this.query.updateTable("ada_outlook_reminder").set({ owed: 0 }).where("id", "=", owner),
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

function openAdaOutlookDatabase(dbPath: string): AdaOutlookDatabaseStore {
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
      databaseLabel: DB_LABEL,
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(SCHEMA_SQL);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return new AdaOutlookDatabaseStore(db, maintenance, cipher);
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
): SqliteWorkerBackend<AdaOutlookOperations> {
  const database = openAdaOutlookDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<AdaOutlookOperations>) {
      switch (command.type) {
        case "replacePending":
          return database.replacePending(
            command.input.owner,
            command.input.nonce,
            command.input.expiresAtMs,
            command.input.pending,
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
        case "claimReconnectReminder":
          return database.claimReconnectReminder(command.input.owner, command.input.nowMs);
        case "listOwners":
          return database.listOwners();
        case "reminderOwed":
          return database.reminderOwed(command.input.owner, command.input.nowMs);
        case "settleReminder":
          return database.settleReminder(command.input.owner);
      }
      throw new Error("Unexpected Ada Outlook command");
    },
    close: () => database.close(),
  };
}
