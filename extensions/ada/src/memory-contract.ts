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
  /** Last time a digest turn was accepted for delivery. */
  lastDigestAtMs: number | null;
  /** When the morning brief was last delivered to this number: the once-a-local-day guard. */
  lastMorningBriefAtMs: number | null;
  /** When Ada was last told to offer this number the Lexroom connection: the once-a-local-day guard. */
  lastConnectNudgeAtMs: number | null;
  heldPlanJson: string | null;
  /** Failed dispatch attempts for the held plan; zero while it waits on the WhatsApp window. */
  heldPlanAttempts: number;
  /** Earliest time the next dispatch retry may run; null when no retry is scheduled. */
  heldPlanNextAttemptAtMs: number | null;
  /** When the digest-ready template was claimed for the current held plan; at most one send per plan. */
  heldPlanTemplateAttemptedAtMs: number | null;
  /** When the current held plan was first held; cleared with heldPlanJson. */
  heldPlanAtMs: number | null;
  /**
   * The local day (YYYY-MM-DD in the number's zone) whose morning brief is held for a closed
   * WhatsApp window. Also the claim for that day's one nudge template, written before the send.
   */
  heldBriefDay: string | null;
  watchExpirationMs: number | null;
  /** JSON string array of open lawyer todo ids from the last collect. */
  openTodoIdsJson: string | null;
};

/** The wake state of a number that has no memory yet. */
export const EMPTY_WAKE_STATE: WakeState = {
  lastLawyerInboundAtMs: null,
  lastReconcileAtMs: null,
  lastCollectAtMs: null,
  lastDigestAtMs: null,
  lastMorningBriefAtMs: null,
  lastConnectNudgeAtMs: null,
  heldPlanJson: null,
  heldPlanAttempts: 0,
  heldPlanNextAttemptAtMs: null,
  heldPlanTemplateAttemptedAtMs: null,
  heldPlanAtMs: null,
  heldBriefDay: null,
  watchExpirationMs: null,
  openTodoIdsJson: null,
};

/**
 * A todo whose id starts with this was parked in open loops after a digest decision went
 * unanswered three times. It shows in the open loops and in "what is open", but the collector
 * never turns it into a digest signal again.
 */
export const PARKED_TODO_PREFIX = "parked-";

export const DEADLINE_TYPES = ["deadline", "hearing"] as const;
export type DeadlineType = (typeof DEADLINE_TYPES)[number];

/** candidate: found, not yet confirmed. tracked: the lawyer confirmed it, so reminders run. */
export const DEADLINE_STATUSES = [
  "candidate",
  "tracked",
  "dismissed",
  "done",
  "superseded",
] as const;
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];

export const DEADLINE_SOURCE_KINDS = ["email", "pdf", "calendar"] as const;
export type DeadlineSourceKind = (typeof DEADLINE_SOURCE_KINDS)[number];

export const DEADLINE_RESEARCH_STATUSES = ["none", "done", "failed"] as const;
export type DeadlineResearchStatus = (typeof DEADLINE_RESEARCH_STATUSES)[number];

export type DeadlineSource = {
  kind: DeadlineSourceKind;
  /** Gmail message id, "messageId#filename" for a PDF, or Calendar event id. */
  ref: string;
  label: string;
  excerpt: string;
};

