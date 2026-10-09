import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openVeraMemoryFromApi } from "./memory.js";
import { runVeraCollectPass } from "./service.js";

function readNotifyToken(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const token = (config as { googleNotifyToken?: unknown }).googleNotifyToken;
  return typeof token === "string" && token.trim().length >= 16 ? token.trim() : null;
}

function bearerMatches(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1] === expected;
}

/**
 * Google Pub/Sub push target. Requires `googleNotifyToken` (Bearer) so an open
 * plugin route cannot trigger model turns. Without that token the route refuses.
 */
export async function handleVeraGoogleNotify(
  req: IncomingMessage,
  res: ServerResponse,
  api: OpenClawPluginApi,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("method not allowed");
    return true;
  }
  const expected = readNotifyToken(api.pluginConfig);
  if (!expected || !bearerMatches(req, expected)) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }
  try {
    const memory = await openVeraMemoryFromApi(api);
    const hooks = api.runtime.hooks;
    await runVeraCollectPass({
      api,
      memory,
      now: new Date(),
      forceMorning: false,
      dispatchDigestTurn: async (params) => {
        if (!hooks?.dispatchHookAgentTurn) {
          return { ok: false, reason: "hooks_unavailable" };
        }
        const result = await hooks.dispatchHookAgentTurn({
          name: "Vera digest",
          agentId: "main",
          sessionKey: params.sessionKey,
          message: [
            "Run the vera-morning-digest skill phrasing only.",
            JSON.stringify(params.plan),
          ].join("\n"),
          externalContentSource: "email",
          deliver: true,
          timeoutSeconds: 45,
          idempotencyKey: params.idempotencyKey,
        });
        return result.ok ? { ok: true } : { ok: false, reason: result.reason };
      },
    });
    res.statusCode = 204;
    res.end();
  } catch (error) {
    api.logger.error(
      `vera google notify failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    res.statusCode = 500;
    res.end("notify failed");
  }
  return true;
}
