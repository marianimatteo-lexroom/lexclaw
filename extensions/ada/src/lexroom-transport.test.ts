import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuard, LexroomTimeoutError } from "./lexroom-guard.js";
import {
  createTrace,
  endpointLabel,
  exchange,
  fetchGuarded,
  readJsonGuarded,
  type RetryPolicy,
} from "./lexroom-transport.js";

const URL_ = "https://api.lexroom.ai/v1/user/modules?token=abc&q=secret";
const SECRET = "bearer-secret-0123456789";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function netError(code?: string): Error {
  return Object.assign(new TypeError("fetch failed"), code ? { cause: { code } } : {});
}

function recorder() {
  const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
  const trace = createTrace((event, fields) => events.push({ event, fields }), "cid-1");
  return { events, trace };
}

function run(
  fetchImpl: typeof fetch,
  options: { retry?: RetryPolicy; retryTimeout?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const log = recorder();
  const outcome = exchange({
    fetchImpl,
    url: URL_,
    init: { method: "GET", headers: new Headers({ Authorization: `Bearer ${SECRET}` }) },
    timeoutMs: options.timeoutMs ?? 1000,
    signal: options.signal,
    trace: log.trace,
    step: "probe",
    retry: options.retry ?? "any",
    retryTimeout: options.retryTimeout,
    read: (response, guard) => readJsonGuarded(response, guard),
  });
  return { ...log, outcome };
}

describe("exchange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out an endpoint that never responds, aborts the request and leaves no timer", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    const { outcome, events } = run(fetchImpl as unknown as typeof fetch);
    const settled = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect(error).toBeInstanceOf(LexroomTimeoutError);
    expect((error as LexroomTimeoutError).limitMs).toBe(1000);
    expect(signals[0]?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.map((entry) => entry.event)).toEqual(["probe.timeout"]);
  });

  it("covers the body, not just the headers", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stalled, { status: 200 }));
    const { outcome } = run(fetchImpl as unknown as typeof fetch);
    const settled = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settled).toBeInstanceOf(LexroomTimeoutError);
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a transport failure once after a backoff, then succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(netError("ECONNRESET"))
      .mockResolvedValueOnce(json(["Civile"]));
    const { outcome, events } = run(fetchImpl);
    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toMatchObject({ status: 200, value: ["Civile"] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.map((entry) => entry.event)).toEqual([
      "probe.failed",
      "probe.retry",
      "probe.response",
      "probe.done",
    ]);
  });

  it("retries at most once", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(netError("ECONNRESET"));
    const { outcome } = run(fetchImpl);
    const settled = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await settled).toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503])(
    "returns a %i at once and never retries it",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: "no" }, status));
      const { outcome } = run(fetchImpl);
      await expect(outcome).resolves.toMatchObject({ status, ok: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a connect-level failure for a request that starts paid work, and nothing else", async () => {
    const refused = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(netError("ECONNREFUSED"))
      .mockResolvedValueOnce(json({}));
    const first = run(refused, { retry: "connect" });
    await vi.advanceTimersByTimeAsync(500);
    await expect(first.outcome).resolves.toMatchObject({ status: 200 });
    expect(refused).toHaveBeenCalledTimes(2);

    const dropped = vi.fn<typeof fetch>().mockRejectedValue(netError("ECONNRESET"));
    const second = run(dropped, { retry: "connect" });
    await expect(second.outcome).rejects.toBeInstanceOf(TypeError);
    expect(dropped).toHaveBeenCalledTimes(1);

    const none = vi.fn<typeof fetch>().mockRejectedValue(netError("ECONNREFUSED"));
    await expect(run(none, { retry: "none" }).outcome).rejects.toBeInstanceOf(TypeError);
    expect(none).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout only when asked to, and then only once", async () => {
    const hang = () => vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));

    const once = hang();
    const withRetry = run(once, { retryTimeout: true });
    const settled = withRetry.outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000 + 500 + 1000);
    expect(await settled).toBeInstanceOf(LexroomTimeoutError);
    expect(once).toHaveBeenCalledTimes(2);
    expect(withRetry.events.map((entry) => entry.event)).toEqual([
      "probe.timeout",
      "probe.retry",
      "probe.timeout",
    ]);
    expect(vi.getTimerCount()).toBe(0);

    const single = hang();
    const withoutRetry = run(single).outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await withoutRetry).toBeInstanceOf(LexroomTimeoutError);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("never retries a request the caller cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    );
    const { outcome } = run(fetchImpl as unknown as typeof fetch, {
      signal: controller.signal,
      retryTimeout: true,
    });
    const settled = outcome.catch((error: unknown) => error);
    controller.abort(new DOMException("cancelled", "AbortError"));
    const error = await settled;
    expect((error as Error).name).toBe("AbortError");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs the correlation id, endpoint, elapsed ms and outcome, and no secret", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: "no" }, 403));
    const { outcome, events } = run(fetchImpl);
    await outcome;
    expect(events.map((entry) => entry.event)).toEqual(["probe.response", "probe.done"]);
    for (const entry of events) {
      expect(entry.fields).toMatchObject({ cid: "cid-1", endpoint: "GET /v1/user/modules" });
    }
    expect(events[1]?.fields).toMatchObject({ status: 403, attempt: 1, ms: expect.any(Number) });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("token=abc");
  });

  it("does not log a failure's message, which could carry a credential", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`socket closed for Bearer ${SECRET}`));
    const { outcome, events } = run(fetchImpl, { retry: "none" });
    await expect(outcome).rejects.toThrow();
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events[0]).toMatchObject({ event: "probe.failed" });
  });
});

describe("fetchGuarded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a connect that never completes as a timeout on the shared guard", async () => {
    const guard = createGuard({ idleMs: 1000, totalMs: 5000 });
    const log = recorder();
    const sent = fetchGuarded({
      fetchImpl: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      url: URL_,
      init: { method: "POST", headers: new Headers(), body: "{}" },
      guard,
      trace: log.trace,
      step: "research",
      retry: "connect",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sent).toBeInstanceOf(LexroomTimeoutError);
    expect(guard.timedOut()).toBe("idle");
    guard.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("endpointLabel", () => {
  it("is the method and path, never the host or query", () => {
    expect(endpointLabel("POST", "https://api.lexroom.ai/v1/login?x=1#y")).toBe("POST /v1/login");
    expect(endpointLabel("GET", "not a url")).toBe("GET");
  });
});
