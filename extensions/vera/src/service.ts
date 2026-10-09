import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  collectDigest,
  isMorningDigestSlot,
  whatsappWindowOpen,
  type CollectResult,
} from "./collector.js";
import type { DigestPlan } from "./digest.js";
import { openVeraGoogleAccountFromApi } from "./google-account.js";
import {
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
} from "./google-api.js";
import { googleConnectConfigFrom, readGoogleConnectConfig } from "./google-connect.js";
import { openVeraMemoryFromApi, type MemoryStore } from "./memory.js";
import { buildDailyTimelineRecord, buildOnePagerRecord } from "./reconcile.js";

const POLL_MS = 15 * 60 * 1000;
const SELF_WAKE_TIMEOUT_SEC = 45;
const DEFAULT_TZ = "Europe/Rome";

export type DigestDeliveryDecision =
  | { action: "silent" }
  | { action: "batch" }
  | { action: "hold"; plan: DigestPlan }
  | { action: "dispatch"; plan: DigestPlan };

/** Decide after collectDigest: model only on dispatch. */
export function decideDigestDelivery(params: {
  result: CollectResult;
  forceMorning: boolean;
  timeZone: string;
  now: Date;
  lastLawyerInboundAtMs: number | null;
}): DigestDeliveryDecision {
  if (!params.result.plan.deliver) {
    return { action: "silent" };
  }
  const morning =
    params.forceMorning || isMorningDigestSlot(params.now, params.timeZone);
  if (!morning && !params.result.urgent) {
    return { action: "batch" };
  }
  if (!whatsappWindowOpen(params.lastLawyerInboundAtMs, params.now.getTime())) {
    return { action: "hold", plan: params.result.plan };
  }
  return { action: "dispatch", plan: params.result.plan };
}

