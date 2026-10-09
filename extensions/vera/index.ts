import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  defineToolPlugin,
  getToolPluginMetadata,
  toolPluginMetadataSymbol,
} from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { buildInjectedBrief } from "./src/brief.js";
import { planDigest, type DigestSignal } from "./src/digest.js";
import { openVeraGoogleAccountFromApi } from "./src/google-account.js";
import { exchangeAuthorizationCode } from "./src/google-api.js";
import { handleVeraGoogleCallback, writeVeraConnectPage } from "./src/google-callback.js";
import { googleConnectConfigFrom } from "./src/google-connect.js";
import { sendGoogleConnectedNotice } from "./src/google-notify.js";
import {
  executeVeraGoogleConnect,
  executeVeraReadCalendar,
  executeVeraReadInbox,
  executeVeraSendEmail,
} from "./src/google-tools.js";
import { runDraft, runResearch, type LexroomConfig } from "./src/lexroom-client.js";
import { MEMORY_FOLDERS } from "./src/memory-contract.js";
import {
  executeVeraMemoryGet,
  executeVeraMemoryHistory,
  executeVeraMemoryList,
  executeVeraMemorySearch,
  executeVeraTodoGet,
  executeVeraTodoList,
} from "./src/memory-tools.js";
import { openVeraMemoryFromApi } from "./src/memory.js";
import { recordLawyerInbound, registerVeraService } from "./src/service.js";
import { handleVeraGoogleNotify } from "./src/watch.js";

const signalSchema = Type.Object(
  {
    matterId: Type.String({ minLength: 1, description: "Stable id for one client or matter." }),
    matterLabel: Type.String({ minLength: 1, description: "Name safe to show the lawyer." }),
    kind: Type.Union([
      Type.Literal("deadline"),
      Type.Literal("calendar_move"),
      Type.Literal("overnight_email"),
      Type.Literal("decision_waiting"),
    ]),
    summary: Type.String({
      minLength: 1,
      description: "What changed, using facts from this matter only.",
    }),
    dueAt: Type.Optional(Type.String({ description: "ISO-8601 time the lawyer would miss." })),
    movedCloser: Type.Optional(
      Type.Boolean({ description: "True when a calendar item moved earlier." }),
    ),
    needsDecision: Type.Optional(
      Type.Boolean({ description: "True when the lawyer has to decide or reply." }),
    ),
  },
  { additionalProperties: false },
);

