import { describe, expect, it } from "vitest";
import { effectiveTimeZone, nextSlotMs, previousSlotMs } from "./schedule.js";

const ROME = "Europe/Rome";
const SHANGHAI = "Asia/Shanghai";

describe("nextSlotMs", () => {
  it("picks today's 07:40 when it is still ahead, tomorrow's when it has passed", () => {
    // 2026-10-06: Rome is on CEST (UTC+2), so 07:40 local is 05:40Z.
    expect(new Date(nextSlotMs(Date.parse("2026-10-06T03:00:00Z"), ROME)).toISOString()).toBe(
      "2026-10-06T05:40:00.000Z",
    );
    expect(new Date(nextSlotMs(Date.parse("2026-10-06T05:40:00Z"), ROME)).toISOString()).toBe(
      "2026-10-07T05:40:00.000Z",
    );
    expect(new Date(nextSlotMs(Date.parse("2026-10-06T05:39:59.999Z"), ROME)).toISOString()).toBe(
      "2026-10-06T05:40:00.000Z",
    );
  });

  it("keeps 07:40 local across the spring-forward day (23-hour day)", () => {
    // Rome springs forward on 2026-03-29: 07:40 is 06:40Z before and 05:40Z after.
    const before = Date.parse("2026-03-28T06:40:00Z");
    const after = nextSlotMs(before, ROME);
    expect(new Date(after).toISOString()).toBe("2026-03-29T05:40:00.000Z");
    expect(after - before).toBe(23 * 60 * 60 * 1000);
    expect(new Date(nextSlotMs(after, ROME)).toISOString()).toBe("2026-03-30T05:40:00.000Z");
  });

  it("keeps 07:40 local across the fall-back day (25-hour day)", () => {
    // Rome falls back on 2026-10-25: 07:40 is 05:40Z before and 06:40Z after.
    const before = Date.parse("2026-10-24T05:40:00Z");
    const after = nextSlotMs(before, ROME);
    expect(new Date(after).toISOString()).toBe("2026-10-25T06:40:00.000Z");
    expect(after - before).toBe(25 * 60 * 60 * 1000);
  });

  it("is not fooled by the night the clocks change", () => {
    // Started at 01:30 local on spring-forward night: the slot is still that morning.
    expect(new Date(nextSlotMs(Date.parse("2026-03-29T00:30:00Z"), ROME)).toISOString()).toBe(
      "2026-03-29T05:40:00.000Z",
    );
    // 02:30 local happens twice on fall-back night; both resolve to that morning's slot.
    expect(new Date(nextSlotMs(Date.parse("2026-10-25T00:30:00Z"), ROME)).toISOString()).toBe(
      "2026-10-25T06:40:00.000Z",
    );
    expect(new Date(nextSlotMs(Date.parse("2026-10-25T01:30:00Z"), ROME)).toISOString()).toBe(
      "2026-10-25T06:40:00.000Z",
    );
  });

  it("follows the lawyer's timezone rather than Rome's", () => {
    // New York springs forward on 2026-03-08: EST (UTC-5) before, EDT (UTC-4) after.
    expect(
      new Date(nextSlotMs(Date.parse("2026-03-07T12:40:00Z"), "America/New_York")).toISOString(),
    ).toBe("2026-03-08T11:40:00.000Z");
  });
});

describe("one instant, two clocks", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("gives Shanghai (UTC+8, no DST) and Rome their own 07:40", () => {
    const at = Date.parse("2026-10-06T03:00:00Z");
    expect(iso(nextSlotMs(at, SHANGHAI))).toBe("2026-10-06T23:40:00.000Z");
    expect(iso(nextSlotMs(at, ROME))).toBe("2026-10-06T05:40:00.000Z");
  });

  it("moves Rome by an hour on 25 October 2026 and leaves Shanghai alone", () => {
    const beforeChange = Date.parse("2026-10-24T12:00:00Z");
    expect(iso(nextSlotMs(beforeChange, ROME))).toBe("2026-10-25T06:40:00.000Z");
    expect(iso(nextSlotMs(beforeChange, SHANGHAI))).toBe("2026-10-24T23:40:00.000Z");
    const afterRome = Date.parse("2026-10-25T06:40:00Z");
    expect(iso(nextSlotMs(afterRome, ROME))).toBe("2026-10-26T06:40:00.000Z");
    expect(iso(nextSlotMs(afterRome, SHANGHAI))).toBe("2026-10-25T23:40:00.000Z");
  });

  it("finds Shanghai's latest slot, which falls on the previous UTC day", () => {
    expect(iso(previousSlotMs(Date.parse("2026-10-06T03:00:00Z"), SHANGHAI))).toBe(
      "2026-10-05T23:40:00.000Z",
    );
    expect(iso(previousSlotMs(Date.parse("2026-10-06T03:00:00Z"), ROME))).toBe(
      "2026-10-05T05:40:00.000Z",
    );
  });
});

describe("effectiveTimeZone", () => {
  it("uses the profile zone, and Europe/Rome when there is none or it is not a zone", () => {
    expect(effectiveTimeZone(SHANGHAI)).toBe(SHANGHAI);
    expect(effectiveTimeZone(null)).toBe(ROME);
    expect(effectiveTimeZone(undefined)).toBe(ROME);
    expect(effectiveTimeZone("")).toBe(ROME);
    expect(effectiveTimeZone("Mars/Olympus")).toBe(ROME);
  });
});

describe("previousSlotMs", () => {
  it("returns the latest slot at or before now", () => {
    expect(new Date(previousSlotMs(Date.parse("2026-10-06T05:40:00Z"), ROME)).toISOString()).toBe(
      "2026-10-06T05:40:00.000Z",
    );
    expect(new Date(previousSlotMs(Date.parse("2026-10-06T05:39:00Z"), ROME)).toISOString()).toBe(
      "2026-10-05T05:40:00.000Z",
    );
    expect(new Date(previousSlotMs(Date.parse("2026-03-29T07:00:00Z"), ROME)).toISOString()).toBe(
      "2026-03-29T05:40:00.000Z",
    );
    expect(new Date(previousSlotMs(Date.parse("2026-03-29T05:00:00Z"), ROME)).toISOString()).toBe(
      "2026-03-28T06:40:00.000Z",
    );
  });
});
