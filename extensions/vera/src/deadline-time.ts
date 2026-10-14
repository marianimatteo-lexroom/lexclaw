const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function offsetMs(ms: number, timeZone: string): number {
  const local = localParts(ms, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Wall-clock time in `timeZone` to a UTC instant, correct across DST changes. */
export function zonedTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - offsetMs(naive, timeZone);
  const corrected = naive - offsetMs(guess, timeZone);
  if (corrected !== guess) {
    guess = corrected;
  }
  return guess;
}

export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function localIsoDate(ms: number, timeZone: string): string {
  const local = localParts(ms, timeZone);
  return isoDate(local.year, local.month, local.day);
}

export function localTimeLabel(ms: number, timeZone: string): string {
  const local = localParts(ms, timeZone);
  return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

export function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day) ? { year, month, day } : null;
}

export function addDaysIso(value: string, days: number): string {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    throw new Error(`invalid ISO date: ${value}`);
  }
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Weekday for an ISO date: 0 = Sunday. */
export function weekdayOf(value: string): number {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    throw new Error(`invalid ISO date: ${value}`);
  }
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

/** Calendar days from `from` to `to` (both ISO dates). */
export function diffDaysIso(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) {
    throw new Error("invalid ISO date");
  }
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}
