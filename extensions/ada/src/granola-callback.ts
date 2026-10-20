import type { IncomingMessage, ServerResponse } from "node:http";
import { readConnectState } from "./connect-state.js";
import { writeAdaConnectPage } from "./google-callback.js";
import type { GoogleConnectedNotice } from "./google-notify.js";
import type { GranolaAccountDb } from "./granola-account-contract.js";
import { bindGranolaOwner } from "./granola-account.js";
import {
  granolaStateKey,
  prepareGranolaConnect,
  readGranolaConnectConfig,
  type GranolaConnectConfig,
} from "./granola-connect.js";
import {
  discoverGranolaEndpoints,
  exchangeGranolaCode,
  GRANOLA_SCOPE,
  includesMcpScope,
  rejectGranolaMcpScope,
} from "./granola-oauth.js";
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
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  const now = deps.now();
  const parsed = state
    ? readConnectState(granolaStateKey(config.settings.stateSecret), state, now)
    : null;
  const db = await deps.db();
  /**
   * Granola refused `mcp` as a scope, which its authorization server does not list: the person is
   * sent through the sign-in once more with the scope left out, from this very request, so they
   * see no failure. A link that had already left `mcp` out gets no second try.
   */
  const retryWithoutMcp = async (scope: string, owner: string): Promise<boolean> => {
    if (!includesMcpScope(scope)) {
      return false;
    }
    rejectGranolaMcpScope();
    const again = await prepareGranolaConnect({
      owner,
      config: deps.config,
      db,
      now,
      force: true,
      fetchImpl: deps.fetchImpl,
    });
    if (!again.ok || again.connected) {
      return false;
    }
    res.statusCode = 302;
    res.setHeader("location", again.ask.url);
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.end();
    return true;
  };
  if (params.get("error")) {
    if (params.get("error") === "invalid_scope" && parsed) {
      const spent = await bindGranolaOwner(db, parsed.owner).consumePending(
        parsed.nonce,
        now.getTime(),
      );
      revokeShortLinksForNonce(parsed.nonce);
      if (spent && (await retryWithoutMcp(spent.scope || GRANOLA_SCOPE, parsed.owner))) {
        return true;
      }
    }
    writeAdaConnectPage(res, 200, {
      kind: "retry",
      heading: "Not connected",
      message:
        "Ada did not connect Granola. If you went back or declined, return to WhatsApp and ask Ada for a new link.",
    });
    return true;
  }
  if (!code || !parsed) {
    writeAdaConnectPage(res, 400, EXPIRED);
    return true;
  }
  const store = bindGranolaOwner(db, parsed.owner);
  const pending = await store.consumePending(parsed.nonce, now.getTime());
  revokeShortLinksForNonce(parsed.nonce);
  const client = pending ? await db.readClientById(pending.clientId) : null;
  if (!pending || !client) {
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
    if (
      exchanged?.oauthError === "invalid_scope" &&
      (await retryWithoutMcp(pending.scope || GRANOLA_SCOPE, parsed.owner))
    ) {
      return true;
    }
    if (reason === "invalid_client") {
      // Granola forgot Ada's registration: the next link registers it again.
      await db.clearClient(client.clientId);
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
