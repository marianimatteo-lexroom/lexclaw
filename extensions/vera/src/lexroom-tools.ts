import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { LexroomAccountStore } from "./lexroom-account-contract.js";
import { openVeraLexroomAccountFromApi } from "./lexroom-account.js";
import {
  isLexroomAccessLive,
  lexroomConnectConfigFrom,
  prepareLexroomConnect,
  type LexroomConnectConfig,
  type LexroomConnectResult,
} from "./lexroom-connect.js";
import { runResearch, type CitedSource, type LexroomConfig } from "./lexroom-client.js";
import {
  readVeraWhatsAppTarget,
  VERA_WHATSAPP_CHANNEL,
  type GoogleConnectedNotice,
} from "./google-notify.js";
import type { DeadlineItem } from "./memory-contract.js";

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
    return await prepareLexroomConnect({
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
            researchModules: params.config.researchModules,
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
        researchModules: params.config.researchModules,
      },
    };
  }
  return {
    ok: false,
    reason: "not_connected",
    error: "Lexroom is not connected. Call vera_lexroom_connect and send that link.",
  };
}

export { lexroomConnectConfigFrom };

const RESEARCH_EXCERPT_CHARS = 300;

/** Research prompt for one hearing or deadline. Only the notice's own sentence is quoted. */
export function buildDeadlineResearchQuery(params: {
  item: Pick<DeadlineItem, "type" | "dueDate" | "dueTime" | "timeZone" | "title" | "sources">;
  matterLabel: string;
  language?: string | null;
}): string {
  const { item } = params;
  const when = item.dueTime ? `${item.dueDate} ${item.dueTime}` : item.dueDate;
  const excerpt = (item.sources[0]?.excerpt ?? item.title)
    .replace(/["\u201c\u201d]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  return [
    `Prepare a concise briefing for a lawyer ahead of a ${item.type === "hearing" ? "hearing" : "filing deadline"} on ${when} (${item.timeZone}) in the matter "${params.matterLabel}".`,
    `The notice says: "${excerpt.slice(0, RESEARCH_EXCERPT_CHARS)}".`,
    "Cover the procedural rules and formalities that apply, what must be filed or prepared and by when, how the time limits are counted, the main risks, and the recommended next steps. Cite the sources you rely on.",
    ...(params.language?.trim() ? [`Answer in ${params.language.trim()}.`] : []),
  ].join("\n");
}

export type DeadlineResearchResult =
  | { ok: true; answer: string; sources: CitedSource[]; researchId?: string }
  | { ok: false; error: string; reason?: "not_connected" };

/**
 * Lexroom research for one tracked item, scoped to its matter. Read-only: it never
 * drafts and never sends mail. Uses the connected Lexroom account like vera_research.
 */
export async function runDeadlineResearch(params: {
  item: DeadlineItem;
  matterLabel: string;
  language?: string | null;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  now?: Date;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DeadlineResearchResult> {
  const resolved = await resolveLexroomConfig({
    config: params.config,
    api: params.api,
    now: params.now,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const outcome = await runResearch({
    config: resolved.config,
    matterId: params.item.matterId,
    query: buildDeadlineResearchQuery({
      item: params.item,
      matterLabel: params.matterLabel,
      language: params.language,
    }),
    signal: params.signal,
    fetchImpl: params.fetchImpl,
  });
  if (!outcome.ok) {
    return outcome;
  }
  if (!outcome.answer.trim()) {
    return { ok: false, error: "Lexroom returned an empty briefing." };
  }
  return {
    ok: true,
    answer: outcome.answer,
    sources: outcome.sources,
    ...(outcome.researchId ? { researchId: outcome.researchId } : {}),
  };
}