export type DeadlineItem = {
  id: string;
  /** matterId|type|dueDate. Equal keys are the same obligation seen from another source. */
  dedupeKey: string;
  matterId: string;
  type: DeadlineType;
  title: string;
  dueAtMs: number;
  /** YYYY-MM-DD in timeZone. */
  dueDate: string;
  /** HH:MM in timeZone, null when the source names no time. */
  dueTime: string | null;
  timeZone: string;
  confidence: number;
  sources: DeadlineSource[];
  status: DeadlineStatus;
  /** Number shown in the last delivered digest ("reply 1 ..."). */
  offerNo: number | null;
  offeredCount: number;
  /** Reminder cadence steps already sent or skipped, such as "7d". */
  remindersSent: string[];
  researchStatus: DeadlineResearchStatus;
  brief: string | null;
  briefAtMs: number | null;
  movedFromMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DeadlineCandidate = {
  matterId: string;
  type: DeadlineType;
  title: string;
  dueAtMs: number;
  dueDate: string;
  dueTime: string | null;
  timeZone: string;
  confidence: number;
  source: DeadlineSource;
  /** The source says an earlier item moved: by source ref (calendar) or by old date (email). */
  movesFrom?: { sourceRef?: string; dueDate?: string };
  /** The source announces a postponement without naming the old date. */
  rescheduled?: boolean;
};

export type DeadlinePatch = Partial<
  Pick<
    DeadlineItem,
    "status" | "remindersSent" | "researchStatus" | "brief" | "briefAtMs" | "title"
  >
>;

export type DeadlineUpsertResult = {
  created: DeadlineItem[];
  /** New date for an item that moved, carrying over the lawyer's choice. */
  moved: DeadlineItem[];
  updated: DeadlineItem[];
};

/** What one person told Ada about how to work with them; the key names the topic, so a new text replaces the old. */
export type Preference = { key: string; text: string; updatedAtMs: number };

export const PREFERENCE_LIMITS = { maxCount: 30, maxKeyChars: 40, maxTextChars: 300 } as const;

/**
 * The one preference code reads as a setting: while it is saved, the morning pass skips the short
 * brief on quiet days. Urgent digests and the person's time zone are not affected.
 */
export const QUIET_BRIEF_OFF_KEY = "quiet_brief_off";

/**
 * Preferences that code reads when it writes a text on its own (the morning brief and digest),
 * which the model's standing-preference note cannot reach. The person sets them in their own
 * words and the model saves them under these keys with ada_set_preference.
 */
export const SHORT_TEXTS_KEY = "short_texts";
export const BRIEF_SKIP_AGENDA_KEY = "brief_skip_agenda";
export const BRIEF_SKIP_MAIL_KEY = "brief_skip_mail";

/**
 * The person asked for a recap before their hearings and meetings. The recap is sent only inside
 * the WhatsApp window; with it closed the recap is held for their next message, never announced
 * with a template.
 */
export const PREP_ON_KEY = "meeting_prep_on";

/** What Ada learned about how the person works, saved only after they said yes to it. */
export const WORK_PROFILE_KEY = "work_profile";

/**
 * Saved (through ada_set_preference) when a person declines the offer to connect Lexroom. Code
 * reads its time as a cooldown, not as a standing instruction, so the brief does not show it.
 */
export const LEXROOM_OFFER_DECLINED_KEY = "lexroom_offer_declined";

export const CONNECT_FEATURES = ["google", "lexroom", "granola"] as const;
export type ConnectFeature = (typeof CONNECT_FEATURES)[number];

/** Set by code once the unfinished-connection line was shown for `feature`: at most once each. */
export const connectRemindedKey = (feature: ConnectFeature) => `connect_reminded_${feature}`;

/** Set (through ada_set_preference) when a person declines connecting `feature`. */
export const connectDeclinedKey = (feature: ConnectFeature) =>
  feature === "lexroom" ? LEXROOM_OFFER_DECLINED_KEY : `connect_declined_${feature}`;

/** Preferences code reads as state; they are not standing instructions, so the brief omits them. */
export const isConnectStateKey = (key: string) =>
  key === LEXROOM_OFFER_DECLINED_KEY ||
  key.startsWith("connect_reminded_") ||
  key.startsWith("connect_declined_");

/**
 * The preference that opts a number out of product news: while it is saved, no announcement is
 * delivered to that number. Delivery reads it as a setting; the person sets it in their own words.
 */
export const ANNOUNCEMENTS_OFF_KEY = "announcements_off";

export const FEEDBACK_CATEGORIES = [
  "bug",
  "missing_feature",
  "wrong_answer",
  "complaint",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = ["new", "triaged"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_MAX_TEXT_CHARS = 1000;

/** A product problem a person reported, kept for the team in the registry file only. */
export type FeedbackEntry = {
  id: number;
  /** The reporting WhatsApp number's digits. Never leaves the volume unmasked. */
  number: string;
  atMs: number;
  category: FeedbackCategory;
  text: string;
  language: string;
  status: FeedbackStatus;
};

export type NewFeedback = Omit<FeedbackEntry, "id" | "status">;

/** A product update the team wants every known number to hear about once, kept in the registry file. */
export type Announcement = {
  id: string;
  /** The message by language code; every announcement has at least `it` and `en`. */
  texts: Record<string, string>;
  /** The feature it is about, so a number that already has it connected is not told to connect it. */
  feature: string | null;
  createdAtMs: number;
};

/** `sent` went to the number; `skipped` never will (the number opted out or already has the feature). */
export type AnnouncementDelivery = {
  announcementId: string;
  number: string;
  status: "sent" | "skipped";
  reason: string | null;
  atMs: number;
};

export type SetPreferenceResult = { ok: true; replaced: boolean } | { ok: false; reason: "limit" };

/**
 * One piece of a number's proactive state: a watched thread, a reminder, a held notice, or a
 * once-a-day log line. `kind` and `id` are the key; `data` is JSON that `proactive-store.ts` reads
 * back with a check, so a row written by an older build cannot crash a newer one.
 */
export type ProactiveRow = {
  kind: string;
  id: string;
  /** When the row is due (a reminder's time, an event's start); null when it has none. */
  dueAtMs: number | null;
  status: string;
  data: string;
  updatedAtMs: number;
};

export type EmbeddingCandidate = { id: string; text: string };
export type EmbeddingItem = EmbeddingCandidate & { vector: number[] };

type Operation<Input, Output> = { input: Input; output: Output };

export type AdaMemoryOperations = {
  upsertProfile: Operation<LawyerProfile, undefined>;
  readProfile: Operation<undefined, LawyerProfile | null>;
  /**
   * Saves only the zone; a number with no profile yet gets one whose other fields are blank,
   * except the language when one is known.
   */
  setProfileTimezone: Operation<{ timezone: string; atMs: number; language?: string }, undefined>;
  listPreferences: Operation<undefined, Preference[]>;
  /** Saves or replaces the preference under `key`; a new key past the cap is refused. */
  setPreference: Operation<{ key: string; text: string; atMs: number }, SetPreferenceResult>;
  /** True when the key existed. */
  removePreference: Operation<{ key: string }, boolean>;
  /** Saves or replaces the row under `kind` and `id`. */
  putProactive: Operation<{ row: ProactiveRow }, undefined>;
  /** Every row of one kind, soonest due first. */
  listProactive: Operation<{ kind: string }, ProactiveRow[]>;
  /** True when the row existed. */
  removeProactive: Operation<{ kind: string; id: string }, boolean>;
  addFeedback: Operation<NewFeedback, number>;
  /** Entries at or after `sinceMs`, oldest first. */
  listFeedback: Operation<{ sinceMs: number }, FeedbackEntry[]>;
  setFeedbackStatus: Operation<{ id: number; status: FeedbackStatus }, FeedbackEntry | null>;
  /** False when an announcement with this id already exists; it is never overwritten. */
  saveAnnouncement: Operation<Announcement, boolean>;
  /** Oldest first. */
  listAnnouncements: Operation<undefined, Announcement[]>;
  /** True when the number had no delivery row for the announcement and now has one; the dedupe. */
  claimAnnouncementDelivery: Operation<AnnouncementDelivery, boolean>;
  /** Frees a claim whose send failed, so the number is tried again. */
  releaseAnnouncementDelivery: Operation<{ announcementId: string; number: string }, undefined>;
  listAnnouncementDeliveries: Operation<undefined, AnnouncementDelivery[]>;
  upsertRecord: Operation<
    { record: MemoryRecord; reason: RevisionReason; atMs: number },
    undefined
  >;
  /** With a query vector the keyword match is blended with similarity to vectors of `model`. */
  searchRecords: Operation<
    { query: string; matterId: string; queryVector?: number[]; model?: string },
    MemoryRecord[]
  >;
  /** Current notes with no vector of `model` yet, newest first. */
  listUnembedded: Operation<{ model: string; limit: number }, EmbeddingCandidate[]>;
  /** Stores vectors for notes whose text still equals what was embedded; returns how many. */
  storeEmbeddings: Operation<{ model: string; items: EmbeddingItem[] }, number>;
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
  listMatterAliases: Operation<
    undefined,
    Array<{ matterId: string; alias: string; title: string }>
  >;
  upsertDeadlines: Operation<
    { candidates: DeadlineCandidate[]; atMs: number },
    DeadlineUpsertResult
  >;
  listDeadlines: Operation<{ matterId?: string }, DeadlineItem[]>;
  getDeadline: Operation<{ id: string }, DeadlineItem | null>;
  updateDeadline: Operation<
    { id: string; patch: DeadlinePatch; atMs: number },
    DeadlineItem | null
  >;
  commitDeadlineDigest: Operation<
    {
      offers: Array<{ id: string; no: number }>;
      reminders: Array<{ id: string; steps: string[] }>;
      atMs: number;
    },
    undefined
  >;
  filterUnscannedMessages: Operation<{ ids: string[] }, string[]>;
  markMessagesScanned: Operation<{ ids: string[]; atMs: number }, undefined>;
  /** True when `number` had no welcome marker and now has one; false when it was already marked. */
  claimWelcome: Operation<{ number: string; atMs: number }, boolean>;
  releaseWelcome: Operation<{ number: string }, undefined>;
  /** Writes a consistent copy of this database to `path` with the welcome markers left out. */
  exportSnapshot: Operation<{ path: string }, undefined>;
};
