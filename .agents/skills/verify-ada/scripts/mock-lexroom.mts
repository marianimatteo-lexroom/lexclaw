#!/usr/bin/env node
// A local stand-in for the Lexroom API, for verifying Ada's Lexroom integration without
// credentials. It serves the checked-in fixtures from extensions/ada/src/test-fixtures and can
// misbehave on demand. It is verification scaffolding: it never contacts Lexroom, and it
// never records a password or a token value, only whether a bearer was valid.
//
//   node --import ./scripts/tsx.mjs .agents/skills/verify-ada/scripts/mock-lexroom.mts \
//     [--port 0] [--mode normal] [--route /v1/login=401]
//
// Modes (set for every path with `*`, or per path):
//   normal    serve the fixture
//   slow      stream the research answer over several seconds (a healthy but long research)
//   stall     send headers (and the first stream line), then nothing, until the client gives up
//   silent    accept the request and never answer
//   401 403 500   that HTTP status with a Lexroom-shaped `{detail, code}` body
//   mfa       login only: 401 with `detail: mfa_required` (the account needs a one-time code)
//   malformed 200 with a body the client cannot use (not JSON, or JSON of the wrong shape)
//   empty     200 with an empty body
// Control: POST /__mock/config {"mode":"*","routes":{"/v1/login":"401"},"revokeTokens":true}
//          GET  /__mock/requests      the request log (no secrets), POST /__mock/reset clears it.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../../../extensions/ada/src/test-fixtures");

export type MockMode =
  | "normal"
  | "slow"
  | "stall"
  | "silent"
  | "401"
  | "403"
  | "500"
  | "mfa"
  | "malformed"
  | "empty";

export type MockConfig = { mode: MockMode; routes: Record<string, MockMode> };

export type MockRequest = {
  method: string;
  path: string;
  mode: MockMode;
  /** "none" without a bearer, "valid" for a token this mock issued, "unknown" for any other. */
  bearer: "none" | "valid" | "unknown";
  clientType: string;
  /** For POSTs: the JSON keys of the body, never the values. */
  bodyKeys: string[];
  /** For ask_me_anything: the modules the client asked to search. */
  modules?: string[];
};

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

function freshToken(counter: number): string {
  const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: 4102444800, jti: `mock-${counter}` })).toString(
    "base64url",
  );
  return `${header}.${payload}.bW9jaw`;
}

export type MockLexroom = {
  baseUrl: string;
  port: number;
  configure(patch: Partial<MockConfig> & { revokeTokens?: boolean }): void;
  requests(): MockRequest[];
  reset(): void;
  /** The newest token the mock issued, so a check can compare it with what Ada saved. */
  lastIssuedToken(): string | undefined;
  /** Every token issued since the mock started, so a check can prove none leaked into a log. */
  issuedTokens(): string[];
  close(): Promise<void>;
};

