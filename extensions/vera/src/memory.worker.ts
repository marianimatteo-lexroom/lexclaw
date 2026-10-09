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
  MEMORY_FOLDERS,
  MEMORY_RECORD_TYPES,
  REVISION_REASONS,
  TODO_OWNERS,
  TODO_STATUSES,
  type CalendarSnapshotRow,
  type GmailSnapshotRow,
  type LawyerProfile,
  type MemoryFolder,
  type MemoryRecord,
  type MemoryRevision,
  type MemoryTodo,
  type RevisionReason,
  type VeraMemoryOperations,
  type WakeState,
} from "./memory-contract.js";
import { rankMemoryHits } from "./memory-render.js";

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
    throw new Error(`Vera memory worker is missing ${name}.`);
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

const PROFILE_ID = "lawyer";
const WAKE_ID = "lawyer";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** Gmail and Calendar ids may include characters outside the wiki record alphabet. */
const SNAPSHOT_ID = /^[^\s]{1,256}$/u;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vera_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  email TEXT,
  language TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  autonomy TEXT NOT NULL,
  channel_style TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_records (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  body TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  valid_to_ms INTEGER,
  superseded_by TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS vera_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  previous_body TEXT NOT NULL,
  reason TEXT NOT NULL,
  at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_todos (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_gmail_snapshot (
  message_id TEXT PRIMARY KEY,
  internal_date_ms INTEGER NOT NULL,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  seen_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_calendar_snapshot (
  event_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  matter_id TEXT,
  seen_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_wake_state (
  id TEXT PRIMARY KEY,
  last_lawyer_inbound_at_ms INTEGER,
  last_reconcile_at_ms INTEGER,
  last_collect_at_ms INTEGER,
  held_plan_json TEXT,
  watch_expiration_ms INTEGER,
  open_todo_ids_json TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS vera_records_matter ON vera_records (matter_id);
CREATE INDEX IF NOT EXISTS vera_todos_matter ON vera_todos (matter_id);
CREATE INDEX IF NOT EXISTS vera_revisions_record ON vera_revisions (record_id);
`;

type VeraMemoryDatabase = {
  vera_profile: {
    id: string;
    name: string;
    timezone: string;
    email: string | null;
    language: string;
    jurisdiction: string;
    autonomy: string;
    channel_style: string;
    generated_at_ms: number;
  };
  vera_records: {
    id: string;
    matter_id: string;
    folder: string;
    type: string;
    title: string;
    aliases_json: string;
    body: string;
    valid_from_ms: number;
    valid_to_ms: number | null;
    superseded_by: string | null;
  };
  vera_revisions: {
    id: number;
    record_id: string;
    matter_id: string;
    previous_body: string;
    reason: string;
    at_ms: number;
  };
  vera_todos: {
    id: string;
    matter_id: string;
    owner: string;
    title: string;
    status: string;
    detail: string;
    updated_at_ms: number;
  };
  vera_gmail_snapshot: {
    message_id: string;
    internal_date_ms: number;
    from_addr: string;
    subject: string;
    seen_at_ms: number;
  };
  vera_calendar_snapshot: {
    event_id: string;
    summary: string;
    start_ms: number;
    end_ms: number | null;
    matter_id: string | null;
    seen_at_ms: number;
  };
  vera_wake_state: {
    id: string;
    last_lawyer_inbound_at_ms: number | null;
    last_reconcile_at_ms: number | null;
    last_collect_at_ms: number | null;
    held_plan_json: string | null;
    watch_expiration_ms: number | null;
    open_todo_ids_json: string | null;
  };
};

function chmodIfExists(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function assertId(id: string, field: string): void {
  if (!ID.test(id)) {
    throw new Error(`${field} is invalid`);
  }
}

function assertText(value: string, field: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function parseAliases(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  } catch {
    return [];
  }
}

function rowToRecord(row: VeraMemoryDatabase["vera_records"]): MemoryRecord {
  return {
    id: row.id,
    matterId: row.matter_id,
    folder: row.folder as MemoryFolder,
    type: row.type as MemoryRecord["type"],
    title: row.title,
    aliases: parseAliases(row.aliases_json),
    body: row.body,
    validFromMs: row.valid_from_ms,
    validToMs: row.valid_to_ms,
    supersededBy: row.superseded_by,
  };
}

function emptyWake(): WakeState {
  return {
    lastLawyerInboundAtMs: null,
    lastReconcileAtMs: null,
    lastCollectAtMs: null,
    heldPlanJson: null,
    watchExpirationMs: null,
    openTodoIdsJson: null,
  };
}

class VeraMemoryDatabaseStore {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: { close(): void },
  ) {
    this.query = getNodeSqliteKysely<VeraMemoryDatabase>(db);
  }

  upsertProfile(profile: LawyerProfile): undefined {
    const name = assertText(profile.name, "name", 200);
    const timezone = assertText(profile.timezone, "timezone", 80);
    const language = assertText(profile.language, "language", 40);
    const jurisdiction = assertText(profile.jurisdiction, "jurisdiction", 80);
    const autonomy = assertText(profile.autonomy, "autonomy", 4000);
    const channelStyle = assertText(profile.channelStyle, "channelStyle", 2000);
    if (profile.email !== null && (profile.email.length > 320 || !profile.email.includes("@"))) {
      throw new Error("email is invalid");
    }
    if (!Number.isFinite(profile.generatedAtMs)) {
      throw new Error("generatedAtMs is invalid");
    }
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_profile").where("id", "=", PROFILE_ID),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_profile").values({
            id: PROFILE_ID,
            name,
            timezone,
            email: profile.email,
            language,
            jurisdiction,
            autonomy,
            channel_style: channelStyle,
            generated_at_ms: profile.generatedAtMs,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.profile.upsert",
      },
    );
    return undefined;
  }

  readProfile(): LawyerProfile | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("vera_profile")
        .selectAll()
        .where("id", "=", PROFILE_ID),
    );
    if (!row) {
      return null;
    }
    return {
      name: row.name,
      timezone: row.timezone,
      email: row.email,
      language: row.language,
      jurisdiction: row.jurisdiction,
      autonomy: row.autonomy,
      channelStyle: row.channel_style,
      generatedAtMs: row.generated_at_ms,
    };
  }

  upsertRecord(record: MemoryRecord, reason: RevisionReason, atMs: number): undefined {
    assertId(record.id, "id");
    if (record.matterId !== "" && !ID.test(record.matterId)) {
      throw new Error("matterId is invalid");
    }
    if (!MEMORY_FOLDERS.includes(record.folder)) {
      throw new Error("folder is invalid");
    }
    if (!MEMORY_RECORD_TYPES.includes(record.type)) {
      throw new Error("type is invalid");
    }
    if (!REVISION_REASONS.includes(reason)) {
      throw new Error("reason is invalid");
    }
    const title = assertText(record.title, "title", 200);
    const body = assertText(record.body, "body", 50_000);
    const aliases = record.aliases
      .map((alias) => alias.trim())
      .filter((alias) => alias.length > 0 && alias.length <= 120)
      .slice(0, 40);
    if (!Number.isFinite(atMs) || !Number.isFinite(record.validFromMs)) {
      throw new Error("timestamp is invalid");
    }
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const existing = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query.selectFrom("vera_records").selectAll().where("id", "=", record.id),
        );
        if (existing && existing.matter_id !== record.matterId) {
          throw new Error("record matterId cannot change");
        }
        if (existing && existing.body !== body && reason !== "create") {
          executeSqliteQuerySync(
            this.db,
            this.query.insertInto("vera_revisions").values({
              record_id: record.id,
              matter_id: record.matterId,
              previous_body: existing.body,
              reason,
              at_ms: atMs,
            }),
          );
        }
        if (existing) {
          executeSqliteQuerySync(
            this.db,
            this.query.deleteFrom("vera_records").where("id", "=", record.id),
          );
        }
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_records").values({
            id: record.id,
            matter_id: record.matterId,
            folder: record.folder,
            type: record.type,
            title,
            aliases_json: JSON.stringify(aliases),
            body,
            valid_from_ms: record.validFromMs,
            valid_to_ms: record.validToMs,
            superseded_by: record.supersededBy,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.record.upsert",
      },
    );
    return undefined;
  }

  currentRecordsForMatter(matterId: string): MemoryRecord[] {
    return Array.from(
      iterateSqliteQuerySync(
        this.db,
        this.query
          .selectFrom("vera_records")
          .selectAll()
          .where("matter_id", "=", matterId)
          .where("valid_to_ms", "is", null),
      ),
      rowToRecord,
    );
  }

  searchRecords(query: string, matterId: string): MemoryRecord[] {
    if (matterId !== "" && !ID.test(matterId)) {
      throw new Error("matterId is invalid");
    }
    return rankMemoryHits(this.currentRecordsForMatter(matterId), query).slice(0, 20);
  }

  listRecords(folder: MemoryFolder, matterId: string): MemoryRecord[] {
    if (!MEMORY_FOLDERS.includes(folder)) {
      throw new Error("folder is invalid");
    }
    return this.currentRecordsForMatter(matterId)
      .filter((record) => record.folder === folder)
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  getRecord(id: string, matterId: string): MemoryRecord | null {
    assertId(id, "id");
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("vera_records")
        .selectAll()
        .where("id", "=", id)
        .where("matter_id", "=", matterId),
    );
    return row ? rowToRecord(row) : null;
  }

  history(id: string, matterId: string): MemoryRevision[] {
    assertId(id, "id");
    return Array.from(
      iterateSqliteQuerySync(
        this.db,
        this.query
          .selectFrom("vera_revisions")
          .select(["record_id", "matter_id", "previous_body", "reason", "at_ms"])
          .where("record_id", "=", id)
          .where("matter_id", "=", matterId)
          .orderBy("at_ms", "desc")
          .limit(50),
      ),
      (row) => ({
        recordId: row.record_id,
        matterId: row.matter_id,
        previousBody: row.previous_body,
        reason: row.reason as RevisionReason,
        atMs: row.at_ms,
      }),
    );
  }

  upsertTodo(todo: MemoryTodo): undefined {
    assertId(todo.id, "id");
    assertId(todo.matterId, "matterId");
    if (!TODO_OWNERS.includes(todo.owner)) {
      throw new Error("owner is invalid");
    }
    if (!TODO_STATUSES.includes(todo.status)) {
      throw new Error("status is invalid");
    }
    const title = assertText(todo.title, "title", 200);
    const detail = todo.detail.trim().slice(0, 20_000);
    if (!Number.isFinite(todo.updatedAtMs)) {
      throw new Error("updatedAtMs is invalid");
    }
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_todos").where("id", "=", todo.id),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_todos").values({
            id: todo.id,
            matter_id: todo.matterId,
            owner: todo.owner,
            title,
            status: todo.status,
            detail,
            updated_at_ms: todo.updatedAtMs,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.todo.upsert",
      },
    );
    return undefined;
  }

  listTodos(matterId?: string): MemoryTodo[] {
    let builder = this.query.selectFrom("vera_todos").selectAll();
    if (matterId !== undefined) {
      assertId(matterId, "matterId");
      builder = builder.where("matter_id", "=", matterId);
    }
    return Array.from(
      iterateSqliteQuerySync(this.db, builder.orderBy("updated_at_ms", "desc")),
      (row) => ({
        id: row.id,
        matterId: row.matter_id,
        owner: row.owner as MemoryTodo["owner"],
        title: row.title,
        status: row.status as MemoryTodo["status"],
        detail: row.detail,
        updatedAtMs: row.updated_at_ms,
      }),
    );
  }

  getTodo(id: string): MemoryTodo | null {
    assertId(id, "id");
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("vera_todos").selectAll().where("id", "=", id),
    );
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      matterId: row.matter_id,
      owner: row.owner as MemoryTodo["owner"],
      title: row.title,
      status: row.status as MemoryTodo["status"],
      detail: row.detail,
      updatedAtMs: row.updated_at_ms,
    };
  }

  replaceGmailSnapshot(rows: GmailSnapshotRow[]): undefined {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_gmail_snapshot").where("message_id", "is not", null),
        );
        for (const row of rows.slice(0, 200)) {
          if (!SNAPSHOT_ID.test(row.messageId)) {
            throw new Error("messageId is invalid");
          }
          executeSqliteQuerySync(
            this.db,
            this.query.insertInto("vera_gmail_snapshot").values({
              message_id: row.messageId,
              internal_date_ms: row.internalDateMs,
              from_addr: row.from.trim().slice(0, 320),
              subject: row.subject.trim().slice(0, 500),
              seen_at_ms: row.seenAtMs,
            }),
          );
        }
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.gmail.replace",
      },
    );
    return undefined;
  }

  readGmailSnapshot(): GmailSnapshotRow[] {
    return Array.from(
      iterateSqliteQuerySync(this.db, this.query.selectFrom("vera_gmail_snapshot").selectAll()),
      (row) => ({
        messageId: row.message_id,
        internalDateMs: row.internal_date_ms,
        from: row.from_addr,
        subject: row.subject,
        seenAtMs: row.seen_at_ms,
      }),
    );
  }

  replaceCalendarSnapshot(rows: CalendarSnapshotRow[]): undefined {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_calendar_snapshot").where("event_id", "is not", null),
        );
        for (const row of rows.slice(0, 200)) {
          if (!SNAPSHOT_ID.test(row.eventId)) {
            throw new Error("eventId is invalid");
          }
          executeSqliteQuerySync(
            this.db,
            this.query.insertInto("vera_calendar_snapshot").values({
              event_id: row.eventId,
              summary: row.summary.trim().slice(0, 500),
              start_ms: row.startMs,
              end_ms: row.endMs,
              matter_id: row.matterId,
              seen_at_ms: row.seenAtMs,
            }),
          );
        }
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.calendar.replace",
      },
    );
    return undefined;
  }

  readCalendarSnapshot(): CalendarSnapshotRow[] {
    return Array.from(
      iterateSqliteQuerySync(this.db, this.query.selectFrom("vera_calendar_snapshot").selectAll()),
      (row) => ({
        eventId: row.event_id,
        summary: row.summary,
        startMs: row.start_ms,
        endMs: row.end_ms,
        matterId: row.matter_id,
        seenAtMs: row.seen_at_ms,
      }),
    );
  }

  readWake(): WakeState {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("vera_wake_state").selectAll().where("id", "=", WAKE_ID),
    );
    if (!row) {
      return emptyWake();
    }
    return {
      lastLawyerInboundAtMs: row.last_lawyer_inbound_at_ms,
      lastReconcileAtMs: row.last_reconcile_at_ms,
      lastCollectAtMs: row.last_collect_at_ms,
      heldPlanJson: row.held_plan_json,
      watchExpirationMs: row.watch_expiration_ms,
      openTodoIdsJson: row.open_todo_ids_json ?? null,
    };
  }

  writeWake(patch: Partial<WakeState>): undefined {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const current = this.readWake();
        const next: WakeState = {
          lastLawyerInboundAtMs:
            patch.lastLawyerInboundAtMs !== undefined
              ? patch.lastLawyerInboundAtMs
              : current.lastLawyerInboundAtMs,
          lastReconcileAtMs:
            patch.lastReconcileAtMs !== undefined
              ? patch.lastReconcileAtMs
              : current.lastReconcileAtMs,
          lastCollectAtMs:
            patch.lastCollectAtMs !== undefined ? patch.lastCollectAtMs : current.lastCollectAtMs,
          heldPlanJson:
            patch.heldPlanJson !== undefined ? patch.heldPlanJson : current.heldPlanJson,
          watchExpirationMs:
            patch.watchExpirationMs !== undefined
              ? patch.watchExpirationMs
              : current.watchExpirationMs,
          openTodoIdsJson:
            patch.openTodoIdsJson !== undefined
              ? patch.openTodoIdsJson
              : current.openTodoIdsJson,
        };
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("vera_wake_state").where("id", "=", WAKE_ID),
        );
        executeSqliteQuerySync(
          this.db,
          this.query.insertInto("vera_wake_state").values({
            id: WAKE_ID,
            last_lawyer_inbound_at_ms: next.lastLawyerInboundAtMs,
            last_reconcile_at_ms: next.lastReconcileAtMs,
            last_collect_at_ms: next.lastCollectAtMs,
            held_plan_json: next.heldPlanJson,
            watch_expiration_ms: next.watchExpirationMs,
            open_todo_ids_json: next.openTodoIdsJson,
          }),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.wake.write",
      },
    );
    return undefined;
  }

  listMatterAliases(): Array<{ matterId: string; alias: string; title: string }> {
    const out: Array<{ matterId: string; alias: string; title: string }> = [];
    for (const row of iterateSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("vera_records")
        .select(["matter_id", "title", "aliases_json"])
        .where("matter_id", "!=", "")
        .where("valid_to_ms", "is", null),
    )) {
      for (const alias of parseAliases(row.aliases_json)) {
        out.push({ matterId: row.matter_id, alias, title: row.title });
      }
      out.push({ matterId: row.matter_id, alias: row.title, title: row.title });
    }
    return out;
  }

  close(): void {
    try {
      this.maintenance.close();
    } finally {
      this.db.close();
    }
  }
}

function openVeraMemoryDatabase(dbPath: string): VeraMemoryDatabaseStore {
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
      databaseLabel: "vera memory",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(SCHEMA_SQL);
    const wakeColumns = db
      .prepare("SELECT name FROM pragma_table_info('vera_wake_state')")
      .all() as Array<{ name: string }>;
    if (!wakeColumns.some((column) => column.name === "open_todo_ids_json")) {
      db.exec("ALTER TABLE vera_wake_state ADD COLUMN open_todo_ids_json TEXT");
    }
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return new VeraMemoryDatabaseStore(db, maintenance);
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
): SqliteWorkerBackend<VeraMemoryOperations> {
  const database = openVeraMemoryDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<VeraMemoryOperations>) {
      switch (command.type) {
        case "upsertProfile":
          return database.upsertProfile(command.input);
        case "readProfile":
          return database.readProfile();
        case "upsertRecord":
          return database.upsertRecord(command.input.record, command.input.reason, command.input.atMs);
        case "searchRecords":
          return database.searchRecords(command.input.query, command.input.matterId);
        case "listRecords":
          return database.listRecords(command.input.folder, command.input.matterId);
        case "getRecord":
          return database.getRecord(command.input.id, command.input.matterId);
        case "history":
          return database.history(command.input.id, command.input.matterId);
        case "upsertTodo":
          return database.upsertTodo(command.input);
        case "listTodos":
          return database.listTodos(command.input.matterId);
        case "getTodo":
          return database.getTodo(command.input.id);
        case "replaceGmailSnapshot":
          return database.replaceGmailSnapshot(command.input.rows);
        case "readGmailSnapshot":
          return database.readGmailSnapshot();
        case "replaceCalendarSnapshot":
          return database.replaceCalendarSnapshot(command.input.rows);
        case "readCalendarSnapshot":
          return database.readCalendarSnapshot();
        case "readWake":
          return database.readWake();
        case "writeWake":
          return database.writeWake(command.input);
        case "listMatterAliases":
          return database.listMatterAliases();
      }
      throw new Error("Unexpected Vera memory command");
    },
    close: () => database.close(),
  };
}
