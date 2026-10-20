import { randomBytes } from "node:crypto";
import type { LexroomFailure, ResearchOutcome } from "./lexroom-client.js";
import type { LexroomLog } from "./lexroom-log.js";
import { timeoutFailure, withDeadline } from "./lexroom-timeout.js";
import { markResearchLinkReady } from "./research-link-outbound.js";

/**
 * A Lexroom research run takes about 80 seconds and can take minutes, longer than a chat turn
 * should hold a tool call open. `ada_research` therefore starts a job and returns its handle at
 * once, and `ada_research_status` reads the result.
 *
 * Jobs live in this process only. A running request cannot survive a restart, so there is
 * nothing durable to store; a handle that is gone after a restart is reported as unknown and
 * the research is started again. The registry is bounded, and the Ada service aborts every
 * running job when it stops, so no job outlives the plugin that started it.
 */
const MAX_RUNNING_JOBS = 4;
const MAX_RETAINED_JOBS = 50;
const RETENTION_MS = 60 * 60 * 1000;
const MAX_WAIT_SECONDS = 30;
const DEFAULT_WAIT_SECONDS = 15;

export type ResearchJobFailure =
  | LexroomFailure
  | { ok: false; reason: "unknown_job" | "busy"; error: string; message: string };

type Settled = ResearchOutcome | LexroomFailure;

type Job = {
  id: string;
  matterId: string;
  /** The WhatsApp number that started it; only that number may read it. */
  owner: string;
  startedAtMs: number;
  finishedAtMs?: number;
  controller: AbortController;
  /** Resolves when the job has a result, however it got one. */
  settled: Promise<void>;
  /** Records the result. Only the first call counts. */
  settle: (result: Settled) => void;
  result?: Settled;
  /**
   * What became of the result when code pushes it to the requester. While it is set, they have
   * the result or is about to, so `ada_research_status` must not hand the model the answer to say
   * a second time.
   */
  delivery?: "sending" | "sent" | "held";
};

const jobs = new Map<string, Job>();

function failure(
  reason: "unknown_job" | "busy",
  message: string,
): Extract<ResearchJobFailure, { reason: "unknown_job" | "busy" }> {
  return { ok: false, reason, error: message, message };
}

function prune(nowMs: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAtMs !== undefined && nowMs - job.finishedAtMs > RETENTION_MS) {
      jobs.delete(id);
    }
  }
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_RETAINED_JOBS) {
      return;
    }
    if (job.finishedAtMs !== undefined) {
      jobs.delete(id);
    }
  }
}

/**
 * True while `owner` has a research running, or had one end less than `graceMs` ago: they are
 * about to get, or just got, its answer from Ada herself.
 */
export function ownerResearchActive(owner: string, nowMs = Date.now(), graceMs = 120_000): boolean {
  for (const job of jobs.values()) {
    if (
      job.owner === owner &&
      (job.finishedAtMs === undefined || nowMs - job.finishedAtMs <= graceMs)
    ) {
      return true;
    }
  }
  return false;
}

function runningCount(): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.finishedAtMs === undefined) {
      count += 1;
    }
  }
  return count;
}

/**
 * Aborts every running job and fails it at once, even if its work ignores the abort. Called
 * when the Ada service stops, so no job is left running by a plugin that is no longer there.
 */
export function abortResearchJobs(): void {
  for (const job of jobs.values()) {
    if (job.finishedAtMs === undefined) {
      job.controller.abort(new DOMException("Ada stopped", "AbortError"));
      job.settle({
        ok: false,
        error: "Ada stopped before the research finished. Start it again with ada_research.",
      });
    }
  }
}

/**
 * Starts `run` in the background and returns its handle immediately. `run` gets a signal that
 * aborts when the job's deadline passes or the service stops, and must hand it to every
 * request it makes. Nothing here waits on Lexroom.
 */
