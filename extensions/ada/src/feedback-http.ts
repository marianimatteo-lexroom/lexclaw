import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { bearerMatches, readBearerSecret } from "./bearer-auth.js";
import { feedbackView } from "./feedback.js";
import { registerAdaHttpRoute } from "./http-paths.js";
import { FEEDBACK_STATUSES, type FeedbackStatus } from "./memory-contract.js";
import { openAdaRegistryFromApi, type MemoryStore } from "./memory.js";

const MAX_BODY_BYTES = 2048;
const FEEDBACK_PATH = /^(?:\/(?:ada|vera))?\/admin\/feedback(?:\/([^/]+))?\/?$/u;

/** `ADA_ADMIN_TOKEN` when it is long enough to be a secret; without it the endpoint does not exist. */
export function readAdminToken(env: NodeJS.ProcessEnv): string | null {
  return readBearerSecret({ token: env.ADA_ADMIN_TOKEN }, "token");
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function writeText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

/**
 * The gate every admin endpoint shares: 404 while `ADA_ADMIN_TOKEN` is unset (the endpoint does
 * not exist), 401 without the matching bearer token. True when it answered and the caller stops.
 */
export function denyAdminAccess(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
): boolean {
  const expected = readAdminToken(env);
  if (!expected) {
    writeText(res, 404, "not found");
    return true;
  }
  if (!bearerMatches(req, expected)) {
    res.setHeader("www-authenticate", "Bearer");
    writeText(res, 401, "unauthorized");
    return true;
  }
  return false;
}

async function readStatusBody(req: IncomingMessage): Promise<FeedbackStatus | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const status = (body as { status?: unknown } | null)?.status;
    return FEEDBACK_STATUSES.find((known) => known === status) ?? null;
  } catch {
    return null;
  }
}

/**
 * The team's read of the product-feedback log: `GET /admin/feedback?since=<ms>` lists reports and
 * `POST /admin/feedback/<id>` with `{"status":"new"|"triaged"}` marks one. The log lives in the
 * registry file, so this is the only way to read it without access to the volume. Disabled (404)
 * unless `ADA_ADMIN_TOKEN` is set; every request then needs that bearer token.
 */
export async function handleAdaFeedbackAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    env: NodeJS.ProcessEnv;
    openRegistry: () => Promise<MemoryStore>;
    log: { error: (message: string) => void };
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = FEEDBACK_PATH.exec(url.pathname);
  if (!route) {
    writeText(res, 404, "not found");
    return true;
  }
  if (denyAdminAccess(req, res, deps.env)) {
    return true;
  }
  const rawId = route[1];
  try {
    if (rawId === undefined && req.method === "GET") {
      const since = url.searchParams.get("since");
      const sinceMs = since === null ? 0 : /^\d{1,16}$/u.test(since) ? Number(since) : null;
      if (sinceMs === null) {
        writeJson(res, 400, { ok: false, error: "since must be a time in milliseconds" });
        return true;
      }
      const entries = await (await deps.openRegistry()).listFeedback(sinceMs);
      writeJson(res, 200, { ok: true, entries: entries.map(feedbackView) });
      return true;
    }
    if (rawId !== undefined && req.method === "POST") {
      const id = /^\d{1,12}$/u.test(rawId) ? Number(rawId) : null;
      const status = await readStatusBody(req);
      if (id === null || status === null) {
        writeJson(res, 400, {
          ok: false,
          error: `send {"status": "${FEEDBACK_STATUSES.join('" or "')}"} to a numeric id`,
        });
        return true;
      }
      const entry = await (await deps.openRegistry()).setFeedbackStatus(id, status);
      if (!entry) {
        writeJson(res, 404, { ok: false, error: "no such feedback" });
        return true;
      }
      writeJson(res, 200, { ok: true, entry: feedbackView(entry) });
      return true;
    }
    res.setHeader("allow", rawId === undefined ? "GET" : "POST");
    writeText(res, 405, "method not allowed");
  } catch (error) {
    deps.log.error(
      `ada feedback admin failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    writeText(res, 500, "feedback unavailable");
  }
  return true;
}

/** Serves the admin feedback endpoint on `/admin/feedback` and under the `/ada` and `/vera` prefixes. */
export function registerAdaFeedbackAdmin(api: OpenClawPluginApi): void {
  const route = {
    path: "/admin/feedback",
    auth: "plugin",
    match: "prefix",
    handler: (req: IncomingMessage, res: ServerResponse) =>
      handleAdaFeedbackAdmin(req, res, {
        env: process.env,
        openRegistry: () => openAdaRegistryFromApi(api),
        log: api.logger,
      }),
  } as const;
  api.registerHttpRoute(route);
  registerAdaHttpRoute(api, route);
}
