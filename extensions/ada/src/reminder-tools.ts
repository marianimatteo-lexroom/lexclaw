import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  isValidCalendarDate,
  localIsoDate,
  localTimeLabel,
  zonedTimeToUtcMs,
} from "./deadline-time.js";
import { maskNumber } from "./inbound-log.js";
import { openAdaMemoryFromApi } from "./memory.js";
import {
  listReminders,
  MAX_REMINDERS,
  REMINDER_TEXT_MAX,
  removeReminder,
  saveReminder,
} from "./proactive-store.js";
import { effectiveTimeZone } from "./schedule.js";

type ReminderApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

const LOCAL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/u;
/** A reminder further out than this is almost certainly a mistaken date. */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** The instant a reminder time names: in the person's own zone unless it carries an offset. */
export function parseReminderTime(at: string, timeZone: string): number | null {
  const match = LOCAL_TIME.exec(at.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, offset] = match.map((part) => part ?? "");
  const parts = [year, month, day, hour, minute].map(Number);
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0] = parts;
  if (!isValidCalendarDate(y, mo, d) || h > 23 || mi > 59) {
    return null;
  }
  if (!offset) {
    return zonedTimeToUtcMs(timeZone, y, mo, d, h, mi);
  }
  const zone = offset === "Z" ? "Z" : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
  const ms = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00${zone}`);
  return Number.isFinite(ms) ? ms : null;
}

const localLabel = (ms: number, timeZone: string) =>
  `${localIsoDate(ms, timeZone)} ${localTimeLabel(ms, timeZone)}`;

/** What the model must tell the person about when a reminder can arrive. */
const TIMING_NOTE =
  "Reminders are checked every 15 minutes, so it can arrive up to about 15 minutes after that time. If they have not written to you in the last 24 hours, WhatsApp only allows a short notice and the reminder itself arrives as soon as they reply.";

async function ownerContext(api: ReminderApi, owner: string) {
  const memory = await openAdaMemoryFromApi(api, owner);
  return { memory, timeZone: effectiveTimeZone((await memory.readProfile())?.timezone) };
}

/** Saves one reminder under the asking number's own memory. */
export async function executeAdaSetReminder(
  api: ReminderApi,
  owner: string,
  params: { at: string; text: string },
  now: Date = new Date(),
) {
  const text = params.text.replace(/\s+/gu, " ").trim();
  if (!text || text.length > REMINDER_TEXT_MAX) {
    return {
      ok: false as const,
      error: `The reminder must be one short text of at most ${REMINDER_TEXT_MAX} characters.`,
    };
  }
  try {
    const { memory, timeZone } = await ownerContext(api, owner);
    const dueAtMs = parseReminderTime(params.at, timeZone);
    if (dueAtMs === null) {
      return {
        ok: false as const,
        error:
          "Pass at as a local date and time, YYYY-MM-DDTHH:MM. Ask the person for the time if they gave none.",
      };
    }
    if (dueAtMs <= now.getTime()) {
      return { ok: false as const, error: "That time has already passed. Ask for a later one." };
    }
    if (dueAtMs - now.getTime() > MAX_AHEAD_MS) {
      return {
        ok: false as const,
        error: "That is more than a year away. Check the date with them.",
      };
    }
    if ((await listReminders(memory)).length >= MAX_REMINDERS) {
      return {
        ok: false as const,
        error: `Already ${MAX_REMINDERS} reminders are waiting. Ask which one to cancel, then call ada_cancel_reminder.`,
      };
    }
    const id = `r${randomUUID().slice(0, 8)}`;
    await saveReminder(
      memory,
      { id, text, dueAtMs, createdAtMs: now.getTime(), state: "pending" },
      now.getTime(),
    );
    return {
      ok: true as const,
      id,
      text,
      dueAt: localLabel(dueAtMs, timeZone),
      timeZone,
      note: TIMING_NOTE,
    };
  } catch (error) {
    api.logger.error(
      `ada reminder not saved owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not save the reminder." };
  }
}

/** The reminders of the asking number that have not been delivered. */
export async function executeAdaListReminders(api: ReminderApi, owner: string) {
  try {
    const { memory, timeZone } = await ownerContext(api, owner);
    return {
      ok: true as const,
      timeZone,
      reminders: (await listReminders(memory)).map((reminder) => ({
        id: reminder.id,
        text: reminder.text,
        dueAt: localLabel(reminder.dueAtMs, timeZone),
        status: reminder.state === "ready" ? "due, sent when they next write" : "waiting",
      })),
      note: TIMING_NOTE,
    };
  } catch (error) {
    api.logger.error(
      `ada reminders not listed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not read the reminders." };
  }
}

/** Cancels one reminder of the asking number. */
export async function executeAdaCancelReminder(
  api: ReminderApi,
  owner: string,
  params: { id: string },
) {
  try {
    const { memory } = await ownerContext(api, owner);
    const removed = await removeReminder(memory, params.id.trim());
    return removed
      ? { ok: true as const, id: params.id.trim() }
      : {
          ok: false as const,
          error: "No reminder has that id. Call ada_list_reminders for the ids.",
        };
  } catch (error) {
    api.logger.error(
      `ada reminder not cancelled owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not cancel the reminder." };
  }
}
