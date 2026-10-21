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

/**
 * How a signal reads to the person, kept as data so the digest renders it in their language.
 * `summary` stays an English line for the model and for plans stored before this field existed.
 */
export type DigestPhrase =
  | { id: "calendar_moved" | "calendar_due"; text: string }
  | { id: "new_email" }
  | {
      id: "tracked_deadline";
      type: "deadline" | "hearing";
      /** Local date and time as the deadline lines show it, for example "2026-11-12 09:30". */
      due: string;
      title: string;
      /** Found but not yet confirmed by the person. */
      confirm?: boolean;
      moved?: boolean;
    };

export type DigestSignal = {
  matterId: string;
  matterLabel: string;
  kind: DigestSignalKind;
  summary: string;
  phrase?: DigestPhrase;
  /** ISO-8601 time the lawyer would miss by waiting. */
  dueAt?: string;
  /** The calendar item moved earlier than it was. */
  movedCloser?: boolean;
  /** An email or open question is blocked on the lawyer. */
  needsDecision?: boolean;
  /**
   * A deadline or hearing the lawyer confirmed needs a word: a reminder step the lawyer
   * asked for came due, or the date moved.
   */
  tracked?: "reminder" | "moved";
};

export type RankedDigestItem = {
  matterId: string;
  matterLabel: string;
  kind: DigestSignalKind;
  summary: string;
  phrase?: DigestPhrase;
  cost: number;
  dueAt?: string;
};

export type DigestNextStep = {
  action: "research" | "draft_if_confirmed";
  matterId: string;
  matterLabel: string;
  instruction: string;
};

/** A deadline or hearing from matter memory that the digest lists with a reply action. */
export type DigestDeadlineInput = {
  id: string;
  matterId: string;
  matterLabel: string;
  type: "deadline" | "hearing";
  title: string;
  /** ISO-8601 instant. */
  dueAt: string;
  /** Local date and time in the lawyer's zone, for example "2026-11-12 09:30". Time is omitted when unknown. */
  due: string;
  daysLeft: number;
  /** candidate: found but not confirmed. tracked: the lawyer confirmed it. */
  status: "candidate" | "tracked";
  confidence: number;
  source: string;
  moved?: boolean;
  briefReady: boolean;
  /** Set when a reminder step is due; `covers` lists steps this message settles. */
  reminder?: { step: string; covers: string[] };
};

export type DigestDeadlineLine = DigestDeadlineInput & {
  /** The number the lawyer replies with. */
  no: number;
};

export type DigestPlan =
  | { deliver: false; reason: "nothing_cleared_the_bar" }
  | {
      deliver: true;
      items: RankedDigestItem[];
      nextSteps: [DigestNextStep, DigestNextStep];
      deadlines?: DigestDeadlineLine[];
    };

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
  if (signal.tracked !== undefined) {
    return 60;
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
  const target =
    items.find(
      (item) =>
        item.kind === "deadline" ||
        item.kind === "calendar_move" ||
        item.kind === "decision_waiting",
    ) ?? items[0];
  if (!target) {
    throw new Error("research target requires a ranked item");
  }
  return target;
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

export function numberDeadlineLines(
  deadlines: readonly DigestDeadlineInput[],
): DigestDeadlineLine[] {
  return deadlines.map((deadline, index) => {
    const no = index + 1;
    return {
      ...deadline,
      no,
    };
  });
}

export function planDigest(
  signals: readonly DigestSignal[],
  now: Date = new Date(),
  deadlines: readonly DigestDeadlineInput[] = [],
): DigestPlan {
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
      ...(signal.phrase ? { phrase: signal.phrase } : {}),
      cost,
      ...(signal.dueAt ? { dueAt: signal.dueAt } : {}),
    };
    const current = best.get(signal.matterId);
    if (!current || prefer(candidate, current)) {
      best.set(signal.matterId, candidate);
    }
  }

  return buildPlan([...best.values()], deadlines);
}

function buildPlan(
  items: RankedDigestItem[],
  deadlines: readonly DigestDeadlineInput[] = [],
): DigestPlan {
  const sorted = items.toSorted(compareItems);
  if (sorted.length === 0) {
    return { deliver: false, reason: "nothing_cleared_the_bar" };
  }
  const research = researchTarget(sorted);
  const draft = draftTarget(sorted, research);
  return {
    deliver: true,
    items: sorted,
    nextSteps: [step("research", research), step("draft_if_confirmed", draft)],
    ...(deadlines.length > 0 ? { deadlines: numberDeadlineLines(deadlines) } : {}),
  };
}

/**
 * Combine a plan held from an earlier pass with a fresh one. One item per matter;
 * the fresh item wins unless the held one costs strictly more. Held items whose
 * deadline passed more than 12 hours ago are dropped so a stale hearing never fires.
 * The result carries no deadline lines: the caller numbers the current ones.
 */
export function mergeDigestPlans(held: DigestPlan, fresh: DigestPlan, now: Date): DigestPlan {
  const best = new Map<string, RankedDigestItem>();
  if (held.deliver) {
    for (const item of held.items) {
      const hours = hoursUntil(item.dueAt, now);
      if (hours !== undefined && hours < -RECENTLY_PASSED_HOURS) {
        continue;
      }
      best.set(item.matterId, item);
    }
  }
  if (fresh.deliver) {
    for (const item of fresh.items) {
      const current = best.get(item.matterId);
      if (!current || item.cost >= current.cost) {
        best.set(item.matterId, item);
      }
    }
  }
  return buildPlan([...best.values()]);
}

/** Read a plan persisted as JSON; anything that is not a deliverable plan reads as null. */
export function parseDigestPlan(json: string | null): DigestPlan | null {
  if (!json) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const plan = value as { deliver?: unknown; items?: unknown; nextSteps?: unknown };
  if (
    plan.deliver !== true ||
    !Array.isArray(plan.items) ||
    plan.items.length === 0 ||
    !Array.isArray(plan.nextSteps) ||
    plan.nextSteps.length !== 2
  ) {
    return null;
  }
  return value as DigestPlan;
}
