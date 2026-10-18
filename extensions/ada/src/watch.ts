import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openAdaGoogleAccountDbFromApi } from "./google-account.js";
import {
  constantTimeEqual,
  createGoogleCertSource,
  GoogleCertsUnavailableError,
  looksLikeJwt,
  verifyGooglePushJwt,
  type GoogleCertSource,
  type GooglePushJwtConfig,
} from "./google-push-auth.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { runAdaCollectPass } from "./service.js";

/** One collect pass per interval; Pub/Sub redelivers the 429s and the 15-minute poll backstops. */
export const NOTIFY_MIN_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 65_536;
const MAX_TRACKED_MAILBOXES = 16;
const MAX_RATE_TRACKED_MAILBOXES = 1000;

type NotifyConfig = {
  staticToken: string | null;
  jwt: GooglePushJwtConfig | null;
};

export type NotifyState = {
  /** When each mailbox last triggered a pass, so one mailbox's push never rate-limits another's. */
  lastRunAtMs: Map<string, number>;
  /** Highest Gmail historyId already collected, per mailbox. */
  historyIds: Map<string, bigint>;
};

export type NotifyDeps = {
  certs: GoogleCertSource;
  now: () => number;
  state: NotifyState;
};

export function createNotifyState(): NotifyState {
  return { lastRunAtMs: new Map(), historyIds: new Map() };
}

const defaultDeps: NotifyDeps = {
  certs: createGoogleCertSource(),
  now: Date.now,
  state: createNotifyState(),
};

function readString(config: unknown, key: string, minLength = 1): string | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const value = (config as Record<string, unknown>)[key];
  const text = typeof value === "string" ? value.trim() : "";
  return text.length >= minLength ? text : undefined;
}

export function readNotifyConfig(config: unknown): NotifyConfig {
  const audience = readString(config, "googleNotifyAudience");
  return {
    staticToken: readString(config, "googleNotifyToken", 16) ?? null,
    jwt: audience
      ? {
          audience,
          issuer: readString(config, "googleNotifyIssuer"),
          serviceAccountEmail: readString(config, "googleNotifyServiceAccount"),
        }
      : null,
  };
}

function readBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  return /^Bearer\s+(.+)$/iu.exec(header.trim())?.[1] ?? null;
}

type AuthOutcome = "ok" | "denied" | "certs_unavailable";

async function authenticate(
  req: IncomingMessage,
  config: NotifyConfig,
  deps: NotifyDeps,
): Promise<AuthOutcome> {
  const bearer = readBearer(req);
  if (!bearer) {
    return "denied";
  }
  if (config.jwt && looksLikeJwt(bearer)) {
    try {
      const result = await verifyGooglePushJwt(bearer, config.jwt, deps);
      if (result.ok) {
        return "ok";
      }
    } catch (error) {
      if (error instanceof GoogleCertsUnavailableError) {
        return "certs_unavailable";
      }
      throw error;
    }
  }
  return config.staticToken && constantTimeEqual(bearer, config.staticToken) ? "ok" : "denied";
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The number whose connected Google account is this mailbox, or null when none is. */
async function ownerOfMailbox(api: OpenClawPluginApi, mailbox: string): Promise<string | null> {
  if (!mailbox) {
    return null;
  }
  const db = await openAdaGoogleAccountDbFromApi(api);
  for (const owner of await db.listOwners()) {
    if ((await db.readAccount(owner))?.email.toLowerCase() === mailbox) {
      return owner;
    }
  }
  return null;
}

/** Pub/Sub wraps Gmail's `{ emailAddress, historyId }` in `message.data` (base64). */
function parseHistory(body: string): { mailbox: string; historyId: bigint } | null {
  try {
    const envelope = JSON.parse(body) as { message?: { data?: unknown } };
    const data = envelope.message?.data;
    if (typeof data !== "string") {
      return null;
    }
    const notification = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as {
      emailAddress?: unknown;
      historyId?: unknown;
    };
    const raw = notification.historyId;
    if (typeof raw !== "string" && typeof raw !== "number") {
      return null;
    }
    const text = String(raw);
    if (!/^\d{1,20}$/u.test(text)) {
      return null;
    }
    const mailbox =
      typeof notification.emailAddress === "string" ? notification.emailAddress.toLowerCase() : "";
    return { mailbox, historyId: BigInt(text) };
  } catch {
    return null;
  }
}

function reply(res: ServerResponse, status: number, body = ""): true {
  res.statusCode = status;
  res.end(body);
  return true;
}

/**
 * Google Pub/Sub push target. Authenticates the push subscription's OIDC token
 * (`googleNotifyAudience`, optional `googleNotifyIssuer` and
 * `googleNotifyServiceAccount`) and still accepts the static `googleNotifyToken`
 * Bearer. With neither configured the route refuses, so an open plugin route
 * cannot trigger model turns. A push without a new Gmail historyId is acknowledged
 * without collecting.
 */
export async function handleAdaGoogleNotify(
  req: IncomingMessage,
  res: ServerResponse,
  api: OpenClawPluginApi,
  deps: NotifyDeps = defaultDeps,
): Promise<boolean> {
  if (req.method !== "POST") {
    return reply(res, 405, "method not allowed");
  }
  let outcome: AuthOutcome;
  try {
    outcome = await authenticate(req, readNotifyConfig(api.pluginConfig), deps);
  } catch (error) {
    api.logger.error(
      `ada google notify auth failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return reply(res, 500, "notify failed");
  }
  if (outcome === "certs_unavailable") {
    api.logger.warn("ada google notify could not fetch Google signing keys");
    return reply(res, 503, "unavailable");
  }
  if (outcome !== "ok") {
    return reply(res, 401, "unauthorized");
  }

  const body = await readBody(req);
  if (body === null) {
    return reply(res, 413, "payload too large");
  }
  const history = parseHistory(body);
  const seen = history ? deps.state.historyIds.get(history.mailbox) : undefined;
  if (!history || (seen !== undefined && history.historyId <= seen)) {
    return reply(res, 204);
  }

  const nowMs = deps.now();
  const waitMs =
    (deps.state.lastRunAtMs.get(history.mailbox) ?? Number.NEGATIVE_INFINITY) +
    NOTIFY_MIN_INTERVAL_MS -
    nowMs;
  if (waitMs > 0) {
    res.setHeader("retry-after", String(Math.ceil(waitMs / 1000)));
    return reply(res, 429, "rate limited");
  }
  deps.state.lastRunAtMs.delete(history.mailbox);
  deps.state.lastRunAtMs.set(history.mailbox, nowMs);
  if (deps.state.lastRunAtMs.size > MAX_RATE_TRACKED_MAILBOXES) {
    deps.state.lastRunAtMs.delete(deps.state.lastRunAtMs.keys().next().value ?? history.mailbox);
  }

  try {
    const owner = await ownerOfMailbox(api, history.mailbox);
    if (!owner) {
      api.logger.info("ada google notify skipped: the mailbox is not connected to any number");
      return reply(res, 204);
    }
    const memory = await openAdaMemoryFromApi(api, owner);
    await runAdaCollectPass({
      api,
      owner,
      memory,
      now: new Date(nowMs),
      forceMorning: false,
      trigger: "notify",
    });
    if (deps.state.historyIds.size >= MAX_TRACKED_MAILBOXES) {
      deps.state.historyIds.clear();
    }
    deps.state.historyIds.set(history.mailbox, history.historyId);
    return reply(res, 204);
  } catch (error) {
    api.logger.error(
      `ada google notify failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return reply(res, 500, "notify failed");
  }
}
