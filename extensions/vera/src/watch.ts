import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openVeraMemoryFromApi } from "./memory.js";
import { runVeraCollectPass } from "./service.js";

/**
 * Google Pub/Sub push target for Gmail/Calendar watch.
 * Without a configured topic the 15-minute poll owns wakes.
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
