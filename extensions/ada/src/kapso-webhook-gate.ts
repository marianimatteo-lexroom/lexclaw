import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isAdaPath, registerAdaHttpRoute } from "./http-paths.js";
import { maskNumber } from "./inbound-log.js";
import { firstString, readRecord } from "./kapso-api.js";
import type {
  KapsoInboundDb,
  NewSpooledWebhook,
  SpooledWebhook,
} from "./kapso-inbound-contract.js";
import { openAdaKapsoInboundFromApi } from "./kapso-inbound.js";
import { toOwner } from "./owner.js";
import { ADA_WHATSAPP_CHANNEL } from "./whatsapp-number.js";

const MESSAGE_RECEIVED_EVENT = "whatsapp.message.received";
const DEFAULT_KAPSO_WEBHOOK_PATH = "/kapso/webhook";
const MAX_BODY_BYTES = 2_000_000;
/** The channel plugin answers only when the whole turn is done, so this is the longest a turn may take. */
const FORWARD_TIMEOUT_MS = 10 * 60 * 1000;
const RESUME_DELAY_MS = 3_000;
/** Waits between hand-offs of one webhook; a gateway that is still starting needs the longer ones. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 45_000, 120_000] as const;
/** A webhook the channel plugin answers 5xx for is not retried as long as one the gateway cannot reach. */
const FAILED_ATTEMPTS = 2;
const MAX_TOTAL_ATTEMPTS = 12;
const FORWARDED_HEADERS = /^(?:x-webhook-[a-z0-9-]+|content-type|user-agent)$/u;

export type ForwardOutcome = "delivered" | "rejected" | "unavailable" | "failed";

type QueueLog = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Hands acknowledged webhooks to the channel plugin, one sender at a time and in arrival order,
 * while the webhook request that carried them has long been answered. Every webhook is saved
 * before it is queued and removed only when the hand-off ended, so a restart replays what was
 * not finished.
 */
