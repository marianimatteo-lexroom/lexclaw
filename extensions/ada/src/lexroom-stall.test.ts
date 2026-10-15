import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runDraft, runResearch, type LexroomLogFields } from "./lexroom-client.js";

const MESSAGE = "Lexroom non risponde, riprova tra poco";
const LIMITS = { idleTimeoutMs: 1000, timeoutMs: 2500 };
const QUERY = "una domanda riservata sul cliente Rossi";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A real socket server, so the abort has to reach undici and the connection, not a mock. */
async function serve(handler: Handler) {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const closed: Promise<void>[] = [];
  const stop = () => {
    server.closeAllConnections();
    server.close();
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/user/modules") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(["Civile"]));
      return;
    }
    closed.push(
      new Promise<void>((resolve) => {
        res.on("close", resolve);
      }),
    );
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, seen, closed: () => Promise.all(closed), stop };
}

const line = (snapshot: Record<string, unknown>) => `${JSON.stringify({ research: snapshot })}\n`;

function startStream(res: http.ServerResponse, encoding?: string) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    ...(encoding ? { "content-encoding": encoding } : {}),
  });
  res.flushHeaders();
}

function recorder() {
  const events: Array<{ event: string; fields: LexroomLogFields }> = [];
  return {
    events,
    log: (event: string, fields: LexroomLogFields) => events.push({ event, fields }),
  };
}

/** Concurrent tests each own their server; a shared teardown would cut the others' sockets. */
async function withServer<T>(
  handler: Handler,
  run: (server: Awaited<ReturnType<typeof serve>>) => Promise<T>,
): Promise<T> {
  const server = await serve(handler);
  try {
    return await run(server);
  } finally {
    server.stop();
  }
}

async function research(baseUrl: string, log?: (event: string, fields: LexroomLogFields) => void) {
  const startedAt = Date.now();
  const result = await runResearch({
    config: { accessToken: "secret-token", baseUrl, ...LIMITS },
    matterId: "m",
    query: QUERY,
    log,
  });
  return { result, tookMs: Date.now() - startedAt };
}

describe("stalled Lexroom streams", () => {
  it.concurrent("fails fast when the server accepts the request and says nothing", () =>
    withServer(
      () => undefined,
      async (server) => {
        const { result, tookMs } = await research(server.baseUrl);
        expect(result).toEqual({ ok: false, error: MESSAGE });
        expect(tookMs).toBeGreaterThanOrEqual(900);
        expect(tookMs).toBeLessThan(2400);
        await server.closed();
      },
    ));

  it.concurrent("fails when headers arrive and the body never does", () =>
    withServer(
      (_req, res) => startStream(res),
      async (server) => {
        const { result } = await research(server.baseUrl);
        expect(result).toEqual({ ok: false, error: MESSAGE });
        await server.closed();
      },
    ));

  it.concurrent("fails when the stream goes quiet after the first line", () =>
    withServer(
      (_req, res) => {
        startStream(res);
        res.write(line({ id: "r", status: "RUNNING" }));
      },
      async (server) => {
        const recorded = recorder();
        const { result } = await research(server.baseUrl, recorded.log);
        expect(result).toEqual({ ok: false, error: MESSAGE });
        await server.closed();
        expect(
          recorded.events
            .map((entry) => entry.event)
            .filter((event) => event.startsWith("research.")),
        ).toEqual([
          "research.start",
          "research.response",
          "research.first_line",
          "research.progress",
          "research.timeout",
        ]);
        expect(recorded.events.at(-1)?.fields).toMatchObject({
          kind: "idle",
          lines: 1,
          lastStatus: "RUNNING",
        });
      },
    ));

  it.concurrent("caps a stream that keeps talking but never finishes", () =>
    withServer(
      (_req, res) => {
        startStream(res);
        const timer = setInterval(() => res.write(line({ id: "r", status: "RUNNING" })), 200);
        res.on("close", () => clearInterval(timer));
      },
      async (server) => {
        const recorded = recorder();
        const { result, tookMs } = await research(server.baseUrl, recorded.log);
        expect(result).toEqual({ ok: false, error: MESSAGE });
        expect(tookMs).toBeGreaterThanOrEqual(2400);
        expect(recorded.events.at(-1)).toMatchObject({
          event: "research.timeout",
          fields: { kind: "total" },
        });
        await server.closed();
      },
    ));

  it.concurrent("does not drop a slow stream that is still delivering", () =>
    withServer(
      (_req, res) => {
        startStream(res);
        res.write(line({ id: "r", status: "RUNNING" }));
        setTimeout(() => res.write(line({ id: "r", status: "RUNNING" })), 700);
        setTimeout(
          () => res.end(line({ id: "r", status: "DONE", answer: { text: "Risposta" } })),
          1400,
        );
      },
      async (server) => {
        const { result } = await research(server.baseUrl);
        expect(result).toMatchObject({ ok: true, answer: "Risposta" });
      },
    ));

  it.concurrent("stops a stream that stays busy but has no answer by the answer limit", () =>
    withServer(
      (_req, res) => {
        startStream(res);
        const timer = setInterval(() => res.write(line({ id: "r", status: "RUNNING" })), 150);
        res.on("close", () => clearInterval(timer));
      },
      async (server) => {
        const recorded = recorder();
        const startedAt = Date.now();
        const result = await runResearch({
          config: {
            accessToken: "secret-token",
            baseUrl: server.baseUrl,
            idleTimeoutMs: 2000,
            timeoutMs: 5000,
            answerTimeoutMs: 1000,
          },
          matterId: "m",
          query: QUERY,
          log: recorded.log,
        });
        expect(result).toEqual({ ok: false, error: MESSAGE });
        expect(Date.now() - startedAt).toBeLessThan(2000);
        expect(recorded.events.at(-1)).toMatchObject({
          event: "research.timeout",
          fields: { kind: "answer" },
        });
        await server.closed();
      },
    ));

  it.concurrent("lets a stream that reached its answer run past the answer limit", () =>
    withServer(
      (_req, res) => {
        startStream(res);
        res.write(line({ id: "r", status: "RUNNING" }));
        setTimeout(
          () => res.write(line({ id: "r", status: "RUNNING", answer: { text: "Prima" } })),
          300,
        );
        setTimeout(
          () => res.write(line({ id: "r", status: "RUNNING", answer: { text: "Prima parte" } })),
          900,
        );
        setTimeout(
          () => res.end(line({ id: "r", status: "DONE", answer: { text: "Prima parte, fine" } })),
          1500,
        );
      },
      async (server) => {
        const result = await runResearch({
          config: {
            accessToken: "secret-token",
            baseUrl: server.baseUrl,
            idleTimeoutMs: 1000,
            timeoutMs: 5000,
            answerTimeoutMs: 1000,
          },
          matterId: "m",
          query: QUERY,
        });
        expect(result).toMatchObject({ ok: true, answer: "Prima parte, fine" });
      },
    ));

  it.concurrent("fails module selection that never answers", () =>
    withServer(
      () => undefined,
      async (server) => {
        const result = await runDraft({
          config: { accessToken: "secret-token", baseUrl: server.baseUrl, ...LIMITS },
          matterId: "m",
          prompt: "Diffida",
          confirmed: true,
        });
        expect(result).toEqual({ ok: false, error: MESSAGE });
        expect(server.seen.map((request) => request.url)).toEqual(["/v2/ai/drafting/selectors"]);
        await server.closed();
      },
    ));

  it.concurrent("fails a draft stream that stalls after selection", () =>
    withServer(
      (req, res) => {
        if (req.url === "/v2/ai/drafting/selectors") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ modules: [{ name: "Civile", is_active: true }] }));
          return;
        }
        startStream(res);
        res.write(line({ id: "d", status: "RUNNING", running_step: "RETRIEVING" }));
      },
      async (server) => {
        const recorded = recorder();
        const result = await runDraft({
          config: { accessToken: "secret-token", baseUrl: server.baseUrl, ...LIMITS },
          matterId: "m",
          prompt: "Diffida",
          confirmed: true,
          log: recorded.log,
        });
        expect(result).toEqual({ ok: false, error: MESSAGE });
        expect(recorded.events.map((entry) => entry.event)).toContain("draft.timeout");
        await server.closed();
      },
    ));
});

