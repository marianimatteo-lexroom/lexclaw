import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { LexroomAccountStore } from "./lexroom-account-contract.js";
import { openVeraLexroomAccountFromApi } from "./lexroom-account.js";
import {
  isLexroomAccessLive,
  lexroomConnectConfigFrom,
  planLexroomConnect,
  sameStoredAccessToken,
  type LexroomConnectConfig,
  type LexroomConnectResult,
} from "./lexroom-connect.js";
import {
  invalidateLexroomAccessCache,
  probeLexroomAccess,
  type LexroomConfig,
} from "./lexroom-client.js";
import {
  readVeraWhatsAppTarget,
  VERA_WHATSAPP_CHANNEL,
  type GoogleConnectedNotice,
} from "./google-notify.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger">;

type ToolFailure = {
  ok: false;
  error: string;
  reason?: "not_connected";
};

function isStoreFailure(store: LexroomAccountStore | ToolFailure): store is ToolFailure {
  return "ok" in store;
}

async function openStore(api: StoreApi): Promise<LexroomAccountStore | ToolFailure> {
  try {
    return await openVeraLexroomAccountFromApi(api);
  } catch (error) {
    api.logger.error(
      `vera lexroom account store failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Vera could not open the Lexroom account store." };
  }
}

export function lexroomConnectedText(_email: string): string {
  return "Lexroom is connected. I can run research and drafts when you ask.";
}

export async function sendLexroomConnectedNotice(params: {
  config: OpenClawPluginApi["config"];
  email: string;
  loadAdapter: (channelId: string) => Promise<{ sendText?: (params: {
    cfg: OpenClawPluginApi["config"];
    to: string;
    text: string;
  }) => Promise<unknown> } | null | undefined>;
}): Promise<GoogleConnectedNotice> {
  const to = readVeraWhatsAppTarget(params.config);
  if (!to) {
    return { ok: false, error: "kapso-whatsapp defaultTo is not set" };
  }
  let adapter: { sendText?: (params: {
    cfg: OpenClawPluginApi["config"];
    to: string;
    text: string;
  }) => Promise<unknown> } | null | undefined;
  try {
    adapter = await params.loadAdapter(VERA_WHATSAPP_CHANNEL);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "whatsapp outbound failed",
    };
  }
  const send = adapter?.sendText;
  if (!send) {
    return { ok: false, error: "kapso-whatsapp outbound is unavailable" };
  }
  try {
    await send({
      cfg: params.config,
      to,
      text: lexroomConnectedText(params.email),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "whatsapp send failed",
    };
  }
  return { ok: true };
}

export async function executeVeraLexroomConnect(
  config: LexroomConnectConfig,
  api: StoreApi,
  now = new Date(),
): Promise<LexroomConnectResult | ToolFailure> {
  const store = await openStore(api);
  if (isStoreFailure(store)) {
    return store;
  }
  try {
    const account = await store.readAccount();
    return await planLexroomConnect({
      config,
      now,
      account: account
        ? {
            email: account.email,
            accessToken: account.accessToken,
            accessExpiresAtMs: account.accessExpiresAtMs,
          }
        : null,
      savePending: (nonce, expiresAtMs) => store.replacePending(nonce, expiresAtMs),
      clearAccount: async () => {
        if (!account) {
          return;
        }
        invalidateLexroomAccessCache(account.accessToken);
        const current = await store.readAccount();
        if (!sameStoredAccessToken(current?.accessToken, account.accessToken)) {
          return;
        }
        await store.clearAccount();
      },
      probeAccess: (accessToken) =>
        probeLexroomAccess({
          accessToken,
          baseUrl: config.baseUrl,
          nowMs: now.getTime(),
        }),
    });
  } catch (error) {
    api.logger.error(
      `vera lexroom connect failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Vera could not prepare the Lexroom connect link." };
  }
}

/** Prefer the linked Lexroom account; fall back to a static config token. */
export async function resolveLexroomConfig(params: {
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  now?: Date;
}): Promise<
  | { ok: true; config: LexroomConfig; email?: string; source: "account" | "config" }
  | { ok: false; reason: "not_connected"; error: string }
> {
  const now = params.now ?? new Date();
  const store = await openStore(params.api);
  if (!isStoreFailure(store)) {
    try {
      const account = await store.readAccount();
      if (
        account &&
        isLexroomAccessLive({
          accessToken: account.accessToken,
          accessExpiresAtMs: account.accessExpiresAtMs,
          now,
        })
      ) {
        return {
          ok: true,
          source: "account",
          email: account.email,
          config: {
            accessToken: account.accessToken,
            baseUrl: params.config.baseUrl,
            timeoutMs: params.config.timeoutMs,
          },
        };
      }
      if (account) {
        return {
          ok: false,
          reason: "not_connected",
          error:
            "The Lexroom connection expired. Call vera_lexroom_connect and send that link.",
        };
      }
    } catch (error) {
      params.api.logger.error(
        `vera lexroom resolve failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  const fallback = params.config.accessToken?.trim() ?? "";
  if (
    fallback &&
    isLexroomAccessLive({
      accessToken: fallback,
      accessExpiresAtMs: null,
      now,
    })
  ) {
    return {
      ok: true,
      source: "config",
      config: {
        accessToken: fallback,
        baseUrl: params.config.baseUrl,
        timeoutMs: params.config.timeoutMs,
      },
    };
  }
  return {
    ok: false,
    reason: "not_connected",
    error: "Lexroom is not connected. Call vera_lexroom_connect and send that link.",
  };
}

export async function releaseRejectedLexroomAccount(params: {
  api: StoreApi;
  source: "account" | "config" | undefined;
  accessToken?: string;
  result: { ok: boolean; reason?: string };
}): Promise<void> {
  if (params.result.ok || params.result.reason !== "not_connected" || params.source !== "account") {
    return;
  }
  if (params.accessToken) {
    invalidateLexroomAccessCache(params.accessToken);
  }
  const store = await openStore(params.api);
  if (isStoreFailure(store)) {
    return;
  }
  try {
    const current = await store.readAccount();
    if (!sameStoredAccessToken(current?.accessToken, params.accessToken)) {
      return;
    }
    await store.clearAccount();
  } catch (error) {
    params.api.logger.error(
      `vera lexroom account clear failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

export { lexroomConnectConfigFrom };
