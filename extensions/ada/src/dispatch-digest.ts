import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { DigestPlan } from "./digest.js";

export const DIGEST_TURN_TIMEOUT_SECONDS = 45;

export type DigestDispatchRequest = {
  plan: DigestPlan;
  sessionKey: string;
  idempotencyKey: string;
  /** Ask the lawyer to connect Google instead of phrasing a digest. */
  connectOnly?: boolean;
  /** The lawyer just texted, so the WhatsApp window is open for this send. */
  afterLawyerReply?: boolean;
};

export type DigestDispatchResult = { ok: boolean; reason?: string };

function digestMessage(request: DigestDispatchRequest): string {
  if (request.connectOnly) {
    return "Follow the ada-google-connect skill now. Do not invent a digest.";
  }
  return [
    "Run the ada-morning-digest skill phrasing only.",
    "The collector already ranked the plan. Do not invent signals.",
    request.afterLawyerReply
      ? "The lawyer just texted; write exactly one WhatsApp message from this fresh plan JSON, or NO_REPLY if deliver is false:"
      : "Write exactly one WhatsApp message from this plan JSON, or NO_REPLY if deliver is false:",
    JSON.stringify(request.plan),
  ].join("\n");
}

/** The one place Ada starts an isolated digest turn. */
export async function dispatchDigest(
  api: Pick<OpenClawPluginApi, "runtime">,
  request: DigestDispatchRequest,
): Promise<DigestDispatchResult> {
  const hooks = api.runtime.hooks;
  if (!hooks?.dispatchHookAgentTurn) {
    return { ok: false, reason: "hooks_unavailable" };
  }
  const result = await hooks.dispatchHookAgentTurn({
    name: request.connectOnly
      ? "Ada Google connect"
      : request.afterLawyerReply
        ? "Ada held digest"
        : "Ada digest",
    agentId: "main",
    sessionKey: request.sessionKey,
    message: digestMessage(request),
    externalContentSource: "email",
    deliver: true,
    timeoutSeconds: DIGEST_TURN_TIMEOUT_SECONDS,
    idempotencyKey: request.afterLawyerReply
      ? `vera-held:${request.idempotencyKey}`
      : request.idempotencyKey,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
