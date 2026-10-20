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
  GRANOLA_REMINDER_INTERVAL_MS,
  type AdaGranolaOperations,
  type GranolaAccountRecord,
  type GranolaAccountStamp,
  type GranolaClientRecord,
  type GranolaPending,
  type GranolaRefreshedTokens,
} from "./granola-account-contract.js";
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
    throw new Error(`Ada Granola account worker is missing ${name}.`);
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
 * Granola sign-ins are new, so these tables carry the plain `ada_` prefix. Everything here is
 * created with IF NOT EXISTS and nothing existing is altered. The encryption contexts are bound
 * into every stored secret (AES-GCM additional data), so they must never be renamed.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ada_granola_pending (
  nonce TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  code_verifier TEXT NOT NULL,
  client_id TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ada_granola_account (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  access_expires_at_ms INTEGER,
  scope TEXT,
  client_id TEXT NOT NULL,
  connected_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ada_granola_client (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  redirect_uri TEXT NOT NULL,
  registered_at_ms INTEGER NOT NULL,
  secret_expires_at_ms INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS ada_granola_reminder (
  id TEXT PRIMARY KEY,
  last_reminded_at_ms INTEGER NOT NULL
) STRICT;
`;

type AdaGranolaDatabase = {
  ada_granola_pending: {
    nonce: string;
    owner: string;
    expires_at_ms: number;
    code_verifier: string;
    client_id: string;
  };
  ada_granola_account: {
    id: string;
    access_token: string;
    refresh_token: string | null;
    access_expires_at_ms: number | null;
    scope: string | null;
    client_id: string;
    connected_at_ms: number;
  };
  ada_granola_client: {
    id: string;
    client_id: string;
    client_secret: string | null;
    redirect_uri: string;
    registered_at_ms: number;
    secret_expires_at_ms: number | null;
  };
  ada_granola_reminder: { id: string; last_reminded_at_ms: number };
};

const ACCESS_TOKEN_CONTEXT = "ada_granola_account.access_token";
const REFRESH_TOKEN_CONTEXT = "ada_granola_account.refresh_token";
const CLIENT_SECRET_CONTEXT = "ada_granola_client.client_secret";
const CODE_VERIFIER_CONTEXT = "ada_granola_pending.code_verifier";

const OWNER = /^\d{7,15}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const CLIENT_ROW_ID = "registration";
const DB_LABEL = "ada granola account";

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
    throw new Error("Ada Granola account owner is invalid");
  }
}

function assertAccount(account: GranolaAccountRecord): void {
  if (account.accessToken.trim().length < 8 || account.accessToken.length > 16_384) {
    throw new Error("Ada Granola access token is invalid");
  }
  if (account.refreshToken !== null && account.refreshToken.length > 16_384) {
    throw new Error("Ada Granola refresh token is invalid");
  }
  if (!account.clientId.trim() || account.clientId.length > 512) {
    throw new Error("Ada Granola client id is invalid");
  }
  if (!Number.isFinite(account.connectedAtMs)) {
    throw new Error("Ada Granola connected time is invalid");
  }
  if (account.scope !== null && (account.scope.length > 2000 || /[\r\n]/u.test(account.scope))) {
    throw new Error("Ada Granola scope is invalid");
  }
}

class AdaGranolaDatabaseStore {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: { close(): void },
    private readonly cipher: TokenCipher,
  ) {
    this.query = getNodeSqliteKysely<AdaGranolaDatabase>(db);
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
        this.query.selectFrom("ada_granola_account").select("id").orderBy("id"),
      ),
      (row) => row.id,
    ).filter((id) => OWNER.test(id));
  }

  replacePending(owner: string, nonce: string, expiresAtMs: number, pending: GranolaPending) {
    assertOwner(owner);
    if (!NONCE.test(nonce)) {
      throw new Error("Ada Granola connect nonce is invalid");
    }
    if (!Number.isFinite(expiresAtMs) || !pending.codeVerifier || !pending.clientId) {
      throw new Error("Ada Granola connect state is invalid");
    }
    this.transaction("ada.granola.pending.replace", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_pending").where("owner", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("ada_granola_pending").values({
          nonce,
          owner,
          expires_at_ms: expiresAtMs,
          code_verifier: this.cipher.seal(pending.codeVerifier, CODE_VERIFIER_CONTEXT),
          client_id: pending.clientId,
        }),
      );
    });
    return undefined;
  }

  consumePending(owner: string, nonce: string, nowMs: number): GranolaPending | null {
    assertOwner(owner);
    if (!NONCE.test(nonce)) {
      throw new Error("Ada Granola connect nonce is invalid");
    }
    return this.transaction("ada.granola.pending.consume", () => {
      const row = executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("ada_granola_pending")
          .select(["owner", "expires_at_ms", "code_verifier", "client_id"])
          .where("nonce", "=", nonce),
      );
      if (!row || row.owner !== owner) {
        return null;
      }
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_pending").where("nonce", "=", nonce),
      );
      if (row.expires_at_ms <= nowMs) {
        return null;
      }
      return {
        codeVerifier: this.cipher.open(row.code_verifier, CODE_VERIFIER_CONTEXT).value,
        clientId: row.client_id,
      };
    });
  }

  upsertAccount(owner: string, account: GranolaAccountRecord) {
    assertOwner(owner);
    assertAccount(account);
    this.transaction("ada.granola.account.upsert", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_account").where("id", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("ada_granola_account").values({
          id: owner,
          access_token: this.cipher.seal(account.accessToken, ACCESS_TOKEN_CONTEXT),
          refresh_token:
            account.refreshToken === null
              ? null
              : this.cipher.seal(account.refreshToken, REFRESH_TOKEN_CONTEXT),
          access_expires_at_ms: account.accessExpiresAtMs,
          scope: account.scope,
          client_id: account.clientId,
          connected_at_ms: account.connectedAtMs,
        }),
      );
    });
    return undefined;
  }

  readAccount(owner: string): GranolaAccountRecord | null {
    assertOwner(owner);
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("ada_granola_account")
        .select([
          "access_token",
          "refresh_token",
          "access_expires_at_ms",
          "scope",
          "client_id",
          "connected_at_ms",
        ])
        .where("id", "=", owner),
    );
    if (!row) {
      return null;
    }
    return {
      accessToken: this.cipher.open(row.access_token, ACCESS_TOKEN_CONTEXT).value,
      refreshToken:
        row.refresh_token === null
          ? null
          : this.cipher.open(row.refresh_token, REFRESH_TOKEN_CONTEXT).value,
      accessExpiresAtMs: row.access_expires_at_ms,
      scope: row.scope,
      clientId: row.client_id,
      connectedAtMs: row.connected_at_ms,
    };
  }

  clearAccount(owner: string) {
    assertOwner(owner);
    this.transaction("ada.granola.account.clear", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_account").where("id", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_pending").where("owner", "=", owner),
      );
    });
    return undefined;
  }

  /** Runs `write` in one transaction, only while the row still holds `expected`. */
  private ifStill(
    owner: string,
    expected: GranolaAccountStamp,
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
    expected: GranolaAccountStamp,
    tokens: GranolaRefreshedTokens,
  ): boolean {
    return this.ifStill(owner, expected, "ada.granola.account.refresh", () => {
      executeSqliteQuerySync(
        this.db,
        this.query
          .updateTable("ada_granola_account")
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

  clearAccountIfStill(owner: string, expected: GranolaAccountStamp): boolean {
    return this.ifStill(owner, expected, "ada.granola.account.clear_if_still", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_account").where("id", "=", owner),
      );
    });
  }

  claimReconnectReminder(owner: string, nowMs: number): boolean {
    assertOwner(owner);
    return this.transaction("ada.granola.reminder.claim", () => {
      const row = executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("ada_granola_reminder")
          .select("last_reminded_at_ms")
          .where("id", "=", owner),
      );
      if (row && nowMs - row.last_reminded_at_ms < GRANOLA_REMINDER_INTERVAL_MS) {
        return false;
      }
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_reminder").where("id", "=", owner),
      );
      executeSqliteQuerySync(
        this.db,
        this.query
          .insertInto("ada_granola_reminder")
          .values({ id: owner, last_reminded_at_ms: nowMs }),
      );
      return true;
    });
  }

  readClient(): GranolaClientRecord | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("ada_granola_client")
        .select([
          "client_id",
          "client_secret",
          "redirect_uri",
          "registered_at_ms",
          "secret_expires_at_ms",
        ])
        .where("id", "=", CLIENT_ROW_ID),
    );
    if (!row) {
      return null;
    }
    return {
      clientId: row.client_id,
      clientSecret:
        row.client_secret === null
          ? null
          : this.cipher.open(row.client_secret, CLIENT_SECRET_CONTEXT).value,
      redirectUri: row.redirect_uri,
      registeredAtMs: row.registered_at_ms,
      secretExpiresAtMs: row.secret_expires_at_ms,
    };
  }

  saveClient(client: GranolaClientRecord) {
    if (!client.clientId.trim() || client.clientId.length > 512) {
      throw new Error("Ada Granola client id is invalid");
    }
    this.transaction("ada.granola.client.save", () => {
      executeSqliteQuerySync(
        this.db,
        this.query.deleteFrom("ada_granola_client").where("id", "=", CLIENT_ROW_ID),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("ada_granola_client").values({
          id: CLIENT_ROW_ID,
          client_id: client.clientId,
          client_secret:
            client.clientSecret === null
              ? null
              : this.cipher.seal(client.clientSecret, CLIENT_SECRET_CONTEXT),
          redirect_uri: client.redirectUri,
          registered_at_ms: client.registeredAtMs,
          secret_expires_at_ms: client.secretExpiresAtMs,
        }),
      );
    });
    return undefined;
  }

  clearClientIfStill(clientId: string) {
    executeSqliteQuerySync(
      this.db,
      this.query
        .deleteFrom("ada_granola_client")
        .where("id", "=", CLIENT_ROW_ID)
        .where("client_id", "=", clientId),
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

function openAdaGranolaDatabase(dbPath: string): AdaGranolaDatabaseStore {
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
    return new AdaGranolaDatabaseStore(db, maintenance, cipher);
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
): SqliteWorkerBackend<AdaGranolaOperations> {
  const database = openAdaGranolaDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<AdaGranolaOperations>) {
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
        case "readClient":
          return database.readClient();
        case "saveClient":
          return database.saveClient(command.input.client);
        case "clearClientIfStill":
          return database.clearClientIfStill(command.input.clientId);
      }
      throw new Error("Unexpected Ada Granola command");
    },
    close: () => database.close(),
  };
}
