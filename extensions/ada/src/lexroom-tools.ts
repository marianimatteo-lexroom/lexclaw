import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { ADA_WHATSAPP_CHANNEL, type GoogleConnectedNotice } from "./google-notify.js";
import type { LexroomAccountStore } from "./lexroom-account-contract.js";
import { openAdaLexroomAccountFromApi } from "./lexroom-account.js";
import {
  checkLexroomAuth,
  runDraft,
  runResearch,
  type CitedSource,
  type LexroomConfig,
  type LexroomFailure,
} from "./lexroom-client.js";
import {
  accessTokenExpiresAtMs,
  isLexroomAccessLive,
  lexroomConnectConfigFrom,
  prepareLexroomConnect,
  type LexroomConnectConfig,
  type LexroomConnectResult,
} from "./lexroom-connect.js";
import { startResearchJob } from "./lexroom-jobs.js";
import { lexroomLogger } from "./lexroom-log.js";
import {
  clearAccountIfStill,
  ensureUsableAccount,
  needsReconnect,
  renewLexroomAccount,
  type RenewFailure,
} from "./lexroom-session.js";
import {
  defaultTotalTimeoutMs,
  lexroomTimeoutMs,
  MIN_LEXROOM_TIMEOUT_MS,
} from "./lexroom-timeout.js";
import type { DeadlineItem } from "./memory-contract.js";
import { lawyerOwner } from "./owner.js";
import {
  livePushDeps,
  pushResearchResult,
  sendResearchAck,
  type PushDeps,
} from "./research-push.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

type ToolFailure = {
  ok: false;
  error: string;
  reason?: "not_connected";
};

function isStoreFailure(store: LexroomAccountStore | ToolFailure): store is ToolFailure {
  return "ok" in store;
}

