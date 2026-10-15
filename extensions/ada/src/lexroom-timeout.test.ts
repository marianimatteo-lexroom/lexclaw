import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultTotalTimeoutMs,
  lexroomTimeoutMessage,
  lexroomTimeoutMs,
  timeoutFailure,
  withDeadline,
} from "./lexroom-timeout.js";

describe("lexroomTimeoutMs", () => {
  it("defaults to 60 seconds", () => {
    expect(lexroomTimeoutMs({})).toBe(60_000);
  });

  it("reads ADA_LEXROOM_TIMEOUT_MS, then the pre-rename VERA_ one", () => {
    expect(lexroomTimeoutMs({ ADA_LEXROOM_TIMEOUT_MS: "15000" })).toBe(15_000);
    expect(lexroomTimeoutMs({ VERA_LEXROOM_TIMEOUT_MS: "20000" })).toBe(20_000);
    expect(
      lexroomTimeoutMs({ ADA_LEXROOM_TIMEOUT_MS: "15000", VERA_LEXROOM_TIMEOUT_MS: "20000" }),
    ).toBe(15_000);
  });

  it.each(["", "  ", "soon", "0", "-5", "999", "NaN"])("ignores %j", (value) => {
    expect(lexroomTimeoutMs({ ADA_LEXROOM_TIMEOUT_MS: value })).toBe(60_000);
  });

  it("falls through a blank ADA_ value to the VERA_ one", () => {
    expect(lexroomTimeoutMs({ ADA_LEXROOM_TIMEOUT_MS: " ", VERA_LEXROOM_TIMEOUT_MS: "30000" })).toBe(
      30_000,
    );
  });

  it("keeps the total cap at least three request limits", () => {
    expect(defaultTotalTimeoutMs({})).toBe(180_000);
    expect(defaultTotalTimeoutMs({ ADA_LEXROOM_TIMEOUT_MS: "120000" })).toBe(360_000);
  });
});

describe("the timeout result", () => {
  it("names the limit in whole or tenths of seconds", () => {
    expect(lexroomTimeoutMessage(60_000)).toBe(
      "Lexroom did not respond within 60s; the request was abandoned.",
    );
    expect(lexroomTimeoutMessage(2500)).toBe(
      "Lexroom did not respond within 2.5s; the request was abandoned.",
    );
  });

  it("is {ok:false, reason:'timeout', message}", () => {
    expect(timeoutFailure(60_000)).toEqual({
      ok: false,
      reason: "timeout",
      message: "Lexroom did not respond within 60s; the request was abandoned.",
      error: "Lexroom did not respond within 60s; the request was abandoned.",
    });
  });
});

describe("withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles with the promise and leaves no timer behind", async () => {
    await expect(withDeadline(Promise.resolve("done"), 1000, () => "late")).resolves.toBe("done");
    await expect(
      withDeadline(Promise.reject(new Error("boom")), 1000, () => "late"),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles with the fallback when the promise never does", async () => {
    const pending = withDeadline(new Promise<string>(() => undefined), 1000, () => "late");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe("late");
    expect(vi.getTimerCount()).toBe(0);
  });
});
