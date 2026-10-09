import type { MemoryRecord, MemoryTodo, RevisionReason } from "./memory-contract.js";

export type ReconcileEdit =
  | {
      kind: "upsert_record";
      record: MemoryRecord;
      reason: Exclude<RevisionReason, "create"> | "create";
    }
  | {
      kind: "supersede";
      id: string;
      matterId: string;
      replacementBody: string;
      atMs: number;
    }
  | {
      kind: "upsert_todo";
      todo: MemoryTodo;
    };

/**
 * Apply structured reconcile edits. The answering agent never calls this;
 * only the daily service does, after an isolated turn or a coded edit list.
 */
export async function applyReconcileEdits(params: {
  edits: readonly ReconcileEdit[];
  atMs: number;
  getRecord: (id: string, matterId: string) => Promise<MemoryRecord | null>;
  upsertRecord: (
    record: MemoryRecord,
    reason: RevisionReason,
    atMs: number,
  ) => Promise<void>;
  upsertTodo: (todo: MemoryTodo) => Promise<void>;
}): Promise<{ applied: number }> {
  let applied = 0;
  for (const edit of params.edits) {
    if (edit.kind === "upsert_todo") {
      await params.upsertTodo(edit.todo);
      applied += 1;
      continue;
    }
    if (edit.kind === "upsert_record") {
      await params.upsertRecord(edit.record, edit.reason, params.atMs);
      applied += 1;
      continue;
    }
    const current = await params.getRecord(edit.id, edit.matterId);
    if (!current) {
      continue;
    }
    await params.upsertRecord(
      {
        ...current,
        body: edit.replacementBody,
        validFromMs: edit.atMs,
      },
      "correction",
      edit.atMs,
    );
    applied += 1;
  }
  return { applied };
}

export function buildDailyTimelineRecord(params: {
  matterId: string;
  day: string;
  body: string;
  atMs: number;
}): MemoryRecord {
  return {
    id: `${params.matterId}-daily-${params.day}`,
    matterId: params.matterId,
    folder: "timeline/daily",
    type: "timeline",
    title: `Daily ${params.day}`,
    aliases: [params.day, "today", "yesterday", params.matterId],
    body: params.body,
    validFromMs: params.atMs,
    validToMs: null,
    supersededBy: null,
  };
}

export function buildOnePagerRecord(params: {
  matterId: string;
  matterLabel: string;
  body: string;
  atMs: number;
}): MemoryRecord {
  return {
    id: `${params.matterId}-one-pager`,
    matterId: params.matterId,
    folder: "workstreams/active",
    type: "workstream",
    title: `${params.matterLabel} one-pager`,
    aliases: [params.matterLabel, params.matterId, "one-pager", "brief"],
    body: params.body,
    validFromMs: params.atMs,
    validToMs: null,
    supersededBy: null,
  };
}
