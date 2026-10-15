import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { LexroomAccountStore } from "./lexroom-account-contract.js";
import { openAdaLexroomAccountFromApi } from "./lexroom-account.js";
import { lexroomLogger } from "./lexroom-log.js";
import {
  accessTokenExpiresAtMs,
  isLexroomAccessLive,
  lexroomConnectConfigFrom,
  prepareLexroomConnect,
  type LexroomConnectConfig,
  type LexroomConnectResult,
} from "./lexroom-connect.js";
import {
  checkLexroomAuth,
  runDraft,
  runResearch,
  type CitedSource,
  type LexroomConfig,
} from "./lexroom-client.js";
import {
  readAdaWhatsAppTarget,
  ADA_WHATSAPP_CHANNEL,
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
    return await openAdaLexroomAccountFromApi(api);
  } catch (error) {
    api.logger.error(
      `ada lexroom account store failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Ada could not open the Lexroom account store." };
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
  const to = readAdaWhatsAppTarget(params.config);
  if (!to) {
    return { ok: false, error: "kapso-whatsapp defaultTo is not set" };
  }
  let adapter: { sendText?: (params: {
    cfg: OpenClawPluginApi["config"];
    to: string;
    text: string;
  }) => Promise<unknown> } | null | undefined;
  try {
    adapter = await params.loadAdapter(ADA_WHATSAPP_CHANNEL);
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

/** Removes the saved account, but only if it still holds the credential that failed. */
async function clearAccountIfStill(
  store: LexroomAccountStore,
  accessToken: string,
  api: StoreApi,
  reason: string,
): Promise<void> {
  const current = await store.readAccount();
  if (current && current.accessToken === accessToken) {
    await store.clearAccount();
    lexroomLogger(api.logger)("account.cleared", { reason });
  }
}

/**
 * Lexroom rejected a bearer that came from the saved account: drop it so the next status
 * check reports "not connected" and a fresh link can be issued. A static config token
 * has no stored copy to clear.
 */
async function dropRejectedAccount(params: {
  api: StoreApi;
  resolved: { source: "account" | "config"; config: LexroomConfig };
  outcome: { ok: boolean; reason?: string };
}): Promise<void> {
  const { api, resolved, outcome } = params;
  if (outcome.ok || outcome.reason !== "not_connected" || resolved.source !== "account") {
    return;
  }
  const store = await openStore(api);
  if (isStoreFailure(store)) {
    return;
  }
  try {
    await clearAccountIfStill(store, resolved.config.accessToken ?? "", api, "lexroom_rejected");
  } catch (error) {
    api.logger.error(
      `ada lexroom account clear failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

/**
 * Connection status and link issuer. A saved account is checked with a live authenticated
 * Lexroom call; only a 401 proves it dead, so only then is it cleared and replaced by a new
 * link. A 403, an error or silence from Lexroom leaves the sign-in in place. `force` drops
 * whatever is saved and always issues a link.
 */
export async function executeAdaLexroomConnect(
  config: LexroomConnectConfig,
  api: StoreApi,
  now = new Date(),
  options: { force?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<LexroomConnectResult | ToolFailure> {
  const store = await openStore(api);
  if (isStoreFailure(store)) {
    return store;
  }
  const log = lexroomLogger(api.logger);
  try {
    let account = await store.readAccount();
    if (account && options.force) {
      await clearAccountIfStill(store, account.accessToken, api, "forced");
      account = null;
    }
    if (
      account &&
      isLexroomAccessLive({
        accessToken: account.accessToken,
        accessExpiresAtMs: account.accessExpiresAtMs,
        now,
      })
    ) {
      const verdict = await checkLexroomAuth({
        config: {
          accessToken: account.accessToken,
          baseUrl: config.baseUrl,
        },
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        log,
      });
      if (verdict === "rejected") {
        await clearAccountIfStill(store, account.accessToken, api, "status_check_rejected");
        account = null;
      }
    }
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
      `ada lexroom connect failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Ada could not prepare the Lexroom connect link." };
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
            idleTimeoutMs: params.config.idleTimeoutMs,
            answerTimeoutMs: params.config.answerTimeoutMs,
            researchModules: params.config.researchModules,
          },
        };
      }
      if (account) {
        return {
          ok: false,
          reason: "not_connected",
          error:
            "The Lexroom connection expired. Call ada_lexroom_connect and send that link.",
        };
      }
    } catch (error) {
      params.api.logger.error(
        `ada lexroom resolve failed: ${error instanceof Error ? error.message : "unknown"}`,
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
        idleTimeoutMs: params.config.idleTimeoutMs,
        answerTimeoutMs: params.config.answerTimeoutMs,
        researchModules: params.config.researchModules,
      },
    };
  }
  return {
    ok: false,
    reason: "not_connected",
    error: "Lexroom is not connected. Call ada_lexroom_connect and send that link.",
  };
}

/** Same as resolveLexroomConfig, with the tool call and the account lookup time in the log. */
export async function resolveLexroomConfigLogged(params: {
  tool: string;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  now?: Date;
}): ReturnType<typeof resolveLexroomConfig> {
  const log = lexroomLogger(params.api.logger);
  const startedAt = Date.now();
  log("tool.invoked", { tool: params.tool });
  const resolved = await resolveLexroomConfig(params);
  log("config.resolved", {
    tool: params.tool,
    ok: resolved.ok,
    source: resolved.ok ? resolved.source : resolved.reason,
    ...(resolved.ok ? { tokenExpiresInSec: tokenExpiresInSec(resolved.config.accessToken) } : {}),
    ms: Date.now() - startedAt,
  });
  return resolved;
}

/** Seconds of life left in a JWT bearer; -1 when the token is opaque and carries no expiry. */
function tokenExpiresInSec(accessToken: string | undefined): number {
  const expiresAtMs = accessToken ? accessTokenExpiresAtMs(accessToken) : null;
  return expiresAtMs === null ? -1 : Math.round((expiresAtMs - Date.now()) / 1000);
}

type ResearchArgs = {
  matterId: string;
  query: string;
  libraryDocumentIds?: string[];
  modules?: string[];
  parentResearchId?: string;
};

type DraftArgs = {
  matterId: string;
  prompt: string;
  confirmed: boolean;
  modules?: string[];
  parentResearchId?: string;
};

/** ada_research: resolves the Lexroom credential, runs the call, drops a rejected account. */
export async function executeAdaResearch(params: {
  args: ResearchArgs;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const resolved = await resolveLexroomConfigLogged({
    tool: "ada_research",
    config: params.config,
    api: params.api,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const outcome = await runResearch({
    config: resolved.config,
    ...params.args,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
    log: lexroomLogger(params.api.logger),
  });
  await dropRejectedAccount({ api: params.api, resolved, outcome });
  return outcome;
}

/** ada_draft: nothing is resolved or sent until the lawyer has confirmed. */
export async function executeAdaDraft(params: {
  args: DraftArgs;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  if (!params.args.confirmed) {
    return await runDraft({ config: params.config, ...params.args, signal: params.signal });
  }
  const resolved = await resolveLexroomConfigLogged({
    tool: "ada_draft",
    config: params.config,
    api: params.api,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const outcome = await runDraft({
    config: resolved.config,
    ...params.args,
    signal: params.signal,
    fetchImpl: params.fetchImpl,
    log: lexroomLogger(params.api.logger),
  });
  await dropRejectedAccount({ api: params.api, resolved, outcome });
  return outcome;
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
 * drafts and never sends mail. Uses the connected Lexroom account like ada_research.
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
  const resolved = await resolveLexroomConfigLogged({
    tool: "deadline_research",
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
    log: lexroomLogger(params.api.logger),
  });
  await dropRejectedAccount({ api: params.api, resolved, outcome });
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