async function openStore(api: StoreApi, owner: string): Promise<LexroomAccountStore | ToolFailure> {
  try {
    return await openAdaLexroomAccountFromApi(api, owner);
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
  /** The WhatsApp number that connected the account; the confirmation goes to it alone. */
  owner: string;
  email: string;
  loadAdapter: (channelId: string) => Promise<
    | {
        sendText?: (params: {
          cfg: OpenClawPluginApi["config"];
          to: string;
          text: string;
        }) => Promise<unknown>;
      }
    | null
    | undefined
  >;
}): Promise<GoogleConnectedNotice> {
  const to = `+${params.owner}`;
  let adapter:
    | {
        sendText?: (params: {
          cfg: OpenClawPluginApi["config"];
          to: string;
          text: string;
        }) => Promise<unknown>;
      }
    | null
    | undefined;
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

type Failure = LexroomFailure;

/** The tool result for a renewal that did not produce a usable token. */
function renewalFailure(failure: RenewFailure): Failure {
  if (failure.reason === "timeout") {
    return { ok: false, reason: "timeout", message: failure.error, error: failure.error };
  }
  if (failure.reason === "forbidden" || failure.reason === "captcha_required") {
    return { ok: false, reason: failure.reason, error: failure.error };
  }
  return needsReconnect(failure)
    ? { ok: false, reason: "not_connected", error: failure.error }
    : { ok: false, error: failure.error };
}

/**
 * Runs a Lexroom call with the saved account's token. When Lexroom answers 401, the token is
 * renewed once from the saved email and password and the call is repeated once. A wrong
 * password clears the account; an account that needs a one-time code or has no saved password
 * cannot be renewed, and the token is dead, so it is cleared too. A 403 never reaches here:
 * the client gives it no reconnect reason. A static config token has nothing to renew.
 */
async function runWithRecovery<T extends { ok: boolean; reason?: string }>(params: {
  owner: string;
  api: StoreApi;
  resolved: { source: "account" | "config"; config: LexroomConfig };
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  run: (config: LexroomConfig) => Promise<T>;
}): Promise<T | Failure> {
  const { api, resolved } = params;
  const first = await params.run(resolved.config);
  if (first.ok || first.reason !== "not_connected" || resolved.source !== "account") {
    return first;
  }
  const store = await openStore(api, params.owner);
  if (isStoreFailure(store)) {
    return first;
  }
  const log = lexroomLogger(api.logger);
  try {
    const account = await store.readAccount();
    if (!account || account.accessToken !== resolved.config.accessToken) {
      return first;
    }
    const renewed = await renewLexroomAccount(account, {
      store,
      baseUrl: resolved.config.baseUrl,
      fetchImpl: params.fetchImpl,
      signal: params.signal,
      log,
      now: new Date(),
      why: "rejected",
    });
    if (!renewed.ok) {
      if (needsReconnect(renewed) && renewed.reason !== "wrong_password") {
        await clearAccountIfStill(store, account.accessToken, log, "lexroom_rejected");
      }
      return renewalFailure(renewed);
    }
    const second = await params.run({
      ...resolved.config,
      accessToken: renewed.account.accessToken,
    });
    if (!second.ok && second.reason === "not_connected") {
      log("relogin.retry_rejected", {});
      return {
        ok: false,
        error:
          "Lexroom rejected a sign-in Ada had just renewed. Try again shortly; if it keeps happening, call ada_lexroom_connect with force true.",
      };
    }
    return second;
  } catch (error) {
    api.logger.error(
      `ada lexroom recovery failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return first;
  }
}

/**
 * Connection status and link issuer. A saved sign-in is renewed from the saved email and
 * password when its token is missing or about to expire, then checked with a live Lexroom
 * call. A 401 there triggers one renewal; only a wrong password, or a dead token with nothing
 * to renew it with, clears the account and issues a new link. A 403, an error or silence from
 * Lexroom leaves the sign-in in place. `force` drops whatever is saved and always issues a link.
 */
export async function executeAdaLexroomConnect(
  owner: string,
  config: LexroomConnectConfig,
  api: StoreApi,
  now = new Date(),
  options: { force?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<LexroomConnectResult | ToolFailure> {
  const store = await openStore(api, owner);
  if (isStoreFailure(store)) {
    return store;
  }
  const log = lexroomLogger(api.logger);
  const renewal = {
    store,
    baseUrl: config.baseUrl,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    log,
    now,
  };
  try {
    let account = await store.readAccount();
    let reconnect: RenewFailure | undefined;
    if (account && options.force) {
      await clearAccountIfStill(store, account.accessToken, log, "forced");
      account = null;
    }
    if (account) {
      const ensured = await ensureUsableAccount(account, renewal);
      if (!ensured.ok && !needsReconnect(ensured)) {
        // Lexroom did not answer: the saved email and password are still the best we have.
        return { ok: true, connected: true, email: account.email };
      }
      if (!ensured.ok) {
        // Cleared already for a wrong password; otherwise the stale row is replaced on connect.
        reconnect = ensured;
        account = null;
      } else {
        account = ensured.account;
        const verdict = await checkLexroomAuth({
          config: { accessToken: account.accessToken, baseUrl: config.baseUrl },
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          log,
        });
        if (verdict === "rejected") {
          const renewed = await renewLexroomAccount(account, { ...renewal, why: "rejected" });
          if (!renewed.ok && needsReconnect(renewed)) {
            reconnect = renewed;
            if (renewed.reason !== "wrong_password") {
              await clearAccountIfStill(store, account.accessToken, log, "status_check_rejected");
            }
            account = null;
          }
        }
      }
    }
    return await prepareLexroomConnect({
      owner,
      config,
      now,
      account: account
        ? {
            email: account.email,
            accessToken: account.accessToken,
            accessExpiresAtMs: account.accessExpiresAtMs,
          }
        : null,
      reconnectReason: reconnect?.reason === "mfa_required" ? "mfa" : undefined,
      savePending: (nonce, expiresAtMs) => store.replacePending(nonce, expiresAtMs),
    });
  } catch (error) {
    api.logger.error(
      `ada lexroom connect failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Ada could not prepare the Lexroom connect link." };
  }
}

/**
 * The owner's linked Lexroom account, renewing its token when needed. Only the configured
 * lawyer may fall back to the static config token; every other number without a connection is
 * simply not connected.
 */
export async function resolveLexroomConfig(params: {
  /** The WhatsApp number whose account is used: the only account there is for this call. */
  owner: string;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  now?: Date;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<
  { ok: true; config: LexroomConfig; email?: string; source: "account" | "config" } | LexroomFailure
> {
  const now = params.now ?? new Date();
  const store = await openStore(params.api, params.owner);
  if (!isStoreFailure(store)) {
    try {
      const account = await store.readAccount();
      if (account) {
        const ensured = await ensureUsableAccount(account, {
          store,
          baseUrl: params.config.baseUrl,
          fetchImpl: params.fetchImpl,
          signal: params.signal,
          log: lexroomLogger(params.api.logger),
          now,
        });
        if (!ensured.ok) {
          return renewalFailure(ensured);
        }
        return {
          ok: true,
          source: "account",
          email: ensured.account.email,
          config: {
            accessToken: ensured.account.accessToken,
            baseUrl: params.config.baseUrl,
            timeoutMs: params.config.timeoutMs,
            idleTimeoutMs: params.config.idleTimeoutMs,
            answerTimeoutMs: params.config.answerTimeoutMs,
            researchModules: params.config.researchModules,
          },
        };
      }
    } catch (error) {
      params.api.logger.error(
        `ada lexroom resolve failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  // The static token in plugin config is the configured lawyer's own, and no one else's.
  const fallback =
    params.owner === lawyerOwner(params.api.config)
      ? (params.config.accessToken?.trim() ?? "")
      : "";
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
    error:
      "Lexroom is not connected. Ask whether they want to connect; call ada_lexroom_connect and send the link only after they agree (or if they asked to connect).",
  };
}

/** Same as resolveLexroomConfig, with the tool call and the account lookup time in the log. */
export async function resolveLexroomConfigLogged(params: {
  owner: string;
  tool: string;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  now?: Date;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): ReturnType<typeof resolveLexroomConfig> {
  const log = lexroomLogger(params.api.logger);
  const startedAt = Date.now();
  log("tool.invoked", { tool: params.tool });
  const { tool: _tool, ...resolveParams } = params;
  const resolved = await resolveLexroomConfig(resolveParams);
  log("config.resolved", {
    tool: params.tool,
    ok: resolved.ok,
    source: resolved.ok ? resolved.source : (resolved.reason ?? "unavailable"),
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

/** ada_research: resolves the Lexroom credential, runs the call, renews it once on a 401. */
export async function executeAdaResearch(params: {
  owner: string;
  args: ResearchArgs;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const resolved = await resolveLexroomConfigLogged({
    owner: params.owner,
    tool: "ada_research",
    config: params.config,
    api: params.api,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (!resolved.ok) {
    return resolved;
  }
  return await runWithRecovery({
    owner: params.owner,
    api: params.api,
    resolved,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    run: (config) =>
      runResearch({
        config,
        ...params.args,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        log: lexroomLogger(params.api.logger),
      }),
  });
}

type PushApi = Parameters<typeof livePushDeps>[0];

/**
 * ada_research: checks the arguments, then runs the research as a background job and returns
 * its handle at once. The job gets its own abort signal, because the tool call's ends when the
 * tool returns.
 *
 * `owner` is the WhatsApp number of the private chat that asked, taken from the host's trusted
 * context by the caller. The research runs with that number's Lexroom account and nobody else's,
 * code tells that number that it is running and sends it the result when it ends, so the model
 * neither polls nor has to remember to say anything. Messages go only to that number.
 */
export async function startAdaResearch(params: {
  owner: string;
  args: ResearchArgs;
  config: LexroomConfig & LexroomConnectConfig;
  api: StoreApi & PushApi;
  fetchImpl?: typeof fetch;
  /** Test seam: the sender, window check and nudge for one recipient. Defaults to the live ones. */
  pushDepsFor?: (recipient: string) => PushDeps;
}) {
  const matterId = params.args.matterId.trim();
  if (!matterId) {
    return { ok: false as const, error: "matterId is required" };
  }
  if (!params.args.query.trim()) {
    return { ok: false as const, error: "query is required" };
  }
  const log = lexroomLogger(params.api.logger);
  const { owner } = params;
  const push = (params.pushDepsFor ?? ((to) => livePushDeps(params.api, log, to)))(owner);
  const total =
    params.config.timeoutMs && params.config.timeoutMs >= MIN_LEXROOM_TIMEOUT_MS
      ? params.config.timeoutMs
      : defaultTotalTimeoutMs();
  const started = startResearchJob({
    matterId,
    owner,
    // The call's own total cap, plus room for the sign-in and module lookups before it.
    deadlineMs: total + 3 * lexroomTimeoutMs(),
    log,
    deliver: (result, job) =>
      pushResearchResult(
        {
          jobId: job.id,
          startedAtMs: job.startedAtMs,
          result,
          query: params.args.query,
        },
        push,
      ),
    run: (signal) =>
      executeAdaResearch({
        owner,
        args: params.args,
        config: params.config,
        api: params.api,
        fetchImpl: params.fetchImpl,
        signal,
      }),
  });
  if (!started.ok) {
    return started;
  }
  const notified = await sendResearchAck({ jobId: started.jobId, query: params.args.query }, push);
  return {
    ...started,
    requesterNotified: notified,
    message: notified
      ? "Research started in the background. Ada already told the requester on WhatsApp that it is running and will send the answer herself when it is ready. Do not call ada_research_status and do not message them about it; end this turn with exactly NO_REPLY."
      : "Research started in the background. Ada could not message the requester, so tell them in one short line that it is running; Ada will still send the answer herself when it is ready. Do not call ada_research_status.",
  };
}

/** ada_draft: nothing is resolved or sent until the user has confirmed. */
export async function executeAdaDraft(params: {
  owner: string;
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
    owner: params.owner,
    tool: "ada_draft",
    config: params.config,
    api: params.api,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (!resolved.ok) {
    return resolved;
  }
  return await runWithRecovery({
    owner: params.owner,
    api: params.api,
    resolved,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    run: (config) =>
      runDraft({
        config,
        ...params.args,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        log: lexroomLogger(params.api.logger),
      }),
  });
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
  | { ok: true; answer: string; sources: CitedSource[]; researchId?: string; researchUrl?: string }
  | LexroomFailure;

/**
 * Lexroom research for one tracked item, scoped to its matter. Read-only: it never
 * drafts and never sends mail. Uses the connected Lexroom account like ada_research.
 */
export async function runDeadlineResearch(params: {
  owner: string;
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
    owner: params.owner,
    tool: "deadline_research",
    config: params.config,
    api: params.api,
    now: params.now,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const outcome = await runWithRecovery({
    owner: params.owner,
    api: params.api,
    resolved,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    run: (config) =>
      runResearch({
        config,
        matterId: params.item.matterId,
        query: buildDeadlineResearchQuery({
          item: params.item,
          matterLabel: params.matterLabel,
          language: params.language,
        }),
        signal: params.signal,
        fetchImpl: params.fetchImpl,
        log: lexroomLogger(params.api.logger),
      }),
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
    ...(outcome.researchUrl ? { researchUrl: outcome.researchUrl } : {}),
  };
}
