import type { IncomingMessage, ServerResponse } from "node:http";
import { readConnectState } from "./connect-state.js";
import { writeAdaConnectPage } from "./google-callback.js";
import type { GoogleConnectedNotice } from "./google-notify.js";
import type { OutlookAccountDb } from "./outlook-account-contract.js";
import { bindOutlookOwner } from "./outlook-account.js";
import {
  holdAdminConsent,
  outlookStateKey,
  readOutlookConnectConfig,
  type OutlookConnectConfig,
} from "./outlook-connect.js";
import { exchangeOutlookCode, isAdminConsentError, readOutlookApp } from "./outlook-oauth.js";
import { revokeShortLinksForNonce } from "./short-links.js";

type CallbackDeps = {
  config: OutlookConnectConfig;
  now: () => Date;
  db: () => Promise<OutlookAccountDb>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log: { error: (message: string) => void };
  /** Confirms to the number that asked for the link, and to no one else. */
  notifyConnected?: (owner: string) => Promise<GoogleConnectedNotice>;
  /** Tells the number that asked for the link that its company's IT admin must approve the app. */
  notifyAdminConsent?: (owner: string) => Promise<GoogleConnectedNotice>;
};

const EXPIRED = {
  kind: "retry",
  heading: "Link expired",
  message: "This connect link is no longer valid. Return to WhatsApp and ask Ada for a new link.",
} as const;

const ADMIN_CONSENT_PAGE = {
  kind: "retry",
  heading: "Admin approval needed",
  message:
    "Your organization requires an IT administrator to approve the Ada app in Microsoft before you can connect Outlook. Ask your IT admin to approve it, then return to WhatsApp and tell Ada once it is done.",
} as const;

/**
 * Microsoft's sign-in comes back here. The signed state names the number that asked for the link,
 * and its pending row (single use, 30 minutes) holds the PKCE verifier, so the tokens are saved
 * for that number and no one else, whoever opens the link.
 */
export async function handleAdaOutlookCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CallbackDeps,
): Promise<boolean> {
  if (req.method !== "GET") {
    writeAdaConnectPage(res, 405, {
      kind: "blocked",
      heading: "Could not connect",
      message: "Ada could not finish connecting Outlook.",
    });
    return true;
  }
  const app = readOutlookApp(deps.env);
  const config = readOutlookConnectConfig(deps.config);
  if (!app || !config.ok) {
    deps.log.error("ada outlook callback is not configured");
    writeAdaConnectPage(res, 503, {
      kind: "blocked",
      heading: "Not ready",
      message: "Ada Outlook connect is not configured.",
    });
    return true;
  }
  const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  const now = deps.now();
  const parsed = state
    ? readConnectState(outlookStateKey(config.settings.stateSecret), state, now)
    : null;

  /** The organization needs an administrator's approval: said once, plainly, with no new link. */
  const needsAdmin = async (owner: string | undefined): Promise<boolean> => {
    if (owner) {
      holdAdminConsent(owner, now.getTime());
      const notice = await deps.notifyAdminConsent?.(owner);
      if (notice && !notice.ok) {
        deps.log.error(`ada outlook admin-consent notice was not sent: ${notice.error}`);
      }
    }
    writeAdaConnectPage(res, 200, ADMIN_CONSENT_PAGE);
    return true;
  };

  if (params.get("error")) {
    if (isAdminConsentError(params.get("error"), params.get("error_description"))) {
      if (parsed) {
        const spent = await bindOutlookOwner(await deps.db(), parsed.owner).consumePending(
          parsed.nonce,
          now.getTime(),
        );
        revokeShortLinksForNonce(parsed.nonce);
        return needsAdmin(spent ? parsed.owner : undefined);
      }
      return needsAdmin(undefined);
    }
    writeAdaConnectPage(res, 200, {
      kind: "retry",
      heading: "Not connected",
      message:
        "Ada did not connect Outlook. If you went back or declined, return to WhatsApp and ask Ada for a new link.",
    });
    return true;
  }
  if (!code || !parsed) {
    writeAdaConnectPage(res, 400, EXPIRED);
    return true;
  }
  const store = bindOutlookOwner(await deps.db(), parsed.owner);
  const pending = await store.consumePending(parsed.nonce, now.getTime());
  revokeShortLinksForNonce(parsed.nonce);
  if (!pending) {
    writeAdaConnectPage(res, 400, EXPIRED);
    return true;
  }
  const exchanged = await exchangeOutlookCode({
    app,
    redirectUri: config.settings.redirectUri,
    code,
    verifier: pending.codeVerifier,
    nowMs: now.getTime(),
    fetchImpl: deps.fetchImpl,
  });
  if (!exchanged.ok) {
    deps.log.error(
      `ada outlook token exchange failed: ${exchanged.reason}${exchanged.oauthError ? ` error=${exchanged.oauthError}` : ""}`,
    );
    if (exchanged.reason === "admin_consent") {
      return needsAdmin(parsed.owner);
    }
    if (exchanged.reason === "denied_scopes") {
      writeAdaConnectPage(res, 400, {
        kind: "retry",
        heading: "Approval needed",
        message:
          "Approve reading and sending mail and reading and editing the calendar, then ask Ada for a new link.",
      });
      return true;
    }
    writeAdaConnectPage(res, 400, {
      kind: exchanged.reason === "invalid_grant" ? "retry" : "blocked",
      heading: "Could not connect",
      message:
        "Ada could not finish connecting Outlook. Return to WhatsApp and ask for a new link.",
    });
    return true;
  }
  await store.upsertAccount({
    email: exchanged.tokens.email,
    refreshToken: exchanged.tokens.refreshToken,
    accessToken: exchanged.tokens.accessToken,
    accessExpiresAtMs: exchanged.tokens.accessExpiresAtMs,
    scope: exchanged.tokens.scope,
    connectedAtMs: now.getTime(),
  });
  if (deps.notifyConnected) {
    const notice = await deps.notifyConnected(parsed.owner);
    if (!notice.ok) {
      deps.log.error(`ada outlook connect confirmation was not sent: ${notice.error}`);
    }
  }
  writeAdaConnectPage(res, 200, {
    kind: "ready",
    heading: "Connected",
    message: "Outlook mail and calendar are connected to Ada.",
    email: exchanged.tokens.email,
    access: "none",
  });
  return true;
}
