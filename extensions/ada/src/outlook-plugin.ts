import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { TSchema } from "typebox";
import { noteConnectOffer, takeRequestConnect, withRequestConnect } from "./connect-offers.js";
import { writeAdaConnectPage } from "./google-callback.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { registerAdaHttpRoute } from "./http-paths.js";
import { openAdaOutlookAccountDbFromApi } from "./outlook-account.js";
import { handleAdaOutlookCallback } from "./outlook-callback.js";
import { outlookConnectConfigFrom } from "./outlook-connect.js";
import { outlookEnabled } from "./outlook-oauth.js";
import { outlookAdminConsentText, outlookConnectedText } from "./outlook-text.js";
import {
  adaOutlookConnectDefinition,
  adaOutlookCreateCalendarEventDefinition,
  adaOutlookDraftDefinition,
  adaOutlookReadCalendarDefinition,
  adaOutlookReadInboxDefinition,
  adaOutlookReadMessageDefinition,
  adaOutlookReplyDefinition,
  adaOutlookSendEmailDefinition,
  adaOutlookUpdateCalendarEventDefinition,
} from "./outlook-tool-definitions.js";
import {
  executeAdaOutlookCalendarEvent,
  executeAdaOutlookConnect,
  executeAdaOutlookDraft,
  executeAdaOutlookReadCalendar,
  executeAdaOutlookReadInbox,
  executeAdaOutlookReadMessage,
  executeAdaOutlookReply,
  executeAdaOutlookSend,
} from "./outlook-tools.js";
import { ownerToolFactory, type OwnerToolRun } from "./owner-tool.js";
import { resolveLanguage } from "./research-link-outbound.js";
import { openWakeWindow } from "./service.js";

type Definition<P extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: P;
};

/**
 * An Outlook tool exists only while the Microsoft app registration is configured: without it the
 * factory builds nothing, so the model never sees the tool and Ada has nothing to offer.
 */
function outlookTool<P extends TSchema>(definition: Definition<P>, run: OwnerToolRun<P, unknown>) {
  const build = ownerToolFactory(definition, run);
  return {
    ...definition,
    optional: true as const,
    factory: (context: Parameters<typeof build>[0]) => (outlookEnabled() ? build(context) : null),
  };
}

/** The model-facing tools that connect, read and write one person's own Outlook mail and calendar. */
export const adaOutlookTools = {
  connect: outlookTool(adaOutlookConnectDefinition, async (args, { owner, api, config, signal }) =>
    withRequestConnect(owner, "outlook", args.forPendingRequest, () =>
      executeAdaOutlookConnect(owner, outlookConnectConfigFrom(config), api, args, signal),
    ),
  ),
  readInbox: outlookTool(adaOutlookReadInboxDefinition, (args, { owner, api, signal }) =>
    executeAdaOutlookReadInbox(owner, api, args, signal),
  ),
  readMessage: outlookTool(adaOutlookReadMessageDefinition, (args, { owner, api, signal }) =>
    executeAdaOutlookReadMessage(owner, api, args, signal),
  ),
  draft: outlookTool(adaOutlookDraftDefinition, (args, { owner, api, signal }) =>
    executeAdaOutlookDraft(owner, api, args, signal),
  ),
  send: outlookTool(adaOutlookSendEmailDefinition, (args, { owner, api, signal }) =>
    executeAdaOutlookSend(owner, api, args, signal),
  ),
  reply: outlookTool(adaOutlookReplyDefinition, (args, { owner, api, signal }) =>
    executeAdaOutlookReply(owner, api, args, signal),
  ),
  readCalendar: outlookTool(adaOutlookReadCalendarDefinition, (args, { owner, api, signal }) =>
    executeAdaOutlookReadCalendar(owner, api, args, signal),
  ),
  createEvent: outlookTool(
    adaOutlookCreateCalendarEventDefinition,
    (args, { owner, api, signal }) => executeAdaOutlookCalendarEvent(owner, api, args, signal),
  ),
  updateEvent: outlookTool(
    adaOutlookUpdateCalendarEventDefinition,
    (args, { owner, api, signal }) => executeAdaOutlookCalendarEvent(owner, api, args, signal),
  ),
};

/** Where Microsoft's sign-in returns, on the current and the pre-rename prefix. */
export function registerAdaOutlookCallback(api: OpenClawPluginApi): void {
  registerAdaHttpRoute(api, {
    path: "/outlook/callback",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      try {
        const textOwner = async (
          owner: string,
          text: (language: Awaited<ReturnType<typeof resolveLanguage>>) => string,
        ) =>
          await sendAdaWhatsAppText({
            api,
            to: `+${owner}`,
            text: text(await resolveLanguage("", undefined, owner)),
          });
        return await handleAdaOutlookCallback(req, res, {
          config: outlookConnectConfigFrom(api.pluginConfig),
          now: () => new Date(),
          db: () => openAdaOutlookAccountDbFromApi(api),
          log: api.logger,
          notifyConnected: async (owner) => {
            await openWakeWindow(api, owner);
            const firstLook = !takeRequestConnect(owner, "outlook");
            const sent = await textOwner(owner, (language) =>
              outlookConnectedText(language, firstLook),
            );
            if (sent.ok && firstLook) {
              noteConnectOffer(owner, "first_look", Date.now(), "outlook");
            }
            return sent;
          },
          notifyAdminConsent: async (owner) => {
            await openWakeWindow(api, owner);
            return await textOwner(owner, outlookAdminConsentText);
          },
        });
      } catch (error) {
        api.logger.error(
          `ada outlook callback failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
        writeAdaConnectPage(res, 500, {
          kind: "blocked",
          heading: "Could not connect",
          message: "Ada could not finish connecting Outlook.",
        });
        return true;
      }
    },
  });
}
