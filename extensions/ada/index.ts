import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  defineToolPlugin,
  getToolPluginMetadata,
  toolPluginMetadataSymbol,
} from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { buildInjectedBrief } from "./src/brief.js";
import {
  DEADLINE_REPLY_ACTIONS,
  executeAdaDeadlineList,
  executeAdaDeadlineReply,
} from "./src/deadline-tools.js";
import { planDigest, type DigestSignal } from "./src/digest.js";
import { openAdaGoogleAccountFromApi } from "./src/google-account.js";
import { exchangeAuthorizationCode } from "./src/google-api.js";
import { handleAdaGoogleCallback, writeAdaConnectPage } from "./src/google-callback.js";
import { googleConnectConfigFrom } from "./src/google-connect.js";
import { sendGoogleConnectedNotice } from "./src/google-notify.js";
import {
  executeAdaGoogleConnect,
  executeAdaReadCalendar,
  executeAdaReadInbox,
  executeAdaSendEmail,
} from "./src/google-tools.js";
import { registerAdaHttpRoute } from "./src/http-paths.js";
import { openAdaLexroomAccountFromApi } from "./src/lexroom-account.js";
import type { LexroomConfig } from "./src/lexroom-client.js";
import { lexroomConfigProperties } from "./src/lexroom-config-schema.js";
import { handleAdaLexroomConnect } from "./src/lexroom-connect-http.js";
import {
  executeAdaLexroomConnect,
  lexroomConnectConfigFrom,
  executeAdaDraft,
  sendLexroomConnectedNotice,
} from "./src/lexroom-tools.js";
import { MEMORY_FOLDERS } from "./src/memory-contract.js";
import {
  executeAdaMemoryGet,
  executeAdaMemoryHistory,
  executeAdaMemoryList,
  executeAdaMemorySearch,
  executeAdaTodoGet,
  executeAdaTodoList,
} from "./src/memory-tools.js";
import { openAdaMemoryFromApi } from "./src/memory.js";
import { registerResearchLinkHooks } from "./src/research-link-outbound.js";
import { onSenderInbound } from "./src/research-push.js";
import {
  createResearchStatusTool,
  createResearchTool,
  researchStatusToolDefinition,
  researchToolDefinition,
} from "./src/research-tool.js";
import { recordLawyerInbound, registerAdaService } from "./src/service.js";
import { registerStatusReactionHooks } from "./src/status-reactions.js";
import { handleAdaStatus } from "./src/status.js";
import { handleAdaGoogleNotify } from "./src/watch.js";
import {
  markKapsoMessageRead,
  readInboundChannelId,
  readInboundMessageId,
} from "./src/whatsapp-read.js";

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
  id: "ada",
  name: "Ada",
  description: "Lawyer WhatsApp digest with Instinct-shaped matter memory and event-driven wakes.",
  configSchema: Type.Object(
    {
      ...lexroomConfigProperties,
      googleClientId: Type.Optional(
        Type.String({ description: "Google OAuth client id for Gmail and Calendar." }),
      ),
      googleClientSecret: Type.Optional(
        Type.String({ description: "Google OAuth client secret. Do not commit it." }),
      ),
      googleRedirectUri: Type.Optional(
        Type.String({
          description:
            "Public https URL whose path is /ada/google/callback (the older /vera/google/callback also works).",
        }),
      ),
      googleStateSecret: Type.Optional(
        Type.String({ description: "HMAC secret for connect links. Do not commit it." }),
      ),
      googlePubSubTopic: Type.Optional(
        Type.String({
          description:
            "Optional projects/.../topics/... for Gmail watch. Without it, Ada polls every 15 minutes.",
        }),
      ),
      googleNotifyToken: Type.Optional(
        Type.String({
          description:
            "Static Bearer fallback for POST /ada/google/notify (or /vera/google/notify). At least 16 characters. Prefer googleNotifyAudience. Do not commit it.",
        }),
      ),
      googleNotifyAudience: Type.Optional(
        Type.String({
          description:
            "Audience of the Pub/Sub push subscription's OIDC token. Enables Google JWT verification on POST /ada/google/notify (or /vera/google/notify).",
        }),
      ),
      googleNotifyIssuer: Type.Optional(
        Type.String({
          description:
            "Expected OIDC token issuer. Defaults to https://accounts.google.com (or accounts.google.com).",
        }),
      ),
      googleNotifyServiceAccount: Type.Optional(
        Type.String({
          description:
            "Service account email the push subscription signs tokens as. When set, the token's verified email must match.",
        }),
      ),
      statusToken: Type.Optional(
        Type.String({
          description:
            "Bearer token required by GET /ada/status (or /vera/status). At least 16 characters. Without it the route returns 401. Do not commit it.",
        }),
      ),
      lexroomConnectUri: Type.Optional(
        Type.String({
          description:
            "Public https URL whose path is /ada/lexroom/connect (the older /vera/lexroom/connect also works). Defaults from googleRedirectUri origin when omitted.",
        }),
      ),
      lexroomStateSecret: Type.Optional(
        Type.String({
          description:
            "HMAC secret for Lexroom connect links. Falls back to googleStateSecret. Do not commit it.",
        }),
      ),
      deadlineIntake: Type.Optional(
        Type.Object(
          {
            enabled: Type.Optional(
              Type.Boolean({
                description:
                  "Extract hearings and deadlines from mail and calendar, list them in the digest with reply actions, and send reminders for the ones the lawyer confirms. Default false.",
              }),
            ),
            reminders: Type.Optional(
              Type.Array(Type.String({ pattern: "^(\\d{1,3}d|morning-of)$" }), {
                description:
                  'Reminder cadence for confirmed items, such as ["7d", "2d", "morning-of"]. Default is 7d, 2d, morning-of.',
              }),
            ),
            horizonDays: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 365,
                description: "How far ahead the calendar is scanned. Default 60.",
              }),
            ),
            minConfidence: Type.Optional(
              Type.Number({
                minimum: 0,
                maximum: 1,
                description: "Drop extractions below this confidence. Default 0.6.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      digestReadyTemplate: Type.Optional(
        Type.Object(
          {
            name: Type.String({
              minLength: 1,
              description: "Approved WhatsApp utility template name, for example ada_digest_ready.",
            }),
            language: Type.String({
              minLength: 1,
              description: "Language code the template was approved in, for example en or it.",
            }),
          },
          {
            additionalProperties: false,
            description:
              "Utility template sent once when a digest is held because the WhatsApp 24-hour window is closed. Unset: no nudge is sent.",
          },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      name: "ada_plan_digest",
      label: "Plan Ada digest",
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
      ...researchToolDefinition,
      optional: true,
      factory: ({ api, config, toolContext }) => createResearchTool({ api, config, toolContext }),
    }),
    tool({
      ...researchStatusToolDefinition,
      optional: true,
      factory: ({ api, toolContext }) => createResearchStatusTool({ api, toolContext }),
    }),
    tool({
      name: "ada_draft",
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
        return await executeAdaDraft({
          args: params,
          config,
          api: context.api,
          signal: context.signal,
        });
      },
    }),
    tool({
      name: "ada_lexroom_connect",
      label: "Connect Lexroom",
      description:
        "Check whether this lawyer connected Lexroom for research and drafting. Ada renews the saved sign-in by herself from the saved email and password when it is expiring, then checks it with a live Lexroom call. Only a wrong password, an account that needs a one-time code, or a missing saved password removes it and returns one WhatsApp ask with a single Ada-hosted Lexroom sign-in link. A 403 or an unreachable Lexroom never removes it. Set force true to discard the saved sign-in and always get a new link. Does not send the message.",
      parameters: Type.Object(
        { force: Type.Optional(Type.Boolean()) },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config, context) {
        return await executeAdaLexroomConnect(
          lexroomConnectConfigFrom(config),
          context.api,
          new Date(),
          { force: params.force === true, signal: context.signal },
        );
      },
    }),
    tool({
      name: "ada_google_connect",
      label: "Connect Gmail and Calendar",
      description:
        "Check whether this lawyer connected Gmail and Google Calendar, including permission to send mail. When they have not, or the saved connection cannot send, return one WhatsApp ask and a single Google OAuth link. Does not send the message.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      async execute(_params, config, context) {
        return await executeAdaGoogleConnect(config, context.api);
      },
    }),
    tool({
      name: "ada_read_inbox",
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
        return await executeAdaReadInbox(config, context.api, params.max, context.signal);
      },
    }),
    tool({
      name: "ada_read_calendar",
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
        return await executeAdaReadCalendar(config, context.api, params.hours, context.signal);
      },
    }),
    tool({
      name: "ada_send_email",
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
        return await executeAdaSendEmail(config, context.api, params, context.signal);
      },
    }),
    tool({
      name: "ada_deadline_list",
      label: "List tracked deadlines and hearings",
      description:
        "List upcoming hearings and deadlines Ada extracted from mail and calendar, with the numbers from the last digest, status (candidate or tracked), confidence, sources, and reminder schedule. Read-only. Requires deadlineIntake.enabled.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      async execute(_params, config, context) {
        return await executeAdaDeadlineList(config, context.api);
      },
    }),
    tool({
      name: "ada_deadline_reply",
      label: "Act on a digest deadline",
      description:
        "Apply the lawyer's reply to a numbered deadline or hearing from the digest. research confirms tracking (reminders start) and runs Lexroom research for that matter, returning the brief to text back. track confirms tracking only. brief returns the stored brief again without calling Lexroom. dismiss and done close the item. Call it only after the lawyer replies; never to guess. Sends no email and does not touch the calendar.",
      parameters: Type.Object(
        {
          ref: Type.String({
            minLength: 1,
            description:
              'The digest number the lawyer replied with, such as "1", or a deadline id.',
          }),
          action: Type.Union(DEADLINE_REPLY_ACTIONS.map((action) => Type.Literal(action))),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(params, config, context) {
        return await executeAdaDeadlineReply(params, config, context.api, context.signal);
      },
    }),
    tool({
      name: "ada_memory_search",
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
        return await executeAdaMemorySearch(context.api, params);
      },
    }),
    tool({
      name: "ada_memory_list",
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
        return await executeAdaMemoryList(context.api, params);
      },
    }),
    tool({
      name: "ada_memory_get",
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
        return await executeAdaMemoryGet(context.api, params);
      },
    }),
    tool({
      name: "ada_memory_history",
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
        return await executeAdaMemoryHistory(context.api, params);
      },
    }),
    tool({
      name: "ada_todo_list",
      label: "List open loops",
      description: "List todo ids, owners, titles, and statuses. Details need ada_todo_get.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      async execute(_params, _config, context) {
        return await executeAdaTodoList(context.api);
      },
    }),
    tool({
      name: "ada_todo_get",
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
        return await executeAdaTodoGet(context.api, params);
      },
    }),
  ],
});

