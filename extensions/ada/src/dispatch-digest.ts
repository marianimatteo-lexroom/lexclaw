import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { noteConnectOffer } from "./connect-offers.js";
import {
  digestOfferDetail,
  renderDigestText,
  renderGoogleConnectText,
  renderQuietBriefText,
} from "./digest-text.js";
import type { DigestPlan } from "./digest.js";
import { googleConnectConfigFrom } from "./google-connect.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { executeAdaGoogleConnect } from "./google-tools.js";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import type { QuietBrief } from "./quiet-brief.js";
import { resolveLanguage } from "./research-link-outbound.js";
import { effectiveTimeZone } from "./schedule.js";

export type DigestDispatchRequest = {
  /** The WhatsApp number this digest is for: the only number it is ever sent to. */
  owner: string;
  plan: DigestPlan;
  /** With a plan that has nothing urgent: the short brief to send instead of staying silent. */
  brief?: QuietBrief;
  idempotencyKey: string;
  /** Ask the owner to connect Google instead of sending a digest. */
  connectOnly?: boolean;
  /** With `connectOnly`: the saved Google sign-in expired, so the ask says so. */
  reconnect?: boolean;
  /** The owner just texted, so the WhatsApp window is open for this send. */
  afterLawyerReply?: boolean;
};

export type DigestDispatchResult = { ok: boolean; reason?: string };

const SENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Digests already sent in this process, so a pass that retries after a late failure never repeats one. */
const sent = new Map<string, number>();

function alreadySent(key: string, nowMs: number): boolean {
  for (const [known, at] of sent) {
    if (nowMs - at > SENT_TTL_MS) {
      sent.delete(known);
    }
  }
  return sent.has(key);
}

/** Forgets what was sent. For tests: this state is shared by the whole process. */
export function clearSentDigests(): void {
  sent.clear();
}

/**
 * The one place Ada sends a digest or the Google connect ask: straight to `request.owner`'s
 * WhatsApp number, with that number's own connect link and profile language. No model turn is
 * involved, so nothing can deliver it to anyone else.
 */
export async function dispatchDigest(
  api: Pick<OpenClawPluginApi, "runtime" | "runtimeSource" | "config" | "logger" | "pluginConfig">,
  request: DigestDispatchRequest,
): Promise<DigestDispatchResult> {
  const nowMs = Date.now();
  const key = request.afterLawyerReply ? `held:${request.idempotencyKey}` : request.idempotencyKey;
  if (alreadySent(key, nowMs)) {
    return { ok: true };
  }
  const memory = await openAdaMemoryIfExistsFromApi(api, request.owner);
  const profile = await memory?.readProfile();
  const language = await resolveLanguage("", async () => profile?.language, request.owner);
  let text: string;
  if (request.connectOnly) {
    const connect = await executeAdaGoogleConnect(
      request.owner,
      googleConnectConfigFrom(api.pluginConfig),
      api,
    );
    if (!connect.ok || connect.connected) {
      return { ok: false, reason: connect.ok ? "already_connected" : "connect_unavailable" };
    }
    text = renderGoogleConnectText(
      language,
      connect.ask.url,
      request.reconnect ? "expired" : "connect",
    );
  } else if (request.plan.deliver) {
    text = renderDigestText(request.plan, language, effectiveTimeZone(profile?.timezone));
  } else if (request.brief) {
    text = renderQuietBriefText(request.brief, language);
  } else {
    return { ok: false, reason: "nothing_to_send" };
  }
  const result = await sendAdaWhatsAppText({ api, to: `+${request.owner}`, text });
  if (!result.ok) {
    return { ok: false, reason: result.error };
  }
  sent.set(key, nowMs);
  if (!request.connectOnly && request.plan.deliver) {
    noteConnectOffer(request.owner, "digest", Date.now(), digestOfferDetail(request.plan));
  }
  return { ok: true };
}
