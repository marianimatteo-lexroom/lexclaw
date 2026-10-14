import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  collectDigest,
  isMorningDigestSlot,
  whatsappWindowOpen,
  type CollectResult,
} from "./collector.js";
import { mergeDigestPlans, parseDigestPlan, type DigestPlan } from "./digest.js";
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

function readPubSubTopic(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const topic = (config as { googlePubSubTopic?: unknown }).googlePubSubTopic;
  return typeof topic === "string" && topic.trim().startsWith("projects/") ? topic.trim() : null;
}

const POLL_MS = 15 * 60 * 1000;
const SELF_WAKE_TIMEOUT_SEC = 45;
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
  dispatchDigestTurn?: (params: {
    plan: DigestPlan;
    sessionKey: string;
    idempotencyKey: string;
    connectOnly?: boolean;
  }) => Promise<{ ok: boolean; reason?: string }>;
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

type CollectPassParams = {
  api: OpenClawPluginApi;
  memory: MemoryStore;
  now: Date;
  forceMorning: boolean;
  dispatchDigestTurn: NonNullable<VeraServiceDeps["dispatchDigestTurn"]>;
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

export async function runVeraCollectPass(
  params: CollectPassParams & { trigger: VeraCollectTrigger },
): Promise<VeraCollectOutcome> {
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
async function collectPass(params: CollectPassParams): Promise<VeraCollectOutcome> {
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
    if (params.forceMorning && google.error === "not_connected") {
      const day = dayKey(params.now, DEFAULT_TZ);
      const dispatch = await dispatchSafely(params.dispatchDigestTurn, {
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
    await commitSnapshots();
    await params.memory.writeWake({
      lastCollectAtMs: nowMs,
      openTodoIdsJson: JSON.stringify(openTodoIds),
      heldPlanJson: JSON.stringify(decision.plan),
      heldPlanAtMs,
      heldPlanAttempts: 0,
      heldPlanNextAttemptAtMs: null,
    });
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
  const dispatch = await dispatchSafely(params.dispatchDigestTurn, {
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
  params: Parameters<NonNullable<VeraServiceDeps["dispatchDigestTurn"]>>[0],
): Promise<{ ok: boolean; reason?: string }> {
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
    deps.dispatchDigestTurn ??
    (async (params) => {
      const hooks = api.runtime.hooks;
      if (!hooks?.dispatchHookAgentTurn) {
        return { ok: false, reason: "hooks_unavailable" };
      }
      const message = params.connectOnly
        ? "Follow the vera-google-connect skill now. Do not invent a digest."
        : [
            "Run the vera-morning-digest skill phrasing only.",
            "The collector already ranked the plan. Do not invent signals.",
            "Write exactly one WhatsApp message from this plan JSON, or NO_REPLY if deliver is false:",
            JSON.stringify(params.plan),
          ].join("\n");
      const result = await hooks.dispatchHookAgentTurn({
        name: params.connectOnly ? "Vera Google connect" : "Vera digest",
        agentId: "main",
        sessionKey: params.sessionKey,
        message,
        externalContentSource: "email",
        deliver: true,
        timeoutSeconds: SELF_WAKE_TIMEOUT_SEC,
        idempotencyKey: params.idempotencyKey,
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    });

  // Fallback timers for hosts that omit the V2 scheduler field (e.g. OpenClaw 2026.9.8).
  const fallbackTimers = new Set<ReturnType<typeof setTimeout>>();
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

  api.registerService({
    id: "vera-instinct-wake",
    apiVersion: 2,
    start(ctx) {
      const tick = async (forceMorning: boolean) => {
        try {
          const memory = await openVeraMemoryFromApi(api);
          await runVeraCollectPass({
            api,
            memory,
            now: now(),
            forceMorning,
            trigger: forceMorning ? "morning" : "poll",
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

      scheduleRepeating({
        scheduler: ctx.scheduler,
        id: "vera-poll",
        delayMs: POLL_MS,
        everyMs: POLL_MS,
        run: () => tick(false),
      });

      const clock = now();
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: DEFAULT_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(clock);
      const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
      const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
      let delayMin = (7 - hour) * 60 + (40 - minute);
      if (delayMin <= 0) {
        delayMin += 24 * 60;
      }
      scheduleRepeating({
        scheduler: ctx.scheduler,
        id: "vera-morning",
        delayMs: delayMin * 60 * 1000,
        everyMs: 24 * 60 * 60 * 1000,
        run: () => tick(true),
      });
    },
    stop() {
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
  const wake = await memory.readWake();
  await memory.writeWake({ lastLawyerInboundAtMs: params.atMs });
  if (!wake.heldPlanJson) {
    return;
  }
  // Re-collect so a stale held plan cannot fire after the calendar moved on.
  await runVeraCollectPass({
    api: params.api,
    memory,
    now: new Date(params.atMs),
    forceMorning: true,
    trigger: "inbound",
    dispatchDigestTurn: async (dispatchParams) => {
      const hooks = params.api.runtime.hooks;
      if (!hooks?.dispatchHookAgentTurn) {
        return { ok: false, reason: "hooks_unavailable" };
      }
      const result = await hooks.dispatchHookAgentTurn({
        name: "Vera held digest",
        agentId: "main",
        sessionKey: dispatchParams.sessionKey,
        message: [
          "Run the vera-morning-digest skill phrasing only.",
          "The lawyer just texted; deliver this fresh plan if deliver is true:",
          JSON.stringify(dispatchParams.plan),
        ].join("\n"),
        externalContentSource: "email",
        deliver: true,
        timeoutSeconds: SELF_WAKE_TIMEOUT_SEC,
        idempotencyKey: `vera-held:${dispatchParams.idempotencyKey}`,
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
  });
}
