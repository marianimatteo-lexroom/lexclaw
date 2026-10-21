import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runCollectExclusive } from "./collect-lock.js";
import {
  collectDigest,
  isMorningDigestSlot,
  whatsappWindowOpen,
  type CollectResult,
} from "./collector.js";
import { prepareDeadlineIntake } from "./deadline-intake.js";
import { localParts } from "./deadline-time.js";
import {
  mergeDigestPlans,
  numberDeadlineLines,
  parseDigestPlan,
  type DigestDeadlineInput,
  type DigestPlan,
} from "./digest.js";
import {
  dispatchDigest,
  type DigestDispatchRequest,
  type DigestDispatchResult,
} from "./dispatch-digest.js";
import { openAdaGoogleAccountDbFromApi, openAdaGoogleAccountFromApi } from "./google-account.js";
import {
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
  watchGmailInbox,
} from "./google-api.js";
import { googleConnectConfigFrom, readGoogleConnectConfig } from "./google-connect.js";
import { saveRefreshedAccount } from "./google-tools.js";
import { releaseHeldGranolaReminder, runGranolaKeepAlive } from "./granola-reminder.js";
import { holdReconnectNote, takeHeldReconnectNote } from "./held-reconnect.js";
import { maskNumber, logInboundSkip } from "./inbound-log.js";
import { abortResearchJobs } from "./lexroom-jobs.js";
import { QUIET_BRIEF_OFF_KEY } from "./memory-contract.js";
import { openAdaMemoryFromApi, openAdaMemoryIfExistsFromApi, type MemoryStore } from "./memory.js";
import { createMorningSchedule, createServiceTimers } from "./morning-schedule.js";
import { openAdaOutlookAccountDbFromApi } from "./outlook-account.js";
import { outlookEnabled } from "./outlook-oauth.js";
import { isOutlookSnapshotId, loadOutlookReads, type OutlookReads } from "./outlook-reads.js";
import {
  releaseHeldOutlookReminder,
  remindOutlookReconnect,
  runOutlookKeepAlive,
} from "./outlook-reminder.js";
import { lawyerOwner, toOwner } from "./owner.js";
import { buildQuietBrief } from "./quiet-brief.js";
import { buildDailyTimelineRecord, buildOnePagerRecord } from "./reconcile.js";
import { DEFAULT_TIME_ZONE, effectiveTimeZone } from "./schedule.js";
import {
  readBriefReadyTemplate,
  readDigestReadyTemplate,
  sendDigestReadyNotice,
  warnDigestReadyTemplateUnset,
  type KapsoTemplate,
} from "./whatsapp-template.js";

function readPubSubTopic(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const topic = (config as { googlePubSubTopic?: unknown }).googlePubSubTopic;
  return typeof topic === "string" && topic.trim().startsWith("projects/") ? topic.trim() : null;
}

const POLL_MS = 15 * 60 * 1000;
/** A catch-up after boot sends the quiet brief only while the number's local time is before this hour. */
const CATCH_UP_BRIEF_CUTOFF_HOUR = 11;
/** How many inbox messages a pass reads; a full window is shown as "N+" in the quiet brief. */
const INBOX_WINDOW = 10;

/** A plan whose dispatch failed is retried this many times before waiting for the next morning slot or lawyer message. */
export const HELD_PLAN_MAX_ATTEMPTS = 5;
const HELD_PLAN_BACKOFF_BASE_MS = 15 * 60 * 1000;
const HELD_PLAN_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;

/** Delay before retry number `attempts + 1`: 15m, 30m, 60m, then 2h. */
export function heldPlanBackoffMs(attempts: number): number {
  return Math.min(
    HELD_PLAN_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    HELD_PLAN_BACKOFF_MAX_MS,
  );
}

type DeliverablePlan = Extract<DigestPlan, { deliver: true }>;

export type DigestDeliveryDecision =
  | { action: "silent" }
  | { action: "brief" }
  | { action: "hold_brief" }
  | { action: "batch" }
  | { action: "hold"; plan: DeliverablePlan }
  | { action: "dispatch"; plan: DeliverablePlan };

/**
 * Decide after collectDigest: no model is involved. A quiet morning pass still earns the short
 * brief, but only inside the WhatsApp window and never a second time on the same local day. With
 * the window closed the brief is held for the number's reply instead of lost.
 */
export function decideDigestDelivery(params: {
  result: CollectResult;
  forceMorning: boolean;
  /** The 07:40 pass for this number that owes a quiet brief: not a poll, a release, or a late catch-up. */
  morningPass: boolean;
  /** A morning brief already went out on this local day and no held plan is owed. */
  briefedToday: boolean;
  timeZone: string;
  now: Date;
  lastLawyerInboundAtMs: number | null;
}): DigestDeliveryDecision {
  const plan = params.result.plan;
  if (!plan.deliver) {
    const owed = params.morningPass && !params.briefedToday;
    if (!owed) {
      return { action: "silent" };
    }
    return whatsappWindowOpen(params.lastLawyerInboundAtMs, params.now.getTime())
      ? { action: "brief" }
      : { action: "hold_brief" };
  }
  const morning =
    (params.forceMorning && !params.briefedToday) ||
    isMorningDigestSlot(params.now, params.timeZone);
  if (!morning && !params.result.urgent) {
    return { action: "batch" };
  }
  if (!whatsappWindowOpen(params.lastLawyerInboundAtMs, params.now.getTime())) {
    return { action: "hold", plan };
  }
  return { action: "dispatch", plan };
}

