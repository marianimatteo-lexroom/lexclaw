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
  createDeadlineItem,
  deadlineDedupeKey,
  findMoveTarget,
  mergeDeadlineCandidate,
  moveDeadlineItem,
  reviveDeadlineItem,
} from "./deadline-merge.js";
import {
  DEADLINE_RESEARCH_STATUSES,
  DEADLINE_SOURCE_KINDS,
  DEADLINE_STATUSES,
  DEADLINE_TYPES,
  MEMORY_FOLDERS,
  MEMORY_RECORD_TYPES,
  REVISION_REASONS,
  TODO_OWNERS,
  TODO_STATUSES,
  type CalendarSnapshotRow,
  type DeadlineCandidate,
  type DeadlineItem,
  type DeadlinePatch,
  type DeadlineSource,
  type DeadlineUpsertResult,
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

CREATE TABLE IF NOT EXISTS vera_deadlines (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  matter_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  due_time TEXT,
  time_zone TEXT NOT NULL,
  confidence REAL NOT NULL,
  sources_json TEXT NOT NULL,
  status TEXT NOT NULL,
  offer_no INTEGER,
  offered_count INTEGER NOT NULL,
  reminders_sent_json TEXT NOT NULL,
  research_status TEXT NOT NULL,
  brief TEXT,
  brief_at_ms INTEGER,
  moved_from_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vera_deadline_scanned (
  message_id TEXT PRIMARY KEY,
  scanned_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS vera_deadlines_due ON vera_deadlines (due_at_ms);
CREATE INDEX IF NOT EXISTS vera_deadlines_matter ON vera_deadlines (matter_id);
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
  vera_deadlines: {
    id: string;
    dedupe_key: string;
    matter_id: string;
    type: string;
    title: string;
    due_at_ms: number;
    due_date: string;
    due_time: string | null;
    time_zone: string;
    confidence: number;
    sources_json: string;
    status: string;
    offer_no: number | null;
    offered_count: number;
    reminders_sent_json: string;
    research_status: string;
    brief: string | null;
    brief_at_ms: number | null;
    moved_from_ms: number | null;
    created_at_ms: number;
    updated_at_ms: number;
  };
  vera_deadline_scanned: {
    message_id: string;
    scanned_at_ms: number;
  };
};

const DEADLINE_SCAN_RETENTION_MS = 21 * 24 * 60 * 60 * 1000;
const OPEN_DEADLINE_STATUSES = ["candidate", "tracked"];

function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseSources(json: string): DeadlineSource[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is DeadlineSource =>
        Boolean(entry) &&
        typeof entry === "object" &&
        DEADLINE_SOURCE_KINDS.includes((entry as DeadlineSource).kind) &&
        typeof (entry as DeadlineSource).ref === "string" &&
        typeof (entry as DeadlineSource).label === "string" &&
        typeof (entry as DeadlineSource).excerpt === "string",
    );
  } catch {
    return [];
  }
}