export async function startMockLexroom(options: { port?: number } = {}): Promise<MockLexroom> {
  let config: MockConfig = { mode: "normal", routes: {} };
  let log: MockRequest[] = [];
  const issued = new Set<string>();
  const everIssued: string[] = [];
  let counter = 0;
  let lastToken: string | undefined;
  const open = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ detail: "mock failure" }));
    });
  });

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const failure = (res: http.ServerResponse, mode: MockMode) => {
    if (mode === "401") {
      return sendJson(res, 401, fixture("lexroom-login-401.json"));
    }
    if (mode === "403") {
      return sendJson(res, 403, { detail: "Forbidden", code: "forbidden" });
    }
    return sendJson(res, 500, { detail: "Internal Server Error" });
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://mock.invalid");
    const raw = await readBody(req);
    if (url.pathname === "/__mock/config" && req.method === "POST") {
      const patch = JSON.parse(raw || "{}") as Partial<MockConfig> & { revokeTokens?: boolean };
      if (patch.revokeTokens) {
        issued.clear();
      }
      config = {
        mode: patch.mode ?? config.mode,
        routes: patch.routes ?? config.routes,
      };
      return sendJson(res, 200, config);
    }
    if (url.pathname === "/__mock/requests") {
      return sendJson(res, 200, log);
    }
    if (url.pathname === "/__mock/reset" && req.method === "POST") {
      log = [];
      return sendJson(res, 200, {});
    }

    const mode = config.routes[url.pathname] ?? config.mode;
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // A body that is not JSON is recorded as having no keys.
    }
    const entry: MockRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      mode,
      bearer: !token ? "none" : issued.has(token) ? "valid" : "unknown",
      clientType: String(req.headers["x-client-type"] ?? ""),
      bodyKeys: Object.keys(body).sort(),
      ...(Array.isArray(body.search_on_modules)
        ? { modules: (body.search_on_modules as unknown[]).map(String) }
        : {}),
    };
    log.push(entry);

    if (mode === "silent") {
      return;
    }
    const isLogin = url.pathname === "/v1/login";
    if (isLogin && req.method === "POST") {
      if (mode === "mfa") {
        return sendJson(res, 401, fixture("lexroom-login-mfa.json"));
      }
      if (mode === "401" || mode === "403" || mode === "500") {
        return failure(res, mode);
      }
      if (mode === "stall") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        return;
      }
      if (mode === "malformed") {
        return sendJson(res, 200, "this is not json");
      }
      if (mode === "empty") {
        return sendJson(res, 200, "");
      }
      counter += 1;
      lastToken = freshToken(counter);
      issued.add(lastToken);
      everIssued.push(lastToken);
      const base = JSON.parse(fixture("lexroom-login.json")) as Record<string, unknown>;
      return sendJson(res, 200, { ...base, access_token: lastToken });
    }

    if (mode === "401" || mode === "403" || mode === "500") {
      return failure(res, mode);
    }
    if (mode === "stall") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      if (url.pathname === "/v1/ask_me_anything") {
        res.write(`${fixture("lexroom-ask.ndjson").split("\n")[0]}\n`);
      }
      return;
    }
    if (mode === "malformed") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(url.pathname === "/v1/ask_me_anything" ? "<<<not ndjson\n{" : '"nope"');
    }
    if (mode === "empty") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end();
    }

    // Past this point the call needs a bearer this mock issued, like the real API.
    if (!issued.has(token)) {
      return sendJson(res, 401, {
        detail: "Could not validate credentials",
        code: "invalid_token",
      });
    }
    if (url.pathname === "/v1/user/modules") {
      return sendJson(res, 200, fixture("lexroom-user-modules.json"));
    }
    if (url.pathname === "/v1/credits") {
      return sendJson(res, 200, fixture("lexroom-credits.json"));
    }
    if (url.pathname === "/v1/ask_me_anything" && req.method === "POST") {
      const lines = fixture("lexroom-ask.ndjson").split("\n").filter(Boolean);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const gap = mode === "slow" ? 900 : 0;
      for (const [index, line] of lines.entries()) {
        if (gap && index > 0) {
          await new Promise((resolve) => setTimeout(resolve, gap));
        }
        if (res.destroyed) {
          return;
        }
        res.write(`${line}\n`);
      }
      return void res.end();
    }
    return sendJson(res, 404, { detail: "Not Found" });
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    configure(patch) {
      if (patch.revokeTokens) {
        issued.clear();
      }
      config = {
        mode: patch.mode ?? config.mode,
        routes: patch.routes ?? config.routes,
      };
    },
    requests: () => [...log],
    reset() {
      log = [];
    },
    lastIssuedToken: () => lastToken,
    issuedTokens: () => [...everIssued],
    close() {
      for (const res of open) {
        res.destroy();
      }
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const mock = await startMockLexroom({
    port: args.includes("--port") ? Number(value("--port")) : 0,
  });
  const routes: Record<string, MockMode> = {};
  args.forEach((arg, index) => {
    if (arg === "--route") {
      const [route, mode] = (args[index + 1] ?? "").split("=");
      if (route && mode) {
        routes[route] = mode as MockMode;
      }
    }
  });
  mock.configure({
    mode: (args.includes("--mode") ? value("--mode") : "normal") as MockMode,
    routes,
  });
  console.log(`mock Lexroom listening on ${mock.baseUrl} (Ctrl+C to stop)`);
  process.on("SIGINT", () => void mock.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void mock.close().then(() => process.exit(0)));
}
