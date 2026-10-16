import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
import type { LexroomConfig } from "./lexroom-client.js";
import { readResearchJob } from "./lexroom-jobs.js";
import { lexroomLogger } from "./lexroom-log.js";
import { startAdaResearch } from "./lexroom-tools.js";
import { senderNumber } from "./research-push.js";

/** The model-facing definition of `ada_research`, shared by its static metadata and its factory. */
export const researchToolDefinition = {
  name: "ada_research",
  label: "Lexroom research",
  description:
    "Start Lexroom research for one matter. It runs in the background for one to three minutes and returns a jobId at once. When a WhatsApp number asked, Ada has already told that number on WhatsApp that it is running and sends it the answer, the sources and the link to the Lexroom app herself when it is ready: do not poll, do not write a link, and end that turn with exactly NO_REPLY. Only when the result has no requesterNotified field (Ada could not tell who asked, or it was a group chat, so she sends nothing) call ada_research_status with the jobId to read the answer; even when requesterNotified is false Ada still sends the answer herself. Pass modules (for example Civile) to pick what is searched; otherwise every module the Lexroom user may search is used. Pass libraryDocumentIds only for documents that belong to that matter. The private library is not searched unless those ids are present.",
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
 * result is pushed to the WhatsApp number of whoever asked, and to no one else.
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
            conversationId: toolContext.nativeChannelId,
          },
        }),
      ),
  };
}

/** The model-facing definition of `ada_research_status`. */
export const researchStatusToolDefinition = {
  name: "ada_research_status",
  label: "Lexroom research status",
  description:
    "Read a research started with ada_research, only when its result said Ada would not send it herself, or when the requester asks about it. Once Ada has sent the answer to the requester, state is delivered and the result carries no answer: do not repeat it. state is running (call again), done (the answer and sources are in the result; Ada adds the link to this research in the Lexroom app after your last line, so do not write one yourself) or failed (the result says why; reason timeout means Lexroom did not respond). waitSeconds waits up to that long, at most 30, for it to finish; it defaults to 15. A research can only be read by the WhatsApp number that started it.",
  parameters: Type.Object(
    {
      jobId: Type.String({ minLength: 1 }),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30 })),
    },
    { additionalProperties: false },
  ),
};

/** Built per tool call, because a research is read by the number that started it. */
export function createResearchStatusTool(params: {
  api: OpenClawPluginApi;
  toolContext: OpenClawPluginToolContext;
}): AnyAgentTool {
  const { api, toolContext } = params;
  return {
    ...researchStatusToolDefinition,
    execute: async (_toolCallId, args: Static<typeof researchStatusToolDefinition.parameters>) =>
      jsonResult(
        await readResearchJob({
          jobId: args.jobId,
          waitSeconds: args.waitSeconds,
          requester: senderNumber(toolContext.requesterSenderId) ?? undefined,
          log: lexroomLogger(api.logger),
        }),
      ),
  };
}
