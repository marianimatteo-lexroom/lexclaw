/** Signals below this cost do not earn a WhatsApp message. */
export const DIGEST_COST_BAR = 40;

const HOUR_MS = 60 * 60 * 1000;
const SAME_DAY_HOURS = 24;
const NEAR_HOURS = 48;
const RECENTLY_PASSED_HOURS = 12;

export const DIGEST_SIGNAL_KINDS = [
  "deadline",
  "calendar_move",
  "overnight_email",
  "decision_waiting",
] as const;

export type DigestSignalKind = (typeof DIGEST_SIGNAL_KINDS)[number];

export type DigestSignal = {
  matterId: string;
  matterLabel: string;
  kind: DigestSignalKind;
  summary: string;
  /** ISO-8601 time the lawyer would miss by waiting. */
  dueAt?: string;
  /** The calendar item moved earlier than it was. */
  movedCloser?: boolean;
  /** An email or open question is blocked on the lawyer. */
  needsDecision?: boolean;
};

export type RankedDigestItem = {
  matterId: string;
  matterLabel: string;
  kind: DigestSignalKind;
  summary: string;
  cost: number;
  dueAt?: string;
};

export type DigestNextStep = {
  action: "research" | "draft_if_confirmed";
  matterId: string;
  matterLabel: string;
  instruction: string;
};

export type DigestPlan =
  | { deliver: false; reason: "nothing_cleared_the_bar" }
  | { deliver: true; items: RankedDigestItem[]; nextSteps: [DigestNextStep, DigestNextStep] };

const KIND_RANK: Record<DigestSignalKind, number> = {
  deadline: 4,
  calendar_move: 3,
  overnight_email: 2,
  decision_waiting: 1,
};

function requiredText(value: string, field: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function dueMs(dueAt: string | undefined): number | undefined {
  if (dueAt === undefined || dueAt.trim() === "") {
    return undefined;
  }
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(`dueAt must be an ISO-8601 timestamp: ${dueAt}`);
  }
  return parsed;
}

function hoursUntil(dueAt: string | undefined, now: Date): number | undefined {
  const due = dueMs(dueAt);
  if (due === undefined) {
    return undefined;
  }
  return (due - now.getTime()) / HOUR_MS;
}

function withinWindow(hours: number | undefined, limit: number): boolean {
  return hours !== undefined && hours <= limit && hours >= -RECENTLY_PASSED_HOURS;
}

/**
 * A hearing that moved earlier clears the bar even when the new date is
 * outside the 48-hour window. Same-day and 48-hour deadlines still outrank it.
 */
export function waitingCost(signal: DigestSignal, now: Date): number {
  const hours = hoursUntil(signal.dueAt, now);
  if (signal.kind === "deadline" || signal.kind === "calendar_move") {
    if (withinWindow(hours, SAME_DAY_HOURS)) {
      return 100;
    }
    if (withinWindow(hours, NEAR_HOURS)) {
      return 80;
    }
  }
  if (signal.kind === "calendar_move" && signal.movedCloser === true) {
    return 70;
  }
  if (signal.kind === "overnight_email" && signal.needsDecision === true) {
    return 60;
  }
  if (signal.kind === "decision_waiting" && signal.needsDecision === true) {
    return 50;
  }
  return 0;
}

function normalizeSignal(signal: DigestSignal): DigestSignal {
  if (!DIGEST_SIGNAL_KINDS.includes(signal.kind)) {
    throw new Error(`kind must be one of ${DIGEST_SIGNAL_KINDS.join(", ")}`);
  }
  return {
    ...signal,
    matterId: requiredText(signal.matterId, "matterId"),
    matterLabel: requiredText(signal.matterLabel, "matterLabel"),
    summary: requiredText(signal.summary, "summary"),
    dueAt: signal.dueAt?.trim() || undefined,
  };
}

function prefer(candidate: RankedDigestItem, current: RankedDigestItem): boolean {
  if (candidate.cost !== current.cost) {
    return candidate.cost > current.cost;
  }
  return KIND_RANK[candidate.kind] > KIND_RANK[current.kind];
}

function compareItems(a: RankedDigestItem, b: RankedDigestItem): number {
  if (a.cost !== b.cost) {
    return b.cost - a.cost;
  }
  const aDue = a.dueAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.dueAt);
  const bDue = b.dueAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.dueAt);
  if (aDue !== bDue) {
    return aDue - bDue;
  }
  return a.matterId.localeCompare(b.matterId);
}

function researchTarget(items: RankedDigestItem[]): RankedDigestItem {
  return (
    items.find(
      (item) =>
        item.kind === "deadline" ||
        item.kind === "calendar_move" ||
        item.kind === "decision_waiting",
    ) ?? items[0]
  );
}

function draftTarget(items: RankedDigestItem[], research: RankedDigestItem): RankedDigestItem {
  return (
    items.find((item) => item.kind === "overnight_email" && item.matterId !== research.matterId) ??
    items.find((item) => item.matterId !== research.matterId) ??
    research
  );
}

function step(action: DigestNextStep["action"], item: RankedDigestItem): DigestNextStep {
  const verb =
    action === "research" ? "Research only" : "After the lawyer confirms, draft only for";
  return {
    action,
    matterId: item.matterId,
    matterLabel: item.matterLabel,
    instruction: `${verb} the ${item.matterLabel} matter: ${item.summary}`,
  };
}

export function planDigest(signals: readonly DigestSignal[], now: Date = new Date()): DigestPlan {
  const best = new Map<string, RankedDigestItem>();
  for (const raw of signals) {
    const signal = normalizeSignal(raw);
    const cost = waitingCost(signal, now);
    if (cost < DIGEST_COST_BAR) {
      continue;
    }
    const candidate: RankedDigestItem = {
      matterId: signal.matterId,
      matterLabel: signal.matterLabel,
      kind: signal.kind,
      summary: signal.summary,
      cost,
      ...(signal.dueAt ? { dueAt: signal.dueAt } : {}),
    };
    const current = best.get(signal.matterId);
    if (!current || prefer(candidate, current)) {
      best.set(signal.matterId, candidate);
    }
  }

  const items = [...best.values()].toSorted(compareItems);
  const top = items[0];
  if (!top) {
    return { deliver: false, reason: "nothing_cleared_the_bar" };
  }
  const research = researchTarget(items);
  const draft = draftTarget(items, research);
  return {
    deliver: true,
    items,
    nextSteps: [step("research", research), step("draft_if_confirmed", draft)],
  };
}
