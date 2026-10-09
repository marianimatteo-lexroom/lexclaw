import type { IncomingMessage, ServerResponse } from "node:http";
import type { GoogleAccountStore } from "./google-account-contract.js";
import { exchangeAuthorizationCode } from "./google-api.js";
import {
  readConnectState,
  readGoogleConnectConfig,
  type GoogleConnectConfig,
} from "./google-connect.js";

type CallbackDeps = {
  config: GoogleConnectConfig;
  now: () => Date;
  store: GoogleAccountStore;
  exchange: typeof exchangeAuthorizationCode;
  log: { error: (message: string) => void };
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Vera</title></head><body><p>${text}</p></body></html>`,
  );
}

function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
}

export async function handleVeraGoogleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CallbackDeps,
): Promise<boolean> {
  if (req.method !== "GET") {
    page(res, 405, "Vera could not finish connecting the Google account.");
    return true;
  }
  const config = readGoogleConnectConfig(deps.config);
  if (!config.ok) {
    deps.log.error("vera google callback is not configured");
    page(res, 503, "Vera Google connect is not configured.");
    return true;
  }
  const params = query(req);
  if (params.get("error")) {
    page(
      res,
      200,
      "Vera did not connect Gmail or Google Calendar. Return to WhatsApp and ask Vera for a new link.",
    );
    return true;
  }
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  const now = deps.now();
  const parsed = state ? readConnectState(config.settings.stateSecret, state, now) : null;
  if (!code || !parsed) {
    page(
      res,
      400,
      "This connect link is no longer valid. Return to WhatsApp and ask Vera for a new link.",
    );
    return true;
  }
  const pending = await deps.store.consumePending(parsed.nonce, now.getTime());
  if (!pending) {
    page(
      res,
      400,
      "This connect link is no longer valid. Return to WhatsApp and ask Vera for a new link.",
    );
    return true;
  }
  const exchanged = await deps.exchange({
    clientId: config.settings.clientId,
    clientSecret: config.settings.clientSecret,
    redirectUri: config.settings.redirectUri,
    code,
    now,
  });
  if (!exchanged.ok) {
    deps.log.error(`vera google token exchange failed: ${exchanged.reason}`);
    const text =
      exchanged.reason === "denied_scopes"
        ? "Approve both Gmail and Google Calendar, then ask Vera for a new link."
        : "Vera could not finish connecting the Google account. Return to WhatsApp and ask for a new link.";
    page(res, 400, text);
    return true;
  }
  await deps.store.upsertAccount({
    email: exchanged.token.email,
    refreshToken: exchanged.token.refreshToken,
    accessToken: exchanged.token.accessToken,
    accessExpiresAtMs: exchanged.token.accessExpiresAtMs,
    connectedAtMs: now.getTime(),
  });
  page(
    res,
    200,
    `Gmail and Google Calendar are connected to Vera for ${escapeHtml(exchanged.token.email)}. You can close this page and return to WhatsApp.`,
  );
  return true;
}
