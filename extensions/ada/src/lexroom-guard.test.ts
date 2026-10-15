import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuard, LexroomTimeoutError } from "./lexroom-guard.js";

function never(): Promise<never> {
  return new Promise<never>((_resolve, _reject) => {
    // Settles only if the guard rejects it first.
  });
}

describe("createGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires after the idle limit and aborts the signal", async () => {
    const guard = createGuard({ idleMs: 45_000, totalMs: 180_000 });
    const pending = guard.race(never());
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(guard.timedOut()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.timedOut()).toBe("idle");
    expect(guard.signal.aborted).toBe(true);
    const error = await outcome;
    expect(error).toBeInstanceOf(LexroomTimeoutError);
    expect((error as Error).message).toBe(
      "Lexroom did not respond within 45s; the request was abandoned.",
    );
    guard.dispose();
  });

  it("keeps a live stream going but still stops it at the total cap", async () => {
    const guard = createGuard({ idleMs: 45_000, totalMs: 180_000 });
    for (let elapsed = 0; elapsed < 150_000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      guard.touch();
    }
    expect(guard.timedOut()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(guard.timedOut()).toBe("total");
    guard.dispose();
  });

  it("stops a stream that stays busy but never reaches an answer, until the answer arrives", async () => {
    const waiting = createGuard({ idleMs: 45_000, totalMs: 180_000, answerMs: 60_000 });
    for (let elapsed = 0; elapsed < 55_000; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      waiting.touch();
    }
    expect(waiting.timedOut()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(waiting.timedOut()).toBe("answer");
    waiting.dispose();

    const answered = createGuard({ idleMs: 45_000, totalMs: 180_000, answerMs: 60_000 });
    await vi.advanceTimersByTimeAsync(40_000);
    answered.touch();
    answered.endAnswerWait();
    for (let elapsed = 0; elapsed < 80_000; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      answered.touch();
    }
    expect(answered.timedOut()).toBeUndefined();
    answered.dispose();
  });

  it("reports cancellation as an abort, not a timeout", async () => {
    const caller = new AbortController();
    const guard = createGuard({ idleMs: 45_000, totalMs: 180_000, signal: caller.signal });
    const outcome = guard.race(never()).catch((error: unknown) => error);
    caller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(guard.timedOut()).toBeUndefined();
    guard.dispose();
  });

  it("leaves no timers behind once disposed", () => {
    const guard = createGuard({ idleMs: 45_000, totalMs: 180_000 });
    guard.touch();
    guard.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(guard.signal.aborted).toBe(true);
  });
});
