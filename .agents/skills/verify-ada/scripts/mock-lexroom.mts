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
//   mfa       the account needs a one-time code: 401 `mfa_required` from /v1/login, a redirect to
//             a /u/mfa-* step from /u/login/password, `mfa_required` from /oauth/token
//   malformed 200 with a body the client cannot use (not JSON, or JSON of the wrong shape)
//   empty     200 with an empty body
//   wrong_password, captcha, blocked   /u/login/password: the page again with Auth0's error,
//             a captcha widget, or a blocked account; /oauth/token: invalid_grant (wrong_password)
//   no_token  /api/auth/session: a signed-in session that carries no accessToken
//
// What it models is Lexroom's current sign-in. POST /v1/login answers 403 auth0_login_required.
// The web flow then runs on two more hosts, which the checks' fetch maps onto this server as
// /__host/app.lexroom.ai/... and /__host/auth.lexroom.ai/...: /api/auth/login redirects to
// /authorize, to /u/login/identifier, the identifier and password forms (the real markup, from
// the fixtures), /authorize/resume, the app's /api/auth/callback/auth0, and /api/auth/session,
// which hands out a bearer only to the session cookie the callback set. POST /oauth/token is
// Auth0's password-realm grant. Modes are keyed by the real path (for example
// `--route /u/login/password=captcha`).
// Control: POST /__mock/config {"mode":"*","routes":{"/v1/login":"401"},"revokeTokens":true}
//          GET  /__mock/requests      the request log (no secrets), POST /__mock/reset clears it.
import { randomUUID } from "node:crypto";
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
  | "empty"
  | "wrong_password"
  | "captcha"
  | "blocked"
  | "no_token";

export type MockConfig = { mode: MockMode; routes: Record<string, MockMode> };

export type MockRequest = {
  method: string;
  path: string;
  /** Set for the web app and Auth0 hosts, which are served under /__host/<host>/. */
  host?: string;
  mode: MockMode;
  /** "none" without a bearer, "valid" for a token this mock issued, "unknown" for any other. */
  bearer: "none" | "valid" | "unknown";
  clientType: string;
  /** For POSTs: the keys of the JSON or form body, never the values. */
  bodyKeys: string[];
  /** For ask_me_anything: the modules the client asked to search. */
  modules?: string[];
};

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/** What Auth0's Universal Login adds to the password page after a refused attempt. */
const WRONG_CREDENTIALS =
  '<span id="error-element-password" class="ulp-input-error-message" data-error-code="wrong-credentials">Errore</span>';
const BLOCKED_USER =
  '<span id="error-element-password" class="ulp-input-error-message" data-error-code="blocked-user">Errore</span>';
