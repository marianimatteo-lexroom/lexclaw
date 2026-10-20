import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { whatsappWindowOpen } from "./collector.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import type { GranolaAccountDb } from "./granola-account-contract.js";
import { bindGranolaOwner, openAdaGranolaAccountDbFromApi } from "./granola-account.js";
import { granolaConnectConfigFrom, prepareGranolaConnect } from "./granola-connect.js";
import { loadGranolaAccess } from "./granola-session.js";
import { granolaReconnectText } from "./granola-text.js";
import { maskNumber } from "./inbound-log.js";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import { resolveLanguage } from "./research-link-outbound.js";
import { lastSenderInboundAt } from "./research-push.js";

type ReminderApi = Pick<
  OpenClawPluginApi,
  "runtime" | "runtimeSource" | "config" | "pluginConfig" | "logger"
>;

/** The keep-alive renews a token that would expire before the next 15-minute poll. */
const KEEP_ALIVE_RENEW_WITHIN_MS = 20 * 60 * 1000;
const HELD_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_HELD = 1000;

/** Numbers whose reconnect reminder is owed but could not go out yet; sent when they next write. */
const held = new Map<string, number>();

function hold(owner: string, nowMs: number): void {
  held.delete(owner);
  held.set(owner, nowMs);
  if (held.size > MAX_HELD) {
    held.delete(held.keys().next().value ?? owner);
  }
}

export function clearHeldGranolaReminders(): void {
  held.clear();
}

/** A disconnected number is owed no reminder. */
export function forgetHeldGranolaReminder(owner: string): void {
  held.delete(owner);
}

/** The owner's WhatsApp window: false only when this process or the wake row knows it closed. */
async function windowMayBeOpen(api: ReminderApi, owner: string, nowMs: number): Promise<boolean> {
  const memory = await openAdaMemoryIfExistsFromApi(api, owner).catch(() => null);
  const wake = memory ? await memory.readWake() : null;
  const inbound = Math.max(lastSenderInboundAt(owner) ?? 0, wake?.lastLawyerInboundAtMs ?? 0);
  return inbound === 0 || whatsappWindowOpen(inbound, nowMs);
}

/** Test seams: a ready store and the fetch Granola's servers are reached with. */
type ReminderDeps = { db?: GranolaAccountDb; fetchImpl?: typeof fetch };

async function sendReminder(
  api: ReminderApi,
  owner: string,
  now: Date,
  deps: ReminderDeps,
): Promise<boolean> {
  const connect = await prepareGranolaConnect({
    owner,
    config: granolaConnectConfigFrom(api.pluginConfig),
    db: deps.db ?? (await openAdaGranolaAccountDbFromApi(api)),
    now,
    force: true,
    fetchImpl: deps.fetchImpl,
  });
  if (!connect.ok || connect.connected) {
    return false;
  }
  const sent = await sendAdaWhatsAppText({
    api,
    to: `+${owner}`,
    text: granolaReconnectText(await resolveLanguage("", undefined, owner), connect.ask.url),
  });
  return sent.ok;
}

/**
 * A number's Granola sign-in failed for good. The number is told at most once a day, with a fresh
 * link; a reminder that cannot go out now (closed WhatsApp window, failed
 * send) waits for that number's next message. Nothing is asked of the model.
 */
export async function remindGranolaReconnect(
  api: ReminderApi,
  db: GranolaAccountDb,
  owner: string,
  now: Date,
  deps: Omit<ReminderDeps, "db"> = {},
): Promise<"sent" | "held" | "skipped"> {
  const store = bindGranolaOwner(db, owner);
  const nowMs = now.getTime();
  if (!(await store.claimReconnectReminder(nowMs))) {
    return "skipped";
  }
  if (
    (await windowMayBeOpen(api, owner, nowMs)) &&
    (await sendReminder(api, owner, now, { ...deps, db }))
  ) {
    return "sent";
  }
  hold(owner, nowMs);
  return "held";
}

/** The number just wrote, so its window is open: sends a reminder that was waiting for it. */
export async function releaseHeldGranolaReminder(
  api: ReminderApi,
  owner: string,
  nowMs: number,
  deps: ReminderDeps = {},
): Promise<void> {
  const heldAtMs = held.get(owner);
  held.delete(owner);
  if (heldAtMs === undefined || nowMs - heldAtMs > HELD_TTL_MS) {
    return;
  }
  if (!(await sendReminder(api, owner, new Date(nowMs), deps))) {
    hold(owner, heldAtMs);
  }
}

/**
 * Runs with every 15-minute poll. Renews each connected number's token before it expires, so a
 * connection that nobody uses stays alive, and starts the reminder for one Granola refused.
 */
export async function runGranolaKeepAlive(
  api: ReminderApi,
  now: Date,
  options: ReminderDeps = {},
): Promise<void> {
  const db = options.db ?? (await openAdaGranolaAccountDbFromApi(api));
  for (const owner of await db.listOwners()) {
    try {
      const access = await loadGranolaAccess({
        db,
        owner,
        nowMs: now.getTime(),
        renewWithinMs: KEEP_ALIVE_RENEW_WITHIN_MS,
        fetchImpl: options.fetchImpl,
        log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
      });
      if (!access.ok && access.reason === "reconnect") {
        await remindGranolaReconnect(api, db, owner, now, { fetchImpl: options.fetchImpl });
      }
    } catch (error) {
      api.logger.error(
        `ada granola keep-alive failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
}
