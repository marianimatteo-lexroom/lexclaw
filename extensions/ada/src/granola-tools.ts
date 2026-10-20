import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { GranolaAccountDb } from "./granola-account-contract.js";
import { bindGranolaOwner, openAdaGranolaAccountDbFromApi } from "./granola-account.js";
import { prepareGranolaConnect, type GranolaConnectConfig } from "./granola-connect.js";
import {
  callGranolaTool,
  listGranolaTools,
  type GranolaMcpFailure,
  type GranolaMcpResult,
  type GranolaToolInfo,
} from "./granola-mcp.js";
import { discoverGranolaEndpoints, revokeGranolaToken } from "./granola-oauth.js";
import { forgetHeldGranolaReminder } from "./granola-reminder.js";
import { loadGranolaAccess } from "./granola-session.js";
import { maskNumber } from "./inbound-log.js";

type ToolApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger">;

/** Test seams: a ready store, the fetch every Granola request uses, and the clock. */
export type GranolaToolDeps = { db?: GranolaAccountDb; fetchImpl?: typeof fetch; now?: Date };

/** What one tool result may carry back to the model; the rest is paged with `offset`. */
export const GRANOLA_RESULT_CHARS = 14_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 12;
const CACHE_MAX_CHARS = 1_500_000;
const MAX_ARGUMENT_CHARS = 8_000;
const SCHEMA_CHARS = 1_500;

type Failure = { ok: false; reason: string; error: string };

const NOT_CONNECTED: Failure = {
  ok: false,
  reason: "not_connected",
  error:
    "Granola is not connected. Ask whether they want to connect; call ada_granola_connect and send the link only after they agree (or if they asked to connect).",
};

const RECONNECT: Failure = {
  ok: false,
  reason: "not_connected",
  error:
    "Granola no longer accepts the saved connection. Ask whether they want to reconnect; call ada_granola_connect and send the new link only after they agree (or if they asked to connect).",
};

const UNAVAILABLE: Failure = {
  ok: false,
  reason: "unavailable",
  error:
    "Ada could not reach Granola. Tell the person, in one natural sentence, to try again shortly.",
};

function dbFor(api: ToolApi, deps: GranolaToolDeps): Promise<GranolaAccountDb> {
  return deps.db ? Promise.resolve(deps.db) : openAdaGranolaAccountDbFromApi(api);
}

type Cached = { owner: string; text: string; atMs: number };

/** Recent full results, so reading a long transcript in pages does not fetch it again each time. */
const cache = new Map<string, Cached>();

function cacheKey(owner: string, tool: string, args: Record<string, unknown>): string {
  return JSON.stringify([owner, tool, args]);
}

function remember(key: string, entry: Cached): void {
  if (entry.text.length > CACHE_MAX_CHARS) {
    return;
  }
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value ?? key);
  }
}

/** Forgets what was read for `owner`, on disconnect. */
export function clearGranolaResults(owner?: string): void {
  for (const [key, entry] of cache) {
    if (owner === undefined || entry.owner === owner) {
      cache.delete(key);
    }
  }
}

function page(text: string, offset: number) {
  let end = Math.min(text.length, offset + GRANOLA_RESULT_CHARS);
  if (end < text.length) {
    const newline = text.lastIndexOf("\n", end);
    if (newline > offset + GRANOLA_RESULT_CHARS * 0.8) {
      end = newline;
    }
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
  }
  return { text: text.slice(offset, end), end };
}

