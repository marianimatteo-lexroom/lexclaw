import type { IncomingMessage, ServerResponse } from "node:http";
import { readConnectState } from "./connect-state.js";
import { writeAdaConnectPage } from "./google-callback.js";
import type { GoogleConnectedNotice } from "./google-notify.js";
import type { GranolaAccountDb } from "./granola-account-contract.js";
import { bindGranolaOwner } from "./granola-account.js";
import {
  granolaStateKey,
  readGranolaConnectConfig,
  type GranolaConnectConfig,
} from "./granola-connect.js";
import { discoverGranolaEndpoints, exchangeGranolaCode } from "./granola-oauth.js";
import { revokeShortLinksForNonce } from "./short-links.js";

type CallbackDeps = {
  config: GranolaConnectConfig;
  now: () => Date;
  db: () => Promise<GranolaAccountDb>;
  fetchImpl?: typeof fetch;
  log: { error: (message: string) => void };
  /** Confirms to the number that asked for the link, and to no one else. */
  notifyConnected?: (owner: string) => Promise<GoogleConnectedNotice>;
};

const EXPIRED = {
  kind: "retry",
  heading: "Link expired",
  message: "This connect link is no longer valid. Return to WhatsApp and ask Ada for a new link.",
} as const;

/**
 * Granola's sign-in comes back here. The signed state names the number that asked for the link,
 * and its pending row (single use, 30 minutes) holds the PKCE verifier, so the tokens are saved
 * for that number and no one else, whoever opens the link.
 */
export async function handleAdaGranolaCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CallbackDeps,
): Promise<boolean> {
  if (req.method !== "GET") {
    writeAdaConnectPage(res, 405, {
      kind: "blocked",
      heading: "Could not connect",
      message: "Ada could not finish connecting Granola.",
    });
    return true;
  }
  const config = readGranolaConnectConfig(deps.config);
  if (!config.ok) {
    deps.log.error("ada granola callback is not configured");
    writeAdaConnectPage(res, 503, {
      kind: "blocked",
      heading: "Not ready",
      message: "Ada Granola connect is not configured.",
    });
    return true;
  }
  const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
  if (params.get("error")) {
    writeAdaConnectPage(res, 200, {
      kind: "retry",
      heading: "Not connected",
      message:
        "Ada did not connect Granola. If you went back or declined, return to WhatsApp and ask Ada for a new link.",
    });
    return true;
  }
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  const now = deps.now();
  const parsed = state
    ? readConnectState(granolaStateKey(config.settings.stateSecret), state, now)
    : null;
  if (!code || !parsed) {
    writeAdaConnectPage(res, 400, EXPIRED);
    return true;
  }
  const db = await deps.db();
  const store = bindGranolaOwner(db, parsed.owner);
  const pending = await store.consumePending(parsed.nonce, now.getTime());
  revokeShortLinksForNonce(parsed.nonce);
  const client = pending ? await db.readClient() : null;
  if (!pending || !client || client.clientId !== pending.clientId) {
    writeAdaConnectPage(res, 400, EXPIRED);
    return true;
  }
  const endpoints = await discoverGranolaEndpoints({
    fetchImpl: deps.fetchImpl,
    nowMs: now.getTime(),
  });
  const exchanged = endpoints
    ? await exchangeGranolaCode({
        endpoints,
        client,
        code,
        verifier: pending.codeVerifier,
        nowMs: now.getTime(),
        fetchImpl: deps.fetchImpl,
      })
    : null;
  if (!exchanged?.ok) {
    const reason = exchanged?.reason ?? "unreachable";
    deps.log.error(`ada granola token exchange failed: ${reason}`);
    if (reason === "invalid_client") {
      // Granola forgot Ada's registration: the next link registers it again.
      await db.clearClientIfStill(client.clientId);
    }
    writeAdaConnectPage(res, 400, {
      kind: reason === "unreachable" || reason === "transient" ? "blocked" : "retry",
      heading: "Could not connect",
      message:
        "Ada could not finish connecting Granola. Return to WhatsApp and ask Ada for a new link.",
    });
    return true;
  }
  await store.upsertAccount({
    accessToken: exchanged.tokens.accessToken,
    refreshToken: exchanged.tokens.refreshToken ?? null,
    accessExpiresAtMs: exchanged.tokens.accessExpiresAtMs,
    scope: exchanged.tokens.scope,
    clientId: client.clientId,
    connectedAtMs: now.getTime(),
  });
  if (deps.notifyConnected) {
    const notice = await deps.notifyConnected(parsed.owner);
    if (!notice.ok) {
      deps.log.error(`ada granola connect confirmation was not sent: ${notice.error}`);
    }
  }
  writeAdaConnectPage(res, 200, {
    kind: "ready",
    heading: "Connected",
    message: "Granola is connected to Ada. She can now read your meeting notes.",
    access: "none",
  });
  return true;
}