const tools = defineToolPlugin({
  id: "vera",
  name: "Vera",
  description:
    "Lawyer WhatsApp digest with Instinct-shaped matter memory and event-driven wakes.",
  configSchema: Type.Object(
    {
      accessToken: Type.Optional(
        Type.String({ description: "Lexroom bearer token for this lawyer. Do not commit it." }),
      ),
      baseUrl: Type.Optional(Type.String({ description: "Lexroom API base URL." })),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1000, description: "Research and draft stream timeout." }),
      ),
      googleClientId: Type.Optional(
        Type.String({ description: "Google OAuth client id for Gmail and Calendar." }),
      ),
      googleClientSecret: Type.Optional(
        Type.String({ description: "Google OAuth client secret. Do not commit it." }),
      ),
      googleRedirectUri: Type.Optional(
        Type.String({
          description: "Public https URL whose path is /vera/google/callback.",
        }),
      ),
      googleStateSecret: Type.Optional(
        Type.String({ description: "HMAC secret for connect links. Do not commit it." }),
      ),
      googlePubSubTopic: Type.Optional(
        Type.String({
          description:
            "Optional projects/.../topics/... for Gmail and Calendar watch. Without it, Vera polls every 15 minutes.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      name: "vera_plan_digest",
      label: "Plan Vera digest",
      description:
        "Rank one lawyer's matter signals by the cost of waiting. Returns deliver:false when nothing clears the bar. Otherwise returns one ranked list and exactly two next steps: research first, then a draft that still needs confirmation. Never sends a message.",
      parameters: Type.Object(
        {
          signals: Type.Array(signalSchema),
          now: Type.Optional(
            Type.String({ description: "ISO-8601 clock. Defaults to the current time." }),
          ),
        },
        { additionalProperties: false },
      ),
      optional: true,
      execute({ signals, now }) {
        const clock = now ? new Date(now) : new Date();
        if (Number.isNaN(clock.getTime())) {
          return { ok: false, error: "now must be an ISO-8601 timestamp" };
        }
        try {
          return { ok: true, plan: planDigest(signals as DigestSignal[], clock) };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "digest planning failed",
          };
        }
      },
    }),
    tool({
      name: "vera_research",
      label: "Lexroom research",
      description:
        "Run Lexroom research for one matter. Pass libraryDocumentIds only for documents that belong to that matter. The private library is not searched unless those ids are present.",
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
      optional: true,
      async execute(params, config: LexroomConfig, context) {
        return await runResearch({
          config,
          matterId: params.matterId,
          query: params.query,
          libraryDocumentIds: params.libraryDocumentIds,
          modules: params.modules,
          parentResearchId: params.parentResearchId,
          signal: context.signal,
        });
      },
    }),
    tool({
      name: "vera_draft",
      label: "Lexroom draft",
      description:
        "Draft a legal act for one matter. Set confirmed true only after the lawyer agrees in the chat. Any other value returns confirmation_required and does not call Lexroom.",
      parameters: Type.Object(
        {
          matterId: Type.String({ minLength: 1 }),
          prompt: Type.String({ minLength: 1 }),
          confirmed: Type.Boolean(),
          modules: Type.Optional(Type.Array(Type.String())),
          parentResearchId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config: LexroomConfig, context) {
        return await runDraft({
          config,
          matterId: params.matterId,
          prompt: params.prompt,
          confirmed: params.confirmed,
          modules: params.modules,
          parentResearchId: params.parentResearchId,
          signal: context.signal,
        });
      },
    }),
    tool({
      name: "vera_google_connect",
      label: "Connect Gmail and Calendar",
      description:
        "Check whether this lawyer connected Gmail and Google Calendar, including permission to send mail. When they have not, or the saved connection cannot send, return one WhatsApp ask and a single Google OAuth link. Does not send the message.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      async execute(_params, config, context) {
        return await executeVeraGoogleConnect(config, context.api);
      },
    }),
    tool({
      name: "vera_read_inbox",
      label: "Read connected Gmail",
      description:
        "Read recent inbox metadata from the Gmail account this lawyer connected. Does not send mail.",
      parameters: Type.Object(
        {
          max: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config, context) {
        return await executeVeraReadInbox(config, context.api, params.max, context.signal);
      },
    }),
    tool({
      name: "vera_read_calendar",
      label: "Read connected Google Calendar",
      description:
        "Read upcoming events from the Google Calendar this lawyer connected. Read-only. Never creates or moves events.",
      parameters: Type.Object(
        {
          hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config, context) {
        return await executeVeraReadCalendar(config, context.api, params.hours, context.signal);
      },
    }),
    tool({
      name: "vera_send_email",
      label: "Send email from connected Gmail",
      description:
        "Send one plain-text email from the Gmail account this lawyer connected. Set confirmed true only after he agrees in the chat to that exact message. Any other value returns confirmation_required and does not send. Calendar stays read-only.",
      parameters: Type.Object(
        {
          to: Type.String({ minLength: 3, description: "One recipient email address." }),
          subject: Type.String({ minLength: 1, description: "One-line subject." }),
          text: Type.String({ minLength: 1, description: "Plain-text body." }),
          confirmed: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config, context) {
        return await executeVeraSendEmail(config, context.api, params, context.signal);
      },
    }),
    tool({
      name: "vera_memory_search",
      label: "Search matter memory",
      description:
        "Keyword search inside one matter's Instinct-shaped wiki. Aliases matter; misspellings do not. Never crosses matters.",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1 }),
          matterId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, _config, context) {
        return await executeVeraMemorySearch(context.api, params);
      },
    }),
    tool({
      name: "vera_memory_list",
      label: "List matter memory folder",
      description: "List current wiki pages in one Instinct folder for one matter.",
      parameters: Type.Object(
        {
          folder: Type.Union(MEMORY_FOLDERS.map((folder) => Type.Literal(folder))),
          matterId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, _config, context) {
        return await executeVeraMemoryList(context.api, params);
      },
    }),
    tool({
      name: "vera_memory_get",
      label: "Get matter memory page",
      description: "Read one rendered wiki page. Requires the matter id that owns it.",
      parameters: Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          matterId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, _config, context) {
        return await executeVeraMemoryGet(context.api, params);
      },
    }),
    tool({
      name: "vera_memory_history",
      label: "Matter memory history",
      description: "Read revision summaries for one page. Old bodies stay here after corrections.",
      parameters: Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          matterId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, _config, context) {
        return await executeVeraMemoryHistory(context.api, params);
      },
    }),
    tool({
      name: "vera_todo_list",
      label: "List open loops",
      description: "List todo ids, owners, titles, and statuses. Details need vera_todo_get.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      async execute(_params, _config, context) {
        return await executeVeraTodoList(context.api);
      },
    }),
    tool({
      name: "vera_todo_get",
      label: "Get open loop detail",
      description: "Read detail for one open loop.",
      parameters: Type.Object(
        {
          id: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, _config, context) {
        return await executeVeraTodoGet(context.api, params);
      },
    }),
  ],
});

