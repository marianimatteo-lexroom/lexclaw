import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KapsoInboundDb,
  NewSpooledWebhook,
  SpooledWebhook,
} from "./kapso-inbound-contract.js";
import { createSqliteWorkerBackend } from "./kapso-inbound.worker.js";
import {
  createKapsoInboundQueue,
  createLoopbackForward,
  handleKapsoWebhook,
  kapsoPluginWebhookPath,
  kapsoSenderKey,
  kapsoWebhookSecrets,
  registerAdaKapsoWebhook,
  verifyKapsoSignature,
  type ForwardOutcome,
} from "./kapso-webhook-gate.js";

const openAdaKapsoInboundFromApi = vi.hoisted(() => vi.fn());
vi.mock("./kapso-inbound.js", () => ({ openAdaKapsoInboundFromApi }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SECRET = "kapso-webhook-secret";
const ANNA = "393331111111";
const BRUNO = "393332222222";

function memoryStore() {
  const rows = new Map<number, SpooledWebhook>();
  let next = 0;
  const db: KapsoInboundDb = {
    spool: async (entry: NewSpooledWebhook) => {
      next += 1;
      rows.set(next, { ...entry, id: next, attempts: 0, answeredAtMs: null });
      return next;
    },
    listSpooled: async () => [...rows.values()].toSorted((a, b) => a.id - b.id),
    noteAttempt: async (id) => {
      const row = rows.get(id);
      if (!row) {
        return 0;
      }
      row.attempts += 1;
      return row.attempts;
    },
    markAnswered: async (id, atMs) => {
      const row = rows.get(id);
      if (row) {
        row.answeredAtMs = atMs;
      }
    },
    unspool: async (id) => {
      rows.delete(id);
    },
  };
  return { db, rows };
}

const entry = (senderKey: string, text = "ciao"): NewSpooledWebhook => ({
  senderKey,
  headers: { "x-webhook-signature": "sig", "content-type": "application/json" },
  bodyBase64: Buffer.from(JSON.stringify({ message: { from: senderKey, text } })).toString(
    "base64",
  ),
  receivedAtMs: 1,
});

const quietLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const noSleep = async () => {};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const bodyOf = (sender: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "whatsapp.message.received",
    message: { id: `wamid.${text}`, from: sender, type: "text", text: { body: text } },
    conversation: { phone_number: `+${sender}` },
    ...extra,
  });
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("the saved webhooks", () => {
  it("keeps arrival order, counts failed hand-offs, and forgets a handled webhook", () => {
    const backend = createSqliteWorkerBackend(undefined, {
      databasePath: path.join(tempDirs.make("ada-kapso-inbound-"), "kapso-inbound.sqlite"),
    });
    try {
      const first = backend.execute({ type: "spool", input: { entry: entry(ANNA, "uno") } });
      const second = backend.execute({ type: "spool", input: { entry: entry(BRUNO, "due") } });
      expect(second).toBeGreaterThan(first as number);
      expect(backend.execute({ type: "noteAttempt", input: { id: first as number } })).toBe(1);
      expect(backend.execute({ type: "noteAttempt", input: { id: first as number } })).toBe(2);

      const listed = backend.execute({ type: "listSpooled", input: undefined }) as SpooledWebhook[];
      expect(listed.map((row) => [row.senderKey, row.attempts])).toEqual([
        [ANNA, 2],
        [BRUNO, 0],
      ]);
      expect(listed[0]?.headers).toEqual({
        "x-webhook-signature": "sig",
        "content-type": "application/json",
      });
      expect(Buffer.from(listed[0]?.bodyBase64 ?? "", "base64").toString()).toContain("uno");

      backend.execute({ type: "markAnswered", input: { id: first as number, atMs: 77 } });
      expect(
        (backend.execute({ type: "listSpooled", input: undefined }) as SpooledWebhook[]).map(
          (row) => row.answeredAtMs,
        ),
      ).toEqual([77, null]);
      backend.execute({ type: "unspool", input: { id: first as number } });
      const rest = backend.execute({ type: "listSpooled", input: undefined }) as SpooledWebhook[];
      expect(rest.map((row) => row.senderKey)).toEqual([BRUNO]);
    } finally {
      void backend.close();
    }
  });

  it("refuses a sender that is not a number", () => {
    const backend = createSqliteWorkerBackend(undefined, {
      databasePath: path.join(tempDirs.make("ada-kapso-inbound-"), "kapso-inbound.sqlite"),
    });
    try {
      expect(() =>
        backend.execute({ type: "spool", input: { entry: entry("not a number") } }),
      ).toThrow(/sender is invalid/u);
    } finally {
      void backend.close();
    }
  });
});

describe("the hand-off queue", () => {
  function queueWith(
    forward: (entry: SpooledWebhook) => Promise<ForwardOutcome>,
    store = memoryStore(),
  ) {
    const queue = createKapsoInboundQueue({
      store: async () => store.db,
      forward: (row) => forward(row),
      log: quietLog,
      sleep: noSleep,
    });
    return { queue, ...store };
  }

  it("saves a webhook before it queues it, and forgets it once the plugin has answered", async () => {
    const seen: number[] = [];
    const { queue, rows } = queueWith(async () => {
      seen.push(rows.size);
      return "delivered";
    });
    await queue.accept(entry(ANNA));
    await queue.settled();
    expect(seen).toEqual([1]);
    expect(rows.size).toBe(0);
  });

  it("hands one sender's messages over in order, one at a time, and other senders in parallel", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const started: string[] = [];
    const { queue } = queueWith(async (row) => {
      const text = Buffer.from(row.bodyBase64, "base64").toString();
      const label = `${row.senderKey.slice(-4)}:${JSON.parse(text).message.text}`;
      started.push(label);
      const gate = deferred();
      gates.set(label, gate);
      await gate.promise;
      return "delivered";
    });
    await queue.accept(entry(ANNA, "a1"));
    await queue.accept(entry(ANNA, "a2"));
    await queue.accept(entry(BRUNO, "b1"));
    await vi.waitFor(() => expect(started).toEqual(["1111:a1", "2222:b1"]));

    gates.get("1111:a1")?.resolve();
    await vi.waitFor(() => expect(started).toEqual(["1111:a1", "2222:b1", "1111:a2"]));
    gates.get("1111:a2")?.resolve();
    gates.get("2222:b1")?.resolve();
    await queue.settled();
  });

  it("tries again when the gateway or the plugin is not ready, and keeps the webhook until it works", async () => {
    const outcomes: ForwardOutcome[] = ["unavailable", "unavailable", "delivered"];
    const calls: number[] = [];
    const { queue, rows } = queueWith(async (row) => {
      calls.push(rows.get(row.id)?.attempts ?? -1);
      return outcomes.shift() ?? "delivered";
    });
    await queue.accept(entry(ANNA));
    await queue.settled();
    expect(calls).toEqual([0, 1, 2]);
    expect(rows.size).toBe(0);
  });

  it("drops a webhook the plugin refuses, and one that keeps failing after a second try", async () => {
    const refused = queueWith(async () => "rejected");
    await refused.queue.accept(entry(ANNA));
    await refused.queue.settled();
    expect(refused.rows.size).toBe(0);

    const calls = vi.fn(async (): Promise<ForwardOutcome> => "failed");
    const failing = queueWith(calls);
    await failing.queue.accept(entry(ANNA));
    await failing.queue.settled();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(failing.rows.size).toBe(0);
  });

  it("keeps a webhook for the next start when the gateway never came up", async () => {
    const calls = vi.fn(async (): Promise<ForwardOutcome> => "unavailable");
    const { queue, rows } = queueWith(calls);
    await queue.accept(entry(ANNA));
    await queue.settled();
    expect(calls).toHaveBeenCalledTimes(6);
    expect([...rows.values()].map((row) => row.attempts)).toEqual([6]);
  });

  it("replays what a crash left behind, oldest first, and drops what failed too often", async () => {
    const store = memoryStore();
    const first = await store.db.spool(entry(ANNA, "a1"));
    await store.db.spool(entry(ANNA, "a2"));
    await store.db.spool(entry(BRUNO, "b1"));
    const stale = await store.db.spool(entry(BRUNO, "old"));
    for (let n = 0; n < 12; n += 1) {
      await store.db.noteAttempt(stale);
    }
    const order: string[] = [];
    const { queue } = queueWith(async (row) => {
      order.push(JSON.parse(Buffer.from(row.bodyBase64, "base64").toString()).message.text);
      return "delivered";
    }, store);

    expect(await queue.resume()).toBe(3);
    await queue.settled();
    expect(order.filter((text) => text.startsWith("a"))).toEqual(["a1", "a2"]);
    expect(order).toContain("b1");
    expect(order).not.toContain("old");
    expect(store.rows.size).toBe(0);
    expect(first).toBe(1);
  });

  it("hands a webhook that arrives right after a restart over behind the ones saved before it", async () => {
    const store = memoryStore();
    await store.db.spool(entry(ANNA, "before"));
    const order: string[] = [];
    const { queue } = queueWith(async (row) => {
      order.push(JSON.parse(Buffer.from(row.bodyBase64, "base64").toString()).message.text);
      return "delivered";
    }, store);

    await queue.accept(entry(ANNA, "after"));
    expect(await queue.resume()).toBe(0);
    await queue.settled();
    expect(order).toEqual(["before", "after"]);
    expect(store.rows.size).toBe(0);
  });

  it("does not hand a webhook over twice when resume sees one that is already queued", async () => {
    const forward = vi.fn(async (): Promise<ForwardOutcome> => "delivered");
    const { queue } = queueWith(forward);
    await queue.accept(entry(ANNA));
    await queue.resume();
    await queue.settled();
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("lets a hand-off that is running finish on shutdown, so the turn is not cut off and replayed", async () => {
    const gate = deferred();
    const store = memoryStore();
    const started = vi.fn();
    const queue = createKapsoInboundQueue({
      store: async () => store.db,
      forward: async () => {
        started();
        await gate.promise;
        return "delivered";
      },
      log: quietLog,
      sleep: noSleep,
    });
    await queue.accept(entry(ANNA));
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    queue.stop();
    gate.resolve();
    await queue.settled();
    expect(store.rows.size).toBe(0);
  });

  it("ends the wait between retries on shutdown and leaves the saved webhook for the next start", async () => {
    const store = memoryStore();
    const queue = createKapsoInboundQueue({
      store: async () => store.db,
      forward: async () => "unavailable",
      log: quietLog,
      sleep: async (_ms, signal) => {
        queue.stop();
        expect(signal.aborted).toBe(true);
      },
    });
    await queue.accept(entry(ANNA));
    await queue.settled();
    expect([...store.rows.values()].map((row) => row.attempts)).toEqual([1]);
  });

  it("does not replay a webhook whose reply already went out, even when the hand-off was cut", async () => {
    const store = memoryStore();
    const gate = deferred();
    const first = createKapsoInboundQueue({
      store: async () => store.db,
      forward: async () => {
        await gate.promise;
        return "unavailable";
      },
      log: quietLog,
      sleep: noSleep,
    });
    await first.accept(entry(ANNA, "a1"));
    await first.accept(entry(ANNA, "a2"));
    await vi.waitFor(async () => expect(await store.db.listSpooled()).toHaveLength(2));
    await first.noteAnswered(ANNA, 1234);
    await first.noteAnswered(BRUNO, 1234);
    expect([...store.rows.values()].map((row) => row.answeredAtMs)).toEqual([1234, null]);

    // A restart: what was answered is dropped, what was not is handed over.
    const handed: string[] = [];
    const second = createKapsoInboundQueue({
      store: async () => store.db,
      forward: async (row) => {
        handed.push(JSON.parse(Buffer.from(row.bodyBase64, "base64").toString()).message.text);
        return "delivered";
      },
      log: quietLog,
      sleep: noSleep,
    });
    expect(await second.resume()).toBe(1);
    await second.settled();
    expect(handed).toEqual(["a2"]);
    expect(store.rows.size).toBe(0);
    gate.resolve();
    first.stop();
  });

  it("does not hand an answered webhook over again when the plugin's answer never came back", async () => {
    const store = memoryStore();
    const forward = vi.fn(async (): Promise<ForwardOutcome> => {
      await queue.noteAnswered(ANNA);
      return "unavailable";
    });
    const queue = createKapsoInboundQueue({
      store: async () => store.db,
      forward,
      log: quietLog,
      sleep: noSleep,
    });
    await queue.accept(entry(ANNA));
    await queue.settled();
    expect(forward).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(0);
  });
});

describe("the webhook request", () => {
  const configWithSecret = {
    channels: { "kapso-whatsapp": { webhookSecret: SECRET } },
  };

  async function serve(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    return {
      port,
      origin: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function setup(options: { secrets?: string[]; failSpool?: boolean } = {}) {
    const store = memoryStore();
    if (options.failSpool) {
      store.db.spool = async () => {
        throw new Error("disk full");
      };
    }
    const pluginRequests: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];
    const pluginGate = deferred();
    const plugin = await serve((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        pluginRequests.push({ body: Buffer.concat(chunks).toString(), headers: req.headers });
        // The channel plugin answers only after the whole turn.
        await pluginGate.promise;
        res.statusCode = 200;
        res.end('{"ok":true,"dispatched":1}');
      })();
    });
    servers.push(plugin);
    const queue = createKapsoInboundQueue({
      store: async () => store.db,
      forward: createLoopbackForward({
        origin: () => plugin.origin,
        path: () => "/kapso/webhook",
      }),
      log: quietLog,
      sleep: noSleep,
    });
    const front = await serve((req, res) => {
      void handleKapsoWebhook(req, res, {
        queue,
        secrets: () => options.secrets ?? [SECRET],
        log: quietLog,
      });
    });
    servers.push(front);
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${front.origin}/ada/kapso/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": sign(body),
          "x-webhook-event": "whatsapp.message.received",
          ...headers,
        },
        body,
      });
    return { store, queue, plugin, pluginRequests, pluginGate, front, post };
  }

  it("answers 200 at once while the turn is still running, then hands the same request over", async () => {
    const { post, pluginRequests, pluginGate, queue, store } = await setup();
    const body = bodyOf(ANNA, "Quali sono i termini per impugnare?");

    const response = await post(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: true });

    // The plugin received the request and has not answered; Kapso already has its 200.
    await vi.waitFor(() => expect(pluginRequests).toHaveLength(1));
    expect(store.rows.size).toBe(1);
    expect(pluginRequests[0]?.body).toBe(body);
    expect(pluginRequests[0]?.headers["x-webhook-signature"]).toBe(sign(body));
    expect(pluginRequests[0]?.headers["x-webhook-event"]).toBe("whatsapp.message.received");

    pluginGate.resolve();
    await queue.settled();
    expect(store.rows.size).toBe(0);
  });

  it("keeps one sender's messages in order even when each answer is slow", async () => {
    const { post, pluginRequests, pluginGate, queue } = await setup();
    await post(bodyOf(ANNA, "primo messaggio"));
    await post(bodyOf(ANNA, "secondo messaggio"));
    await vi.waitFor(() => expect(pluginRequests).toHaveLength(1));
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(pluginRequests).toHaveLength(1);

    pluginGate.resolve();
    await queue.settled();
    expect(pluginRequests.map((request) => JSON.parse(request.body).message.text.body)).toEqual([
      "primo messaggio",
      "secondo messaggio",
    ]);
  });

  it("refuses a bad signature, a missing secret and a body that is not JSON, and saves nothing", async () => {
    const bad = await setup();
    const body = bodyOf(ANNA, "ciao a tutti");
    expect((await bad.post(body, { "x-webhook-signature": sign(body, "other") })).status).toBe(401);
    expect((await bad.post(body, { "x-webhook-signature": "" })).status).toBe(401);
    const notJson = "not json";
    expect((await bad.post(notJson)).status).toBe(400);
    expect(bad.store.rows.size).toBe(0);

    const noSecret = await setup({ secrets: [] });
    expect((await noSecret.post(body)).status).toBe(503);
    expect(noSecret.store.rows.size).toBe(0);
  });

  it("acknowledges events that are not messages without queueing them", async () => {
    const { post, store, pluginRequests } = await setup();
    const body = bodyOf(ANNA, "x");
    const response = await post(body, { "x-webhook-event": "whatsapp.message.sent" });
    expect(await response.json()).toEqual({ ok: true, queued: false });
    expect(store.rows.size).toBe(0);
    expect(pluginRequests).toHaveLength(0);
  });

  it("answers 503, so Kapso sends it again, when the webhook could not be saved", async () => {
    const { post, pluginRequests } = await setup({ failSpool: true });
    const response = await post(bodyOf(ANNA, "ciao a tutti"));
    expect(response.status).toBe(503);
    expect(pluginRequests).toHaveLength(0);
  });

  it("answers only POST", async () => {
    const { front } = await setup();
    const response = await fetch(`${front.origin}/ada/kapso/webhook`);
    expect(response.status).toBe(405);
  });

  it("turns the plugin's own answers into hand-off outcomes", async () => {
    const statuses = [200, 503, 500, 401];
    const plugin = await serve((_req, res) => {
      res.statusCode = statuses.shift() ?? 200;
      res.end();
    });
    servers.push(plugin);
    const forward = createLoopbackForward({
      origin: () => plugin.origin,
      path: () => "/kapso/webhook",
    });
    const row: SpooledWebhook = { ...entry(ANNA), id: 1, attempts: 0, answeredAtMs: null };
    const signal = new AbortController().signal;
    expect(await forward(row, signal)).toBe("delivered");
    expect(await forward(row, signal)).toBe("unavailable");
    expect(await forward(row, signal)).toBe("failed");
    expect(await forward(row, signal)).toBe("rejected");
  });

  it("never hands a webhook to its own route, and waits while the gateway port is unknown", async () => {
    const row: SpooledWebhook = { ...entry(ANNA), id: 1, attempts: 0, answeredAtMs: null };
    const signal = new AbortController().signal;
    const fetchImpl = vi.fn();
    const self = createLoopbackForward({
      origin: () => "http://127.0.0.1:1",
      path: () => "/ada/kapso/webhook",
      fetchImpl,
    });
    expect(await self(row, signal)).toBe("rejected");
    const unknown = createLoopbackForward({
      origin: () => undefined,
      path: () => "/kapso/webhook",
      fetchImpl,
    });
    expect(await unknown(row, signal)).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads secrets, plugin path and sender the way the channel plugin does", () => {
    expect(
      kapsoWebhookSecrets(
        {
          channels: {
            "kapso-whatsapp": {
              webhookSecret: "one",
              accounts: { second: { webhookSecret: "two" }, third: {} },
            },
          },
        },
        { KAPSO_WEBHOOK_SECRET: "three" },
      ),
    ).toEqual(["one", "two", "three"]);
    expect(kapsoWebhookSecrets({}, {})).toEqual([]);
    expect(kapsoPluginWebhookPath({}, {})).toBe("/kapso/webhook");
    expect(kapsoPluginWebhookPath({}, { KAPSO_WEBHOOK_PATH: "hooks/kapso" })).toBe("/hooks/kapso");
    expect(
      kapsoPluginWebhookPath(
        { channels: { "kapso-whatsapp": { webhookPath: "/custom" } } },
        { KAPSO_WEBHOOK_PATH: "/env" },
      ),
    ).toBe("/custom");

    expect(kapsoSenderKey(JSON.parse(bodyOf(ANNA, "x")))).toBe(ANNA);
    expect(kapsoSenderKey({ data: [{ message: { from: `+${BRUNO}` } }] })).toBe(BRUNO);
    expect(kapsoSenderKey({ conversation: { phone_number: "+39 333 111 1111" } })).toBe(ANNA);
    expect(kapsoSenderKey({ nothing: true })).toBe("unknown");
    expect(kapsoSenderKey("text")).toBe("unknown");

    const body = Buffer.from("payload");
    const good = createHmac("sha256", "s").update(body).digest("hex");
    expect(verifyKapsoSignature(body, good, ["x", "s"])).toBe(true);
    expect(verifyKapsoSignature(body, `sha256=${good}`, ["s"])).toBe(true);
    expect(verifyKapsoSignature(body, good, ["x"])).toBe(false);
    expect(verifyKapsoSignature(body, undefined, ["s"])).toBe(false);
    expect(verifyKapsoSignature(body, "zz", ["s"])).toBe(false);
  });

  it("records on the saved webhook that Ada's reply to that number went out", async () => {
    const store = memoryStore();
    openAdaKapsoInboundFromApi.mockResolvedValue(store.db);
    const gate = deferred();
    const plugin = await serve((_req, res) => {
      void gate.promise.then(() => res.end("{}"));
    });
    servers.push(plugin);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", String(plugin.port));
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    const api = createTestPluginApi({
      id: "ada",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: configWithSecret as OpenClawPluginApi["config"],
      on: ((name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        hooks.set(name, handler);
      }) as OpenClawPluginApi["on"],
    });
    const queue = registerAdaKapsoWebhook(api, { resumeDelayMs: 0 });
    await queue.accept(entry(ANNA));
    const answered = () => [...store.rows.values()][0]?.answeredAtMs;
    const sentTo = (
      to: string,
      event: Record<string, unknown> = {},
      ctx: Record<string, unknown> = {},
    ) =>
      hooks.get("message_sent")?.(
        { to, content: "risposta", success: true, runId: "run-1", ...event },
        { channelId: "kapso-whatsapp", ...ctx },
      );
    await sentTo(`+${BRUNO}`);
    await sentTo(`+${ANNA}`, { success: false });
    await sentTo(`+${ANNA}`, { runId: undefined });
    await sentTo(`+${ANNA}`, {}, { channelId: "telegram" });
    expect(answered()).toBeNull();
    await sentTo(`+${ANNA}`);
    expect(answered()).toEqual(expect.any(Number));
    gate.resolve();
    await queue.settled();
    expect(store.rows.size).toBe(0);
    vi.unstubAllEnvs();
  });

  it("registers the fast route under both prefixes and replays saved webhooks when the service starts", async () => {
    const store = memoryStore();
    await store.db.spool(entry(ANNA, "left behind"));
    openAdaKapsoInboundFromApi.mockResolvedValue(store.db);
    const plugin = await serve((_req, res) => {
      res.end("{}");
    });
    servers.push(plugin);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", String(plugin.port));

    const routes: Array<{ path: string; auth: string; match?: string }> = [];
    let service: { start: () => void; stop: () => void } | undefined;
    const api = createTestPluginApi({
      id: "ada",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: configWithSecret as OpenClawPluginApi["config"],
      registerHttpRoute: ((route: { path: string; auth: string; match?: string }) => {
        routes.push(route);
      }) as OpenClawPluginApi["registerHttpRoute"],
      registerService: ((registered: { start: () => void; stop: () => void }) => {
        service = registered;
      }) as unknown as OpenClawPluginApi["registerService"],
    });
    const queue = registerAdaKapsoWebhook(api, { resumeDelayMs: 0 });
    expect(routes.map((route) => [route.path, route.auth, route.match])).toEqual([
      ["/ada/kapso/webhook", "plugin", "exact"],
      ["/vera/kapso/webhook", "plugin", "exact"],
    ]);

    service?.start();
    await vi.waitFor(async () => expect(await store.db.listSpooled()).toHaveLength(0));
    await queue.settled();
    service?.stop();
    vi.unstubAllEnvs();
  });
});
