import { readAdaEnv } from "./ada-env.js";

export const DEFAULT_LEXROOM_TIMEOUT_MS = 60_000;
/** Below this a limit is a typo, not a choice; the default applies instead. */
export const MIN_LEXROOM_TIMEOUT_MS = 1000;

/**
 * Per-request limit for every Lexroom call: how long one request may take end to end (or, for a
 * stream, how long it may stay silent). `ADA_LEXROOM_TIMEOUT_MS`, or the pre-rename
 * `VERA_LEXROOM_TIMEOUT_MS`; 60 seconds when unset or not a number of at least one second.
 */
export function lexroomTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = readAdaEnv(env, "LEXROOM_TIMEOUT_MS");
  const parsed = raw === undefined ? Number.NaN : Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= MIN_LEXROOM_TIMEOUT_MS
    ? Math.floor(parsed)
    : DEFAULT_LEXROOM_TIMEOUT_MS;
}

/** Cap on one whole research or draft call. Never below three request limits. */
export function defaultTotalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(180_000, 3 * lexroomTimeoutMs(env));
}

export function lexroomTimeoutMessage(limitMs: number): string {
  const seconds = Number((limitMs / 1000).toFixed(1));
  return `Lexroom did not respond within ${seconds}s; the request was abandoned.`;
}

/** What every Lexroom tool returns when a request outlived its limit. */
export type LexroomTimeoutFailure = {
  ok: false;
  reason: "timeout";
  message: string;
  /** Same text as `message`, for callers that read `error` on every failure. */
  error: string;
};

export function timeoutFailure(limitMs: number): LexroomTimeoutFailure {
  const message = lexroomTimeoutMessage(limitMs);
  return { ok: false, reason: "timeout", message, error: message };
}

/**
 * Settles with `promise`, or with `onTimeout()` once `ms` have passed. The last line of defense
 * for work that no request limit covers, such as a local store call: nothing waits forever.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
