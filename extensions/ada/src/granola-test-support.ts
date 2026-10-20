import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { vi } from "vitest";
import type { GranolaAccountDb } from "./granola-account-contract.js";
import { wrapGranolaWorker } from "./granola-account.js";
import { createSqliteWorkerBackend } from "./granola-account.worker.js";
import { handleAdaGranolaCallback } from "./granola-callback.js";
import { granolaConnectConfigFrom, prepareGranolaConnect } from "./granola-connect.js";
import { clearGranolaDiscoveryCache, resetGranolaScope } from "./granola-oauth.js";
import { handleAdaShortLink } from "./short-links-http.js";

export const ANNA = "393331111111";
export const BRUNO = "393332222222";

export const GRANOLA_PLUGIN_CONFIG = {
  googleRedirectUri: "https://vera.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

export const REDIRECT_URI = "https://vera.example/ada/granola/callback";

/** A real SQLite store, through the same worker code production uses. */
export function openGranolaTestDb(dir: string): {
  db: GranolaAccountDb;
  dir: string;
  close: () => void;
} {
  const backend = createSqliteWorkerBackend(undefined, {
    databasePath: path.join(dir, "granola-account.sqlite"),
  });
  return {
    db: wrapGranolaWorker({
      execute: async (command) => backend.execute(command as never),
    } as never),
    dir,
    close: () => void backend.close(),
  };
}

export function testApi() {
  return {
    runtimeSource: "/fake/ada/index.ts",
    runtime: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

type Grant = {
  scope: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  user: string;
};

type MockMeeting = { id: string; title: string; date: string; notes: string; transcript: string };

/**
 * Stands in for Granola's MCP server and its authorization server. The person who "signs in" is
 * named by `signIn(authorizeUrl, user)`; every token belongs to that user, and the MCP side only
 * answers with that user's own meetings.
 */
export class MockGranola {
  readonly requests: Array<{ url: string; method: string; authorization?: string; body?: string }> =
    [];
  registrations = 0;
  /** Clients Granola still knows; deleting one makes it answer `invalid_client`. */
  readonly clients = new Map<string, { redirectUri: string }>();
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, string>();
  private readonly refreshTokens = new Map<string, { user: string; clientId: string }>();
  readonly meetings = new Map<string, MockMeeting[]>();
  plan: "paid" | "free" = "paid";
  /** What the next refresh answers instead of success. */
  refreshFailure: "invalid_grant" | "server_error" | "gateway_page" | null = null;
  refreshes = 0;
  /** Access tokens last this long; tests move the clock past it. */
  accessTtlSeconds = 3600;
  mcpStatusOverride: { status: number; body: string } | null = null;
  /** More tools in the list, as Granola may add; they answer "ok". */
  extraTools: Array<Record<string, unknown>> = [];
  /** A server request with the same id comes first in the event stream. */
  sseNoise = false;
  /** `expires_in` as a string, as some servers send it. */
  expiresInAsString = false;
  transcriptError: string | null = null;
  /** Where Granola's authorization server refuses `mcp` as a scope, as the real one would not list it. */
  rejectMcp: "register" | "authorize" | "token" | null = null;
  /** The scope of every authorize request and registration it has seen. */
  readonly scopesSeen: string[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : init?.body?.toString();
    this.requests.push({
      url,
      method,
      authorization: headers.get("authorization") ?? undefined,
      body,
    });
    const { origin, pathname } = new URL(url);
    if (origin === "https://mcp.granola.ai") {
      if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json({
          resource: "https://mcp.granola.ai/mcp",
          authorization_servers: ["https://mcp-auth.granola.ai"],
        });
      }
      if (pathname === "/mcp") {
        return this.mcp(headers, body ?? "");
      }
    }
    if (origin === "https://mcp-auth.granola.ai") {
      if (pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: "https://mcp-auth.granola.ai",
          authorization_endpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
          token_endpoint: "https://mcp-auth.granola.ai/oauth2/token",
          registration_endpoint: "https://mcp-auth.granola.ai/oauth2/register",
          revocation_endpoint: "https://mcp-auth.granola.ai/oauth2/revoke",
        });
      }
      if (pathname === "/oauth2/register") {
        return this.register(JSON.parse(body ?? "{}"));
      }
      if (pathname === "/oauth2/token") {
        return this.token(new URLSearchParams(body ?? ""));
      }
      if (pathname === "/oauth2/revoke") {
        const token = new URLSearchParams(body ?? "").get("token") ?? "";
        this.refreshTokens.delete(token);
        this.accessTokens.delete(token);
        return new Response(null, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };

  private register(request: {
    redirect_uris?: string[];
    grant_types?: string[];
    scope?: string;
  }): Response {
    this.scopesSeen.push(`register:${request.scope ?? ""}`);
    if (this.rejectMcp === "register" && request.scope?.split(" ").includes("mcp")) {
      return json(
        { error: "invalid_client_metadata", error_description: "unknown scope mcp" },
        400,
      );
    }
    if (!request.redirect_uris?.length || !request.grant_types?.includes("refresh_token")) {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    this.registrations += 1;
    const clientId = `client-${this.registrations}-${randomBytes(4).toString("hex")}`;
    this.clients.set(clientId, { redirectUri: request.redirect_uris[0] ?? "" });
    return json({ client_id: clientId, redirect_uris: request.redirect_uris }, 201);
  }

  /** The browser step: the person signs in and Granola redirects back with a code. */
  signIn(authorizeUrl: string, user: string): URL {
    const url = new URL(authorizeUrl);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (this.clients.get(clientId)?.redirectUri !== redirectUri) {
      throw new Error("Granola would show an error: unknown client or redirect URI");
    }
    if (url.searchParams.get("code_challenge_method") !== "S256") {
      throw new Error("PKCE S256 is required");
    }
    const scope = url.searchParams.get("scope") ?? "";
    this.scopesSeen.push(`authorize:${scope}`);
    if (this.rejectMcp === "authorize" && scope.split(" ").includes("mcp")) {
      const refused = new URL(redirectUri);
      refused.searchParams.set("error", "invalid_scope");
      refused.searchParams.set("state", url.searchParams.get("state") ?? "");
      return refused;
    }
    const code = `code-${randomBytes(6).toString("hex")}`;
    this.grants.set(code, {
      scope,
      clientId,
      redirectUri,
      challenge: url.searchParams.get("code_challenge") ?? "",
      user,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return back;
  }

  private issue(user: string, clientId: string): Response {
    const accessToken = `at-${user}-${randomBytes(6).toString("hex")}`;
    const refreshToken = `rt-${user}-${randomBytes(6).toString("hex")}`;
    this.accessTokens.set(accessToken, user);
    this.refreshTokens.set(refreshToken, { user, clientId });
    return json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: this.expiresInAsString ? String(this.accessTtlSeconds) : this.accessTtlSeconds,
      token_type: "Bearer",
      scope: "openid email profile offline_access mcp",
    });
  }

  private token(form: URLSearchParams): Response {
    const clientId = form.get("client_id") ?? "";
    if (!this.clients.has(clientId)) {
      return json({ error: "invalid_client" }, 401);
    }
    if (form.get("grant_type") === "authorization_code") {
      const grant = this.grants.get(form.get("code") ?? "");
      this.grants.delete(form.get("code") ?? "");
      if (this.rejectMcp === "token" && grant?.scope.split(" ").includes("mcp")) {
        return json({ error: "invalid_scope" }, 400);
      }
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        !grant ||
        grant.clientId !== clientId ||
        grant.redirectUri !== form.get("redirect_uri") ||
        grant.challenge !== challenge
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      return this.issue(grant.user, clientId);
    }
    this.refreshes += 1;
    if (this.refreshFailure === "gateway_page") {
      return new Response("<html>Forbidden</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    if (this.refreshFailure === "server_error") {
      return json({ error: "server_error" }, 503);
    }
    const known = this.refreshTokens.get(form.get("refresh_token") ?? "");
    if (this.refreshFailure === "invalid_grant" || !known || known.clientId !== clientId) {
      return json({ error: "invalid_grant" }, 400);
    }
    // Refresh tokens rotate: the one presented is spent.
    this.refreshTokens.delete(form.get("refresh_token") ?? "");
    return this.issue(known.user, clientId);
  }

  /** Ends the access token of `user`, as if it expired on Granola's side. */
  expireAccessTokens(user: string): void {
    for (const [token, owner] of this.accessTokens) {
      if (owner === user) {
        this.accessTokens.delete(token);
      }
    }
  }

  userOf(accessToken: string): string | undefined {
    return this.accessTokens.get(accessToken);
  }

  private tools() {
    const base = [
      {
        name: "query_granola_meetings",
        description: "Ask a question about the person's meetings.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "list_meetings",
        description: "List recent meetings.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_meeting_folders",
        description: "List meeting folders.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_meeting_transcript",
        description: "Read the transcript of one meeting.",
        inputSchema: {
          type: "object",
          properties: { meeting_id: { type: "string" } },
          required: ["meeting_id"],
        },
      },
      {
        name: "delete_meeting",
        description: "Delete a meeting.",
        inputSchema: { type: "object", properties: { meeting_id: { type: "string" } } },
        annotations: { destructiveHint: true },
      },
    ];
    const offered =
      this.plan === "free" ? base.filter((tool) => tool.name !== "get_meeting_transcript") : base;
    return [...offered, ...this.extraTools];
  }

  private mcp(headers: Headers, body: string): Response {
    if (this.mcpStatusOverride) {
      return new Response(this.mcpStatusOverride.body, { status: this.mcpStatusOverride.status });
    }
    const bearer = headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
    const user = this.accessTokens.get(bearer);
    if (!user) {
      return new Response("unauthorized", { status: 401 });
    }
    const message = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) {
      return new Response(null, { status: 202 });
    }
    const reply = (result: unknown, event = false) =>
      event || this.sseNoise
        ? new Response(
            `${this.sseNoise ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "ping" })}\n\n` : ""}event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
            {
              headers: { "content-type": "text/event-stream", "mcp-session-id": `session-${user}` },
            },
          )
        : json({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") {
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } }, true);
    }
    if (message.method === "tools/list") {
      return reply({ tools: this.tools() });
    }
    const name = String(message.params?.name);
    const args = (message.params?.arguments ?? {}) as Record<string, string>;
    const own = this.meetings.get(user) ?? [];
    const text = (value: string, isError = false) =>
      reply({ content: [{ type: "text", text: value }], isError });
    if (name === "list_meetings") {
      return text(
        own.map((meeting) => `${meeting.id} | ${meeting.date} | ${meeting.title}`).join("\n"),
      );
    }
    if (name === "query_granola_meetings") {
      const hit = own.find((meeting) =>
        meeting.notes.toLowerCase().includes((args.query ?? "").toLowerCase()),
      );
      return text(hit ? `${hit.title} (${hit.date}): ${hit.notes}` : "No meeting matches.");
    }
    if (name === "get_meeting_transcript") {
      if (this.transcriptError) {
        return text(this.transcriptError, true);
      }
      const meeting = own.find((item) => item.id === args.meeting_id);
      return meeting ? text(meeting.transcript) : text("Meeting not found.", true);
    }
    if (this.extraTools.some((tool) => tool.name === name)) {
      return text("ok");
    }
    return json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Unknown tool" },
    });
  }
}