export type AdaServiceDeps = {
  api: OpenClawPluginApi;
  now?: () => Date;
  dispatchDigestTurn?: (request: DigestDispatchRequest) => Promise<DigestDispatchResult>;
};

function dayKey(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function reconnectNoteRequest(params: { owner: string; now: Date }) {
  return {
    owner: params.owner,
    plan: { deliver: false, reason: "nothing_cleared_the_bar" } as const,
    idempotencyKey: `reconnect:${params.owner}:${dayKey(params.now, DEFAULT_TIME_ZONE)}`,
    connectOnly: true,
    reconnect: true,
  };
}

async function loadGoogleReads(api: OpenClawPluginApi, owner: string, now: Date) {
  const config = readGoogleConnectConfig(googleConnectConfigFrom(api.pluginConfig));
  if (!config.ok) {
    return { ok: false as const, error: config.error };
  }
  const store = await openAdaGoogleAccountFromApi(api, owner);
  const account = await store.readAccount();
  if (!account) {
    return { ok: false as const, error: "not_connected" };
  }
  const token = await loadAccessToken({
    account,
    clientId: config.settings.clientId,
    clientSecret: config.settings.clientSecret,
    now,
    log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
  });
  if (!token.ok) {
    if (token.reason === "reconnect") {
      // Google no longer accepts this sign-in: it is not a connection, so every path sees none.
      // Only the row that failed: a reconnect during the refresh is a new sign-in.
      await store.clearAccountIfStill(account);
    }
    return { ok: false as const, error: token.reason };
  }
  await saveRefreshedAccount(store, account, token).catch((error: unknown) => {
    api.logger.warn(
      `ada google refreshed token not saved owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  });
  const inbox = await listInboxMessages({ accessToken: token.accessToken, max: INBOX_WINDOW });
  if (!inbox.ok) {
    return { ok: false as const, error: `gmail_${inbox.status}` };
  }
  const events = await listUpcomingEvents({
    accessToken: token.accessToken,
    now,
    hours: 72,
  });
  if (!events.ok) {
    return { ok: false as const, error: `calendar_${events.status}` };
  }
  return {
    ok: true as const,
    email: account.email,
    accessToken: token.accessToken,
    messages: inbox.messages,
    events: events.events,
  };
}

/**
 * Outlook's share of a pass. It never throws and never ends the pass: a person without Outlook, or
 * with Outlook down for a moment, still gets what Google feeds. A sign-in Microsoft just refused
 * for good starts the once-a-day reconnect text here, because nothing else would notice it.
 */
async function loadOutlookReadsSafely(
  api: OpenClawPluginApi,
  owner: string,
  now: Date,
): Promise<OutlookReads> {
  if (!outlookEnabled()) {
    return { ok: false, error: "disabled" };
  }
  try {
    const db = await openAdaOutlookAccountDbFromApi(api);
    const reads = await loadOutlookReads(api, owner, now, {
      db,
      inboxWindow: INBOX_WINDOW,
      hours: 72,
    });
    if (!reads.ok && reads.error === "reconnect") {
      await remindOutlookReconnect(api, db, owner, now);
    }
    return reads;
  } catch (error) {
    api.logger.warn(
      `ada outlook reads failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "unavailable" };
  }
}

/** A provider that is only down for a moment keeps its rows in the shared snapshots for the next pass. */
const TRANSIENT_READ_ERROR = /^(?:gmail_|calendar_|outlook_)|^(?:google_error|unavailable)$/u;

export type AdaCollectTrigger = "poll" | "morning" | "notify" | "inbound";

export type AdaCollectOutcome = {
  collected: boolean;
  delivered: boolean;
  held: boolean;
  reason?: string;
  result?: CollectResult;
  decision: DigestDeliveryDecision["action"] | "connect" | "none";
  /** Unknown until the wake row is read, so absent when Google reads fail first. */
  windowOpen?: boolean;
};

export type AdaCollectPassParams = {
  api: OpenClawPluginApi;
  /** The WhatsApp number this pass is for: its Google account, its memory, its digest. */
  owner: string;
  /** That number's own memory store. */
  memory: MemoryStore;
  now: Date;
  forceMorning: boolean;
  trigger: AdaCollectTrigger;
  /** Missed-slot catch-up after boot: never re-sends the Google connect ask on every restart. */
  catchUp?: boolean;
  dispatchDigestTurn?: NonNullable<AdaServiceDeps["dispatchDigestTurn"]>;
  /** Sends the digest-ready template; defaults to Kapso. Injected by tests. */
  sendDigestReadyNotice?: (template: KapsoTemplate) => Promise<unknown>;
};

export type AdaCollectLogEvent = {
  event: "ada.collect";
  at: string;
  /** The number the pass was for, masked. */
  owner: string;
  trigger: AdaCollectTrigger;
  /** `collected` advances lastCollectAt; `skipped` means Google was unavailable; `error` threw. */
  result: "collected" | "skipped" | "error";
  decision: AdaCollectOutcome["decision"];
  dispatchReason: string | null;
  delivered: boolean;
  held: boolean;
  urgent: boolean | null;
  forceMorning: boolean;
  windowOpen: boolean | null;
  deliverable: boolean | null;
  durationMs: number;
  error?: string;
};

/**
 * One JSON line per collect pass. The "no collect in 45 minutes" alert keys off
 * the absence of `result: "collected"`; see extensions/ada/README.md#monitoring.
 */
export function logAdaCollectEvent(
  logger: Pick<OpenClawPluginApi["logger"], "info" | "error">,
  event: AdaCollectLogEvent,
): void {
  const line = JSON.stringify(event);
  if (event.result === "error") {
    logger.error(line);
  } else {
    logger.info(line);
  }
}

/**
 * Entry point for every collect pass. Passes run one at a time; forced passes
 * (morning slot, catch-up, lawyer reply) each get their own run, while polls and
 * push notifications coalesce into at most one waiting pass.
 */
export function runAdaCollectPass(params: AdaCollectPassParams): Promise<AdaCollectOutcome> {
  return runCollectExclusive(() => runLoggedCollectPass(params), {
    coalesce: !params.forceMorning,
    key: params.owner,
  });
}

async function runLoggedCollectPass(params: AdaCollectPassParams): Promise<AdaCollectOutcome> {
  const startedMs = Date.now();
  const base = {
    event: "ada.collect" as const,
    at: params.now.toISOString(),
    owner: maskNumber(params.owner),
    trigger: params.trigger,
    forceMorning: params.forceMorning,
  };
  try {
    const outcome = await collectPass(params);
    logAdaCollectEvent(params.api.logger, {
      ...base,
      result: outcome.collected ? "collected" : "skipped",
      decision: outcome.decision,
      dispatchReason: outcome.reason ?? null,
      delivered: outcome.delivered,
      held: outcome.held,
      urgent: outcome.result?.urgent ?? null,
      windowOpen: outcome.windowOpen ?? null,
      deliverable: outcome.result?.plan.deliver ?? null,
      durationMs: Date.now() - startedMs,
    });
    return outcome;
  } catch (error) {
    logAdaCollectEvent(params.api.logger, {
      ...base,
      result: "error",
      decision: "none",
      dispatchReason: null,
      delivered: false,
      held: false,
      urgent: null,
      windowOpen: null,
      deliverable: null,
      durationMs: Date.now() - startedMs,
      error: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}

/**
 * Snapshots and open-todo ids are the diff baseline for the next pass, so they only
 * advance once the digest they produced is delivered or safely held. A pass that
 * batches or fails to dispatch leaves them alone and the next pass re-emits the signals.
 */
async function collectPass(params: AdaCollectPassParams): Promise<AdaCollectOutcome> {
  const dispatchDigestTurn =
    params.dispatchDigestTurn ?? ((request) => dispatchDigest(params.api, request));
  const nowMs = params.now.getTime();
  const earlyWake = await params.memory.readWake();
  const earlyHeld = parseDigestPlan(earlyWake.heldPlanJson);
  if (earlyHeld && !params.forceMorning) {
    if (earlyWake.heldPlanAttempts >= HELD_PLAN_MAX_ATTEMPTS) {
      return {
        collected: false,
        delivered: false,
        held: true,
        reason: "retries_exhausted",
        decision: "none",
      };
    }
    if (earlyWake.heldPlanNextAttemptAtMs !== null && nowMs < earlyWake.heldPlanNextAttemptAtMs) {
      return {
        collected: false,
        delivered: false,
        held: true,
        reason: "retry_backoff",
        decision: "none",
      };
    }
  }

  const google = await loadGoogleReads(params.api, params.owner, params.now);
  const outlook = await loadOutlookReadsSafely(params.api, params.owner, params.now);
  // Neither saved nor configured: the person has nothing from Outlook to lose or to be asked about.
  const outlookGone =
    !outlook.ok && (outlook.error === "disabled" || outlook.error === "not_connected");
  if (!google.ok && google.error === "reconnect") {
    // The dead row is gone, so nothing would retry: a note that cannot go out is held for the
    // number's next message. Free text outside the 24-hour window can be accepted by WhatsApp
    // and fail later, so a closed window holds it without trying.
    const windowOpen = whatsappWindowOpen(earlyWake.lastLawyerInboundAtMs, nowMs);
    const dispatch = windowOpen
      ? await dispatchSafely(dispatchDigestTurn, reconnectNoteRequest(params))
      : { ok: false };
    if (!dispatch.ok) {
      holdReconnectNote(params.owner, nowMs);
    }
    if (!outlook.ok) {
      return {
        collected: false,
        delivered: dispatch.ok,
        held: false,
        reason: dispatch.ok ? "reconnect_dispatched" : "reconnect_held",
        decision: "connect",
      };
    }
  }
  if (!google.ok && !outlook.ok) {
    if (params.forceMorning && !params.catchUp && google.error === "not_connected" && outlookGone) {
      const ownZone = effectiveTimeZone((await params.memory.readProfile())?.timezone);
      const day = dayKey(params.now, ownZone);
      const dispatch = await dispatchSafely(dispatchDigestTurn, {
        owner: params.owner,
        plan: { deliver: false, reason: "nothing_cleared_the_bar" },
        idempotencyKey: `connect:${params.owner}:${day}`,
        connectOnly: true,
      });
      return {
        collected: false,
        delivered: dispatch.ok,
        held: false,
        reason: dispatch.ok ? "connect_dispatched" : (dispatch.reason ?? "connect_rejected"),
        decision: "connect",
      };
    }
    return {
      collected: false,
      delivered: false,
      held: false,
      reason: google.error === "not_connected" && !outlookGone ? outlook.error : google.error,
      decision: "none",
    };
  }
  /** What the person's connected providers feed this pass; Gmail and Outlook merge into one list. */
  const feeds = [google, outlook].filter((feed) => feed.ok);
  const messages = [...(google.ok ? google.messages : []), ...(outlook.ok ? outlook.messages : [])];
  const events = [...(google.ok ? google.events : []), ...(outlook.ok ? outlook.events : [])];
  const inboxFull = feeds.some((feed) => feed.messages.length >= INBOX_WINDOW);

  const [previousGmail, previousCalendar, aliases, todos, wake, profile, preferences] =
    await Promise.all([
      params.memory.readGmailSnapshot(),
      params.memory.readCalendarSnapshot(),
      params.memory.listMatterAliases(),
      params.memory.listTodos(),
      params.memory.readWake(),
      params.memory.readProfile(),
      params.memory.listPreferences(),
    ]);

  let previousOpenTodoIds: string[] = [];
  if (wake.openTodoIdsJson) {
    try {
      const parsed: unknown = JSON.parse(wake.openTodoIdsJson);
      if (Array.isArray(parsed)) {
        previousOpenTodoIds = parsed.filter((id): id is string => typeof id === "string");
      }
    } catch {
      previousOpenTodoIds = [];
    }
  }

  const timeZone = effectiveTimeZone(profile?.timezone);
  // Deadline intake reads Gmail itself, so it runs only for a person who has Google connected.
  const deadlineIntake = google.ok
    ? await prepareDeadlineIntake({
        api: params.api,
        memory: params.memory,
        now: params.now,
        forceMorning: params.forceMorning,
        aliases,
        timeZone,
        accessToken: google.accessToken,
      })
    : null;
  const result = collectDigest({
    now: params.now,
    forceMorning: params.forceMorning,
    inbox: messages,
    events,
    previousGmail,
    previousCalendar,
    aliases,
    todos,
    previousOpenTodoIds,
    ...(deadlineIntake ? { deadlines: deadlineIntake.digest } : {}),
  });

  const openTodoIds = todos
    .filter((todo) => todo.owner === "lawyer" && todo.status !== "done")
    .map((todo) => todo.id);

  const topic = readPubSubTopic(params.api.pluginConfig);
  if (
    google.ok &&
    topic &&
    (wake.watchExpirationMs === null || wake.watchExpirationMs < nowMs + 60 * 60 * 1000)
  ) {
    const watched = await watchGmailInbox({
      accessToken: google.accessToken,
      topicName: topic,
    });
    if (watched.ok && watched.expirationMs !== null) {
      await params.memory.writeWake({ watchExpirationMs: watched.expirationMs });
    }
  }

  const held = parseDigestPlan(wake.heldPlanJson);
  const plan = withCurrentDeadlines(
    held ? mergeDigestPlans(held, result.plan, params.now) : result.plan,
    deadlineIntake?.digest.lines,
  );
  const day = dayKey(params.now, timeZone);
  // A catch-up that runs once the local morning is over skips the quiet brief for that day;
  // an urgent plan still goes out or is held as usual.
  // A reply that releases a brief held earlier today is that morning pass, run late.
  const releasingBrief = params.trigger === "inbound" && wake.heldBriefDay === day;
  const morningPass =
    (params.trigger === "morning" || releasingBrief) &&
    !preferences.some((preference) => preference.key === QUIET_BRIEF_OFF_KEY) &&
    !(params.catchUp && localParts(nowMs, timeZone).hour >= CATCH_UP_BRIEF_CUTOFF_HOUR);
  // Read from the stored time alone: a quiet-brief preference or a late catch-up changes whether a
  // brief is owed, not whether this morning already had one, so forceMorning is demoted either way.
  const briefedToday =
    held === null &&
    wake.lastMorningBriefAtMs !== null &&
    dayKey(new Date(wake.lastMorningBriefAtMs), timeZone) === day;
  const decision = decideDigestDelivery({
    // A held plan is already owed to the lawyer, so it skips the morning-or-urgent gate.
    result: { ...result, plan, urgent: result.urgent || (held !== null && plan.deliver) },
    forceMorning: params.forceMorning,
    morningPass,
    briefedToday,
    timeZone,
    now: params.now,
    lastLawyerInboundAtMs: wake.lastLawyerInboundAtMs,
  });
  const windowOpen = whatsappWindowOpen(wake.lastLawyerInboundAtMs, nowMs);
  const heldPlanAtMs = wake.heldPlanJson ? (wake.heldPlanAtMs ?? nowMs) : nowMs;

  // A provider read for a moment only keeps its earlier rows, so it does not look new next pass.
  const keptRows = <Row>(rows: readonly Row[], idOf: (row: Row) => string): Row[] =>
    rows.filter((row) => {
      const isOutlook = isOutlookSnapshotId(idOf(row));
      const feed = isOutlook ? outlook : google;
      return !feed.ok && TRANSIENT_READ_ERROR.test(feed.error);
    });
  const commitSnapshots = async () => {
    await params.memory.replaceGmailSnapshot([
      ...result.gmailSnapshot,
      ...keptRows(previousGmail, (row) => row.messageId),
    ]);
    await params.memory.replaceCalendarSnapshot([
      ...result.calendarSnapshot,
      ...keptRows(previousCalendar, (row) => row.eventId),
    ]);
  };
  /** One nudge template; the caller has already written its claim, and a failure is never retried. */
  const sendNudge = async (template: KapsoTemplate) => {
    const send =
      params.sendDigestReadyNotice ??
      ((value: KapsoTemplate) =>
        sendDigestReadyNotice({ api: params.api, template: value, to: `+${params.owner}` }));
    try {
      await send(template);
    } catch (error) {
      params.api.logger.warn(
        `ada digest-ready template failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  };
  const noHeldPlan = {
    heldPlanJson: null,
    heldPlanAtMs: null,
    heldPlanAttempts: 0,
    heldPlanNextAttemptAtMs: null,
    heldPlanTemplateAttemptedAtMs: null,
  } as const;

  if (decision.action === "batch") {
    await params.memory.writeWake({ lastCollectAtMs: nowMs });
    return {
      collected: true,
      delivered: false,
      held: false,
      result,
      reason: "batched_until_morning",
      decision: "batch",
      windowOpen,
    };
  }

  if (decision.action === "silent") {
    await commitSnapshots();
    await params.memory.writeWake({
      lastCollectAtMs: nowMs,
      openTodoIdsJson: JSON.stringify(openTodoIds),
      ...noHeldPlan,
      // A reply that finds nothing owed (briefed already, brief turned off) settles the held day.
      ...(params.trigger === "inbound" ? { heldBriefDay: null } : {}),
    });
    return {
      collected: true,
      delivered: false,
      held: false,
      result,
      decision: "silent",
      windowOpen,
    };
  }

  if (decision.action === "brief") {
    const brief = buildQuietBrief({
      now: params.now,
      timeZone,
      events,
      inbox: messages,
      inboxLimit: INBOX_WINDOW,
      inboxFull,
      aliases,
      deadlines: deadlineIntake?.digest.lines,
      alertedToday:
        wake.lastDigestAtMs !== null && dayKey(new Date(wake.lastDigestAtMs), timeZone) === day,
    });
    const dispatch = await dispatchSafely(dispatchDigestTurn, {
      owner: params.owner,
      plan,
      brief,
      idempotencyKey: `brief:${params.owner}:${day}`,
    });
    // Nothing urgent was dropped, so the baseline advances whether or not the brief went out.
    await commitSnapshots();
    await params.memory.writeWake({
      lastCollectAtMs: nowMs,
      openTodoIdsJson: JSON.stringify(openTodoIds),
      ...noHeldPlan,
      // A failed release keeps the held day, so the number's next message the same day tries again.
      ...(dispatch.ok
        ? { lastDigestAtMs: nowMs, lastMorningBriefAtMs: nowMs, heldBriefDay: null }
        : {}),
    });
    return {
      collected: true,
      delivered: dispatch.ok,
      held: false,
      result,
      ...(dispatch.ok ? {} : { reason: dispatch.reason ?? "dispatch_rejected" }),
      decision: "brief",
      windowOpen,
    };
  }

  if (decision.action === "hold_brief") {
    // Held for the number's reply, which releases it the same local day. At most one template per
    // number per local day, claimed (heldBriefDay) with the hold and before the send, so a crash or
    // a timeout that Kapso actually accepted can never produce a second nudge.
    const nudgedToday =
      wake.heldBriefDay === day ||
      (wake.heldPlanTemplateAttemptedAtMs !== null &&
        dayKey(new Date(wake.heldPlanTemplateAttemptedAtMs), timeZone) === day);
    const template = nudgedToday
      ? null
      : readBriefReadyTemplate(params.api.pluginConfig, profile?.language);
    if (!nudgedToday && !template) {
      warnDigestReadyTemplateUnset(params.api, "brief");
    }
    // Nothing urgent was dropped, so the baseline advances like in the brief itself.
    await commitSnapshots();
    await params.memory.writeWake({
      lastCollectAtMs: nowMs,
      openTodoIdsJson: JSON.stringify(openTodoIds),
      heldBriefDay: day,
    });
    if (template) {
      await sendNudge(template);
    }
    return {
      collected: true,
      delivered: false,
      held: true,
      result,
      reason: "whatsapp_window_closed",
      decision: "hold_brief",
      windowOpen,
    };
  }

  if (decision.action === "hold") {
    // One template per held plan, and none when a brief nudge already went out today. The claim
    // is written with the hold, before the send, so a crash or a timeout that Kapso actually
    // accepted can never produce a second nudge.
    const template = readDigestReadyTemplate(params.api.pluginConfig);
    const needsTemplate = wake.heldPlanTemplateAttemptedAtMs === null;
    if (needsTemplate && !template) {
      warnDigestReadyTemplateUnset(params.api);
    }
    await commitSnapshots();
    await params.memory.writeWake({
      lastCollectAtMs: nowMs,
      openTodoIdsJson: JSON.stringify(openTodoIds),
      heldPlanJson: JSON.stringify(decision.plan),
      heldPlanAtMs,
      heldPlanAttempts: 0,
      heldPlanNextAttemptAtMs: null,
      ...(needsTemplate && template ? { heldPlanTemplateAttemptedAtMs: nowMs } : {}),
    });
    if (needsTemplate && template && wake.heldBriefDay !== day) {
      await sendNudge(template);
    }
    return {
      collected: true,
      delivered: false,
      held: true,
      result,
      reason: "whatsapp_window_closed",
      decision: "hold",
      windowOpen,
    };
  }

  const itemIds = decision.plan.items.map((item) => item.matterId).join(",");
  const deadlineIds = decision.plan.deliver
    ? decision.plan.deadlines?.map((line) => line.id).join(",")
    : undefined;
  const dispatch = await dispatchSafely(dispatchDigestTurn, {
    owner: params.owner,
    plan: decision.plan,
    idempotencyKey: `digest:${params.owner}:${day}:${itemIds}${deadlineIds ? `:${deadlineIds}` : ""}`,
  });
  if (!dispatch.ok) {
    // An exhausted plan reaching here was re-armed by a morning slot or lawyer message.
    const priorAttempts =
      wake.heldPlanAttempts >= HELD_PLAN_MAX_ATTEMPTS ? 0 : wake.heldPlanAttempts;
    const attempts = priorAttempts + 1;
    // The collector is alive even though the dispatch failed; snapshots stay put so the
    // next pass re-emits the signals.
    await params.memory.writeWake({
      lastCollectAtMs: nowMs,
      heldPlanJson: JSON.stringify(decision.plan),
      heldPlanAtMs,
      heldPlanAttempts: attempts,
      heldPlanNextAttemptAtMs:
        attempts >= HELD_PLAN_MAX_ATTEMPTS ? null : nowMs + heldPlanBackoffMs(attempts),
    });
    return {
      collected: true,
      delivered: false,
      held: true,
      result,
      reason: dispatch.reason ?? "dispatch_rejected",
      decision: "dispatch",
      windowOpen,
    };
  }
  await deadlineIntake?.commit(decision.plan);
  await commitSnapshots();
  await params.memory.writeWake({
    lastCollectAtMs: nowMs,
    lastDigestAtMs: nowMs,
    ...(params.forceMorning || isMorningDigestSlot(params.now, timeZone)
      ? { lastMorningBriefAtMs: nowMs }
      : {}),
    openTodoIdsJson: JSON.stringify(openTodoIds),
    ...noHeldPlan,
    heldBriefDay: null,
  });
  return {
    collected: true,
    delivered: true,
    held: false,
    result,
    decision: "dispatch",
    windowOpen,
  };
}

/**
 * Deadline lines are recomputed every pass from matter memory and numbered here, so a
 * held plan never replays stale numbers or reminder steps; the lines in a stored held
 * plan are dropped, and nothing is listed when intake is off or failed this pass.
 */
function withCurrentDeadlines(
  plan: DigestPlan,
  lines: readonly DigestDeadlineInput[] | undefined,
): DigestPlan {
  if (!plan.deliver) {
    return plan;
  }
  const { deadlines: _replaced, ...rest } = plan;
  return lines?.length ? { ...rest, deadlines: numberDeadlineLines(lines) } : rest;
}

async function dispatchSafely(
  dispatch: NonNullable<AdaServiceDeps["dispatchDigestTurn"]>,
  params: DigestDispatchRequest,
): Promise<DigestDispatchResult> {
  try {
    return await dispatch(params);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "dispatch_threw" };
  }
}

export async function runAdaReconcilePass(params: {
  memory: MemoryStore;
  now: Date;
}): Promise<{ ran: boolean; reason?: string }> {
  const wake = await params.memory.readWake();
  if (
    wake.lastReconcileAtMs !== null &&
    params.now.getTime() - wake.lastReconcileAtMs < 20 * 60 * 60 * 1000
  ) {
    return { ran: false, reason: "already_reconciled" };
  }
  if (wake.lastCollectAtMs === null) {
    return { ran: false, reason: "no_collect_yet" };
  }

  const profile = await params.memory.readProfile();
  const timeZone = effectiveTimeZone(profile?.timezone);
  const day = dayKey(params.now, timeZone);
  const aliases = await params.memory.listMatterAliases();
  const matterIds = [...new Set(aliases.map((entry) => entry.matterId))];
  const atMs = params.now.getTime();

  for (const matterId of matterIds) {
    const label = aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId;
    const todos = await params.memory.listTodos(matterId);
    const open = todos.filter((todo) => todo.status !== "done");
    const body = [
      `- Generated: ${new Date(atMs).toISOString()}`,
      open.length === 0
        ? "- Open loops: none"
        : `- Open loops: ${open.map((todo) => todo.title).join("; ")}`,
    ].join("\n");
    await params.memory.upsertRecord(
      buildDailyTimelineRecord({ matterId, day, body, atMs }),
      "create",
      atMs,
    );
    const existing = await params.memory.getRecord(`${matterId}-one-pager`, matterId);
    if (!existing) {
      await params.memory.upsertRecord(
        buildOnePagerRecord({
          matterId,
          matterLabel: label,
          body: `- Matter: ${label}\n- Autonomy: text only when cost clears the bar.\n- Generated: ${day}`,
          atMs,
        }),
        "create",
        atMs,
      );
    }
  }

  await params.memory.writeWake({ lastReconcileAtMs: atMs });
  return { ran: true };
}

export function registerAdaService(deps: AdaServiceDeps): void {
  const { api } = deps;
  const now = deps.now ?? (() => new Date());
  const dispatchDigestTurn =
    deps.dispatchDigestTurn ?? ((request: DigestDispatchRequest) => dispatchDigest(api, request));
  const timers = createServiceTimers({ logger: api.logger, now });
  let stopped = false;

  api.registerService({
    id: "ada-instinct-wake",
    apiVersion: 2,
    async start(ctx) {
      stopped = false;
      /** One number's pass: its Google account, its memory, its digest. */
      const tickOwner = async (owner: string, forceMorning: boolean, catchUp = false) => {
        try {
          const memory = await openAdaMemoryFromApi(api, owner);
          await runAdaCollectPass({
            api,
            owner,
            memory,
            now: now(),
            forceMorning,
            trigger: forceMorning ? "morning" : "poll",
            catchUp,
            dispatchDigestTurn,
          });
          const clock = now();
          const profile = await memory.readProfile();
          if (forceMorning || isMorningDigestSlot(clock, effectiveTimeZone(profile?.timezone))) {
            await runAdaReconcilePass({ memory, now: clock });
          }
        } catch (error) {
          api.logger.error(
            `ada service tick failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      };
      /** Every number with a Google connection, and the lawyer, who is asked to connect. */
      const tickAll = async () => {
        let owners: string[] = [];
        try {
          owners = await listCollectOwners(api);
        } catch (error) {
          api.logger.error(
            `ada service could not list accounts: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
        for (const owner of owners) {
          await tickOwner(owner, false);
        }
        try {
          await runGranolaKeepAlive(api, now());
        } catch (error) {
          api.logger.error(
            `ada granola keep-alive failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
        try {
          await runOutlookKeepAlive(api, now());
        } catch (error) {
          api.logger.error(
            `ada outlook keep-alive failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      };
      const { armMorning, armCatchUp } = createMorningSchedule({
        api,
        now,
        scheduler: ctx.scheduler,
        timers,
        listOwners: () => listCollectOwners(api),
        runOwner: tickOwner,
        isStopped: () => stopped,
      });

      // The poll also re-arms the morning timer, so numbers added or removed and zones changed
      // since the last run take effect within one poll.
      timers.scheduleRepeating({
        scheduler: ctx.scheduler,
        id: "ada-poll",
        delayMs: POLL_MS,
        everyMs: POLL_MS,
        run: async () => {
          await tickAll();
          try {
            await armMorning();
          } catch (error) {
            api.logger.error(
              `ada could not refresh the morning slots: ${error instanceof Error ? error.message : "unknown"}`,
            );
          }
        },
      });
      try {
        await armMorning();
      } catch (error) {
        api.logger.error(
          `ada could not schedule the morning slot: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      try {
        await armCatchUp();
      } catch (error) {
        api.logger.error(
          `ada catch-up check failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    },
    stop() {
      stopped = true;
      abortResearchJobs();
      timers.stop();
    },
  });
}

/** Every number that has a Google or Outlook connection, plus the lawyer; the passes the service runs. */
export async function listCollectOwners(api: OpenClawPluginApi): Promise<string[]> {
  const owners = new Set(await (await openAdaGoogleAccountDbFromApi(api)).listOwners());
  if (outlookEnabled()) {
    for (const owner of await (await openAdaOutlookAccountDbFromApi(api)).listOwners()) {
      owners.add(owner);
    }
  }
  const lawyer = lawyerOwner(api.config);
  if (lawyer) {
    owners.add(lawyer);
  }
  return [...owners].toSorted();
}

/**
 * A number's digest window opens when it writes. A connection made by a link counts as a message:
 * the person had just been chatting with Ada to get the link, and the confirmation is sent in
 * that window.
 */
export async function openWakeWindow(
  api: OpenClawPluginApi,
  owner: string,
  atMs = Date.now(),
): Promise<void> {
  try {
    await (await openAdaMemoryFromApi(api, owner)).writeWake({ lastLawyerInboundAtMs: atMs });
  } catch (error) {
    api.logger.error(
      `ada could not open the digest window owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

/**
 * The number just wrote, so the window is open: sends the expired-Google note that could not go
 * out before, with a link made now. Kept for the next message when the send fails again.
 */
async function releaseHeldReconnectNote(
  api: OpenClawPluginApi,
  owner: string,
  nowMs: number,
): Promise<void> {
  if (!takeHeldReconnectNote(owner, nowMs)) {
    return;
  }
  const now = new Date(nowMs);
  const result = await dispatchSafely(
    (request) => dispatchDigest(api, { ...request, afterLawyerReply: true }),
    reconnectNoteRequest({ owner, now }),
  );
  if (!result.ok && result.reason !== "already_connected") {
    holdReconnectNote(owner, nowMs);
  }
}

/**
 * Records that a number wrote, which opens its paid WhatsApp window and releases a digest held
 * for that number, and only that number's. A number with no memory yet has no digest to release,
 * so nothing is created for it: its window starts when it first connects an account.
 */
export async function recordSenderInbound(params: {
  api: OpenClawPluginApi;
  atMs: number;
  /** Only Kapso WhatsApp messages open the Cloud API window. */
  channelId?: string;
  /** Sender ids from the inbound event; the first that is a phone number is the owner. */
  senders: unknown[];
}): Promise<void> {
  if (params.channelId && params.channelId !== "kapso-whatsapp") {
    logInboundSkip(params.api.logger, {
      stage: "wake_window",
      reason: "not_whatsapp_channel",
      sender: params.senders,
    });
    return;
  }
  const owner = params.senders.map(toOwner).find((value) => value !== null);
  if (!owner) {
    logInboundSkip(params.api.logger, {
      stage: "wake_window",
      reason: "sender_not_a_phone_number",
      sender: params.senders,
    });
    return;
  }
  await releaseHeldReconnectNote(params.api, owner, params.atMs);
  await releaseHeldGranolaReminder(params.api, owner, params.atMs).catch((error: unknown) => {
    params.api.logger.error(
      `ada granola reminder release failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  });
  await releaseHeldOutlookReminder(params.api, owner, params.atMs).catch((error: unknown) => {
    params.api.logger.error(
      `ada outlook reminder release failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  });
  const memory = await openAdaMemoryIfExistsFromApi(params.api, owner);
  if (!memory) {
    logInboundSkip(params.api.logger, {
      stage: "wake_window",
      reason: "no_digest_for_sender",
      sender: owner,
    });
    return;
  }
  await memory.writeWake({ lastLawyerInboundAtMs: params.atMs });
  // Read the held plan under the collect lock: a pass that is mid-hold has either written
  // its plan before this read or is not holding one, so the release is never stranded.
  await runCollectExclusive(
    async () => {
      const wake = await memory.readWake();
      let briefHeldToday = false;
      if (wake.heldBriefDay !== null) {
        const day = dayKey(
          new Date(params.atMs),
          effectiveTimeZone((await memory.readProfile())?.timezone),
        );
        briefHeldToday = wake.heldBriefDay === day;
        if (!briefHeldToday) {
          // A brief held for an earlier day is dropped: a reply now would be a stale one.
          await memory.writeWake({ heldBriefDay: null });
        }
      }
      if (!wake.heldPlanJson && !briefHeldToday) {
        return;
      }
      // Re-collect so a stale held plan cannot fire after the calendar moved on. A held brief is
      // built now, from today's calendar and mail, as the morning pass would have built it.
      await runLoggedCollectPass({
        api: params.api,
        owner,
        memory,
        now: new Date(params.atMs),
        forceMorning: true,
        trigger: "inbound",
        dispatchDigestTurn: (request) =>
          dispatchDigest(params.api, { ...request, afterLawyerReply: true }),
      });
    },
    { key: owner },
  );
}
