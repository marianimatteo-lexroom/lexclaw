import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readAdaEnv } from "./ada-env.js";
import { ADA_WHATSAPP_CHANNEL } from "./google-notify.js";
import { logInboundSkip } from "./inbound-log.js";
import {
  firstString,
  kapsoMessagesEndpoint,
  postKapsoMessage,
  resolveKapsoAccount,
} from "./kapso-api.js";
import { normalizeWhatsAppNumber } from "./whatsapp-number.js";
import { isWhatsAppMessageId } from "./whatsapp-read.js";

const REACTION_TIMEOUT_MS = 5_000;
/** A reply that finishes inside this window never shows the thinking emoji. */
const THINKING_DELAY_MS = 1_000;

export type StatusReactionSettings = {
  ack: string;
  /** Null: no emoji while the model works, so the ack stays the only one shown. */
  thinking: string | null;
  /** Empty: the ack is removed when the run ends, which WhatsApp does with an empty emoji. */
  done: string;
  /** Empty: removed like `done`; a failed or declined run never shows a success mark. */
  error: string;
};

/**
 * Null when `ADA_STATUS_REACTIONS=false`; the default is on. By default the inbound message shows
 * 👀 while Ada works and nothing afterwards: no ⏳, no ✅ and no ❌. Setting `ADA_REACTION_THINKING`,
 * `ADA_REACTION_DONE` or `ADA_REACTION_ERROR` to an emoji turns that one back on.
 */
export function readStatusReactionSettings(env: NodeJS.ProcessEnv): StatusReactionSettings | null {
  if (readAdaEnv(env, "STATUS_REACTIONS")?.trim().toLowerCase() === "false") {
    return null;
  }
  return {
    ack: firstString(readAdaEnv(env, "REACTION_ACK")) ?? "👀",
    thinking: firstString(readAdaEnv(env, "REACTION_THINKING")) ?? null,
    done: firstString(readAdaEnv(env, "REACTION_DONE")) ?? "",
    error: firstString(readAdaEnv(env, "REACTION_ERROR")) ?? "",
  };
}

type Run = {
  messageId: string;
  to: string;
  accountId?: string;
  /** Bound from the first user-triggered agent hook; later hooks of other runs are ignored. */
  runId?: string;
  last?: string;
  finished: boolean;
  thinkingScheduled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Sends are chained so a slow request can never land after the emoji that replaces it. */
  chain: Promise<void>;
};

/**
 * Best-effort status reactions on the inbound WhatsApp message, sent straight through Kapso
 * because the channel plugin cannot send reactions. WhatsApp keeps one reaction per message,
 * so every send replaces the previous emoji. Nothing here throws or is awaited by a hook.
 */