export function startResearchJob(params: {
  matterId: string;
  /** The WhatsApp number that asked; only that number can read the job. */
  owner: string;
  deadlineMs: number;
  run: (signal: AbortSignal) => Promise<Settled>;
  log: LexroomLog;
  /** Pushes the result to the requester when the job ends, however it ends. */
  deliver?: (result: Settled, job: { id: string; startedAtMs: number }) => Promise<"sent" | "held">;
  now?: () => number;
}) {
  const now = params.now ?? Date.now;
  prune(now());
  if (runningCount() >= MAX_RUNNING_JOBS) {
    return failure(
      "busy",
      "Ada is already running several Lexroom researches. Check them with ada_research_status first.",
    );
  }
  const { log, deadlineMs } = params;
  const controller = new AbortController();
  const id = `rj_${randomBytes(6).toString("hex")}`;
  const startedAtMs = now();
  let resolveSettled: () => void = () => undefined;
  const job: Job = {
    id,
    matterId: params.matterId,
    owner: params.owner,
    startedAtMs,
    controller,
    settled: new Promise<void>((resolve) => {
      resolveSettled = resolve;
    }),
    settle(result) {
      if (job.finishedAtMs !== undefined) {
        return;
      }
      job.result = result;
      job.finishedAtMs = now();
      if (params.deliver) {
        job.delivery = "sending";
        params
          .deliver(result, { id, startedAtMs })
          .then((delivery) => {
            job.delivery = delivery;
          })
          .catch(() => {
            // The push itself broke, so nobody has the result: let a status read hand it over.
            job.delivery = undefined;
          });
      }
      log("job.finished", {
        job: id,
        ok: result.ok,
        ...(result.ok ? {} : { reason: result.reason ?? "error" }),
        ms: job.finishedAtMs - startedAtMs,
      });
      resolveSettled();
    },
  };
  const run = params.run(controller.signal).catch((error: unknown): LexroomFailure => ({
    ok: false,
    error: error instanceof Error ? error.message.slice(0, 200) : "Lexroom research failed",
  }));
  void withDeadline(run, deadlineMs, (): LexroomFailure => {
    controller.abort(new DOMException("Research deadline", "AbortError"));
    return timeoutFailure(deadlineMs);
  }).then(job.settle);
  jobs.set(id, job);
  log("job.started", { job: id, deadlineMs });
  return {
    ok: true as const,
    state: "running" as const,
    jobId: id,
    matterId: params.matterId,
    message:
      "Research started in the background. Tell the lawyer it is running, then call ada_research_status with this jobId to read the answer.",
  };
}

const DELIVERY_NOTE: Record<NonNullable<Job["delivery"]>, string> = {
  sending: "Ada is sending the requester this research result on WhatsApp right now.",
  sent: "Ada already sent the requester this research result on WhatsApp.",
  held: "Ada will send the requester this research result on WhatsApp when they next write, because the 24-hour window is closed.",
};

function snapshot(job: Job, nowMs: number) {
  if (job.result === undefined) {
    const elapsedSec = Math.round((nowMs - job.startedAtMs) / 1000);
    return {
      ok: true as const,
      state: "running" as const,
      jobId: job.id,
      matterId: job.matterId,
      elapsedSec,
      message: `Research is still running (${elapsedSec}s). Call ada_research_status again with this jobId.`,
    };
  }
  if (job.delivery) {
    return {
      ok: true as const,
      state: "delivered" as const,
      jobId: job.id,
      matterId: job.matterId,
      outcome: job.result.ok ? ("done" as const) : ("failed" as const),
      delivery: job.delivery,
      ...(job.result.ok && job.result.researchId ? { researchId: job.result.researchId } : {}),
      message: `${DELIVERY_NOTE[job.delivery]} Do not repeat the answer or its sources. For a follow-up question call ada_research with parentResearchId set to researchId.`,
    };
  }
  return {
    ...job.result,
    jobId: job.id,
    state: job.result.ok ? ("done" as const) : ("failed" as const),
  };
}

/**
 * ada_research_status: the state of one research job. With `waitSeconds` it waits at most that
 * long (never more than 30) for the job to finish, so a model need not poll in a tight loop.
 */
export async function readResearchJob(params: {
  jobId: string;
  /** The WhatsApp number reading; a job is read by the number that started it, and by no other. */
  requester: string;
  waitSeconds?: number;
  now?: () => number;
  log?: LexroomLog;
}) {
  const now = params.now ?? Date.now;
  const found = jobs.get(params.jobId.trim());
  const job = found && found.owner === params.requester ? found : undefined;
  if (!job) {
    params.log?.("job.read", { state: "unknown" });
    return failure(
      "unknown_job",
      "No research job has this id. It may have expired or Ada restarted; start the research again with ada_research.",
    );
  }
  const waitMs =
    Math.min(Math.max(params.waitSeconds ?? DEFAULT_WAIT_SECONDS, 0), MAX_WAIT_SECONDS) * 1000;
  if (job.result === undefined && waitMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      job.settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }
  const view = snapshot(job, now());
  const url = "researchUrl" in view ? view.researchUrl : undefined;
  if (url) {
    // The model now holds this research, so the next final reply must end with its link.
    markResearchLinkReady(url, job.owner, now());
  }
  params.log?.("job.read", {
    job: job.id,
    state: view.state,
    researchUrl: url ? "present" : "absent",
  });
  return view;
}
