import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { runCollectExclusive } from "./collect-lock.js";
import {
  collectDigest,
  isMorningDigestSlot,
  whatsappWindowOpen,
  type CollectResult,
} from "./collector.js";
import { mergeDigestPlans, parseDigestPlan, type DigestPlan } from "./digest.js";
import {
  dispatchDigest,
  type DigestDispatchRequest,
  type DigestDispatchResult,
} from "./dispatch-digest.js";
import { openVeraGoogleAccountFromApi } from "./google-account.js";
import {
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
  watchGmailInbox,
} from "./google-api.js";
import { googleConnectConfigFrom, readGoogleConnectConfig } from "./google-connect.js";
import { isConfiguredLawyerSender } from "./google-notify.js";
import { openVeraMemoryFromApi, type MemoryStore } from "./memory.js";
import { buildDailyTimelineRecord, buildOnePagerRecord } from "./reconcile.js";
import { nextSlotMs, previousSlotMs } from "./schedule.js";
import {
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
const CATCH_UP_DELAY_MS = 30 * 1000;
const DEFAULT_TZ = "Europe/Rome";

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
  | { action: "batch" }
  | { action: "hold"; plan: DeliverablePlan }
  | { action: "dispatch"; plan: DeliverablePlan };

/** Decide after collectDigest: model only on dispatch. */
export function decideDigestDelivery(params: {
  result: CollectResult;
  forceMorning: boolean;
  timeZone: string;
  now: Date;
  lastLawyerInboundAtMs: number | null;
}): DigestDeliveryDecision {
  const plan = params.result.plan;
  if (!plan.deliver) {
    return { action: "silent" };
  }
  const morning = params.forceMorning || isMorningDigestSlot(params.now, params.timeZone);
  if (!morning && !params.result.urgent) {
    return { action: "batch" };
  }
  if (!whatsappWindowOpen(params.lastLawyerInboundAtMs, params.now.getTime())) {
    return { action: "hold", plan };
  }
  return { action: "dispatch", plan };
}

export type VeraServiceDeps = {
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

async function loadGoogleReads(api: OpenClawPluginApi, now: Date) {
  const config = readGoogleConnectConfig(googleConnectConfigFrom(api.pluginConfig));
  if (!config.ok) {
    return { ok: false as const, error: config.error };
  }
  const store = await openVeraGoogleAccountFromApi(api);
  const account = await store.readAccount();
  if (!account) {
    return { ok: false as const, error: "not_connected" };
  }
  const token = await loadAccessToken({
    account,
    clientId: config.settings.clientId,
    clientSecret: config.settings.clientSecret,
    now,
  });
  if (!token.ok) {
    return { ok: false as const, error: token.reason };
  }
  const inbox = await listInboxMessages({ accessToken: token.accessToken, max: 10 });
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

export type VeraCollectTrigger = "poll" | "morning" | "notify" | "inbound";

export type VeraCollectOutcome = {
  collected: boolean;
  delivered: boolean;
  held: boolean;
  reason?: string;
  result?: CollectResult;
  decision: DigestDeliveryDecision["action"] | "connect" | "none";
  /** Unknown until the wake row is read, so absent when Google reads fail first. */
  windowOpen?: boolean;
};

export type VeraCollectPassParams = {
  api: OpenClawPluginApi;
  memory: MemoryStore;
  now: Date;
  forceMorning: boolean;
  trigger: VeraCollectTrigger;
  /** Missed-slot catch-up after boot: never re-sends the Google connect ask on every restart. */
  catchUp?: boolean;
  dispatchDigestTurn?: NonNullable<VeraServiceDeps["dispatchDigestTurn"]>;
  /** Sends the digest-ready template; defaults to Kapso. Injected by tests. */
  sendDigestReadyNotice?: (template: KapsoTemplate) => Promise<unknown>;
};

export type VeraCollectLogEvent = {
  event: "vera.collect";
  at: string;
  trigger: VeraCollectTrigger;
  /** `collected` advances lastCollectAt; `skipped` means Google was unavailable; `error` threw. */
  result: "collected" | "skipped" | "error";
  decision: VeraCollectOutcome["decision"];
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
 * the absence of `result: "collected"`; see extensions/vera/README.md#monitoring.
 */
export function logVeraCollectEvent(
  logger: Pick<OpenClawPluginApi["logger"], "info" | "error">,
  event: VeraCollectLogEvent,
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
export function runVeraCollectPass(params: VeraCollectPassParams): Promise<VeraCollectOutcome> {
  return runCollectExclusive(() => runLoggedCollectPass(params), {
    coalesce: !params.forceMorning,
  });
}

async function runLoggedCollectPass(params: VeraCollectPassParams): Promise<VeraCollectOutcome> {
  const startedMs = Date.now();
  const base = {
    event: "vera.collect" as const,
    at: params.now.toISOString(),
    trigger: params.trigger,
    forceMorning: params.forceMorning,
  };
  try {
    const outcome = await collectPass(params);
    logVeraCollectEvent(params.api.logger, {
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
    logVeraCollectEvent(params.api.logger, {
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
async function collectPass(params: VeraCollectPassParams): Promise<VeraCollectOutcome> {
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

  const google = await loadGoogleReads(params.api, params.now);
  if (!google.ok) {
    if (params.forceMorning && !params.catchUp && google.error === "not_connected") {
      const day = dayKey(params.now, DEFAULT_TZ);
      const dispatch = await dispatchSafely(dispatchDigestTurn, {
        plan: { deliver: false, reason: "nothing_cleared_the_bar" },
        sessionKey: `hook:vera:connect:${day}`,
        idempotencyKey: `vera-connect:${day}`,
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
      reason: google.error,
      decision: "none",
    };
  }

  const [previousGmail, previousCalendar, aliases, todos, wake, profile] = await Promise.all([
    params.memory.readGmailSnapshot(),
    params.memory.readCalendarSnapshot(),
    params.memory.listMatterAliases(),
    params.memory.listTodos(),
    params.memory.readWake(),
    params.memory.readProfile(),
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

  const timeZone = profile?.timezone ?? DEFAULT_TZ;
  const result = collectDigest({
    now: params.now,
    forceMorning: params.forceMorning,
    inbox: google.messages,
    events: google.events,
    previousGmail,
    previousCalendar,
    aliases,
    todos,
    previousOpenTodoIds,
  });

  const openTodoIds = todos
    .filter((todo) => todo.owner === "lawyer" && todo.status !== "done")
    .map((todo) => todo.id);

  const topic = readPubSubTopic(params.api.pluginConfig);
  if (
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
  const plan = held ? mergeDigestPlans(held, result.plan, params.now) : result.plan;
  const decision = decideDigestDelivery({
    // A held plan is already owed to the lawyer, so it skips the morning-or-urgent gate.
    result: { ...result, plan, urgent: result.urgent || (held !== null && plan.deliver) },
    forceMorning: params.forceMorning,
    timeZone,
    now: params.now,
    lastLawyerInboundAtMs: wake.lastLawyerInboundAtMs,
  });
  const windowOpen = whatsappWindowOpen(wake.lastLawyerInboundAtMs, nowMs);
  const heldPlanAtMs = wake.heldPlanJson ? (wake.heldPlanAtMs ?? nowMs) : nowMs;

  const commitSnapshots = async () => {
    await params.memory.replaceGmailSnapshot(result.gmailSnapshot);
    await params.memory.replaceCalendarSnapshot(result.calendarSnapshot);
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

  if (decision.action === "hold") {
    // One template per held plan. The claim is written with the hold, before the send, so a
    // crash or a timeout that Kapso actually accepted can never produce a second nudge.
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
    if (needsTemplate && template) {
      const send =
        params.sendDigestReadyNotice ??
        ((value: KapsoTemplate) => sendDigestReadyNotice({ api: params.api, template: value }));
      try {
        await send(template);
      } catch (error) {
        params.api.logger.warn(
          `vera digest-ready template failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
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

  const day = dayKey(params.now, timeZone);
  const itemIds = decision.plan.items.map((item) => item.matterId).join(",");
  const dispatch = await dispatchSafely(dispatchDigestTurn, {
    plan: decision.plan,
    sessionKey: `hook:vera:digest:${day}`,
    idempotencyKey: `vera-digest:${day}:${itemIds}`,
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
  await commitSnapshots();
  await params.memory.writeWake({
    lastCollectAtMs: nowMs,
    lastDigestAtMs: nowMs,
    openTodoIdsJson: JSON.stringify(openTodoIds),
    ...noHeldPlan,
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

async function dispatchSafely(
  dispatch: NonNullable<VeraServiceDeps["dispatchDigestTurn"]>,
  params: DigestDispatchRequest,
): Promise<DigestDispatchResult> {
  try {
    return await dispatch(params);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "dispatch_threw" };
  }
}

export async function runVeraReconcilePass(params: {
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
  const timeZone = profile?.timezone ?? DEFAULT_TZ;
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

export function registerVeraService(deps: VeraServiceDeps): void {
  const { api } = deps;
  const now = deps.now ?? (() => new Date());
  const dispatchDigestTurn =
    deps.dispatchDigestTurn ?? ((request: DigestDispatchRequest) => dispatchDigest(api, request));

  // Fallback timers for hosts that omit the V2 scheduler field (e.g. OpenClaw 2026.9.8).
  const fallbackTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  type ServiceScheduler = Pick<PluginServiceSchedulerV1, "schedule">;
  const scheduleRepeating = (params: {
    scheduler:
      | {
          schedule: (job: {
            id: string;
            delayMs: number;
            everyMs?: number;
            run: () => void | Promise<void>;
          }) => void;
        }
      | undefined;
    id: string;
    delayMs: number;
    everyMs: number;
    run: () => void | Promise<void>;
  }) => {
    if (params.scheduler) {
      params.scheduler.schedule({
        id: params.id,
        delayMs: params.delayMs,
        everyMs: params.everyMs,
        run: params.run,
      });
      return;
    }
    api.logger.warn(`vera: Gateway service scheduler missing; using setInterval for ${params.id}`);
    const first = setTimeout(() => {
      fallbackTimers.delete(first);
      void params.run();
      const interval = setInterval(() => {
        void params.run();
      }, params.everyMs);
      fallbackTimers.add(interval);
    }, params.delayMs);
    fallbackTimers.add(first);
  };
  const scheduleOnce = (params: {
    scheduler: ServiceScheduler | undefined;
    id: string;
    atMs: number;
    run: () => void | Promise<void>;
  }) => {
    if (params.scheduler) {
      params.scheduler.schedule({ id: params.id, atMs: params.atMs, run: params.run });
      return;
    }
    api.logger.warn(`vera: Gateway service scheduler missing; using setTimeout for ${params.id}`);
    const timer = setTimeout(
      () => {
        fallbackTimers.delete(timer);
        void params.run();
      },
      Math.max(0, params.atMs - now().getTime()),
    );
    timer.unref?.();
    fallbackTimers.add(timer);
  };

  api.registerService({
    id: "vera-instinct-wake",
    apiVersion: 2,
    async start(ctx) {
      stopped = false;
      const tick = async (forceMorning: boolean, catchUp = false) => {
        try {
          const memory = await openVeraMemoryFromApi(api);
          await runVeraCollectPass({
            api,
            memory,
            now: now(),
            forceMorning,
            trigger: forceMorning ? "morning" : "poll",
            catchUp,
            dispatchDigestTurn,
          });
          const clock = now();
          const profile = await memory.readProfile();
          if (forceMorning || isMorningDigestSlot(clock, profile?.timezone ?? DEFAULT_TZ)) {
            await runVeraReconcilePass({ memory, now: clock });
          }
        } catch (error) {
          api.logger.error(
            `vera service tick failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      };

      const resolveTimeZone = async (): Promise<string> => {
        try {
          const memory = await openVeraMemoryFromApi(api);
          const timeZone = (await memory.readProfile())?.timezone ?? DEFAULT_TZ;
          // An unknown zone name throws here instead of inside the slot math.
          new Intl.DateTimeFormat("en-GB", { timeZone }).format(0);
          return timeZone;
        } catch {
          return DEFAULT_TZ;
        }
      };

      // Each run schedules the next slot from the calendar, so DST days stay at 07:40
      // and a long run or a slow host never drifts the way a fixed 24h interval would.
      const armMorning = async (afterMs: number): Promise<void> => {
        if (stopped) {
          return;
        }
        const atMs = nextSlotMs(afterMs, await resolveTimeZone());
        scheduleOnce({
          scheduler: ctx.scheduler,
          id: "vera-morning",
          atMs,
          run: async () => {
            try {
              await tick(true);
            } finally {
              try {
                await armMorning(Math.max(now().getTime(), atMs));
              } catch (error) {
                api.logger.error(
                  `vera could not schedule the next morning slot: ${error instanceof Error ? error.message : "unknown"}`,
                );
              }
            }
          },
        });
      };

      // A restart can straddle the 07:40 slot. When nothing was collected since the
      // latest slot, run the morning pass once shortly after boot.
      const armCatchUp = async (): Promise<void> => {
        const memory = await openVeraMemoryFromApi(api);
        const { lastCollectAtMs } = await memory.readWake();
        if (lastCollectAtMs === null) {
          return;
        }
        const clock = now().getTime();
        const slotMs = previousSlotMs(clock, await resolveTimeZone());
        if (lastCollectAtMs >= slotMs) {
          return;
        }
        scheduleOnce({
          scheduler: ctx.scheduler,
          id: "vera-catch-up",
          atMs: clock + CATCH_UP_DELAY_MS,
          run: () => tick(true, true),
        });
      };

      scheduleRepeating({
        scheduler: ctx.scheduler,
        id: "vera-poll",
        delayMs: POLL_MS,
        everyMs: POLL_MS,
        run: () => tick(false),
      });
      try {
        await armMorning(now().getTime());
      } catch (error) {
        api.logger.error(
          `vera could not schedule the morning slot: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      try {
        await armCatchUp();
      } catch (error) {
        api.logger.error(
          `vera catch-up check failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    },
    stop() {
      stopped = true;
      for (const timer of fallbackTimers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      fallbackTimers.clear();
    },
  });
}

export async function recordLawyerInbound(params: {
  api: OpenClawPluginApi;
  atMs: number;
  /** Only Kapso WhatsApp from the lawyer should open the Cloud API window. */
  channelId?: string;
  /** Sender ids from the inbound event; one must be the configured lawyer number. */
  senders: unknown[];
}): Promise<void> {
  if (params.channelId && params.channelId !== "kapso-whatsapp") {
    return;
  }
  // The channel allowlist is not enough: this opens the paid WhatsApp window and
  // releases a held digest, so only the configured lawyer may do that.
  if (!isConfiguredLawyerSender(params.api.config, ...params.senders)) {
    params.api.logger.warn(
      "vera ignored an inbound message that is not from the configured lawyer",
    );
    return;
  }
  const memory = await openVeraMemoryFromApi(params.api);
  await memory.writeWake({ lastLawyerInboundAtMs: params.atMs });
  // Read the held plan under the collect lock: a pass that is mid-hold has either written
  // its plan before this read or is not holding one, so the release is never stranded.
  await runCollectExclusive(async () => {
    const wake = await memory.readWake();
    if (!wake.heldPlanJson) {
      return;
    }
    // Re-collect so a stale held plan cannot fire after the calendar moved on.
    await runLoggedCollectPass({
      api: params.api,
      memory,
      now: new Date(params.atMs),
      forceMorning: true,
      trigger: "inbound",
      dispatchDigestTurn: (request) =>
        dispatchDigest(params.api, { ...request, afterLawyerReply: true }),
    });
  });
}