export function createStatusReactions(deps: {
  config: () => unknown;
  logger: { warn(message: string): void; info?(message: string): void };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  thinkingDelayMs?: number;
}) {
  const runs = new Map<string, Run>();
  const env = () => deps.env ?? process.env;

  function enqueue(run: Run, emoji: string): Promise<void> {
    if (run.last === emoji) {
      return run.chain;
    }
    run.last = emoji;
    run.chain = run.chain.then(async () => {
      try {
        const account = resolveKapsoAccount(deps.config(), run.accountId, env());
        const endpoint = account.enabled === false ? null : kapsoMessagesEndpoint(account);
        if (!endpoint) {
          return;
        }
        if (!endpoint.ok) {
          if (endpoint.reason === "invalid") {
            deps.logger.warn(`ada whatsapp reaction skipped: ${endpoint.error}`);
          }
          return;
        }
        const posted = await postKapsoMessage({
          endpoint,
          body: {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: run.to,
            type: "reaction",
            reaction: { message_id: run.messageId, emoji },
          },
          timeoutMs: REACTION_TIMEOUT_MS,
          fetchImpl: deps.fetchImpl,
        });
        if (!posted.ok) {
          deps.logger.warn(
            `ada whatsapp reaction failed: ${posted.kind === "http" ? `HTTP ${posted.status}` : posted.kind}`,
          );
        }
      } catch {
        deps.logger.warn("ada whatsapp reaction failed: unexpected error");
      }
    });
    return run.chain;
  }

  function stop(run: Run) {
    run.finished = true;
    clearTimeout(run.timer);
    run.timer = undefined;
  }

  function matching(sessionKey: string | undefined, runId: string | undefined): Run | undefined {
    const run = sessionKey ? runs.get(sessionKey) : undefined;
    if (!run || run.finished || (run.runId && runId && run.runId !== runId)) {
      return undefined;
    }
    return run;
  }

  return {
    /** Inbound message: react 👀 and make it the target of this session's status. */
    received(params: {
      sessionKey?: string;
      channelId?: string;
      accountId?: string;
      messageId?: string;
      senders: unknown[];
    }): void {
      const settings = readStatusReactionSettings(env());
      const messageId = params.messageId?.trim() ?? "";
      const to = params.senders.map(normalizeWhatsAppNumber).find((value) => value !== null);
      const skip = (reason: string) =>
        logInboundSkip(deps.logger, {
          stage: "reaction",
          reason,
          sender: to ?? params.senders,
          messageId,
        });
      if (!settings) {
        return skip("reactions_disabled");
      }
      if (params.channelId !== ADA_WHATSAPP_CHANNEL) {
        return skip("not_whatsapp_channel");
      }
      if (!params.sessionKey) {
        return skip("no_session_key");
      }
      if (!isWhatsAppMessageId(messageId)) {
        return skip("not_a_whatsapp_message_id");
      }
      if (!to) {
        return skip("sender_not_a_phone_number");
      }
      const previous = runs.get(params.sessionKey);
      if (previous) {
        stop(previous);
      }
      const run: Run = {
        messageId,
        to,
        accountId: params.accountId,
        finished: false,
        thinkingScheduled: false,
        chain: Promise.resolve(),
      };
      runs.set(params.sessionKey, run);
      void enqueue(run, settings.ack);
    },

    /** Agent run start or tool call: show ⏳ unless the run finishes within the debounce window. */
    thinking(params: {
      sessionKey?: string;
      runId?: string;
      trigger?: string;
      bind?: boolean;
    }): void {
      const settings = readStatusReactionSettings(env());
      const run = matching(params.sessionKey, params.runId);
      if (!settings || !run || (params.trigger && params.trigger !== "user")) {
        return;
      }
      if (params.bind && params.runId && !run.runId) {
        run.runId = params.runId;
      }
      if (settings.thinking === null || run.thinkingScheduled || !run.runId) {
        return;
      }
      run.thinkingScheduled = true;
      const { thinking } = settings;
      run.timer = setTimeout(() => {
        run.timer = undefined;
        if (!run.finished) {
          void enqueue(run, thinking);
        }
      }, deps.thinkingDelayMs ?? THINKING_DELAY_MS);
      run.timer.unref?.();
    },

    /** Agent run end: ✅ on success, ❌ on error. Returns once the final emoji was attempted. */
    async finished(params: {
      sessionKey?: string;
      runId?: string;
      trigger?: string;
      success: boolean;
    }): Promise<void> {
      const settings = readStatusReactionSettings(env());
      const run = matching(params.sessionKey, params.runId);
      if (!settings || !run || (params.trigger && params.trigger !== "user")) {
        return;
      }
      stop(run);
      await enqueue(run, params.success ? settings.done : settings.error);
      if (params.sessionKey && runs.get(params.sessionKey) === run) {
        runs.delete(params.sessionKey);
      }
    },
  };
}

/** Wire the agent lifecycle hooks; the caller feeds inbound messages to the returned `received`. */
export function registerStatusReactionHooks(api: OpenClawPluginApi) {
  const reactions = createStatusReactions({ config: () => api.config, logger: api.logger });
  api.on("llm_input", (event, ctx) => {
    reactions.thinking({
      sessionKey: ctx.sessionKey,
      runId: event.runId,
      trigger: ctx.trigger,
      bind: true,
    });
  });
  api.on("before_tool_call", (event, ctx) => {
    reactions.thinking({ sessionKey: ctx.sessionKey, runId: event.runId ?? ctx.runId });
  });
  api.on("agent_end", (event, ctx) => {
    if (!event.success && (!ctx.trigger || ctx.trigger === "user")) {
      logInboundSkip(api.logger, {
        stage: "agent_run",
        reason: "run_failed_without_reply",
        sender: ctx.senderId ?? (ctx.sessionKey ? ctx.sessionKey.split(":") : undefined),
      });
    }
    void reactions.finished({
      sessionKey: ctx.sessionKey,
      runId: event.runId ?? ctx.runId,
      trigger: ctx.trigger,
      success: event.success,
    });
  });
  return reactions;
}