const entry = definePluginEntry({
  id: "ada",
  name: "Ada",
  description: "Lawyer WhatsApp digest with Instinct-shaped matter memory and event-driven wakes.",
  configSchema: () => {
    const schema = tools.configSchema;
    if (!schema) {
      throw new Error("Ada config schema is missing");
    }
    return schema;
  },
  register(api) {
    tools.register(api);
    registerAdaService({ api });

    const statusReactions = registerStatusReactionHooks(api);
    registerResearchLinkHooks(
      api,
      async () => (await (await openAdaMemoryFromApi(api)).readProfile())?.language,
    );

    api.on("message_received", async (event, ctx) => {
      const channelId = readInboundChannelId(event, ctx);
      const messageId = readInboundMessageId(event, ctx);
      const accountId = typeof ctx.accountId === "string" ? ctx.accountId : undefined;
      statusReactions.received({
        sessionKey: ctx.sessionKey ?? event.sessionKey,
        channelId,
        accountId,
        messageId,
        senders: [ctx.senderId, event.from],
      });
      const readReceipt = markKapsoMessageRead({
        config: api.config,
        channelId,
        accountId,
        messageId,
      }).then((result) => {
        if (!result.ok) {
          api.logger.warn(`ada whatsapp read receipt failed: ${result.error}`);
        }
      });
      try {
        await recordLawyerInbound({
          api,
          atMs: Date.now(),
          channelId,
          senders: [event.from, ctx.senderId],
        });
        onSenderInbound({
          api,
          channelId,
          senders: [event.from, ctx.senderId],
          atMs: Date.now(),
        });
      } catch (error) {
        api.logger.error(
          `ada inbound wake record failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      await readReceipt;
    });

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        try {
          const authority = ctx.toolAuthority;
          if (!authority?.allows("ada_memory_search")) {
            return;
          }
          const memory = await openAdaMemoryFromApi(api);
          const [profile, todos] = await Promise.all([memory.readProfile(), memory.listTodos()]);
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
            `ada brief inject failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
          return;
        }
      },
      { requiresToolAuthority: true },
    );

    registerAdaHttpRoute(api, {
      path: "/google/callback",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        try {
          const store = await openAdaGoogleAccountFromApi(api);
          return await handleAdaGoogleCallback(req, res, {
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
            `ada google callback failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
          writeAdaConnectPage(res, 500, {
            kind: "blocked",
            heading: "Could not connect",
            message: "Ada could not finish connecting the Google account.",
          });
          return true;
        }
      },
    });

    registerAdaHttpRoute(api, {
      path: "/google/notify",
      auth: "plugin",
      match: "exact",
      handler: (req, res) => handleAdaGoogleNotify(req, res, api),
    });

    registerAdaHttpRoute(api, {
      path: "/status",
      auth: "plugin",
      match: "exact",
      handler: (req, res) =>
        handleAdaStatus(req, res, {
          config: api.pluginConfig,
          now: () => new Date(),
          readWake: async () => (await openAdaMemoryFromApi(api)).readWake(),
          log: api.logger,
        }),
    });

    registerAdaHttpRoute(api, {
      path: "/lexroom/connect",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        try {
          const store = await openAdaLexroomAccountFromApi(api);
          return await handleAdaLexroomConnect(req, res, {
            config: lexroomConnectConfigFrom(api.pluginConfig),
            now: () => new Date(),
            store,
            log: api.logger,
            notifyConnected: (email) =>
              sendLexroomConnectedNotice({
                config: api.config,
                email,
                loadAdapter: (channelId) => api.runtime.channel.outbound.loadAdapter(channelId),
              }),
          });
        } catch (error) {
          api.logger.error(
            `ada lexroom connect failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Ada could not finish connecting Lexroom.");
          return true;
        }
      },
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
