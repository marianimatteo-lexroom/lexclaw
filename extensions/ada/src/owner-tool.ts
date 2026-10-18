import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { Static, TSchema } from "typebox";
import { ownerRefusalMessage, resolveTurnOwner, type Owner } from "./owner.js";

type OwnerToolDefinition<Parameters extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: Parameters;
};

export type OwnerToolRun<Parameters extends TSchema, Config> = (
  args: Static<Parameters>,
  context: { owner: Owner; api: OpenClawPluginApi; config: Config; signal?: AbortSignal },
) => unknown;

/**
 * A tool that acts on one person's accounts or data. It is built per call, because only then does
 * the host say who is asking: the owner is the WhatsApp number of the current private chat, taken
 * from the trusted sender and session key, and `run` receives it as the only way to name a number.
 * A tool call from a group, another channel or an unknown sender never reaches `run`, and nothing
 * the model puts in the arguments can pick another owner.
 */
export function ownerToolFactory<Parameters extends TSchema, Config>(
  definition: OwnerToolDefinition<Parameters>,
  run: OwnerToolRun<Parameters, Config>,
) {
  return (context: {
    api: OpenClawPluginApi;
    config: Config;
    toolContext: OpenClawPluginToolContext;
  }): AnyAgentTool => ({
    ...definition,
    execute: async (_toolCallId, args: Static<Parameters>, signal?: AbortSignal) => {
      const turn = resolveTurnOwner({
        requesterSenderId: context.toolContext.requesterSenderId,
        messageChannel: context.toolContext.messageChannel,
        nativeChannelId: context.toolContext.nativeChannelId,
        sessionKey: context.toolContext.sessionKey,
      });
      if (!turn.ok) {
        context.api.logger.info(`ada tool refused tool=${definition.name} reason=${turn.reason}`);
        return jsonResult({
          ok: false,
          reason: "private_chat_required",
          error: ownerRefusalMessage(turn.reason),
        });
      }
      return jsonResult(
        await run(args, { owner: turn.owner, api: context.api, config: context.config, signal }),
      );
    },
  });
}