const CAPTCHA =
  '<div data-captcha-sitekey="mock-sitekey" data-captcha-provider="auth0_v2"><input type="hidden" name="captcha"></div>';

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
  /** Web-flow sessions by cookie value: the address typed at the identifier step, never a password. */
  const webSessions = new Map<string, { email: string; token?: string }>();

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

  const issue = () => {
    counter += 1;
    lastToken = freshToken(counter);
    issued.add(lastToken);
    everIssued.push(lastToken);
    return lastToken;
  };

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

  const AUTH = "https://auth.lexroom.ai";
  const APP = "https://app.lexroom.ai";
  const STATE = "mock-state-token";

  const page = (res: http.ServerResponse, status: number, html: string, cookies: string[] = []) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      ...(cookies.length ? { "set-cookie": cookies } : {}),
    });
    res.end(html);
  };

  const redirectTo = (res: http.ServerResponse, location: string, cookies: string[] = []) => {
    res.writeHead(302, { location, ...(cookies.length ? { "set-cookie": cookies } : {}) });
    res.end();
  };

  const cookieOf = (req: http.IncomingMessage, name: string): string | undefined =>
    String(req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .find(([key]) => key === name)?.[1];

  /** The real Universal Login form, with the mock's own state in it. */
  const loginPage = (name: string, extra = "") =>
    fixture(name).replaceAll("STATE-TOKEN", STATE).replace("</form>", `${extra}</form>`);

  const webFailure = (res: http.ServerResponse, mode: MockMode): boolean => {
    if (mode === "500" || mode === "401" || mode === "403") {
      page(res, 500, "<html>Lexroom is down</html>");
      return true;
    }
    if (mode === "stall") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html>");
      return true;
    }
    if (mode === "malformed") {
      page(res, 200, "<html>maintenance</html>");
      return true;
    }
    if (mode === "empty") {
      res.writeHead(200);
      res.end();
      return true;
    }
    return false;
  };

  /** Auth0's password-realm grant. Only the key names of the request are ever recorded. */
  function handleToken(res: http.ServerResponse, mode: MockMode) {
    if (mode === "500") {
      return sendJson(res, 500, { error: "server_error" });
    }
    if (mode === "wrong_password") {
      return sendJson(res, 403, {
        error: "invalid_grant",
        error_description: "Wrong email or password.",
      });
    }
    if (mode === "mfa") {
      return sendJson(res, 403, {
        error: "mfa_required",
        error_description: "Multifactor authentication required",
        mfa_token: "mock-mfa-token-0123456789abcdefghijklmnop",
      });
    }
    if (mode === "403" || mode === "blocked") {
      return sendJson(res, 403, {
        error: "unauthorized_client",
        error_description: "Grant type 'password-realm' not allowed for the client.",
      });
    }
    if (mode === "401") {
      return sendJson(res, 401, { error: "invalid_client", error_description: "Unauthorized" });
    }
    return sendJson(res, 200, {
      access_token: issue(),
      id_token: "mock-id-token",
      token_type: "Bearer",
      expires_in: 86400,
    });
  }

  /** The web app and Auth0, as the sign-in sees them. */
  async function handleWeb(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    call: {
      host: string;
      route: string;
      mode: MockMode;
      body: Record<string, unknown>;
      url: URL;
    },
  ) {
    const { host, route, mode, body } = call;
    const get = req.method === "GET";
    if (host === "auth.lexroom.ai" && route === "/oauth/token" && req.method === "POST") {
      return handleToken(res, mode);
    }
    if (webFailure(res, mode)) {
      return;
    }
    if (host === "app.lexroom.ai" && route === "/api/auth/login" && get) {
      // One id follows the sign-in through both hosts: the PKCE cookie, then `state`.
      const flow = randomUUID();
      return redirectTo(
        res,
        `${AUTH}/authorize?client_id=mock&state=${flow}&code_challenge=CHALLENGE`,
        [`authjs.pkce.code_verifier=${flow}; Path=/; HttpOnly; Secure`],
      );
    }
    if (host === "auth.lexroom.ai") {
      if (route === "/authorize" && get) {
        const flow = call.url.searchParams.get("state") ?? randomUUID();
        return redirectTo(res, `/u/login/identifier?state=${STATE}&ui_locales=it`, [
          `auth0=${flow}; Path=/; Secure`,
        ]);
      }
      if (route === "/u/login/identifier") {
        if (get) {
          return page(res, 200, loginPage("auth0-identifier.html"));
        }
        webSessions.set(cookieOf(req, "auth0") ?? "", { email: String(body.username ?? "") });
        return redirectTo(res, `/u/login/password?state=${STATE}&ui_locales=it`);
      }
      if (route === "/u/login/password") {
        if (get) {
          return page(res, 200, loginPage("auth0-password.html"));
        }
        if (mode === "wrong_password") {
          return page(res, 400, loginPage("auth0-password.html", WRONG_CREDENTIALS));
        }
        if (mode === "blocked") {
          return page(res, 400, loginPage("auth0-password.html", BLOCKED_USER));
        }
        if (mode === "captcha") {
          return page(res, 400, loginPage("auth0-password.html", CAPTCHA));
        }
        if (mode === "mfa") {
          return redirectTo(res, `/u/mfa-otp-challenge?state=${STATE}`);
        }
        return redirectTo(res, `/authorize/resume?state=${STATE}`);
      }
      if (route === "/authorize/resume" && get) {
        const flow = cookieOf(req, "auth0") ?? "";
        return redirectTo(res, `${APP}/api/auth/callback/auth0?code=mock-code&state=${flow}`);
      }
    }
    if (host === "app.lexroom.ai") {
      if (route === "/api/auth/callback/auth0" && get) {
        const flow = cookieOf(req, "authjs.pkce.code_verifier");
        if (!flow || call.url.searchParams.get("state") !== flow) {
          return redirectTo(res, "/auth/sign-in?error=Callback");
        }
        const sid = randomUUID();
        webSessions.set(sid, { email: webSessions.get(flow)?.email ?? "", token: issue() });
        return redirectTo(res, "/", [`authjs.session-token=${sid}; Path=/; HttpOnly; Secure`]);
      }
      if (route === "/" && get) {
        return page(res, 200, "<html>Lexroom</html>");
      }
      if (route === "/api/auth/session" && get) {
        const session = webSessions.get(cookieOf(req, "authjs.session-token") ?? "");
        if (!session?.token) {
          return sendJson(res, 200, {});
        }
        return sendJson(res, 200, {
          user: {
            email: session.email,
            ...(mode === "no_token" ? {} : { accessToken: session.token }),
          },
          expires: "2999-01-01T00:00:00.000Z",
        });
      }
    }
    return sendJson(res, 404, { detail: "Not Found" });
  }

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

    const hostMatch = /^\/__host\/([a-z.]+)(\/.*)$/u.exec(url.pathname);
    const host = hostMatch?.[1];
    const route = hostMatch?.[2] ?? url.pathname;
    const mode = config.routes[route] ?? config.mode;
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let body: Record<string, unknown> = {};
    try {
      body = String(req.headers["content-type"] ?? "").startsWith(
        "application/x-www-form-urlencoded",
      )
        ? Object.fromEntries(new URLSearchParams(raw))
        : raw
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {};
    } catch {
      // A body that is not JSON is recorded as having no keys.
    }
    const entry: MockRequest = {
      method: req.method ?? "GET",
      path: route,
      ...(host ? { host } : {}),
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
    if (host) {
      return await handleWeb(req, res, { host, route, mode, body, url });
    }
    const isLogin = route === "/v1/login";
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
      // Lexroom has moved to Auth0: the old endpoint says so instead of signing anyone in.
      return sendJson(res, 403, { detail: "auth0_login_required" });
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
