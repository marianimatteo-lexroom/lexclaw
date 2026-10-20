import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { windowMayBeOpen } from "./granola-reminder.js";
import { maskNumber } from "./inbound-log.js";
import type { OutlookAccountDb } from "./outlook-account-contract.js";
import { bindOutlookOwner, openAdaOutlookAccountDbFromApi } from "./outlook-account.js";
import { outlookConnectConfigFrom, prepareOutlookConnect } from "./outlook-connect.js";
import { outlookEnabled } from "./outlook-oauth.js";
import { loadOutlookAccess } from "./outlook-session.js";
import { outlookReconnectText } from "./outlook-text.js";
import { resolveLanguage } from "./research-link-outbound.js";

type ReminderApi = Pick<
  OpenClawPluginApi,
  "runtime" | "runtimeSource" | "config" | "pluginConfig" | "logger"
>;

/** The keep-alive renews a token that would expire before the next 15-minute poll. */
const KEEP_ALIVE_RENEW_WITHIN_MS = 20 * 60 * 1000;

/** Test seams: a ready store, the fetch Microsoft is reached with, and the environment. */
type ReminderDeps = { db?: OutlookAccountDb; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv };

async function sendReminder(
  api: ReminderApi,
  owner: string,
  now: Date,
  deps: ReminderDeps,
): Promise<boolean> {
  const connect = await prepareOutlookConnect({
    owner,
    config: outlookConnectConfigFrom(api.pluginConfig),
    db: deps.db ?? (await openAdaOutlookAccountDbFromApi(api)),
    now,
    force: true,
    env: deps.env,
  });
  if (!connect.ok || connect.connected) {
    return false;
  }
  const sent = await sendAdaWhatsAppText({
    api,
    to: `+${owner}`,
    text: outlookReconnectText(await resolveLanguage("", undefined, owner), connect.ask.url),
  });
  return sent.ok;
}

/**
 * A number's Outlook sign-in failed for good. The number is told at most once a day, with a fresh
 * link; a reminder that cannot go out now (closed WhatsApp window, failed send) stays owed in the
 * store and goes out when that number next writes. Nothing is asked of the model.
 */
export async function remindOutlookReconnect(
  api: ReminderApi,
  db: OutlookAccountDb,
  owner: string,
  now: Date,
  deps: Omit<ReminderDeps, "db"> = {},
): Promise<"sent" | "held" | "skipped"> {
  const store = bindOutlookOwner(db, owner);
  const nowMs = now.getTime();
  if (!(await store.claimReconnectReminder(nowMs))) {
    return "skipped";
  }
  if (
    (await windowMayBeOpen(api, owner, nowMs)) &&
    (await sendReminder(api, owner, now, { ...deps, db }))
  ) {
    await store.settleReminder();
    return "sent";
  }
  return "held";
}

/**
 * The number just wrote, so its window is open: sends the reminder that could not go out before.
 * The debt is kept in the account store, so a restart does not forget it.
 */
export async function releaseHeldOutlookReminder(
  api: ReminderApi,
  owner: string,
  nowMs: number,
  deps: ReminderDeps = {},
): Promise<void> {
  if (!outlookEnabled(deps.env)) {
    return;
  }
  const db = deps.db ?? (await openAdaOutlookAccountDbFromApi(api));
  const store = bindOutlookOwner(db, owner);
  if (!(await store.reminderOwed(nowMs))) {
    return;
  }
  if (await sendReminder(api, owner, new Date(nowMs), { ...deps, db })) {
    await store.settleReminder();
  }
}

/**
 * Runs with every 15-minute poll. Renews each connected number's token before it expires, so a
 * connection that nobody uses stays alive (Microsoft hands out a new refresh token with every
 * renewal), and starts the reminder for one Microsoft refused.
 */
export async function runOutlookKeepAlive(
  api: ReminderApi,
  now: Date,
  options: ReminderDeps = {},
): Promise<void> {
  if (!outlookEnabled(options.env)) {
    return;
  }
  const db = options.db ?? (await openAdaOutlookAccountDbFromApi(api));
  for (const owner of await db.listOwners()) {
    try {
      const access = await loadOutlookAccess({
        db,
        owner,
        nowMs: now.getTime(),
        renewWithinMs: KEEP_ALIVE_RENEW_WITHIN_MS,
        env: options.env,
        fetchImpl: options.fetchImpl,
        log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
      });
      if (!access.ok && access.reason === "reconnect") {
        await remindOutlookReconnect(api, db, owner, now, options);
      }
    } catch (error) {
      api.logger.error(
        `ada outlook keep-alive failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
}
