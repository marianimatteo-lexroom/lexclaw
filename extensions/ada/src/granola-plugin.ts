import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  adaGranolaCallDefinition,
  adaGranolaConnectDefinition,
  adaGranolaDisconnectDefinition,
  adaGranolaToolsDefinition,
} from "./account-tool-definitions.js";
import { noteConnectOffer } from "./connect-offers.js";
import { writeAdaConnectPage } from "./google-callback.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { openAdaGranolaAccountDbFromApi } from "./granola-account.js";
import { handleAdaGranolaCallback } from "./granola-callback.js";
import { granolaConnectConfigFrom } from "./granola-connect.js";
import { granolaConnectedText } from "./granola-text.js";
import {
  executeAdaGranolaCall,
  executeAdaGranolaConnect,
  executeAdaGranolaDisconnect,
  executeAdaGranolaTools,
} from "./granola-tools.js";
import { registerAdaHttpRoute } from "./http-paths.js";
import { ownerToolFactory } from "./owner-tool.js";
import { resolveLanguage } from "./research-link-outbound.js";
import { openWakeWindow } from "./service.js";
import { mirrorSentText } from "./transcript-mirror.js";

/** The model-facing tools that connect, read and disconnect one person's own Granola. */
export const adaGranolaTools = {
  connect: {
    ...adaGranolaConnectDefinition,
    optional: true as const,
    factory: ownerToolFactory(adaGranolaConnectDefinition, (args, { owner, api, config, signal }) =>
      executeAdaGranolaConnect(owner, granolaConnectConfigFrom(config), api, args, signal),
    ),
  },
  disconnect: {
    ...adaGranolaDisconnectDefinition,
    optional: true as const,
    factory: ownerToolFactory(adaGranolaDisconnectDefinition, (_args, { owner, api, signal }) =>
      executeAdaGranolaDisconnect(owner, api, signal),
    ),
  },
  tools: {
    ...adaGranolaToolsDefinition,
    optional: true as const,
    factory: ownerToolFactory(adaGranolaToolsDefinition, (_args, { owner, api, signal }) =>
      executeAdaGranolaTools(owner, api, signal),
    ),
  },
  call: {
    ...adaGranolaCallDefinition,
    optional: true as const,
    factory: ownerToolFactory(adaGranolaCallDefinition, (args, { owner, api, signal }) =>
      executeAdaGranolaCall(owner, api, args, signal),
    ),
  },
};

/** Where Granola's sign-in returns, on the current and the pre-rename prefix. */
export function registerAdaGranolaCallback(api: OpenClawPluginApi): void {
  registerAdaHttpRoute(api, {
    path: "/granola/callback",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      try {
        return await handleAdaGranolaCallback(req, res, {
          config: granolaConnectConfigFrom(api.pluginConfig),
          now: () => new Date(),
          db: () => openAdaGranolaAccountDbFromApi(api),
          log: api.logger,
          notifyConnected: async (owner) => {
            await openWakeWindow(api, owner);
            const text = granolaConnectedText(await resolveLanguage("", undefined, owner));
            const sent = await sendAdaWhatsAppText({ api, to: `+${owner}`, text });
            if (sent.ok) {
              noteConnectOffer(owner, "first_look", Date.now(), "granola");
              await mirrorSentText(api, owner, text, `ada-connected:granola:${Date.now()}`);
            }
            return sent;
          },
        });
      } catch (error) {
        api.logger.error(
          `ada granola callback failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
        writeAdaConnectPage(res, 500, {
          kind: "blocked",
          heading: "Could not connect",
          message: "Ada could not finish connecting Granola.",
        });
        return true;
      }
    },
  });
}
