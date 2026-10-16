import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
import type { LexroomConfig } from "./lexroom-client.js";
import { startAdaResearch } from "./lexroom-tools.js";

/** The model-facing definition of `ada_research`, shared by its static metadata and its factory. */
export const researchToolDefinition = {
  name: "ada_research",
  label: "Lexroom research",
  description:
    "Start Lexroom research for one matter. It runs in the background for one to three minutes and returns a jobId at once. When the lawyer asked, Ada has already told them on WhatsApp that it is running and sends the answer, the sources and the link to the Lexroom app herself when it is ready: do not poll, do not write a link, and end that turn with exactly NO_REPLY. Only when the result has no lawyerNotified field (the lawyer did not ask, so Ada sends them nothing) call ada_research_status with the jobId to read the answer; even when lawyerNotified is false Ada still sends the answer herself. Pass modules (for example Civile) to pick what is searched; otherwise every module the Lexroom user may search is used. Pass libraryDocumentIds only for documents that belong to that matter. The private library is not searched unless those ids are present.",
  parameters: Type.Object(
    {
      matterId: Type.String({ minLength: 1 }),
      query: Type.String({ minLength: 1 }),
      libraryDocumentIds: Type.Optional(Type.Array(Type.String())),
      modules: Type.Optional(Type.Array(Type.String())),
      parentResearchId: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
};

/**
 * `ada_research` built per tool call, because only then does the host say who is asking: the
 * result is pushed to the lawyer's WhatsApp only when the requester is the lawyer.
 */
export function createResearchTool(params: {
  api: OpenClawPluginApi;
  config: LexroomConfig;
  toolContext: OpenClawPluginToolContext;
}): AnyAgentTool {
  const { api, config, toolContext } = params;
  return {
    ...researchToolDefinition,
    execute: async (_toolCallId, args: Static<typeof researchToolDefinition.parameters>) =>
      jsonResult(
        await startAdaResearch({
          args,
          config,
          api,
          requester: {
            senderId: toolContext.requesterSenderId,
            channel: toolContext.messageChannel,
          },
        }),
      ),
  };
}
