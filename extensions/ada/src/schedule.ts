const DAY_MS = 24 * 60 * 60 * 1000;

type LocalDate = { year: number; month: number; day: number };

function localParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Wall-clock offset of `timeZone` at the instant `ms`. */
function offsetMs(ms: number, timeZone: string): number {
  const local = localParts(ms, timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant of a local wall-clock time. The second pass re-reads the offset at the
 * first answer, which lands on the right side of a DST change.
 */
function zonedTimeToUtcMs(date: LocalDate, hour: number, minute: number, timeZone: string): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = naive - offsetMs(naive, timeZone);
  return naive - offsetMs(first, timeZone);
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export type DailySlot = { hour: number; minute: number };

/** The 07:40 digest slot in the lawyer's timezone. */
export const MORNING_SLOT: DailySlot = { hour: 7, minute: 40 };

/**
 * First occurrence of `slot` strictly after `afterMs`. Walks calendar days in the
 * target zone instead of adding 24 hours, so a 23- or 25-hour day keeps the slot at 07:40.
 */
export function nextSlotMs(
  afterMs: number,
  timeZone: string,
  slot: DailySlot = MORNING_SLOT,
): number {
  const today = localParts(afterMs, timeZone);
  let date: LocalDate = { year: today.year, month: today.month, day: today.day };
  for (let guard = 0; guard < 3; guard += 1) {
    const candidate = zonedTimeToUtcMs(date, slot.hour, slot.minute, timeZone);
    if (candidate > afterMs) {
      return candidate;
    }
    date = addDays(date, 1);
  }
  throw new Error(`Could not compute the next ${slot.hour}:${slot.minute} slot in ${timeZone}`);
}

/** Latest occurrence of `slot` at or before `atMs`. */
export function previousSlotMs(
  atMs: number,
  timeZone: string,
  slot: DailySlot = MORNING_SLOT,
): number {
  const today = localParts(atMs, timeZone);
  let date: LocalDate = { year: today.year, month: today.month, day: today.day };
  for (let guard = 0; guard < 3; guard += 1) {
    const candidate = zonedTimeToUtcMs(date, slot.hour, slot.minute, timeZone);
    if (candidate <= atMs) {
      return candidate;
    }
    date = addDays(date, -1);
  }
  throw new Error(`Could not compute the previous ${slot.hour}:${slot.minute} slot in ${timeZone}`);
}
