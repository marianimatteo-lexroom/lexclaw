import { randomUUID } from "node:crypto";
import { createGuard, LexroomTimeoutError, type LexroomGuard } from "./lexroom-guard.js";
import type { LexroomLog, LexroomLogFields } from "./lexroom-client.js";

type FetchLike = typeof fetch;

export type Trace = (event: string, fields?: LexroomLogFields) => void;

/**
 * - `any`: every transport failure may be retried once. For idempotent requests (a GET, a login).
 * - `connect`: only a failure that proves the request never reached Lexroom. For a POST that
 *   starts paid work, where a retry after a dropped connection could run it twice.
 * - `none`: never.
 */
export type RetryPolicy = "any" | "connect" | "none";

export type LexroomRequest = {
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
};

const RETRY_BACKOFF_MS = 500;

/** Node and undici codes that mean the TCP connection was never established. */
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** One id for everything one tool call sends to Lexroom, so its log lines can be joined. */
export function newCorrelationId(): string {
  return randomUUID().slice(0, 8);
}

/** Every event carries the correlation id. A throwing sink must never change an outcome. */
export function createTrace(log: LexroomLog | undefined, cid: string): Trace {
  return (event, fields = {}) => {
    try {
      log?.(event, { cid, ...fields });
    } catch {
      // Diagnostics must never change the outcome of a Lexroom call.
    }
  };
}

/** Method and path only: never the query string, the host or a credential. */
export function endpointLabel(method: string, url: string): string {
  try {
    return `${method} ${new URL(url).pathname}`;
  } catch {
    return method;
  }
}

function errorCode(error: unknown): string {
  const record = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = record?.cause?.code ?? record?.code;
  return typeof code === "string" ? code : "";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function retryable(error: unknown, policy: RetryPolicy): boolean {
  if (error instanceof LexroomTimeoutError || isAbort(error)) {
    return false;
  }
  if (policy === "any") {
    return true;
  }
  return policy === "connect" && NEVER_SENT_CODES.has(errorCode(error));
}

/** Closes a response body that nobody finished reading, so no socket or reader stays open. */
export function closeBody(response: Response | undefined): void {
  void response?.body?.cancel().catch(() => undefined);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Sends one request under `guard`, so a hang in connecting or in waiting for headers ends as a
 * timeout. A transport failure is retried once after a short backoff when `retry` allows it.
 * A response, whatever its status, is returned as it is: a 4xx or 5xx is never retried here.
 */
export async function fetchGuarded(params: {
  fetchImpl: FetchLike;
  url: string;
  init: LexroomRequest;
  guard: LexroomGuard;
  trace: Trace;
  step: string;
  retry: RetryPolicy;
}): Promise<Response> {
  const { guard, trace, step } = params;
  const endpoint = endpointLabel(params.init.method, params.url);
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    guard.touch();
    try {
      const response = await guard.race(
        params.fetchImpl(params.url, {
          method: params.init.method,
          headers: params.init.headers,
          ...(params.init.body === undefined ? {} : { body: params.init.body }),
          signal: guard.signal,
        }),
      );
      guard.touch();
      trace(`${step}.response`, {
        endpoint,
        attempt,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        contentEncoding: response.headers.get("content-encoding") ?? "none",
        ms: Date.now() - startedAt,
        headersMs: guard.elapsedMs(),
      });
      return response;
    } catch (error) {
      if (guard.signal.aborted || attempt >= 2 || !retryable(error, params.retry)) {
        throw error;
      }
      trace(`${step}.retry`, {
        endpoint,
        attempt,
        code: errorCode(error) || "network",
        ms: Date.now() - startedAt,
        backoffMs: RETRY_BACKOFF_MS,
      });
      await guard.race(sleep(RETRY_BACKOFF_MS, guard.signal));
    }
  }
}

/**
 * Reads a JSON body under the guard, through a reader of its own so that a timeout or abort can
 * close it. A body that is not JSON is `undefined`; a timeout or abort is thrown.
 */
export async function readJsonGuarded(
  response: Response,
  guard: LexroomGuard,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await guard.race(reader.read());
      if (done) {
        break;
      }
      guard.touch();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (guard.timedOut() || isAbort(error) || guard.signal.aborted) {
      throw error;
    }
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One complete request/response exchange with its own hard deadline per attempt, covering
 * connecting, headers and the whole body. Retried once after a transport failure when `retry`
 * allows it, and after a timeout only when `retryTimeout` is set: a retry after a timeout costs
 * the whole limit again, so only requests that are cheap to repeat opt in. Throws
 * `LexroomTimeoutError` when the limit ends the last attempt; every attempt is logged.
 */
export async function exchange<T>(params: {
  fetchImpl: FetchLike;
  url: string;
  init: LexroomRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  trace: Trace;
  step: string;
  retry: RetryPolicy;
  retryTimeout?: boolean;
  read: (response: Response, guard: LexroomGuard) => Promise<T>;
}): Promise<{ status: number; ok: boolean; value: T }> {
  const { trace, step } = params;
  const endpoint = endpointLabel(params.init.method, params.url);
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    const guard = createGuard({
      idleMs: params.timeoutMs,
      totalMs: params.timeoutMs,
      signal: params.signal,
    });
    let received: Response | undefined;
    try {
      const response = await fetchGuarded({
        fetchImpl: params.fetchImpl,
        url: params.url,
        init: params.init,
        guard,
        trace,
        step,
        retry: "none",
      });
      received = response;
      const value = await params.read(response, guard);
      trace(`${step}.done`, {
        endpoint,
        attempt,
        status: response.status,
        ms: Date.now() - startedAt,
      });
      return { status: response.status, ok: response.ok, value };
    } catch (error) {
      const ms = Date.now() - startedAt;
      const kind = guard.timedOut();
      const cancelled = params.signal?.aborted === true;
      const again =
        attempt < 2 &&
        !cancelled &&
        (kind ? params.retryTimeout === true : retryable(error, params.retry));
      if (kind) {
        trace(`${step}.timeout`, { endpoint, attempt, kind, limitMs: params.timeoutMs, ms });
      } else if (!cancelled) {
        trace(`${step}.failed`, { endpoint, attempt, code: errorCode(error) || "network", ms });
      }
      if (!again) {
        throw error;
      }
      trace(`${step}.retry`, { endpoint, attempt, backoffMs: RETRY_BACKOFF_MS });
      await sleep(RETRY_BACKOFF_MS, params.signal);
    } finally {
      closeBody(received);
      guard.dispose();
    }
  }
}