const entry = definePluginEntry({
  id: "vera",
  name: "Vera",
  description:
    "Lawyer WhatsApp digest with Instinct-shaped matter memory and event-driven wakes.",
  configSchema: () => {
    const schema = tools.configSchema;
    if (!schema) {
      throw new Error("Vera config schema is missing");
    }
    return schema;
  },
  register(api) {
    tools.register(api);
    registerVeraService({ api });

    api.on("message_received", async () => {
      try {
        await recordLawyerInbound({ api, atMs: Date.now() });
      } catch (error) {
        api.logger.error(
          `vera inbound wake record failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    });

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        try {
          const authority = ctx.toolAuthority;
          if (!authority?.allows("vera_memory_search")) {
            return;
          }
          const memory = await openVeraMemoryFromApi(api);
          const [profile, todos] = await Promise.all([
            memory.readProfile(),
            memory.listTodos(),
          ]);
          authority.assertActive();
          const brief = buildInjectedBrief({
            profile,
            todos,
            sessionKey: ctx.sessionKey,
          });
          if (!brief.trim()) {
            return;
          }
          return { prependContext: brief };
        } catch (error) {
          api.logger.error(
            `vera brief inject failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
          return;
        }
      },
      { requiresToolAuthority: true },
    );

    api.registerHttpRoute({
      path: "/vera/google/callback",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        try {
          const store = await openVeraGoogleAccountFromApi(api);
          return await handleVeraGoogleCallback(req, res, {
            config: googleConnectConfigFrom(api.pluginConfig),
            now: () => new Date(),
            store,
            exchange: exchangeAuthorizationCode,
            log: api.logger,
            notifyConnected: (email) =>
              sendGoogleConnectedNotice({
                config: api.config,
                email,
                loadAdapter: (channelId) => api.runtime.channel.outbound.loadAdapter(channelId),
              }),
          });
        } catch (error) {
          api.logger.error(
            `vera google callback failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
          writeVeraConnectPage(res, 500, {
            kind: "blocked",
            heading: "Could not connect",
            message: "Vera could not finish connecting the Google account.",
          });
          return true;
        }
      },
    });

    api.registerHttpRoute({
      path: "/vera/google/notify",
      auth: "plugin",
      match: "exact",
      handler: (req, res) => handleVeraGoogleNotify(req, res, api),
    });
  },
});

const metadata = getToolPluginMetadata(tools);
if (metadata) {
  Object.defineProperty(entry, toolPluginMetadataSymbol, {
    value: metadata,
    enumerable: false,
  });
}

export default entry;