export function createKapsoInboundQueue(deps: {
  store: () => Promise<KapsoInboundDb>;
  forward: (entry: SpooledWebhook, signal: AbortSignal) => Promise<ForwardOutcome>;
  log: QueueLog;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const sleep = deps.sleep ?? sleepFor;
  const chains = new Map<string, Promise<void>>();
  const queued = new Set<number>();
  let controller = new AbortController();

  async function finish(entry: SpooledWebhook, reason: string): Promise<void> {
    await (await deps.store()).unspool(entry.id);
    deps.log.info(
      `ada kapso webhook ${reason} sender=${maskNumber(entry.senderKey)} id=${entry.id} attempts=${entry.attempts}`,
    );
  }

  async function handle(entry: SpooledWebhook): Promise<void> {
    const { signal } = controller;
    let attempts = entry.attempts;
    while (!signal.aborted) {
      const outcome = await deps.forward(entry, signal).catch((): ForwardOutcome => "unavailable");
      if (signal.aborted) {
        return;
      }
      if (outcome === "delivered") {
        return await finish({ ...entry, attempts }, "handled");
      }
      if (outcome === "rejected") {
        return await finish({ ...entry, attempts }, "rejected by the channel plugin and dropped");
      }
      attempts = await (await deps.store()).noteAttempt(entry.id);
      const delay = RETRY_DELAYS_MS[attempts - 1 - entry.attempts];
      if (
        attempts >= MAX_TOTAL_ATTEMPTS ||
        (outcome === "failed" && attempts - entry.attempts >= FAILED_ATTEMPTS)
      ) {
        deps.log.error(
          `ada kapso webhook dropped after ${attempts} failed attempts sender=${maskNumber(entry.senderKey)} id=${entry.id}`,
        );
        return await finish({ ...entry, attempts }, "dropped");
      }
      if (delay === undefined) {
        deps.log.warn(
          `ada kapso webhook kept for the next start sender=${maskNumber(entry.senderKey)} id=${entry.id} attempts=${attempts}`,
        );
        return;
      }
      await sleep(delay, signal);
    }
  }

  function enqueue(entry: SpooledWebhook): void {
    if (queued.has(entry.id)) {
      return;
    }
    queued.add(entry.id);
    const previous = chains.get(entry.senderKey) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(() => handle(entry))
      .catch((error: unknown) => {
        deps.log.error(
          `ada kapso webhook hand-off failed sender=${maskNumber(entry.senderKey)} id=${entry.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      })
      .finally(() => {
        queued.delete(entry.id);
        if (chains.get(entry.senderKey) === next) {
          chains.delete(entry.senderKey);
        }
      });
    chains.set(entry.senderKey, next);
  }

  /** Settles once what an earlier run saved has been queued, so nothing newer jumps ahead of it. */
  let replayed: Promise<void> | undefined;

  async function replay(): Promise<number> {
    controller = controller.signal.aborted ? new AbortController() : controller;
    const store = await deps.store();
    let resumed = 0;
    for (const row of await store.listSpooled()) {
      if (row.attempts >= MAX_TOTAL_ATTEMPTS) {
        await finish(row, "dropped after too many failed attempts");
      } else if (!queued.has(row.id)) {
        enqueue({ ...row });
        resumed += 1;
      }
    }
    return resumed;
  }

  return {
    /** Saves the webhook, then queues it; resolves once it is safe to acknowledge. */
    async accept(entry: NewSpooledWebhook): Promise<number> {
      const id = await (await deps.store()).spool(entry);
      // A webhook that arrives before the saved ones were replayed queues behind them.
      await (replayed ??= replay().then(
        () => undefined,
        () => undefined,
      ));
      enqueue({ ...entry, id, attempts: 0 });
      return id;
    },
    /** Queues what an earlier run saved and did not finish, oldest first; returns how many it queued. */
    async resume(): Promise<number> {
      const run = replay();
      replayed = run.then(
        () => undefined,
        () => undefined,
      );
      return await run;
    },
    /** Gives up waiting and in-flight hand-offs; what is saved stays saved for the next start. */
    stop(): void {
      controller.abort();
    },
    /** Resolves when nothing is queued. */
    async settled(): Promise<void> {
      while (chains.size > 0) {
        await Promise.all(chains.values());
      }
    },
  };
}

export type KapsoInboundQueue = ReturnType<typeof createKapsoInboundQueue>;

/** The webhook secrets the channel plugin accepts: channel config, each account, and the env. */
export function kapsoWebhookSecrets(config: unknown, env: NodeJS.ProcessEnv): string[] {
  const channels = readRecord(readRecord(config)?.channels);
  const section = readRecord(channels?.[ADA_WHATSAPP_CHANNEL]);
  const accounts = Object.values(readRecord(section?.accounts) ?? {});
  const secrets = [section, ...accounts.map(readRecord)].map((source) =>
    firstString(source?.webhookSecret),
  );
  secrets.push(firstString(env.KAPSO_WEBHOOK_SECRET));
  return [...new Set(secrets.filter((secret): secret is string => secret !== undefined))];
}

export function verifyKapsoSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secrets: readonly string[],
): boolean {
  const signature = signatureHeader?.replace(/^sha256=/iu, "").trim();
  if (!signature || !/^[0-9a-f]+$/iu.test(signature)) {
    return false;
  }
  const actual = Buffer.from(signature, "hex");
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  });
}

/**
 * The sender whose queue a webhook joins: the first event's message sender, or conversation
 * number. A batch is treated as that sender's; the channel plugin handles a batch in order.
 */
export function kapsoSenderKey(payload: unknown): string {
  const record = readRecord(payload);
  const event = Array.isArray(record?.data) ? readRecord(record.data[0]) : record;
  const conversation = readRecord(event?.conversation);
  return (
    toOwner(firstString(readRecord(event?.message)?.from)) ??
    toOwner(firstString(conversation?.phone_number, conversation?.phoneNumber)) ??
    "unknown"
  );
}

/** The path the channel plugin's own webhook route answers on; this gate never forwards to itself. */
export function kapsoPluginWebhookPath(config: unknown, env: NodeJS.ProcessEnv): string {
  const channels = readRecord(readRecord(config)?.channels);
  const section = readRecord(channels?.[ADA_WHATSAPP_CHANNEL]);
  const configured = firstString(section?.webhookPath, env.KAPSO_WEBHOOK_PATH);
  if (!configured) {
    return DEFAULT_KAPSO_WEBHOOK_PATH;
  }
  return configured.startsWith("/") ? configured : `/${configured}`;
}

function statusOutcome(status: number): ForwardOutcome {
  if (status >= 200 && status < 300) {
    return "delivered";
  }
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
    return "unavailable";
  }
  return status >= 500 ? "failed" : "rejected";
}

/** Replays a saved webhook to the channel plugin's route in this same gateway. */
export function createLoopbackForward(deps: {
  origin: () => string | undefined;
  path: () => string;
  fetchImpl?: typeof fetch;
}): (entry: SpooledWebhook, signal: AbortSignal) => Promise<ForwardOutcome> {
  return async (entry, signal) => {
    const origin = deps.origin();
    const path = deps.path();
    if (!origin || isAdaPath(path, "/kapso/webhook")) {
      return origin ? "rejected" : "unavailable";
    }
    const timeout = AbortSignal.timeout(FORWARD_TIMEOUT_MS);
    try {
      const response = await (deps.fetchImpl ?? fetch)(`${origin}${path}`, {
        method: "POST",
        headers: entry.headers,
        body: Buffer.from(entry.bodyBase64, "base64"),
        signal: AbortSignal.any([signal, timeout]),
      });
      await response.arrayBuffer().catch(() => undefined);
      return statusOutcome(response.status);
    } catch {
      return timeout.aborted ? "failed" : "unavailable";
    }
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error("body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The webhook as Kapso should see it: check the signature, save the request, say 200, and let
 * the queue hand it to the channel plugin. Kapso times out after a few seconds, while a turn
 * can take much longer, and a timed-out webhook is sent again.
 */
export async function handleKapsoWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    queue: Pick<KapsoInboundQueue, "accept">;
    secrets: () => string[];
    log: QueueLog;
    now?: () => number;
  },
): Promise<boolean> {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }
  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch {
    writeJson(res, 413, { ok: false, error: "body_too_large" });
    return true;
  }
  const secrets = deps.secrets();
  if (secrets.length === 0) {
    deps.log.warn("ada kapso webhook refused: no webhook secret is configured");
    writeJson(res, 503, { ok: false, error: "webhook_secret_missing" });
    return true;
  }
  if (!verifyKapsoSignature(rawBody, headerOf(req, "x-webhook-signature"), secrets)) {
    writeJson(res, 401, { ok: false, error: "invalid_signature" });
    return true;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    writeJson(res, 400, { ok: false, error: "invalid_json" });
    return true;
  }
  const eventName = headerOf(req, "x-webhook-event");
  if (eventName && eventName !== MESSAGE_RECEIVED_EVENT) {
    writeJson(res, 200, { ok: true, queued: false });
    return true;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const text = Array.isArray(value) ? value[0] : value;
    if (text !== undefined && FORWARDED_HEADERS.test(name)) {
      headers[name] = text;
    }
  }
  const senderKey = kapsoSenderKey(payload);
  try {
    const id = await deps.queue.accept({
      senderKey,
      headers,
      bodyBase64: rawBody.toString("base64"),
      receivedAtMs: (deps.now ?? Date.now)(),
    });
    deps.log.info(`ada kapso webhook accepted sender=${maskNumber(senderKey)} id=${id}`);
    writeJson(res, 200, { ok: true, queued: true });
  } catch (error) {
    // Not saved, so Kapso must send it again: a 5xx is how it hears that.
    deps.log.error(
      `ada kapso webhook could not be saved: ${error instanceof Error ? error.message : "unknown"}`,
    );
    writeJson(res, 503, { ok: false, error: "not_saved" });
  }
  return true;
}

/**
 * Puts Ada's own webhook in front of the channel plugin's: Kapso is pointed at
 * `/ada/kapso/webhook`, which answers at once, and the plugin's route at
 * `KAPSO_WEBHOOK_PATH` (default `/kapso/webhook`) does the work out of Kapso's sight. The old
 * address keeps working as before until Kapso is pointed at the new one.
 */
export function registerAdaKapsoWebhook(
  api: OpenClawPluginApi,
  options: { fetchImpl?: typeof fetch; resumeDelayMs?: number } = {},
): KapsoInboundQueue {
  let localPort: number | undefined;
  const queue = createKapsoInboundQueue({
    store: () => openAdaKapsoInboundFromApi(api),
    log: api.logger,
    forward: createLoopbackForward({
      origin: () => {
        const port =
          localPort ?? Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? Number.NaN);
        return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : undefined;
      },
      path: () => kapsoPluginWebhookPath(api.config, process.env),
      fetchImpl: options.fetchImpl,
    }),
  });
  registerAdaHttpRoute(api, {
    path: "/kapso/webhook",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      localPort = req.socket.localPort ?? localPort;
      return handleKapsoWebhook(req, res, {
        queue,
        secrets: () => kapsoWebhookSecrets(api.config, process.env),
        log: api.logger,
      });
    },
  });
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  api.registerService({
    id: "ada-kapso-inbound",
    start() {
      resumeTimer = setTimeout(() => {
        queue
          .resume()
          .then((count) => {
            if (count > 0) {
              api.logger.info(`ada kapso webhook resumed saved=${count}`);
            }
          })
          .catch((error: unknown) => {
            api.logger.error(
              `ada kapso webhook resume failed: ${error instanceof Error ? error.message : "unknown"}`,
            );
          });
      }, options.resumeDelayMs ?? RESUME_DELAY_MS);
      resumeTimer.unref?.();
    },
    stop() {
      clearTimeout(resumeTimer);
      queue.stop();
    },
  });
  return queue;
}
