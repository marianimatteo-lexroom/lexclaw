import type { IncomingMessage, ServerResponse } from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  defineToolPlugin,
  getToolPluginMetadata,
  toolPluginMetadataSymbol,
} from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import {
  adaCreateCalendarEventDefinition,
  adaDeadlineListDefinition,
  adaDeadlineReplyDefinition,
  adaDraftDefinition,
  adaGoogleConnectDefinition,
  adaLexroomConnectDefinition,
  adaMemoryGetDefinition,
  adaMemoryHistoryDefinition,
  adaMemoryListDefinition,
  adaMemorySearchDefinition,
  adaReadCalendarDefinition,
  adaReadInboxDefinition,
  adaSendEmailDefinition,
  adaSetTimezoneDefinition,
  adaTodoGetDefinition,
  adaTodoListDefinition,
  adaUpdateCalendarEventDefinition,
} from "./src/account-tool-definitions.js";
import { registerAdaAnnouncementsAdmin } from "./src/announcements-http.js";
import { registerAnnouncementRelease } from "./src/announcements.js";
import { buildInjectedBrief } from "./src/brief.js";
import { connectOfferNote, takeConnectOffers } from "./src/connect-offers.js";
import { executeAdaDeadlineList, executeAdaDeadlineReply } from "./src/deadline-tools.js";
import { planDigest, type DigestSignal } from "./src/digest.js";
import { createInboundTextGuard, registerInboundDuplicateHooks } from "./src/duplicate-text.js";
import { registerAdaFeedbackAdmin } from "./src/feedback-http.js";
import { openAdaGoogleAccountFromApi } from "./src/google-account.js";
import { exchangeAuthorizationCode } from "./src/google-api.js";
import { handleAdaGoogleCallback, writeAdaConnectPage } from "./src/google-callback.js";
import { googleConnectConfigFrom } from "./src/google-connect.js";
import { sendGoogleConnectedNotice } from "./src/google-notify.js";
import {
  executeAdaCalendarEvent,
  executeAdaGoogleConnect,
  executeAdaReadCalendar,
  executeAdaReadInbox,
  executeAdaSendEmail,
} from "./src/google-tools.js";
import { adaGranolaTools, registerAdaGranolaCallback } from "./src/granola-plugin.js";
import { registerAdaHttpRoute } from "./src/http-paths.js";
import { logInboundSkip, maskNumber } from "./src/inbound-log.js";
import { registerAdaKapsoWebhook } from "./src/kapso-webhook-gate.js";
import { openAdaLexroomAccountFromApi } from "./src/lexroom-account.js";
import type { LexroomConfig } from "./src/lexroom-client.js";
import { lexroomConfigProperties } from "./src/lexroom-config-schema.js";
import { handleAdaLexroomConnect } from "./src/lexroom-connect-http.js";
import { registerLexroomNudge } from "./src/lexroom-nudge.js";
import {
  executeAdaLexroomConnect,
  lexroomConnectConfigFrom,
  executeAdaDraft,
  sendLexroomConnectedNotice,
} from "./src/lexroom-tools.js";
import { releaseMailboxFromOtherOwners } from "./src/mailbox-owner.js";
import { EMPTY_WAKE_STATE } from "./src/memory-contract.js";
import {
  executeAdaMemoryGet,
  executeAdaMemoryHistory,
  executeAdaMemoryList,
  executeAdaMemorySearch,
  executeAdaTodoGet,
  executeAdaTodoList,
} from "./src/memory-tools.js";
import { openAdaMemoryIfExistsFromApi } from "./src/memory.js";
import { ownerToolFactory } from "./src/owner-tool.js";
import { lawyerOwner, resolveHookTurnOwner } from "./src/owner.js";
import { ADA_PERSONA } from "./src/persona.js";
import { adaPreferenceTools } from "./src/preference-tools.js";
import { recordInboundLanguage, registerResearchLinkHooks } from "./src/research-link-outbound.js";
import {
  lastSenderInboundAt,
  onSenderInbound,
  recordSenderInbound as recordInboundArrival,
  senderNumber,
} from "./src/research-push.js";
import {
  createResearchStatusTool,
  createResearchTool,
  researchStatusToolDefinition,
  researchToolDefinition,
} from "./src/research-tool.js";
import { openWakeWindow, recordSenderInbound, registerAdaService } from "./src/service.js";
import { handleAdaShortLink } from "./src/short-links-http.js";
import { registerStatusReactionHooks } from "./src/status-reactions.js";
import { handleAdaStatus } from "./src/status.js";
import { executeAdaSetTimezone } from "./src/timezone-tool.js";
import { handleAdaGoogleNotify } from "./src/watch.js";
import { registerWelcomeHook } from "./src/welcome.js";
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
      ...adaDraftDefinition,
      optional: true,
      factory: ownerToolFactory(adaDraftDefinition, (args, { owner, api, config, signal }) =>
        executeAdaDraft({ owner, args, config: config as LexroomConfig, api, signal }),
      ),
    }),
    tool({
      ...adaLexroomConnectDefinition,
      optional: true,
      factory: ownerToolFactory(
        adaLexroomConnectDefinition,
        (args, { owner, api, config, signal }) =>
          executeAdaLexroomConnect(owner, lexroomConnectConfigFrom(config), api, new Date(), {
            force: args.force === true,
            signal,
          }),
      ),
    }),
    tool({
      ...adaGoogleConnectDefinition,
      optional: true,
      factory: ownerToolFactory(adaGoogleConnectDefinition, (_args, { owner, api, config }) =>
        executeAdaGoogleConnect(owner, config, api),
      ),
    }),
    tool({
      ...adaReadInboxDefinition,
      optional: true,
      factory: ownerToolFactory(adaReadInboxDefinition, (args, { owner, api, config, signal }) =>
        executeAdaReadInbox(owner, config, api, args.max, signal),
      ),
    }),
    tool({
      ...adaReadCalendarDefinition,
      optional: true,
      factory: ownerToolFactory(adaReadCalendarDefinition, (args, { owner, api, config, signal }) =>
        executeAdaReadCalendar(owner, config, api, args.hours, signal),
      ),
    }),
    tool({
      ...adaSendEmailDefinition,
      optional: true,
      factory: ownerToolFactory(adaSendEmailDefinition, (args, { owner, api, config, signal }) =>
        executeAdaSendEmail(owner, config, api, args, signal),
      ),
    }),
    tool({
      ...adaCreateCalendarEventDefinition,
      optional: true,
      factory: ownerToolFactory(
        adaCreateCalendarEventDefinition,
        (args, { owner, api, config, signal }) =>
          executeAdaCalendarEvent(owner, config, api, args, signal),
      ),
    }),
    tool({
      ...adaUpdateCalendarEventDefinition,
      optional: true,
      factory: ownerToolFactory(
        adaUpdateCalendarEventDefinition,
        (args, { owner, api, config, signal }) =>
          executeAdaCalendarEvent(owner, config, api, args, signal),
      ),
    }),
    tool({
      ...adaDeadlineListDefinition,
      optional: true,
      factory: ownerToolFactory(adaDeadlineListDefinition, (_args, { owner, api, config }) =>
        executeAdaDeadlineList(config, api, owner),
      ),
    }),
    tool({
      ...adaDeadlineReplyDefinition,
      optional: true,
      factory: ownerToolFactory(
        adaDeadlineReplyDefinition,
        (args, { owner, api, config, signal }) =>
          executeAdaDeadlineReply(args, config, api, owner, signal),
      ),
    }),
    tool({
      ...adaSetTimezoneDefinition,
      optional: true,
      factory: ownerToolFactory(adaSetTimezoneDefinition, (args, { owner, api }) =>
        executeAdaSetTimezone(api, owner, args),
      ),
    }),
    tool(adaPreferenceTools.set),
    tool(adaPreferenceTools.forget),
    tool(adaPreferenceTools.reportFeedback),
    tool({
      ...adaMemorySearchDefinition,
      optional: true,
      factory: ownerToolFactory(adaMemorySearchDefinition, (args, { owner, api }) =>
        executeAdaMemorySearch(api, owner, args),
      ),
    }),
    tool({
      ...adaMemoryListDefinition,
      optional: true,
      factory: ownerToolFactory(adaMemoryListDefinition, (args, { owner, api }) =>
        executeAdaMemoryList(api, owner, args),
      ),
    }),
    tool({
      ...adaMemoryGetDefinition,
      optional: true,
      factory: ownerToolFactory(adaMemoryGetDefinition, (args, { owner, api }) =>
        executeAdaMemoryGet(api, owner, args),
      ),
    }),
    tool({
      ...adaMemoryHistoryDefinition,
      optional: true,
      factory: ownerToolFactory(adaMemoryHistoryDefinition, (args, { owner, api }) =>
        executeAdaMemoryHistory(api, owner, args),
      ),
    }),
    tool({
      ...adaTodoListDefinition,
      optional: true,
      factory: ownerToolFactory(adaTodoListDefinition, (_args, { owner, api }) =>
        executeAdaTodoList(api, owner),
      ),
    }),
    tool({
      ...adaTodoGetDefinition,
      optional: true,
      factory: ownerToolFactory(adaTodoGetDefinition, (args, { owner, api }) =>
        executeAdaTodoGet(api, owner, args),
      ),
    }),
    tool(adaGranolaTools.connect),
    tool(adaGranolaTools.disconnect),
    tool(adaGranolaTools.tools),
    tool(adaGranolaTools.call),
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
    registerAdaKapsoWebhook(api);

    const inboundText = createInboundTextGuard();
    registerInboundDuplicateHooks(api, inboundText);
    const statusReactions = registerStatusReactionHooks(api);
    registerResearchLinkHooks(
      api,
      async (owner) =>
        (await (await openAdaMemoryIfExistsFromApi(api, owner))?.readProfile())?.language,
    );

    registerWelcomeHook(api, {
      onGreetingAnswered: (sessionKey) => {
        void statusReactions.finished({ sessionKey, success: true });
      },
    });

    api.on("message_received", async (event, ctx) => {
      const arrivedAtMs = Date.now();
      const channelId = readInboundChannelId(event, ctx);
      const arrivedFrom =
        channelId === undefined || channelId === "kapso-whatsapp"
          ? senderNumber(event.from, ctx.senderId)
          : null;
      if (arrivedFrom) {
        // Before any await: the run for this message must see when it arrived, so it does not
        // read a question that this very message caused to be sent.
        recordInboundArrival(arrivedFrom, arrivedAtMs);
        // Also before any await: the held reconnect note released below is written in this language.
        recordInboundLanguage(arrivedFrom, typeof event.content === "string" ? event.content : "");
      }
      const messageId = readInboundMessageId(event, ctx);
      const accountId = typeof ctx.accountId === "string" ? ctx.accountId : undefined;
      api.logger.info(
        `ada inbound received channel=${channelId ?? "unknown"} sender=${maskNumber(ctx.senderId, event.from)}`,
      );
      const repeatedText =
        inboundText.verdict({
          channelId,
          senders: [ctx.senderId, event.from],
          messageId,
          text: event.content,
          timestampMs: event.timestamp,
        }) === "duplicate";
      if (!repeatedText) {
        statusReactions.received({
          sessionKey: ctx.sessionKey ?? event.sessionKey,
          channelId,
          accountId,
          messageId,
          senders: [ctx.senderId, event.from],
        });
      }
      const readReceipt = markKapsoMessageRead({
        config: api.config,
        channelId,
        accountId,
        messageId,
      }).then((result) => {
        if (!result.ok) {
          api.logger.warn(`ada whatsapp read receipt failed: ${result.error}`);
        } else if ("skipped" in result) {
          logInboundSkip(api.logger, {
            stage: "read_receipt",
            reason: result.skipped.replaceAll("-", "_"),
            sender: [ctx.senderId, event.from],
            messageId,
          });
        }
      });
      try {
        await recordSenderInbound({
          api,
          atMs: arrivedAtMs,
          channelId,
          senders: [event.from, ctx.senderId],
        });
        onSenderInbound({
          api,
          channelId,
          senders: [event.from, ctx.senderId],
          atMs: arrivedAtMs,
        });
      } catch (error) {
        api.logger.error(
          `ada inbound wake record failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      await readReceipt;
    });

    api.on("before_prompt_build", (_event, ctx) => {
      const turn = resolveHookTurnOwner(ctx ?? {});
      const personTurn = ctx?.trigger === undefined || ctx.trigger === "user";
      const note = connectOfferNote(
        turn.ok && personTurn
          ? takeConnectOffers(turn.owner, {
              runId: ctx?.runId,
              inboundAtMs: lastSenderInboundAt(turn.owner),
            })
          : [],
      );
      return note
        ? { prependSystemContext: ADA_PERSONA, prependContext: note }
        : { prependSystemContext: ADA_PERSONA };
    });

    registerLexroomNudge(api);

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        try {
          const authority = ctx.toolAuthority;
          if (!authority?.allows("ada_memory_search")) {
            return;
          }
          const turn = resolveHookTurnOwner(ctx);
          if (!turn.ok) {
            return;
          }
          const memory = await openAdaMemoryIfExistsFromApi(api, turn.owner);
          if (!memory) {
            return;
          }
          const [profile, todos, preferences] = await Promise.all([
            memory.readProfile(),
            memory.listTodos(),
            memory.listPreferences(),
          ]);
          authority.assertActive();
          const brief = buildInjectedBrief({
            profile,
            todos,
            preferences,
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
          return await handleAdaGoogleCallback(req, res, {
            config: googleConnectConfigFrom(api.pluginConfig),
            now: () => new Date(),
            openStore: (owner) => openAdaGoogleAccountFromApi(api, owner),
            exchange: exchangeAuthorizationCode,
            log: api.logger,
            releaseMailbox: (owner, email) => releaseMailboxFromOtherOwners(api, owner, email),
            notifyConnected: async (owner, email) => {
              await openWakeWindow(api, owner);
              return await sendGoogleConnectedNotice({
                config: api.config,
                owner,
                email,
                loadAdapter: (channelId) => api.runtime.channel.outbound.loadAdapter(channelId),
              });
            },
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

    for (const kind of ["g", "l", "gr"] as const) {
      const route = {
        path: `/${kind}`,
        auth: "plugin",
        match: "prefix",
        handler: (req: IncomingMessage, res: ServerResponse) =>
          handleAdaShortLink(req, res, kind, new Date()),
      } as const;
      api.registerHttpRoute(route);
      registerAdaHttpRoute(api, route);
    }

    registerAdaFeedbackAdmin(api);
    registerAdaAnnouncementsAdmin(api);
    registerAnnouncementRelease(api);
    registerAdaGranolaCallback(api);

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
          readWake: async () => {
            const lawyer = lawyerOwner(api.config);
            const memory = lawyer ? await openAdaMemoryIfExistsFromApi(api, lawyer) : null;
            return memory ? await memory.readWake() : EMPTY_WAKE_STATE;
          },
          log: api.logger,
        }),
    });

    registerAdaHttpRoute(api, {
      path: "/lexroom/connect",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        try {
          return await handleAdaLexroomConnect(req, res, {
            config: lexroomConnectConfigFrom(api.pluginConfig),
            now: () => new Date(),
            openStore: (owner) => openAdaLexroomAccountFromApi(api, owner),
            log: api.logger,
            notifyConnected: (owner, email) =>
              sendLexroomConnectedNotice({
                config: api.config,
                owner,
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