/** Starts or renews the person's connection and returns the one short link that signs them in. */
export async function executeAdaGranolaConnect(
  owner: string,
  config: GranolaConnectConfig,
  api: ToolApi,
  args: { force?: boolean },
  signal?: AbortSignal,
  deps: GranolaToolDeps = {},
) {
  try {
    return await prepareGranolaConnect({
      owner,
      config,
      db: await dbFor(api, deps),
      now: deps.now ?? new Date(),
      force: args.force === true,
      fetchImpl: deps.fetchImpl,
      signal,
      log: (message) => api.logger.warn(`${message} owner=${maskNumber(owner)}`),
    });
  } catch (error) {
    api.logger.error(
      `ada granola connect failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not prepare the Granola connect link." };
  }
}

/** Deletes the saved sign-in of one number, asking Granola to revoke it when it can. */
export async function executeAdaGranolaDisconnect(
  owner: string,
  api: ToolApi,
  signal?: AbortSignal,
  deps: GranolaToolDeps = {},
) {
  try {
    const db = await dbFor(api, deps);
    const store = bindGranolaOwner(db, owner);
    const account = await store.readAccount();
    let revoked = false;
    if (account) {
      const client = await db.readClient();
      const endpoints =
        client?.clientId === account.clientId
          ? await discoverGranolaEndpoints({ fetchImpl: deps.fetchImpl, signal })
          : null;
      if (client && endpoints) {
        revoked = await revokeGranolaToken({
          endpoints,
          client,
          token: account.refreshToken ?? account.accessToken,
          fetchImpl: deps.fetchImpl,
          signal,
        });
      }
    }
    await store.clearAccount();
    clearGranolaResults(owner);
    forgetHeldGranolaReminder(owner);
    return { ok: true as const, disconnected: account !== null, revoked };
  } catch (error) {
    api.logger.error(
      `ada granola disconnect failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not disconnect Granola." };
  }
}

function describeTools(tools: readonly GranolaToolInfo[]) {
  return tools
    .filter((tool) => tool.readOnly)
    .map((tool) => {
      const schema = JSON.stringify(tool.inputSchema);
      return {
        name: tool.name,
        description: tool.description.slice(0, 400),
        inputSchema: schema.length <= SCHEMA_CHARS ? tool.inputSchema : undefined,
        inputSchemaTruncated: schema.length > SCHEMA_CHARS ? true : undefined,
      };
    });
}

function mapFailure(failure: GranolaMcpFailure, tool?: string): Failure & Record<string, unknown> {
  switch (failure.kind) {
    case "plan":
      return {
        ok: false,
        reason: "plan_limit",
        error:
          "Granola says this is not part of the person's plan: the free plan only gives access to notes from the last 30 days, and some features need a paid plan. Explain it naturally in their language, without technical detail, and offer what you can still do with their recent notes. Do not push an upgrade.",
        detail: failure.message,
      };
    case "too_large":
      return {
        ok: false,
        reason: "too_large",
        error:
          "That result is too large for Granola to return in one piece. Ask for a narrower part instead, for example one meeting at a time, a shorter date range, or a question about the meeting (the query tool answers questions without the whole transcript), and then summarize.",
        detail: failure.message,
      };
    case "missing_tool":
      return {
        ok: false,
        reason: "tool_unavailable",
        error: `Granola does not offer ${tool ?? "that tool"} on this person's plan. Pick one from available, or tell them naturally that part of Granola is not available on their plan.`,
        available: describeTools(failure.tools ?? []).map((item) => item.name),
      };
    case "bad_request":
      return {
        ok: false,
        reason: "invalid_request",
        error: `Granola rejected the call: ${failure.message}. Check the tool's inputSchema and try once more with corrected arguments.`,
        inputSchema: failure.tools?.find((item) => item.name === tool)?.inputSchema,
      };
    default:
      return UNAVAILABLE;
  }
}

type Via = {
  db: GranolaAccountDb;
  owner: string;
  nowMs: number;
  deps: GranolaToolDeps;
  signal?: AbortSignal;
};

/**
 * Runs `run` with the person's access token. A token Granola refuses is renewed once and the call
 * repeated; a second refusal means the consent is gone, so the saved sign-in is deleted.
 */
async function viaGranola<V>(
  via: Via,
  run: (accessToken: string) => Promise<GranolaMcpResult<V>>,
): Promise<GranolaMcpResult<V> | Failure> {
  for (const force of [false, true]) {
    const access = await loadGranolaAccess({
      db: via.db,
      owner: via.owner,
      nowMs: via.nowMs,
      force,
      fetchImpl: via.deps.fetchImpl,
      signal: via.signal,
    });
    if (!access.ok) {
      return access.reason === "unavailable"
        ? UNAVAILABLE
        : access.reason === "reconnect"
          ? RECONNECT
          : NOT_CONNECTED;
    }
    const result = await run(access.accessToken);
    if (result.ok || result.kind !== "unauthorized") {
      return result;
    }
  }
  await bindGranolaOwner(via.db, via.owner).clearAccount();
  clearGranolaResults(via.owner);
  return RECONNECT;
}

/** The Granola tools this person's plan offers right now, with their real argument schemas. */
export async function executeAdaGranolaTools(
  owner: string,
  api: ToolApi,
  signal?: AbortSignal,
  deps: GranolaToolDeps = {},
) {
  try {
    const via = {
      db: await dbFor(api, deps),
      owner,
      nowMs: (deps.now ?? new Date()).getTime(),
      deps,
      signal,
    };
    const listed = await viaGranola(via, (accessToken) =>
      listGranolaTools({ accessToken, fetchImpl: deps.fetchImpl, signal }),
    );
    if (listed.ok) {
      return { ok: true as const, tools: describeTools(listed.value) };
    }
    return "kind" in listed ? mapFailure(listed) : listed;
  } catch (error) {
    api.logger.error(
      `ada granola tools failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return UNAVAILABLE;
  }
}

/**
 * Calls one Granola tool with this person's own token. The tool name and arguments come from the
 * model and are checked against the live tool list; Granola's answer comes back as text of at most
 * GRANOLA_RESULT_CHARS, with `offset` for the next part of a long transcript.
 */
export async function executeAdaGranolaCall(
  owner: string,
  api: ToolApi,
  args: { tool: string; arguments?: Record<string, unknown>; offset?: number },
  signal?: AbortSignal,
  deps: GranolaToolDeps = {},
) {
  const callArgs = args.arguments ?? {};
  if (!/^[\w.-]{1,128}$/u.test(args.tool) || JSON.stringify(callArgs).length > MAX_ARGUMENT_CHARS) {
    return {
      ok: false as const,
      reason: "invalid_request",
      error: "Name a Granola tool and pass small arguments.",
    };
  }
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const key = cacheKey(owner, args.tool, callArgs);
  try {
    const via = {
      db: await dbFor(api, deps),
      owner,
      nowMs: (deps.now ?? new Date()).getTime(),
      deps,
      signal,
    };
    const result = await viaGranola(via, async (accessToken) => {
      const known = cache.get(key);
      if (known && via.nowMs - known.atMs <= CACHE_TTL_MS) {
        return { ok: true as const, value: known.text };
      }
      const called = await callGranolaTool({
        accessToken,
        tool: args.tool,
        arguments: callArgs,
        fetchImpl: deps.fetchImpl,
        signal,
      });
      if (called.ok) {
        remember(key, { owner, text: called.value.text, atMs: via.nowMs });
      }
      return called.ok ? { ok: true as const, value: called.value.text } : called;
    });
    if (!result.ok) {
      return "kind" in result ? mapFailure(result, args.tool) : result;
    }
    const shown = page(result.value, offset);
    const truncated = shown.end < result.value.length;
    return {
      ok: true as const,
      tool: args.tool,
      text: shown.text,
      offset,
      totalChars: result.value.length,
      truncated,
      ...(truncated
        ? {
            nextOffset: shown.end,
            note: "This is only part of a long result. Summarize what you have, and call again with offset set to nextOffset only if the person needs the rest.",
          }
        : {}),
    };
  } catch (error) {
    api.logger.error(
      `ada granola call failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return UNAVAILABLE;
  }
}
