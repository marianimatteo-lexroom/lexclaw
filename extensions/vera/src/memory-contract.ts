/** Folders mirror Instinct's wiki layout. */
export const MEMORY_FOLDERS = [
  "entities/people",
  "entities/orgs",
  "knowledge/facts",
  "knowledge/preferences",
  "knowledge/decisions",
  "comms/phone",
  "timeline/daily",
  "timeline/weekly",
  "workstreams/active",
  "workstreams/completed",
] as const;

export type MemoryFolder = (typeof MEMORY_FOLDERS)[number];

export const MEMORY_RECORD_TYPES = [
  "preference",
  "person",
  "organization",
  "conversation",
  "fact",
  "decision",
  "workstream",
  "timeline",
] as const;

export type MemoryRecordType = (typeof MEMORY_RECORD_TYPES)[number];

export const REVISION_REASONS = [
  "correction",
  "compress",
  "move",
  "forget",
  "generalize",
  "create",
] as const;

export type RevisionReason = (typeof REVISION_REASONS)[number];

export const TODO_OWNERS = ["lawyer", "counterparty"] as const;
export type TodoOwner = (typeof TODO_OWNERS)[number];

export const TODO_STATUSES = ["pending", "in_progress", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** Empty matterId is lawyer-global (preferences only). */
export type MemoryRecord = {
  id: string;
  matterId: string;
  folder: MemoryFolder;
  type: MemoryRecordType;
  title: string;
  aliases: string[];
  body: string;
  validFromMs: number;
  validToMs: number | null;
  supersededBy: string | null;
};

export type MemoryRevision = {
  recordId: string;
  matterId: string;
  previousBody: string;
  reason: RevisionReason;
  atMs: number;
};

export type MemoryTodo = {
  id: string;
  matterId: string;
  owner: TodoOwner;
  title: string;
  status: TodoStatus;
  detail: string;
  updatedAtMs: number;
};

export type LawyerProfile = {
  name: string;
  timezone: string;
  email: string | null;
  language: string;
  jurisdiction: string;
  autonomy: string;
  channelStyle: string;
  generatedAtMs: number;
};

export type GmailSnapshotRow = {
  messageId: string;
  internalDateMs: number;
  from: string;
  subject: string;
  seenAtMs: number;
};

export type CalendarSnapshotRow = {
  eventId: string;
  summary: string;
  startMs: number;
  endMs: number | null;
  matterId: string | null;
  seenAtMs: number;
};

export type WakeState = {
  lastLawyerInboundAtMs: number | null;
  lastReconcileAtMs: number | null;
  lastCollectAtMs: number | null;
  heldPlanJson: string | null;
  watchExpirationMs: number | null;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type VeraMemoryOperations = {
  upsertProfile: Operation<LawyerProfile, undefined>;
  readProfile: Operation<undefined, LawyerProfile | null>;
  upsertRecord: Operation<
    { record: MemoryRecord; reason: RevisionReason; atMs: number },
    undefined
  >;
  searchRecords: Operation<{ query: string; matterId: string }, MemoryRecord[]>;
  listRecords: Operation<{ folder: MemoryFolder; matterId: string }, MemoryRecord[]>;
  getRecord: Operation<{ id: string; matterId: string }, MemoryRecord | null>;
  history: Operation<{ id: string; matterId: string }, MemoryRevision[]>;
  upsertTodo: Operation<MemoryTodo, undefined>;
  listTodos: Operation<{ matterId?: string }, MemoryTodo[]>;
  getTodo: Operation<{ id: string }, MemoryTodo | null>;
  replaceGmailSnapshot: Operation<{ rows: GmailSnapshotRow[] }, undefined>;
  readGmailSnapshot: Operation<undefined, GmailSnapshotRow[]>;
  replaceCalendarSnapshot: Operation<{ rows: CalendarSnapshotRow[] }, undefined>;
  readCalendarSnapshot: Operation<undefined, CalendarSnapshotRow[]>;
  readWake: Operation<undefined, WakeState>;
  writeWake: Operation<Partial<WakeState>, undefined>;
  listMatterAliases: Operation<undefined, Array<{ matterId: string; alias: string; title: string }>>;
};
