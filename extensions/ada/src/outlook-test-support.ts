import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { SqliteWorkerCommand } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { vi } from "vitest";
import type { AdaOutlookOperations, OutlookAccountDb } from "./outlook-account-contract.js";
import { wrapOutlookWorker } from "./outlook-account.js";
import { createSqliteWorkerBackend } from "./outlook-account.worker.js";
import { handleAdaOutlookCallback } from "./outlook-callback.js";
import {
  clearAdminConsentHolds,
  outlookConnectConfigFrom,
  prepareOutlookConnect,
} from "./outlook-connect.js";
import { OUTLOOK_SCOPES } from "./outlook-oauth.js";
import { handleAdaShortLink } from "./short-links-http.js";

export const ANNA = "393331111111";
export const BRUNO = "393332222222";

export const OUTLOOK_PLUGIN_CONFIG = {
  googleRedirectUri: "https://vera.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

export const OUTLOOK_ENV = {
  ADA_MS_CLIENT_ID: "app-client-id",
  ADA_MS_CLIENT_SECRET: "app-client-secret",
} as NodeJS.ProcessEnv;

export const REDIRECT_URI = "https://vera.example/ada/outlook/callback";

/** A real SQLite store, through the same worker code production uses. */
export function openOutlookTestDb(dir: string): {
  db: OutlookAccountDb;
  dir: string;
  close: () => void;
} {
  const backend = createSqliteWorkerBackend(undefined, {
    databasePath: path.join(dir, "outlook-account.sqlite"),
  });
  return {
    db: wrapOutlookWorker({
      execute: async (command: SqliteWorkerCommand<AdaOutlookOperations>) =>
        backend.execute(command),
    } as never),
    dir,
    close: () => void backend.close(),
  };
}

export function testApi() {
  return {
    runtimeSource: "/fake/ada/index.ts",
    runtime: {} as never,
    config: {},
    pluginConfig: OUTLOOK_PLUGIN_CONFIG,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export type MockMail = {
  id: string;
  from: string;
  fromName?: string;
  subject: string;
  receivedAt: string;
  preview: string;
  body?: string;
  unread?: boolean;
  /** Defaults to `conv-<id>`: every message is its own conversation unless the test says so. */
  conversationId?: string;
};

export type MockEvent = {
  id: string;
  subject: string;
  /** UTC, as an ISO instant. */
  start: string;
  end: string;
  attendees?: string[];
  allDay?: boolean;
};

type Grant = { user: string; redirectUri: string; challenge: string };

function zoneOffsetMs(zone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    atMs
  );
}

/** Local wall-clock time in `zone` to a UTC instant, the way Graph reads a `dateTimeTimeZone`. */
function toUtcInstant(dateTime: string, zone: string): string {
  const naive = Date.parse(`${dateTime.replace(/\.\d+$/u, "")}Z`);
  return new Date(zone === "UTC" ? naive : naive - zoneOffsetMs(zone, naive)).toISOString();
}

/**
 * Stands in for the Microsoft identity platform and Microsoft Graph. The person who "signs in" is
 * named by `signIn(authorizeUrl, user)`; every token belongs to that user, and Graph only answers
 * with that user's own mailbox and calendar.
 */
export class MockMicrosoft {
  readonly requests: Array<{
    method: string;
    url: string;
    authorization?: string;
    body?: string;
    prefer?: string;
  }> = [];
  clockMs = Date.parse("2026-10-20T09:00:00.000Z");
  readonly mail = new Map<string, MockMail[]>();
  readonly events = new Map<string, MockEvent[]>();
  readonly sent: Array<{ user: string; to: string; subject: string; text: string }> = [];
  readonly drafts: Array<{ user: string; to: string; subject: string; text: string }> = [];
  readonly replies: Array<{ user: string; id: string; text: string; all: boolean }> = [];
  readonly written: Array<{ user: string; method: string; body: Record<string, unknown> }> = [];
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, { user: string; expiresAtMs: number }>();
  private readonly refreshTokens = new Map<string, string>();
  private nextId = 1;
  /** Scopes the token response reports; Microsoft lists what was granted. */
  grantedScope: string = OUTLOOK_SCOPES.join(" ");
  /** What the next refresh answers instead of success. */
  refreshFailure: "invalid_grant" | "server_error" | "invalid_client" | "admin_consent" | null =
    null;
  /** The code exchange fails as it does in a tenant that needs an administrator's approval. */
  exchangeFailure: "admin_consent" | null = null;
  /** The authorize step redirects back with this error instead of a code. */
  authorizeError: { error: string; description: string } | null = null;
  refreshes = 0;
  accessTtlSeconds = 3600;
  /** Graph answers 401 to the next call that carries a still-live token. */
  rejectNextGraphToken = false;
  /** Without `mail`, Graph returns only the user principal name. */
  mailAttribute = true;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : init?.body?.toString();
    this.requests.push({
      method,
      url,
      authorization: headers.get("authorization") ?? undefined,
      body,
      prefer: headers.get("prefer") ?? undefined,
    });
    const parsed = new URL(url);
    if (parsed.origin === "https://login.microsoftonline.com") {
      const match = /^\/([^/]+)\/oauth2\/v2\.0\/token$/u.exec(parsed.pathname);
      return match
        ? this.token(new URLSearchParams(body ?? ""))
        : new Response("no", { status: 404 });
    }
    if (parsed.origin === "https://graph.microsoft.com") {
      return this.graph(method, parsed, headers, body);
    }
    return new Response("not found", { status: 404 });
  };

  private token(form: URLSearchParams): Response {
    if (form.get("client_id") !== OUTLOOK_ENV.ADA_MS_CLIENT_ID) {
      return json({ error: "invalid_client" }, 401);
    }
    if (form.get("client_secret") !== OUTLOOK_ENV.ADA_MS_CLIENT_SECRET) {
      return json(
        { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret" },
        401,
      );
    }
    if (form.get("grant_type") === "authorization_code") {
      if (this.exchangeFailure === "admin_consent") {
        return json(
          {
            error: "invalid_grant",
            error_description:
              "AADSTS65001: The user or administrator has not consented to use the application.",
            error_codes: [65001],
            suberror: "consent_required",
          },
          400,
        );
      }
      const grant = this.grants.get(form.get("code") ?? "");
      this.grants.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (
        !grant ||
        grant.redirectUri !== form.get("redirect_uri") ||
        createHash("sha256").update(verifier).digest("base64url") !== grant.challenge
      ) {
        return json({ error: "invalid_grant", error_description: "AADSTS70000: bad grant" }, 400);
      }
      return this.issue(grant.user, true);
    }
    if (form.get("grant_type") === "refresh_token") {
      this.refreshes += 1;
      if (this.refreshFailure === "server_error") {
        return json({ error: "temporarily_unavailable" }, 503);
      }
      if (this.refreshFailure === "invalid_client") {
        return json(
          { error: "invalid_client", error_description: "AADSTS7000222: secret expired" },
          401,
        );
      }
      if (this.refreshFailure === "admin_consent") {
        return json(
          {
            error: "invalid_grant",
            error_description: "AADSTS65001: consent",
            error_codes: [65001],
          },
          400,
        );
      }
      const user = this.refreshTokens.get(form.get("refresh_token") ?? "");
      if (this.refreshFailure === "invalid_grant" || !user) {
        return json(
          {
            error: "invalid_grant",
            error_description: "AADSTS700082: The refresh token has expired",
          },
          400,
        );
      }
      // Microsoft rotates the refresh token: the one presented is spent.
      this.refreshTokens.delete(form.get("refresh_token") ?? "");
      return this.issue(user, false);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  private issue(user: string, withIdToken: boolean): Response {
    const accessToken = `at-${user}-${randomBytes(6).toString("hex")}`;
    const refreshToken = `rt-${user}-${randomBytes(6).toString("hex")}`;
    this.accessTokens.set(accessToken, {
      user,
      expiresAtMs: this.clockMs + this.accessTtlSeconds * 1000,
    });
    this.refreshTokens.set(refreshToken, user);
    const claims = Buffer.from(JSON.stringify({ email: `${user}@contoso.example` })).toString(
      "base64url",
    );
    return json({
      token_type: "Bearer",
      scope: this.grantedScope,
      expires_in: this.accessTtlSeconds,
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(withIdToken ? { id_token: `x.${claims}.y` } : {}),
    });
  }

  /** The browser step: the person signs in and Microsoft redirects back with a code. */
  signIn(authorizeUrl: string, user: string): URL {
    const url = new URL(authorizeUrl);
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const back = new URL(redirectUri);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    if (
      url.origin !== "https://login.microsoftonline.com" ||
      !url.pathname.endsWith("/oauth2/v2.0/authorize") ||
      url.searchParams.get("client_id") !== OUTLOOK_ENV.ADA_MS_CLIENT_ID ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      url.searchParams.get("response_type") !== "code"
    ) {
      throw new Error("Microsoft would show an error for this authorize request");
    }
    if (this.authorizeError) {
      back.searchParams.set("error", this.authorizeError.error);
      back.searchParams.set("error_description", this.authorizeError.description);
      return back;
    }
    const code = `code-${randomBytes(6).toString("hex")}`;
    this.grants.set(code, {
      user,
      redirectUri,
      challenge: url.searchParams.get("code_challenge") ?? "",
    });
    back.searchParams.set("code", code);
    return back;
  }

  private graph(method: string, url: URL, headers: Headers, body: string | undefined): Response {
    const token = /^Bearer (.+)$/u.exec(headers.get("authorization") ?? "")?.[1] ?? "";
    const session = this.accessTokens.get(token);
    if (!session || session.expiresAtMs <= this.clockMs || this.rejectNextGraphToken) {
      this.rejectNextGraphToken = false;
      return json({ error: { code: "InvalidAuthenticationToken", message: "expired" } }, 401);
    }
    const user = session.user;
    const route = url.pathname.replace(/^\/v1\.0/u, "");
    const mailbox = this.mail.get(user) ?? [];
    const message = (item: MockMail, full: boolean) => ({
      id: item.id,
      conversationId: item.conversationId ?? `conv-${item.id}`,
      parentFolderId: "folder-inbox",
      subject: item.subject,
      from: { emailAddress: { name: item.fromName ?? "", address: item.from } },
      receivedDateTime: item.receivedAt,
      bodyPreview: item.preview,
      isRead: item.unread !== true,
      ...(full
        ? {
            body: { contentType: "text", content: item.body ?? item.preview },
            toRecipients: [{ emailAddress: { address: `${user}@contoso.example` } }],
          }
        : {}),
    });
    if (route === "/me" && method === "GET") {
      return json({
        ...(this.mailAttribute ? { mail: `${user}@contoso.example` } : {}),
        userPrincipalName: `${user}@contoso.example`,
      });
    }
    if (route === "/me/mailFolders/inbox/messages" && method === "GET") {
      const top = Number(url.searchParams.get("$top") ?? 10);
      const sorted = mailbox.toSorted((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      return json({ value: sorted.slice(0, top).map((item) => message(item, false)) });
    }
    if (route === "/me/mailFolders/sentitems" && method === "GET") {
      return json({ id: "folder-sent" });
    }
    if (route === "/me/mailFolders/sentitems/messages" && method === "GET") {
      return json({
        value: this.sent
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.user === user)
          .toReversed()
          .map(({ item, index }) => ({
            id: `sent-${index}`,
            conversationId: `conv-sent-${index}`,
            subject: item.subject,
            toRecipients: [{ emailAddress: { address: item.to } }],
            sentDateTime: "2099-01-01T00:00:00Z",
          })),
      });
    }
    const conversation = /^conversationId eq '(.*)'$/u.exec(url.searchParams.get("$filter") ?? "");
    if (route === "/me/messages" && method === "GET" && conversation) {
      const wanted = (conversation[1] ?? "").replaceAll("''", "'");
      return json({
        value: [
          ...mailbox
            .filter((item) => (item.conversationId ?? `conv-${item.id}`) === wanted)
            .map((item) => message(item, false)),
          ...this.sent
            .map((item, index) => ({ item, index }))
            .filter(({ item, index }) => item.user === user && `conv-sent-${index}` === wanted)
            .map(({ item, index }) => ({
              id: `sent-${index}`,
              subject: item.subject,
              from: { emailAddress: { address: `${user}@contoso.example` } },
              sentDateTime: "2099-01-01T00:00:00Z",
              parentFolderId: "folder-sent",
              bodyPreview: item.text,
            })),
        ],
      });
    }
    if (route === "/me/messages" && method === "GET") {
      const search = (url.searchParams.get("$search") ?? "").replaceAll('"', "").toLowerCase();
      return json({
        value: mailbox
          .filter((item) => `${item.subject} ${item.preview}`.toLowerCase().includes(search))
          .map((item) => message(item, false)),
      });
    }
    if (route === "/me/messages" && method === "POST") {
      const draft = JSON.parse(body ?? "{}") as {
        subject: string;
        body: { content: string };
        toRecipients: Array<{ emailAddress: { address: string } }>;
      };
      this.drafts.push({
        user,
        to: draft.toRecipients[0]?.emailAddress.address ?? "",
        subject: draft.subject,
        text: draft.body.content,
      });
      return json({ id: `draft-${this.nextId++}` }, 201);
    }
    const single = /^\/me\/messages\/([^/]+)$/u.exec(route);
    if (single && method === "GET") {
      const found = mailbox.find((item) => item.id === decodeURIComponent(single[1] ?? ""));
      return found
        ? json(message(found, true))
        : json({ error: { code: "ErrorItemNotFound" } }, 404);
    }
    const reply = /^\/me\/messages\/([^/]+)\/(reply|replyAll)$/u.exec(route);
    if (reply && method === "POST") {
      const id = decodeURIComponent(reply[1] ?? "");
      if (!mailbox.some((item) => item.id === id)) {
        return json({ error: { code: "ErrorItemNotFound" } }, 404);
      }
      this.replies.push({
        user,
        id,
        text: (JSON.parse(body ?? "{}") as { comment: string }).comment,
        all: reply[2] === "replyAll",
      });
      return new Response(null, { status: 202 });
    }
    if (route === "/me/sendMail" && method === "POST") {
      const sent = (
        JSON.parse(body ?? "{}") as {
          message: {
            subject: string;
            body: { content: string };
            toRecipients: Array<{ emailAddress: { address: string } }>;
          };
        }
      ).message;
      this.sent.push({
        user,
        to: sent.toRecipients[0]?.emailAddress.address ?? "",
        subject: sent.subject,
        text: sent.body.content,
      });
      return new Response(null, { status: 202 });
    }
    if (route === "/me/calendarView" && method === "GET") {
      const from = Date.parse(url.searchParams.get("startDateTime") ?? "");
      const to = Date.parse(url.searchParams.get("endDateTime") ?? "");
      return json({
        value: (this.events.get(user) ?? [])
          .filter((event) => Date.parse(event.start) >= from && Date.parse(event.start) < to)
          .map((event) => this.eventShape(event)),
      });
    }
    if (route === "/me/events" && method === "POST") {
      const created: MockEvent = { id: `event-${this.nextId++}`, subject: "", start: "", end: "" };
      return this.writeEvent(user, "POST", created, body, true);
    }
    const eventMatch = /^\/me\/events\/([^/]+)$/u.exec(route);
    if (eventMatch) {
      const existing = (this.events.get(user) ?? []).find(
        (event) => event.id === decodeURIComponent(eventMatch[1] ?? ""),
      );
      if (!existing) {
        return json({ error: { code: "ErrorItemNotFound" } }, 404);
      }
      if (method === "GET") {
        return json(this.eventShape(existing));
      }
      if (method === "PATCH") {
        if (existing.attendees?.includes("organizer-only@example.com")) {
          return json({ error: { code: "ErrorAccessDenied" } }, 403);
        }
        return this.writeEvent(user, "PATCH", existing, body, false);
      }
    }
    return json({ error: { code: "BadRequest" } }, 400);
  }

  private eventShape(event: MockEvent) {
    const wall = (instant: string) =>
      `${instant.replace(/Z$/u, "").replace(/\.\d+$/u, "")}.0000000`;
    return {
      id: event.id,
      subject: event.subject,
      start: { dateTime: wall(event.start), timeZone: "UTC" },
      end: { dateTime: wall(event.end), timeZone: "UTC" },
      isAllDay: event.allDay === true,
      isCancelled: false,
      bodyPreview: "",
      originalStartTimeZone: "W. Europe Standard Time",
      attendees: (event.attendees ?? []).map((address) => ({
        emailAddress: { address },
        type: "required",
        status: { response: "none" },
      })),
    };
  }

  private writeEvent(
    user: string,
    method: string,
    event: MockEvent,
    body: string | undefined,
    create: boolean,
  ): Response {
    const input = JSON.parse(body ?? "{}") as Record<string, unknown>;
    this.written.push({ user, method, body: input });
    const zoned = (value: unknown) => {
      const slot = value as { dateTime: string; timeZone: string } | undefined;
      return slot ? toUtcInstant(slot.dateTime, slot.timeZone) : undefined;
    };
    if (typeof input.subject === "string") {
      event.subject = input.subject;
    }
    event.start = zoned(input.start) ?? event.start;
    event.end = zoned(input.end) ?? event.end;
    if (input.start) {
      event.allDay = false;
    }
    if (Array.isArray(input.attendees)) {
      event.attendees = (input.attendees as Array<{ emailAddress: { address: string } }>).map(
        (attendee) => attendee.emailAddress.address,
      );
    }
    if (create) {
      this.events.set(user, [...(this.events.get(user) ?? []), event]);
    }
    return json(this.eventShape(event), create ? 201 : 200);
  }
}

export function newMockMicrosoft(): MockMicrosoft {
  clearAdminConsentHolds();
  return new MockMicrosoft();
}

export type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export function fakeResponse(): { res: ServerResponse; out: CapturedResponse } {
  const out: CapturedResponse = { statusCode: 200, headers: {}, body: "" };
  const res = {
    get statusCode() {
      return out.statusCode;
    },
    set statusCode(value: number) {
      out.statusCode = value;
    },
    setHeader: (name: string, value: string) => {
      out.headers[name.toLowerCase()] = value;
    },
    end: (chunk?: string) => {
      out.body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, out };
}

/** Opens a connect link the way a browser does, and returns where it sends the person. */
export function openShortLink(url: string, now: Date): CapturedResponse {
  const { res, out } = fakeResponse();
  handleAdaShortLink(
    { method: "GET", url: new URL(url).pathname } as IncomingMessage,
    res,
    "o",
    now,
  );
  return out;
}

export function callbackDeps(params: {
  db: OutlookAccountDb;
  mock: MockMicrosoft;
  now: Date;
  notifyConnected?: (owner: string) => Promise<{ ok: true }>;
  notifyAdminConsent?: (owner: string) => Promise<{ ok: true }>;
}) {
  return {
    config: outlookConnectConfigFrom(OUTLOOK_PLUGIN_CONFIG),
    now: () => params.now,
    db: async () => params.db,
    env: OUTLOOK_ENV,
    fetchImpl: params.mock.fetch,
    log: { error: vi.fn() },
    notifyConnected: params.notifyConnected,
    notifyAdminConsent: params.notifyAdminConsent,
  };
}

export async function visitCallback(
  back: URL,
  deps: ReturnType<typeof callbackDeps>,
): Promise<CapturedResponse> {
  const { res, out } = fakeResponse();
  await handleAdaOutlookCallback(
    { method: "GET", url: `${back.pathname}${back.search}` } as IncomingMessage,
    res,
    deps,
  );
  return out;
}

/** Everything a person does to connect: the link, Microsoft's sign-in, and the redirect back. */
export async function signInThroughFlow(params: {
  mock: MockMicrosoft;
  db: OutlookAccountDb;
  owner: string;
  user: string;
  now: Date;
}): Promise<CapturedResponse> {
  const ask = await prepareOutlookConnect({
    owner: params.owner,
    config: outlookConnectConfigFrom(OUTLOOK_PLUGIN_CONFIG),
    db: params.db,
    now: params.now,
    force: true,
    env: OUTLOOK_ENV,
  });
  if (!ask.ok || ask.connected) {
    throw new Error("expected an Outlook connect link");
  }
  const redirect = openShortLink(ask.ask.url, params.now);
  const back = params.mock.signIn(redirect.headers.location ?? "", params.user);
  return visitCallback(back, callbackDeps(params));
}