export type VeraServiceDeps = {
  api: OpenClawPluginApi;
  now?: () => Date;
  dispatchDigestTurn?: (params: {
    plan: DigestPlan;
    sessionKey: string;
    idempotencyKey: string;
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
    messages: inbox.messages,
    events: events.events,
  };
}

export async function runVeraCollectPass(params: {
  api: OpenClawPluginApi;
  memory: MemoryStore;
  now: Date;
  forceMorning: boolean;
  dispatchDigestTurn: NonNullable<VeraServiceDeps["dispatchDigestTurn"]>;
}): Promise<{
  collected: boolean;
  delivered: boolean;
  held: boolean;
  reason?: string;
  result?: CollectResult;
}> {
  const google = await loadGoogleReads(params.api, params.now);
  if (!google.ok) {
    return { collected: false, delivered: false, held: false, reason: google.error };
  }

  const [previousGmail, previousCalendar, aliases, todos, wake, profile] = await Promise.all([
    params.memory.readGmailSnapshot(),
    params.memory.readCalendarSnapshot(),
    params.memory.listMatterAliases(),
    params.memory.listTodos(),
    params.memory.readWake(),
    params.memory.readProfile(),
  ]);

  const timeZone = profile?.timezone ?? DEFAULT_TZ;
  const result = collectDigest({
    now: params.now,
    inbox: google.messages,
    events: google.events,
    previousGmail,
    previousCalendar,
    aliases,
    todos,
  });

  await params.memory.replaceGmailSnapshot(result.gmailSnapshot);
  await params.memory.replaceCalendarSnapshot(result.calendarSnapshot);
  await params.memory.writeWake({ lastCollectAtMs: params.now.getTime() });

  const decision = decideDigestDelivery({
    result,
    forceMorning: params.forceMorning,
    timeZone,
    now: params.now,
    lastLawyerInboundAtMs: wake.lastLawyerInboundAtMs,
  });

  if (decision.action === "silent") {
    return { collected: true, delivered: false, held: false, result };
  }
  if (decision.action === "batch") {
    return { collected: true, delivered: false, held: false, result, reason: "batched_until_morning" };
  }
  if (decision.action === "hold") {
    await params.memory.writeWake({
      heldPlanJson: JSON.stringify(decision.plan),
    });
    return { collected: true, delivered: false, held: true, result, reason: "whatsapp_window_closed" };
  }

  const day = dayKey(params.now, timeZone);
  const itemIds = decision.plan.items.map((item) => item.matterId).join(",");
  const dispatch = await params.dispatchDigestTurn({
    plan: decision.plan,
    sessionKey: `hook:vera:digest:${day}`,
    idempotencyKey: `vera-digest:${day}:${itemIds}`,
  });
  if (!dispatch.ok) {
    return {
      collected: true,
      delivered: false,
      held: false,
      result,
      reason: dispatch.reason ?? "dispatch_rejected",
    };
  }
  await params.memory.writeWake({ heldPlanJson: null });
  return { collected: true, delivered: true, held: false, result };
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
      const result = await hooks.dispatchHookAgentTurn({
        name: "Vera digest",
        agentId: "main",
        sessionKey: params.sessionKey,
        message: [
          "Run the vera-morning-digest skill phrasing only.",
          "The collector already ranked the plan. Do not invent signals.",
          "Write exactly one WhatsApp message from this plan JSON, or NO_REPLY if deliver is false:",
          JSON.stringify(params.plan),
        ].join("\n"),
        externalContentSource: "email",
        deliver: true,
        timeoutSeconds: SELF_WAKE_TIMEOUT_SEC,
        idempotencyKey: params.idempotencyKey,
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    });

  api.registerService({
    id: "vera-instinct-wake",
    apiVersion: 2,
    start({ scheduler }) {
      const tick = async (forceMorning: boolean) => {
        try {
          const memory = await openVeraMemoryFromApi(api);
          const pass = await runVeraCollectPass({
            api,
            memory,
            now: now(),
            forceMorning,
            dispatchDigestTurn,
          });
          if (pass.held) {
            api.logger.info("vera held digest: WhatsApp window closed");
          } else if (pass.delivered) {
            api.logger.info("vera digest dispatched");
          } else if (pass.collected && pass.result && !pass.result.plan.deliver) {
            api.logger.info("vera collect silent: nothing cleared the bar");
          }
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

      scheduler.schedule({
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
      scheduler.schedule({
        id: "vera-morning",
        delayMs: delayMin * 60 * 1000,
        everyMs: 24 * 60 * 60 * 1000,
        run: () => tick(true),
      });
    },
  });
}

export async function recordLawyerInbound(params: {
  api: OpenClawPluginApi;
  atMs: number;
}): Promise<void> {
  const memory = await openVeraMemoryFromApi(params.api);
  const wake = await memory.readWake();
  await memory.writeWake({ lastLawyerInboundAtMs: params.atMs });
  if (!wake.heldPlanJson) {
    return;
  }
  let plan: DigestPlan;
  try {
    plan = JSON.parse(wake.heldPlanJson) as DigestPlan;
  } catch {
    await memory.writeWake({ heldPlanJson: null });
    return;
  }
  if (!plan || plan.deliver !== true) {
    await memory.writeWake({ heldPlanJson: null });
    return;
  }
  const hooks = params.api.runtime.hooks;
  if (!hooks?.dispatchHookAgentTurn) {
    return;
  }
  const day = dayKey(new Date(params.atMs), DEFAULT_TZ);
  const result = await hooks.dispatchHookAgentTurn({
    name: "Vera held digest",
    agentId: "main",
    sessionKey: `hook:vera:held:${day}`,
    message: [
      "Run the vera-morning-digest skill phrasing only.",
      "Deliver this held plan now that the lawyer texted:",
      JSON.stringify(plan),
    ].join("\n"),
    externalContentSource: "email",
    deliver: true,
    timeoutSeconds: SELF_WAKE_TIMEOUT_SEC,
    idempotencyKey: `vera-held:${day}`,
  });
  if (result.ok) {
    await memory.writeWake({ heldPlanJson: null });
  }
}