/** A mock whose users have signed in through the real connect flow's tokens. */
export function newMockGranola(): MockGranola {
  clearGranolaDiscoveryCache();
  resetGranolaScope();
  return new MockGranola();
}

/** Everything a person does to connect: the link, Granola's sign-in, and the redirect back. */
export async function signInThroughFlow(params: {
  mock: MockGranola;
  db: GranolaAccountDb;
  owner: string;
  user: string;
  now: Date;
}): Promise<void> {
  const config = granolaConnectConfigFrom(GRANOLA_PLUGIN_CONFIG);
  const ask = await prepareGranolaConnect({
    owner: params.owner,
    config,
    db: params.db,
    now: params.now,
    force: true,
    fetchImpl: params.mock.fetch,
  });
  if (!ask.ok || ask.connected) {
    throw new Error("expected a Granola connect link");
  }
  let location = "";
  handleAdaShortLink(
    { method: "GET", url: new URL(ask.ask.url).pathname } as IncomingMessage,
    {
      setHeader: (name: string, value: string) => {
        if (name === "location") {
          location = value;
        }
      },
      end: () => {},
    } as unknown as ServerResponse,
    "gr",
    params.now,
  );
  const back = params.mock.signIn(location, params.user);
  await handleAdaGranolaCallback(
    { method: "GET", url: `${back.pathname}${back.search}` } as IncomingMessage,
    { setHeader: () => {}, end: () => {} } as unknown as ServerResponse,
    {
      config,
      now: () => params.now,
      db: async () => params.db,
      fetchImpl: params.mock.fetch,
      log: { error: () => {} },
    },
  );
}
