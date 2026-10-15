import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerMatches, readBearerSecret } from "./bearer-auth.js";
import { WHATSAPP_WINDOW_MS, whatsappWindowOpen } from "./collector.js";
import type { WakeState } from "./memory-contract.js";

export type AdaStatus = {
  ok: true;
  now: string;
  lastCollectAt: string | null;
  lastCollectAgeSec: number | null;
  lastDigestAt: string | null;
  heldPlan: {
    held: boolean;
    heldSince: string | null;
    ageSec: number | null;
  };
  window: {
    state: "open" | "closed" | "never_opened";
    lastLawyerInboundAt: string | null;
    expiresAt: string | null;
  };
};

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function ageSec(ms: number | null, nowMs: number): number | null {
  return ms === null ? null : Math.max(0, Math.round((nowMs - ms) / 1000));
}

export function buildAdaStatus(wake: WakeState, now: Date): AdaStatus {
  const nowMs = now.getTime();
  const inboundMs = wake.lastLawyerInboundAtMs;
  const windowState =
    inboundMs === null ? "never_opened" : whatsappWindowOpen(inboundMs, nowMs) ? "open" : "closed";
  return {
    ok: true,
    now: now.toISOString(),
    lastCollectAt: iso(wake.lastCollectAtMs),
    lastCollectAgeSec: ageSec(wake.lastCollectAtMs, nowMs),
    lastDigestAt: iso(wake.lastDigestAtMs),
    heldPlan: {
      held: wake.heldPlanJson !== null,
      heldSince: iso(wake.heldPlanJson === null ? null : wake.heldPlanAtMs),
      ageSec: wake.heldPlanJson === null ? null : ageSec(wake.heldPlanAtMs, nowMs),
    },
    window: {
      state: windowState,
      lastLawyerInboundAt: iso(inboundMs),
      expiresAt: iso(inboundMs === null ? null : inboundMs + WHATSAPP_WINDOW_MS),
    },
  };
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

/**
 * Operator health read for alerting. Fails closed: without a configured
 * `statusToken` (16+ chars) every request is unauthorized, so the open plugin
 * route never exposes lawyer activity timing.
 */
export async function handleAdaStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    config: unknown;
    now: () => Date;
    readWake: () => Promise<WakeState>;
    log: { error: (message: string) => void };
  },
): Promise<boolean> {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    writeText(res, 405, "method not allowed");
    return true;
  }
  const expected = readBearerSecret(deps.config, "statusToken");
  if (!expected || !bearerMatches(req, expected)) {
    writeText(res, 401, "unauthorized");
    return true;
  }
  try {
    const status = buildAdaStatus(await deps.readWake(), deps.now());
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(status));
  } catch (error) {
    deps.log.error(`ada status failed: ${error instanceof Error ? error.message : "unknown"}`);
    writeText(res, 500, "status unavailable");
  }
  return true;
}
