import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { WHATSAPP_WINDOW_MS } from "./collector.js";
import type { WakeState } from "./memory-contract.js";
import { buildAdaStatus, handleAdaStatus, type AdaStatus } from "./status.js";

const TOKEN = "status-token-0123456789";
const NOW = new Date("2026-10-14T09:00:00.000Z");

function wake(patch: Partial<WakeState> = {}): WakeState {
  return {
    lastLawyerInboundAtMs: null,
    lastReconcileAtMs: null,
    lastCollectAtMs: null,
    lastDigestAtMs: null,
    lastMorningBriefAtMs: null,
    lastConnectNudgeAtMs: null,
    heldPlanJson: null,
    heldPlanAtMs: null,
    watchExpirationMs: null,
    openTodoIdsJson: null,
    ...patch,
  };
}

function call(params: {
  method?: string;
  authorization?: string;
  config?: unknown;
  wake?: WakeState;
  failWith?: Error;
}) {
  const headers = new Map<string, string>();
  let body = "";
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const req = {
    method: params.method ?? "GET",
    headers: params.authorization ? { authorization: params.authorization } : {},
  } as unknown as IncomingMessage;
  const readWake = vi.fn(async () => {
    if (params.failWith) {
      throw params.failWith;
    }
    return params.wake ?? wake();
  });
  const log = { error: vi.fn() };
  const done = handleAdaStatus(req, res, {
    config: "config" in params ? params.config : { statusToken: TOKEN },
    now: () => NOW,
    readWake,
    log,
  });
  return { res, headers, body: () => body, readWake, log, done };
}

describe("buildAdaStatus", () => {
  it("reports nulls and a never-opened window before anything has happened", () => {
    expect(buildAdaStatus(wake(), NOW)).toEqual({
      ok: true,
      now: NOW.toISOString(),
      lastCollectAt: null,
      lastCollectAgeSec: null,
      lastDigestAt: null,
      heldPlan: { held: false, heldSince: null, ageSec: null },
      window: { state: "never_opened", lastLawyerInboundAt: null, expiresAt: null },
    });
  });

  it("reports collect age, held plan age, and an open window", () => {
    const inbound = NOW.getTime() - 60 * 60 * 1000;
    const status = buildAdaStatus(
      wake({
        lastCollectAtMs: NOW.getTime() - 5 * 60 * 1000,
        lastDigestAtMs: NOW.getTime() - 3 * 60 * 60 * 1000,
        heldPlanJson: "{}",
        heldPlanAtMs: NOW.getTime() - 90 * 60 * 1000,
        lastLawyerInboundAtMs: inbound,
      }),
      NOW,
    );
    expect(status.lastCollectAt).toBe("2026-10-14T08:55:00.000Z");
    expect(status.lastCollectAgeSec).toBe(300);
    expect(status.lastDigestAt).toBe("2026-10-14T06:00:00.000Z");
    expect(status.heldPlan).toEqual({
      held: true,
      heldSince: "2026-10-14T07:30:00.000Z",
      ageSec: 5400,
    });
    expect(status.window).toEqual({
      state: "open",
      lastLawyerInboundAt: new Date(inbound).toISOString(),
      expiresAt: new Date(inbound + WHATSAPP_WINDOW_MS).toISOString(),
    });
  });

  it("reports a closed window and tolerates a held plan without a timestamp", () => {
    const status = buildAdaStatus(
      wake({
        heldPlanJson: "{}",
        lastLawyerInboundAtMs: NOW.getTime() - WHATSAPP_WINDOW_MS - 1,
      }),
      NOW,
    );
    expect(status.window.state).toBe("closed");
    expect(status.heldPlan).toEqual({ held: true, heldSince: null, ageSec: null });
  });
});

describe("GET /ada/status", () => {
  it("returns the status JSON for a matching bearer token", async () => {
    const t = call({
      authorization: `Bearer ${TOKEN}`,
      wake: wake({ lastCollectAtMs: NOW.getTime() - 1000 }),
    });
    await expect(t.done).resolves.toBe(true);
    expect(t.res.statusCode).toBe(200);
    expect(t.headers.get("content-type")).toContain("application/json");
    expect(t.headers.get("cache-control")).toBe("no-store");
    const parsed = JSON.parse(t.body()) as AdaStatus;
    expect(parsed.lastCollectAgeSec).toBe(1);
    expect(parsed.window.state).toBe("never_opened");
  });

  it.each([
    ["no authorization header", undefined],
    ["a wrong token", "Bearer status-token-wrong-0000"],
    ["a shorter token", `Bearer ${TOKEN.slice(0, 17)}`],
    ["a non-bearer scheme", `Basic ${TOKEN}`],
  ])("rejects %s without reading memory", async (_label, authorization) => {
    const t = call({ authorization });
    await t.done;
    expect(t.res.statusCode).toBe(401);
    expect(t.body()).toBe("unauthorized");
    expect(t.readWake).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", {}],
    ["too short", { statusToken: "short" }],
  ])("fails closed when statusToken is %s", async (_label, config) => {
    const t = call({ config, authorization: "Bearer short" });
    await t.done;
    expect(t.res.statusCode).toBe(401);
    expect(t.readWake).not.toHaveBeenCalled();
  });

  it("rejects other methods", async () => {
    const t = call({ method: "POST", authorization: `Bearer ${TOKEN}` });
    await t.done;
    expect(t.res.statusCode).toBe(405);
    expect(t.headers.get("allow")).toBe("GET");
  });

  it("returns 500 without leaking the error when memory fails", async () => {
    const t = call({
      authorization: `Bearer ${TOKEN}`,
      failWith: new Error("disk path /secret"),
    });
    await t.done;
    expect(t.res.statusCode).toBe(500);
    expect(t.body()).toBe("status unavailable");
    expect(t.log.error).toHaveBeenCalledWith("ada status failed: disk path /secret");
  });
});
