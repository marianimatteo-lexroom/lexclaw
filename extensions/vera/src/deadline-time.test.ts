import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  diffDaysIso,
  isValidCalendarDate,
  localIsoDate,
  localTimeLabel,
  weekdayOf,
  zonedTimeToUtcMs,
} from "./deadline-time.js";

const ROME = "Europe/Rome";

describe("zonedTimeToUtcMs", () => {
  it("applies CEST before the October change and CET after it", () => {
    expect(new Date(zonedTimeToUtcMs(ROME, 2026, 10, 24, 9, 0)).toISOString()).toBe(
      "2026-10-24T07:00:00.000Z",
    );
    expect(new Date(zonedTimeToUtcMs(ROME, 2026, 10, 26, 9, 0)).toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
  });

  it("applies CET before the March change and CEST after it", () => {
    expect(new Date(zonedTimeToUtcMs(ROME, 2026, 3, 28, 9, 0)).toISOString()).toBe(
      "2026-03-28T08:00:00.000Z",
    );
    expect(new Date(zonedTimeToUtcMs(ROME, 2026, 3, 30, 9, 0)).toISOString()).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });

  it("round-trips through the local date and time labels", () => {
    const ms = zonedTimeToUtcMs(ROME, 2026, 11, 12, 9, 30);
    expect(localIsoDate(ms, ROME)).toBe("2026-11-12");
    expect(localTimeLabel(ms, ROME)).toBe("09:30");
  });

  it("keeps a late evening UTC instant on the next Rome day", () => {
    expect(localIsoDate(Date.parse("2026-11-12T23:30:00.000Z"), ROME)).toBe("2026-11-13");
  });
});

describe("iso date helpers", () => {
  it("rejects impossible calendar dates and honors leap years", () => {
    expect(isValidCalendarDate(2027, 2, 29)).toBe(false);
    expect(isValidCalendarDate(2028, 2, 29)).toBe(true);
    expect(isValidCalendarDate(2026, 4, 31)).toBe(false);
    expect(isValidCalendarDate(2026, 13, 1)).toBe(false);
  });

  it("shifts across month and year ends", () => {
    expect(addDaysIso("2026-12-30", 5)).toBe("2027-01-04");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
    expect(diffDaysIso("2026-10-14", "2026-11-12")).toBe(29);
    expect(weekdayOf("2026-11-12")).toBe(4);
  });
});