function never<T>(): Promise<T> {
  return new Promise<T>((_resolve, _reject) => {
    // Neither settles, like a socket that stopped answering.
  });
}

describe("a transport that ignores the abort signal", () => {
  const config = { accessToken: "secret-token", baseUrl: "https://api.lexroom.ai", ...LIMITS };

  it.concurrent("still gives up when fetch itself never settles", async () => {
    const result = await runResearch({
      config,
      matterId: "m",
      query: QUERY,
      fetchImpl: () => never<Response>(),
    });
    expect(result).toEqual({ ok: false, error: MESSAGE });
  });

  it.concurrent("still gives up when a body read never settles", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => never<void>(),
    });
    const result = await runResearch({
      config,
      matterId: "m",
      query: QUERY,
      fetchImpl: async () => new Response(stalled, { status: 200 }),
    });
    expect(result).toEqual({ ok: false, error: MESSAGE });
  });
});

describe("what a live request looks like on the wire", () => {
  it("sends lexroom-bot's request over a real socket and reads the gzip stream it gets back", () =>
    withServer(
      (req, res) => {
        const gzip = String(req.headers["accept-encoding"] ?? "").includes("gzip");
        const body = line({ id: "r", status: "DONE", answer: { text: "Risposta" } });
        startStream(res, gzip ? "gzip" : undefined);
        res.end(gzip ? gzipSync(body) : body);
      },
      async (server) => {
        const recorded = recorder();
        const { result } = await research(server.baseUrl, recorded.log);
        expect(result).toMatchObject({ ok: true, answer: "Risposta" });

        const [request] = server.seen;
        expect(request?.url).toBe("/v1/ask_me_anything");
        expect(request?.headers.authorization).toBe("Bearer secret-token");
        expect(request?.headers["content-type"]).toBe("application/json");
        expect(request?.headers["x-client-type"]).toBe("app_lex");
        expect(request?.headers.accept).toBe("*/*");
        expect(request?.headers["x-request-id"]).toBeUndefined();
        expect(JSON.parse(request?.body ?? "")).toEqual({
          query: QUERY,
          search_on_user_data: false,
          search_on_modules: ["Civile"],
        });

        const logged = JSON.stringify(recorded.events);
        expect(logged).not.toContain("secret-token");
        expect(logged).not.toContain("Rossi");
        const events = recorded.events.filter((entry) => entry.event.startsWith("research."));
        expect(events[0]).toMatchObject({
          event: "research.start",
          fields: { modules: "Civile", queryLength: QUERY.length },
        });
        expect(events[1]).toMatchObject({
          event: "research.response",
          fields: { status: 200, contentType: "text/event-stream", contentEncoding: "gzip" },
        });
        expect(events.at(-1)).toMatchObject({
          event: "research.done",
          fields: { lines: 1, answerChars: 8 },
        });
      },
    ));
});
