import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { appendAssistantMirrorMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { maskNumber } from "./inbound-log.js";
import { sessionKeyOwner } from "./owner.js";
import { ADA_WHATSAPP_CHANNEL } from "./whatsapp-number.js";

/**
 * A text Ada's code sends (the morning brief, a digest, a research result, a connect
 * confirmation, a reminder, an announcement) is not part of the model's conversation, so a reply
 * such as "make it shorter" would reach a model that never saw it. The sender writes what it sent
 * into the number's session as an assistant turn right after delivery. It is best effort: a
 * number with no session yet has nothing to write into, and a failure never undoes the send.
 */

/** A conversation Ada has with one number: where a code-sent text is written down. */
export type WhatsAppSession = { owner: string; sessionKey: string; sessionId: string };

type SessionApi = Pick<OpenClawPluginApi, "runtime" | "config">;

/**
 * The numbers Ada has a private WhatsApp conversation with: one per direct session of the channel,
 * the most recently used when a number has several.
 */
export function listWhatsAppSessions(api: SessionApi): WhatsAppSession[] {
  const latest = new Map<string, WhatsAppSession & { updatedAt: number }>();
  // The session store is per agent and refuses a listing that names none.
  const entries = listAgentIds(api.config).flatMap((agentId) =>
    api.runtime.agent.session.listSessionEntries({
      agentId,
      readOnly: true,
      includeParticipants: false,
    }),
  );
  for (const { sessionKey, entry } of entries) {
    const owner = sessionKeyOwner(sessionKey);
    if (!owner || !sessionKey.split(":").includes(ADA_WHATSAPP_CHANNEL) || !entry.sessionId) {
      continue;
    }
    const updatedAt = entry.updatedAt ?? 0;
    if (updatedAt >= (latest.get(owner)?.updatedAt ?? -1)) {
      latest.set(owner, { owner, sessionKey, sessionId: entry.sessionId, updatedAt });
    }
  }
  return [...latest.values()]
    .toSorted((a, b) => a.owner.localeCompare(b.owner))
    .map(({ owner, sessionKey, sessionId }) => ({ owner, sessionKey, sessionId }));
}

/** Writes `text` into one session as something Ada said. `key` makes a repeat harmless. */
export async function mirrorToSession(
  session: { sessionKey: string; sessionId: string },
  text: string,
  key: string,
): Promise<boolean> {
  const result = await appendAssistantMirrorMessageByIdentity({
    agentId: resolveAgentIdFromSessionKey(session.sessionKey),
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    text,
    idempotencyKey: key,
    updateMode: "none",
  });
  return result.ok;
}

/** Like `mirrorToSession`, for a session key whose id is not known yet: false when it has none. */
export async function mirrorToSessionKey(
  api: Pick<OpenClawPluginApi, "runtime">,
  sessionKey: string,
  text: string,
  key: string,
): Promise<boolean> {
  const { session } = api.runtime.agent;
  const entry = await (
    session.getSessionEntryAsync ?? ((params) => session.getSessionEntry(params))
  )({ agentId: resolveAgentIdFromSessionKey(sessionKey), sessionKey });
  return entry?.sessionId
    ? await mirrorToSession({ sessionKey, sessionId: entry.sessionId }, text, key)
    : false;
}

/**
 * Writes what Ada just sent to `owner` into that number's own session. Never throws; returns
 * whether the text is now in the conversation.
 */
export async function mirrorSentText(
  api: SessionApi & Pick<OpenClawPluginApi, "logger">,
  owner: string,
  text: string,
  key: string,
): Promise<boolean> {
  try {
    const session = listWhatsAppSessions(api).find((candidate) => candidate.owner === owner);
    return session ? await mirrorToSession(session, text, key) : false;
  } catch (error) {
    api.logger.warn(
      `ada sent text not in history owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}
