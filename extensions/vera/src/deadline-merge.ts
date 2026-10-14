import { createHash } from "node:crypto";
import type {
  DeadlineCandidate,
  DeadlineItem,
  DeadlineSource,
  DeadlineType,
} from "./memory-contract.js";

const MAX_SOURCES = 6;

export function deadlineDedupeKey(matterId: string, type: DeadlineType, dueDate: string): string {
  return `${matterId}|${type}|${dueDate}`;
}

export function deadlineIdFor(dedupeKey: string): string {
  return `dl-${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 10)}`;
}

export function mergeSources(
  current: readonly DeadlineSource[],
  incoming: readonly DeadlineSource[],
): DeadlineSource[] {
  const merged = [...current];
  for (const source of incoming) {
    if (!merged.some((entry) => entry.kind === source.kind && entry.ref === source.ref)) {
      merged.push(source);
    }
  }
  return merged.slice(0, MAX_SOURCES);
}

export function createDeadlineItem(candidate: DeadlineCandidate, atMs: number): DeadlineItem {
  const dedupeKey = deadlineDedupeKey(candidate.matterId, candidate.type, candidate.dueDate);
  return {
    id: deadlineIdFor(dedupeKey),
    dedupeKey,
    matterId: candidate.matterId,
    type: candidate.type,
    title: candidate.title,
    dueAtMs: candidate.dueAtMs,
    dueDate: candidate.dueDate,
    dueTime: candidate.dueTime,
    timeZone: candidate.timeZone,
    confidence: candidate.confidence,
    sources: [candidate.source],
    status: "candidate",
    offerNo: null,
    offeredCount: 0,
    remindersSent: [],
    researchStatus: "none",
    brief: null,
    briefAtMs: null,
    movedFromMs: null,
    createdAtMs: atMs,
    updatedAtMs: atMs,
  };
}

/**
 * Same obligation seen again, usually from another source. The lawyer's status and any
 * brief stay; the evidence and confidence grow.
 */
export function mergeDeadlineCandidate(
  item: DeadlineItem,
  candidate: DeadlineCandidate,
  atMs: number,
): DeadlineItem | null {
  const sources = mergeSources(item.sources, [candidate.source]);
  const confidence = Math.max(item.confidence, candidate.confidence);
  const learnsTime = item.dueTime === null && candidate.dueTime !== null;
  // The calendar event this item already follows moved within the same day.
  const retimed =
    candidate.source.kind === "calendar" &&
    item.sources.some(
      (source) => source.kind === "calendar" && source.ref === candidate.source.ref,
    ) &&
    candidate.dueTime !== null &&
    candidate.dueAtMs !== item.dueAtMs;
  if (
    sources.length === item.sources.length &&
    confidence === item.confidence &&
    !learnsTime &&
    !retimed
  ) {
    return null;
  }
  return {
    ...item,
    sources,
    confidence,
    ...(learnsTime || retimed ? { dueTime: candidate.dueTime, dueAtMs: candidate.dueAtMs } : {}),
    updatedAtMs: atMs,
  };
}

/** The open item a candidate replaces, when the source says the obligation moved. */
export function findMoveTarget(
  openItems: readonly DeadlineItem[],
  candidate: DeadlineCandidate,
): DeadlineItem | null {
  const sameKind = openItems.filter(
    (item) =>
      item.matterId === candidate.matterId &&
      item.type === candidate.type &&
      item.dueDate !== candidate.dueDate,
  );
  const sourceRef = candidate.movesFrom?.sourceRef;
  if (sourceRef) {
    const bySource = sameKind.find((item) =>
      item.sources.some((source) => source.ref === sourceRef),
    );
    if (bySource) {
      return bySource;
    }
  }
  const oldDate = candidate.movesFrom?.dueDate;
  if (oldDate) {
    const byDate = sameKind.find((item) => item.dueDate === oldDate);
    if (byDate) {
      return byDate;
    }
  }
  if (candidate.rescheduled && sameKind.length === 1) {
    return sameKind[0] ?? null;
  }
  return null;
}

/** New date for a moved item. The old row is retired so a stale notice cannot revive it. */
export function moveDeadlineItem(
  previous: DeadlineItem,
  candidate: DeadlineCandidate,
  atMs: number,
): { retired: DeadlineItem; next: DeadlineItem } {
  const fresh = createDeadlineItem(candidate, atMs);
  return {
    retired: { ...previous, status: "superseded", offerNo: null, updatedAtMs: atMs },
    next: {
      ...fresh,
      title: candidate.title,
      confidence: Math.max(candidate.confidence, previous.confidence),
      sources: mergeSources([candidate.source], previous.sources),
      status: previous.status,
      movedFromMs: previous.dueAtMs,
    },
  };
}

/**
 * The obligation moved back to a date it already had. That date's retired row comes back
 * to life, carrying the lawyer's choice from the row it replaces.
 */
export function reviveDeadlineItem(
  retiredAtThatDate: DeadlineItem,
  current: DeadlineItem,
  candidate: DeadlineCandidate,
  atMs: number,
): { retired: DeadlineItem; next: DeadlineItem } {
  return {
    retired: { ...current, status: "superseded", offerNo: null, updatedAtMs: atMs },
    next: {
      ...retiredAtThatDate,
      confidence: Math.max(candidate.confidence, retiredAtThatDate.confidence),
      sources: mergeSources(retiredAtThatDate.sources, [candidate.source]),
      status: current.status,
      offerNo: null,
      offeredCount: 0,
      remindersSent: [],
      movedFromMs: current.dueAtMs,
      updatedAtMs: atMs,
    },
  };
}
