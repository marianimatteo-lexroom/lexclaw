import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomFailure, ResearchOutcome } from "./lexroom-client.js";
import { abortResearchJobs, readResearchJob, startResearchJob } from "./lexroom-jobs.js";
import { takeResearchLinks } from "./research-link-outbound.js";

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

  it("makes the link ready only when a finished research is read, and logs each read", async () => {
    takeResearchLinks("");
    const withLink: ResearchOutcome = {
      ...outcome,
      researchUrl: "https://app.lexroom.ai/research/r1",
    };
    const running = deferred<ResearchOutcome>();
    const started = start(() => running.promise);
    const reads = vi.fn();
    await readResearchJob({ jobId: started.jobId, waitSeconds: 0, log: reads });
    expect(takeResearchLinks("")).toEqual([]);
    running.resolve(withLink);
    await readResearchJob({ jobId: started.jobId, waitSeconds: 1, log: reads });
    expect(reads.mock.calls).toEqual([
      ["job.read", { job: started.jobId, state: "running", researchUrl: "absent" }],
      ["job.read", { job: started.jobId, state: "done", researchUrl: "present" }],
    ]);
    expect(takeResearchLinks("")).toEqual(["https://app.lexroom.ai/research/r1"]);

    const failed = start(async () => ({ ok: false, error: "no" }));
    await readResearchJob({ jobId: failed.jobId, waitSeconds: 1 });
    expect(takeResearchLinks("")).toEqual([]);
  });

  it("logs a read of a job that does not exist", async () => {
    const reads = vi.fn();
    await readResearchJob({ jobId: "rj_missing", waitSeconds: 0, log: reads });
    expect(reads).toHaveBeenCalledWith("job.read", { state: "unknown" });
  });

  describe("when code pushes the result to the lawyer", () => {
    const withLink: ResearchOutcome = {
      ...outcome,
      researchUrl: "https://app.lexroom.ai/research/r1",
    };
    const startDelivered = (
      run: () => Promise<ResearchOutcome | LexroomFailure>,
      deliver: () => Promise<"sent" | "held">,
    ) => {
      const started = startResearchJob({ matterId: "m", deadlineMs: 10_000, run, deliver, log });
      if (!started.ok) {
        throw new Error(started.message);
      }
      return started;
    };

    it("hands the model no answer to repeat, only that the lawyer has it", async () => {
      takeResearchLinks("");
      const started = startDelivered(
        async () => withLink,
        async () => "sent",
      );
      const read = await readResearchJob({ jobId: started.jobId, waitSeconds: 1 });
      expect(read).toMatchObject({
        ok: true,
        state: "delivered",
        outcome: "done",
        delivery: "sent",
        researchId: "r1",
        jobId: started.jobId,
      });
      expect(read).not.toHaveProperty("answer");
      expect(read).not.toHaveProperty("sources");
      expect(read).not.toHaveProperty("researchUrl");
      expect(JSON.stringify(read)).not.toContain("Risposta");
      expect(takeResearchLinks("")).toEqual([]);
    });

    it("already treats it as delivered while the push is still being sent", async () => {
      const sending = deferred<"sent" | "held">();
      const started = startDelivered(
        async () => withLink,
        () => sending.promise,
      );
      await expect(
        readResearchJob({ jobId: started.jobId, waitSeconds: 1 }),
      ).resolves.toMatchObject({
        state: "delivered",
        delivery: "sending",
      });
      sending.resolve("held");
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        readResearchJob({ jobId: started.jobId, waitSeconds: 0 }),
      ).resolves.toMatchObject({
        state: "delivered",
        delivery: "held",
        message: expect.stringContaining("when they next write"),
      });
    });

    it("says a failed research was delivered too", async () => {
      const started = startDelivered(
        async () => ({ ok: false, error: "no" }),
        async () => "sent",
      );
      await expect(
        readResearchJob({ jobId: started.jobId, waitSeconds: 1 }),
      ).resolves.toMatchObject({
        ok: true,
        state: "delivered",
        outcome: "failed",
      });
    });

    it("hands over the full result when the push itself broke, so nobody is left without it", async () => {
      takeResearchLinks("");
      const started = startDelivered(
        async () => withLink,
        async () => {
          throw new Error("push exploded");
        },
      );
      await readResearchJob({ jobId: started.jobId, waitSeconds: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        readResearchJob({ jobId: started.jobId, waitSeconds: 0 }),
      ).resolves.toMatchObject({
        ok: true,
        state: "done",
        answer: "Risposta [1]",
      });
      expect(takeResearchLinks("")).toEqual(["https://app.lexroom.ai/research/r1"]);
    });

    it("pushes a job that timed out, with the structured failure", async () => {
      const deliver = vi.fn(async () => "sent" as const);
      startDelivered(
        () =>
          new Promise(() => {
            // Never settles.
          }),
        deliver,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, reason: "timeout" }),
        expect.objectContaining({ id: expect.stringMatching(/^rj_/u) }),
      );
    });

    it("pushes once, even when the service stops a job that already finished", async () => {
      const deliver = vi.fn(async () => "sent" as const);
      startDelivered(async () => withLink, deliver);
      await vi.advanceTimersByTimeAsync(0);
      abortResearchJobs();
      expect(deliver).toHaveBeenCalledTimes(1);
    });
  });
});
