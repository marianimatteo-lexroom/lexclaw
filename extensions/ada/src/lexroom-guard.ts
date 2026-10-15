import { lexroomTimeoutMessage } from "./lexroom-timeout.js";

/** `answer`: the stream was alive but never produced answer text within the answer limit. */
export type TimeoutKind = "idle" | "total" | "answer";

export class LexroomTimeoutError extends Error {
  constructor(
    readonly kind: TimeoutKind,
    /** The limit that tripped, in milliseconds. */
    readonly limitMs: number,
  ) {
    super(lexroomTimeoutMessage(limitMs));
    this.name = "LexroomTimeoutError";
  }
}

export type LexroomGuard = {
  /** Aborts the fetch and its body when a limit trips, the caller cancels, or the guard is disposed. */
  signal: AbortSignal;
  /** Progress was seen; restarts the idle clock. */
  touch(): void;
  /** The milestone the answer limit waits for has happened; that limit stops applying. */
  endAnswerWait(): void;
  /**
   * Settles with `promise`, or rejects as soon as a limit trips. The abort alone is not
   * trusted to unblock a pending read, so every network await goes through here.
   */
  race<T>(promise: Promise<T>): Promise<T>;
  elapsedMs(): number;
  timedOut(): TimeoutKind | undefined;
  dispose(): void;
};

/**
 * One guard covers a whole Lexroom operation (selectors, stream, stored-draft fetch).
 * `idleMs` bounds silence between progress signals, `totalMs` bounds the operation.
 */
export function createGuard(options: {
  idleMs: number;
  totalMs: number;
  /** Optional earlier limit on reaching the first answer text, lifted by endAnswerWait(). */
  answerMs?: number;
  signal?: AbortSignal;
}): LexroomGuard {
  const controller = new AbortController();
  const startedAt = Date.now();
  let expiredKind: TimeoutKind | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectExpired: (error: unknown) => void = () => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectExpired = reject;
  });
  expired.catch(() => undefined);

  const stop = (reason: unknown) => {
    controller.abort(reason);
    rejectExpired(reason);
  };
  const expire = (kind: TimeoutKind, limitMs: number) => {
    if (expiredKind || controller.signal.aborted) {
      return;
    }
    expiredKind = kind;
    stop(new LexroomTimeoutError(kind, limitMs));
  };
  const totalTimer = setTimeout(() => expire("total", options.totalMs), options.totalMs);
  const answerTimer =
    options.answerMs === undefined
      ? undefined
      : setTimeout(() => expire("answer", options.answerMs ?? 0), options.answerMs);
  const touch = () => {
    if (expiredKind || controller.signal.aborted) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire("idle", options.idleMs), options.idleMs);
  };
  const callerAborted = () =>
    stop(options.signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
  if (options.signal?.aborted) {
    callerAborted();
  } else {
    options.signal?.addEventListener("abort", callerAborted, { once: true });
  }
  touch();

  return {
    signal: controller.signal,
    touch,
    endAnswerWait: () => clearTimeout(answerTimer),
    race(promise) {
      promise.catch(() => undefined);
      return Promise.race([promise, expired]);
    },
    elapsedMs: () => Date.now() - startedAt,
    timedOut: () => expiredKind,
    dispose() {
      clearTimeout(totalTimer);
      clearTimeout(answerTimer);
      clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", callerAborted);
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Lexroom request finished", "AbortError"));
      }
    },
  };
}
