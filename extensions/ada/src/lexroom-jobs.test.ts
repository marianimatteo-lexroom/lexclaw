import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomFailure, ResearchOutcome } from "./lexroom-client.js";
import { abortResearchJobs, readResearchJob, startResearchJob } from "./lexroom-jobs.js";

const outcome: ResearchOutcome = {
  ok: true,
  matterId: "m",
  researchId: "r1",
  status: "DONE",
  answer: "Risposta [1]",
  sources: [{ id: 1, title: "Cass. 1/2024" }],
};

const log = vi.fn();

function start(
  run: (signal: AbortSignal) => Promise<ResearchOutcome | LexroomFailure>,
  deadlineMs = 10_000,
) {
  const started = startResearchJob({ matterId: "m", deadlineMs, run, log });
  if (!started.ok) {
    throw new Error(started.message);
  }
  return started;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("research jobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    log.mockClear();
  });
  afterEach(() => {
    abortResearchJobs();
    vi.useRealTimers();
  });

  it("acknowledges at once with a handle while the research is still running", async () => {
    const research = deferred<ResearchOutcome>();
    const started = start(() => research.promise);
    expect(started).toMatchObject({ ok: true, state: "running", matterId: "m" });
    expect(started.jobId).toMatch(/^rj_[0-9a-f]{12}$/u);
    await expect(readResearchJob({ jobId: started.jobId, waitSeconds: 0 })).resolves.toMatchObject({
      ok: true,
      state: "running",
      jobId: started.jobId,
    });
    research.resolve(outcome);
    await expect(readResearchJob({ jobId: started.jobId, waitSeconds: 1 })).resolves.toEqual({
      ...outcome,
      jobId: started.jobId,
      state: "done",
    });
  });

  it("waits up to waitSeconds for the result and returns early when it arrives", async () => {
    const research = deferred<ResearchOutcome>();
    const started = start(() => research.promise);
    const waiting = readResearchJob({ jobId: started.jobId, waitSeconds: 20 });
    await vi.advanceTimersByTimeAsync(5000);
    research.resolve(outcome);
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      state: "done",
      answer: "Risposta [1]",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns running, not an error, when the wait ends first, and never waits past 30 seconds", async () => {
    const started = start(
      () =>
        new Promise(() => {
          // Never settles.
        }),
      600_000,
    );
    const waiting = readResearchJob({ jobId: started.jobId, waitSeconds: 500 });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(waiting).resolves.toMatchObject({ ok: true, state: "running", elapsedSec: 30 });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reports a failure with its reason", async () => {
    const started = start(async () => ({
      ok: false,
      reason: "not_connected",
      error: "Lexroom is not connected.",
    }));
    await expect(readResearchJob({ jobId: started.jobId, waitSeconds: 1 })).resolves.toEqual({
      ok: false,
      reason: "not_connected",
      error: "Lexroom is not connected.",
      jobId: started.jobId,
      state: "failed",
    });
  });

  it("turns a thrown error into a failed job rather than a pending one", async () => {
    const started = start(async () => {
      throw new Error("store exploded");
    });
    await expect(readResearchJob({ jobId: started.jobId, waitSeconds: 1 })).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: "store exploded",
    });
  });

  it("declares a job that never settles timed out at its deadline, and aborts it", async () => {
    let signal: AbortSignal | undefined;
    const started = start((jobSignal) => {
      signal = jobSignal;
      return new Promise(() => {
        // Never settles.
      });
    }, 5000);
    const waiting = readResearchJob({ jobId: started.jobId, waitSeconds: 30 });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(waiting).resolves.toEqual({
      ok: false,
      reason: "timeout",
      message: "Lexroom did not respond within 5s; the request was abandoned.",
      error: "Lexroom did not respond within 5s; the request was abandoned.",
      jobId: started.jobId,
      state: "failed",
    });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts running jobs when the service stops", async () => {
    let signal: AbortSignal | undefined;
    start((jobSignal) => {
      signal = jobSignal;
      return new Promise(() => {
        // Never settles.
      });
    }, 600_000);
    abortResearchJobs();
    expect(signal?.aborted).toBe(true);
  });

  it("fails them at once when they ignore the abort, so none stays running", async () => {
    const started = start(
      () =>
        new Promise(() => {
          // Never settles.
        }),
      600_000,
    );
    abortResearchJobs();
    await expect(readResearchJob({ jobId: started.jobId, waitSeconds: 0 })).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: expect.stringContaining("Ada stopped"),
    });
  });

  it("answers an unknown handle plainly", async () => {
    await expect(readResearchJob({ jobId: "rj_nope", waitSeconds: 0 })).resolves.toMatchObject({
      ok: false,
      reason: "unknown_job",
    });
  });

  it("limits how many researches run at once, and frees a slot when one ends", async () => {
    const open = Array.from({ length: 4 }, () => deferred<ResearchOutcome>());
    const handles = open.map((research) => start(() => research.promise));
    const refused = startResearchJob({
      matterId: "m",
      deadlineMs: 10_000,
      run: async () => outcome,
      log,
    });
    expect(refused).toMatchObject({ ok: false, reason: "busy" });
    open[0]?.resolve(outcome);
    await readResearchJob({ jobId: handles[0]?.jobId ?? "", waitSeconds: 1 });
    expect(
      startResearchJob({ matterId: "m", deadlineMs: 10_000, run: async () => outcome, log }),
    ).toMatchObject({ ok: true });
    for (const research of open) {
      research.resolve(outcome);
    }
  });

  it("forgets finished jobs after an hour", async () => {
    const started = start(async () => outcome);
    await readResearchJob({ jobId: started.jobId, waitSeconds: 1 });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    start(async () => outcome);
    await expect(readResearchJob({ jobId: started.jobId, waitSeconds: 0 })).resolves.toMatchObject({
      ok: false,
      reason: "unknown_job",
    });
  });

  it("logs each job's start and end without the question or the answer", async () => {
    const started = start(async () => outcome);
    await readResearchJob({ jobId: started.jobId, waitSeconds: 1 });
    expect(log.mock.calls.map(([event]) => event)).toEqual(["job.started", "job.finished"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Risposta");
  });
});