function rowToDeadline(row: VeraMemoryDatabase["vera_deadlines"]): DeadlineItem {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    matterId: row.matter_id,
    type: row.type as DeadlineItem["type"],
    title: row.title,
    dueAtMs: row.due_at_ms,
    dueDate: row.due_date,
    dueTime: row.due_time,
    timeZone: row.time_zone,
    confidence: row.confidence,
    sources: parseSources(row.sources_json),
    status: row.status as DeadlineItem["status"],
    offerNo: row.offer_no,
    offeredCount: row.offered_count,
    remindersSent: parseStringArray(row.reminders_sent_json),
    researchStatus: row.research_status as DeadlineItem["researchStatus"],
    brief: row.brief,
    briefAtMs: row.brief_at_ms,
    movedFromMs: row.moved_from_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function deadlineToRow(item: DeadlineItem): VeraMemoryDatabase["vera_deadlines"] {
  return {
    id: item.id,
    dedupe_key: item.dedupeKey,
    matter_id: item.matterId,
    type: item.type,
    title: item.title,
    due_at_ms: item.dueAtMs,
    due_date: item.dueDate,
    due_time: item.dueTime,
    time_zone: item.timeZone,
    confidence: item.confidence,
    sources_json: JSON.stringify(item.sources),
    status: item.status,
    offer_no: item.offerNo,
    offered_count: item.offeredCount,
    reminders_sent_json: JSON.stringify(item.remindersSent),
    research_status: item.researchStatus,
    brief: item.brief,
    brief_at_ms: item.briefAtMs,
    moved_from_ms: item.movedFromMs,
    created_at_ms: item.createdAtMs,
    updated_at_ms: item.updatedAtMs,
  };
}

function assertCandidate(candidate: DeadlineCandidate): void {
  assertId(candidate.matterId, "matterId");
  if (!DEADLINE_TYPES.includes(candidate.type)) {
    throw new Error("type is invalid");
  }
  assertText(candidate.title, "title", 300);
  if (!Number.isFinite(candidate.dueAtMs) || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.dueDate)) {
    throw new Error("due date is invalid");
  }
  if (candidate.dueTime !== null && !/^\d{2}:\d{2}$/u.test(candidate.dueTime)) {
    throw new Error("due time is invalid");
  }
  if (!Number.isFinite(candidate.confidence)) {
    throw new Error("confidence is invalid");
  }
  if (!DEADLINE_SOURCE_KINDS.includes(candidate.source.kind) || !candidate.source.ref) {
    throw new Error("source is invalid");
  }
}

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

  private deadlineByKey(dedupeKey: string): DeadlineItem | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("vera_deadlines").selectAll().where("dedupe_key", "=", dedupeKey),
    );
    return row ? rowToDeadline(row) : null;
  }

  private writeDeadline(item: DeadlineItem): void {
    executeSqliteQuerySync(
      this.db,
      this.query.deleteFrom("vera_deadlines").where("id", "=", item.id),
    );
    executeSqliteQuerySync(
      this.db,
      this.query.insertInto("vera_deadlines").values(deadlineToRow(item)),
    );
  }

  upsertDeadlines(candidates: DeadlineCandidate[], atMs: number): DeadlineUpsertResult {
    if (!Number.isFinite(atMs)) {
      throw new Error("atMs is invalid");
    }
    for (const candidate of candidates) {
      assertCandidate(candidate);
    }
    const result: DeadlineUpsertResult = { created: [], moved: [], updated: [] };
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        for (const candidate of candidates) {
          const key = deadlineDedupeKey(candidate.matterId, candidate.type, candidate.dueDate);
          const existing = this.deadlineByKey(key);
          if (existing && existing.status !== "superseded") {
            const merged = mergeDeadlineCandidate(existing, candidate, atMs);
            if (merged) {
              this.writeDeadline(merged);
              result.updated.push(merged);
            }
            continue;
          }
          const open = Array.from(
            iterateSqliteQuerySync(
              this.db,
              this.query
                .selectFrom("vera_deadlines")
                .selectAll()
                .where("matter_id", "=", candidate.matterId)
                .where("type", "=", candidate.type)
                .where("status", "in", OPEN_DEADLINE_STATUSES),
            ),
            rowToDeadline,
          );
          const target = findMoveTarget(open, candidate);
          if (existing) {
            // A stale notice for a retired date changes nothing, unless the source itself
            // moved back to that date.
            if (target) {
              const { retired, next } = reviveDeadlineItem(existing, target, candidate, atMs);
              this.writeDeadline(retired);
              this.writeDeadline(next);
              result.moved.push(next);
            }
            continue;
          }
          if (target) {
            const { retired, next } = moveDeadlineItem(target, candidate, atMs);
            this.writeDeadline(retired);
            this.writeDeadline(next);
            result.moved.push(next);
            continue;
          }
          const created = createDeadlineItem(candidate, atMs);
          this.writeDeadline(created);
          result.created.push(created);
        }
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.deadline.upsert",
      },
    );
    return result;
  }

  listDeadlines(matterId?: string): DeadlineItem[] {
    let builder = this.query.selectFrom("vera_deadlines").selectAll();
    if (matterId !== undefined) {
      assertId(matterId, "matterId");
      builder = builder.where("matter_id", "=", matterId);
    }
    return Array.from(
      iterateSqliteQuerySync(this.db, builder.orderBy("due_at_ms", "asc").orderBy("id", "asc")),
      rowToDeadline,
    );
  }

  getDeadline(id: string): DeadlineItem | null {
    assertId(id, "id");
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("vera_deadlines").selectAll().where("id", "=", id),
    );
    return row ? rowToDeadline(row) : null;
  }

  updateDeadline(id: string, patch: DeadlinePatch, atMs: number): DeadlineItem | null {
    assertId(id, "id");
    if (patch.status !== undefined && !DEADLINE_STATUSES.includes(patch.status)) {
      throw new Error("status is invalid");
    }
    if (
      patch.researchStatus !== undefined &&
      !DEADLINE_RESEARCH_STATUSES.includes(patch.researchStatus)
    ) {
      throw new Error("researchStatus is invalid");
    }
    if (!Number.isFinite(atMs)) {
      throw new Error("atMs is invalid");
    }
    let updated: DeadlineItem | null = null;
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const current = this.getDeadline(id);
        if (!current) {
          return;
        }
        if (current.status === "superseded") {
          // A newer date replaced this row; a late reply must not bring it back.
          updated = current;
          return;
        }
        updated = {
          ...current,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          // Reminder steps only accumulate, so a stale read cannot unsettle a delivered one.
          ...(patch.remindersSent !== undefined
            ? { remindersSent: [...new Set([...current.remindersSent, ...patch.remindersSent])] }
            : {}),
          ...(patch.researchStatus !== undefined ? { researchStatus: patch.researchStatus } : {}),
          ...(patch.brief !== undefined ? { brief: patch.brief?.slice(0, 20_000) ?? null } : {}),
          ...(patch.briefAtMs !== undefined ? { briefAtMs: patch.briefAtMs } : {}),
          ...(patch.title !== undefined ? { title: assertText(patch.title, "title", 300) } : {}),
          updatedAtMs: atMs,
        };
        this.writeDeadline(updated);
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.deadline.update",
      },
    );
    return updated;
  }

  /** One delivered digest renumbers its offers and records the reminders it carried. */
  commitDeadlineDigest(
    offers: ReadonlyArray<{ id: string; no: number }>,
    reminders: ReadonlyArray<{ id: string; steps: string[] }>,
    atMs: number,
  ): undefined {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        executeSqliteQuerySync(
          this.db,
          this.query
            .updateTable("vera_deadlines")
            .set({ offer_no: null })
            .where("offer_no", "is not", null),
        );
        for (const offer of offers) {
          const item = this.getDeadline(offer.id);
          if (!item) {
            continue;
          }
          const sent = reminders.find((entry) => entry.id === offer.id)?.steps ?? [];
          this.writeDeadline({
            ...item,
            offerNo: offer.no,
            offeredCount: item.offeredCount + 1,
            remindersSent: [...new Set([...item.remindersSent, ...sent])],
            updatedAtMs: atMs,
          });
        }
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.deadline.commit",
      },
    );
    return undefined;
  }

  filterUnscannedMessages(ids: readonly string[]): string[] {
    if (ids.length === 0) {
      return [];
    }
    const seen = new Set(
      Array.from(
        iterateSqliteQuerySync(
          this.db,
          this.query
            .selectFrom("vera_deadline_scanned")
            .select("message_id")
            .where("message_id", "in", [...ids]),
        ),
        (row) => row.message_id,
      ),
    );
    return ids.filter((id) => !seen.has(id));
  }

  markMessagesScanned(ids: readonly string[], atMs: number): undefined {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        for (const id of ids.slice(0, 200)) {
          if (!SNAPSHOT_ID.test(id)) {
            throw new Error("messageId is invalid");
          }
          executeSqliteQuerySync(
            this.db,
            this.query.deleteFrom("vera_deadline_scanned").where("message_id", "=", id),
          );
          executeSqliteQuerySync(
            this.db,
            this.query.insertInto("vera_deadline_scanned").values({
              message_id: id,
              scanned_at_ms: atMs,
            }),
          );
        }
        executeSqliteQuerySync(
          this.db,
          this.query
            .deleteFrom("vera_deadline_scanned")
            .where("scanned_at_ms", "<", atMs - DEADLINE_SCAN_RETENTION_MS),
        );
      },
      {
        busyTimeoutMs: 5000,
        databaseLabel: "vera memory",
        operationLabel: "vera.memory.deadline.scanned",
      },
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
        case "upsertDeadlines":
          return database.upsertDeadlines(command.input.candidates, command.input.atMs);
        case "listDeadlines":
          return database.listDeadlines(command.input.matterId);
        case "getDeadline":
          return database.getDeadline(command.input.id);
        case "updateDeadline":
          return database.updateDeadline(command.input.id, command.input.patch, command.input.atMs);
        case "commitDeadlineDigest":
          return database.commitDeadlineDigest(
            command.input.offers,
            command.input.reminders,
            command.input.atMs,
          );
        case "filterUnscannedMessages":
          return database.filterUnscannedMessages(command.input.ids);
        case "markMessagesScanned":
          return database.markMessagesScanned(command.input.ids, command.input.atMs);
      }
      throw new Error("Unexpected Vera memory command");
    },
    close: () => database.close(),
  };
}
