import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRawGmailMessage,
  exchangeAuthorizationCode,
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
  parseCalendarEvents,
  parseGmailMessage,
  sendGmailMessage,
  watchGmailInbox,
} from "./google-api.js";

const NOW = new Date("2026-10-09T07:40:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("google parsers", () => {
  it("reads gmail metadata and skips cancelled calendar events", () => {
    expect(
      parseGmailMessage({
        id: "msg-1",
        snippet: "Please confirm the hearing",
        payload: {
          headers: [
            { name: "From", value: "Counsel <counsel@example.com>" },
            { name: "Subject", value: "Hearing" },
            { name: "Date", value: "Fri, 9 Oct 2026 08:00:00 +0200" },
          ],
        },
      }),
    ).toEqual({
      id: "msg-1",
      from: "Counsel <counsel@example.com>",
      subject: "Hearing",
      date: "Fri, 9 Oct 2026 08:00:00 +0200",
      snippet: "Please confirm the hearing",
    });
    expect(
      parseCalendarEvents({
        items: [
          { id: "gone", status: "cancelled", start: { dateTime: "2026-10-09T09:00:00.000Z" } },
          {
            id: "hearing",
            status: "confirmed",
            summary: "Rossi hearing",
            start: { dateTime: "2026-10-09T09:00:00.000Z" },
            end: { dateTime: "2026-10-09T10:00:00.000Z" },
          },
        ],
      }),
    ).toEqual([
      {
        id: "hearing",
        summary: "Rossi hearing",
        start: "2026-10-09T09:00:00.000Z",
        end: "2026-10-09T10:00:00.000Z",
        status: "confirmed",
      },
    ]);
  });
});

describe("google oauth", () => {
  it("exchanges a code for a refresh token and the account email", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          scope:
            "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
        });
      }
      return jsonResponse({ email: "lawyer@example.com" });
    });
    const result = await exchangeAuthorizationCode({
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: "test-client-secret-value",
      redirectUri: "https://gateway.example/ada/google/callback",
      code: "test-auth-code",
      now: NOW,
      fetchImpl,
    });
    expect(result).toEqual({
      ok: true,
      token: {
        email: "lawyer@example.com",
        refreshToken: "test-refresh-token",
        accessToken: "test-access-token",
        accessExpiresAtMs: NOW.getTime() + 3_600_000,
        scopes:
          "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
      },
    });
  });

  it("refuses a grant that omitted a refresh token or either read scope", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: "test-access-token",
        expires_in: 3600,
        scope:
          "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
      }),
    );
    expect(
      await exchangeAuthorizationCode({
        clientId: "test-client",
        clientSecret: "test-client-secret-value",
        redirectUri: "https://gateway.example/ada/google/callback",
        code: "test-auth-code",
        now: NOW,
        fetchImpl,
      }),
    ).toEqual({ ok: false, reason: "no_refresh_token" });

    fetchImpl.mockImplementation(async () =>
      jsonResponse({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      }),
    );
    expect(
      await exchangeAuthorizationCode({
        clientId: "test-client",
        clientSecret: "test-client-secret-value",
        redirectUri: "https://gateway.example/ada/google/callback",
        code: "test-auth-code",
        now: NOW,
        fetchImpl,
      }),
    ).toEqual({ ok: false, reason: "denied_scopes" });
  });

  it("asks for a new link when Google invalidates the refresh token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400));
    expect(
      await loadAccessToken({
        account: {
          email: "lawyer@example.com",
          refreshToken: "test-refresh-token",
          accessToken: null,
          accessExpiresAtMs: null,
          connectedAtMs: 1,
          scopes: null,
        },
        clientId: "test-client",
        clientSecret: "test-client-secret-value",
        now: NOW,
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, reason: "reconnect" });
  });

  const staleAccount = {
    email: "lawyer@example.com",
    refreshToken: "test-refresh-token",
    accessToken: null,
    accessExpiresAtMs: null,
    connectedAtMs: 1,
    scopes: null,
  };
  const refresh = (fetchImpl: ReturnType<typeof vi.fn>, log?: (message: string) => void) =>
    loadAccessToken({
      account: staleAccount,
      clientId: "test-client",
      clientSecret: "test-client-secret-value",
      now: NOW,
      fetchImpl: fetchImpl as never,
      log,
    });

  it("logs Google's own error and description, one clipped line, never the tokens", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: "invalid_grant", error_description: "Token has been expired\nor revoked." },
        400,
      ),
    );
    expect(await refresh(fetchImpl, log)).toEqual({
      ok: false,
      reason: "reconnect",
      googleError: "invalid_grant",
      description: "Token has been expired or revoked.",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'ada google token refresh failed reason=reconnect google_error=invalid_grant description="Token has been expired or revoked."',
    );
    expect(log.mock.calls[0]?.[0]).not.toContain("test-refresh-token");

    const long = vi.fn(async () =>
      jsonResponse({ error: "invalid_request", error_description: "x".repeat(500) }, 400),
    );
    const result = await refresh(long);
    expect(result.ok === false && result.description?.length).toBe(200);
  });

  it("fails without a description when Google gives none", async () => {
    const log = vi.fn();
    expect(
      await refresh(
        vi.fn(async () => jsonResponse({}, 500)),
        log,
      ),
    ).toEqual({
      ok: false,
      reason: "google_error",
    });
    expect(log).toHaveBeenCalledWith("ada google token refresh failed reason=google_error");
  });

  it("returns a refresh token Google rotated, and ignores one that is not usable", async () => {
    const rotated = vi.fn(async () =>
      jsonResponse({
        access_token: "new-access",
        expires_in: 3600,
        refresh_token: "rotated-refresh",
      }),
    );
    expect(await refresh(rotated)).toEqual({
      ok: true,
      accessToken: "new-access",
      accessExpiresAtMs: NOW.getTime() + 3_600_000,
      refreshToken: "rotated-refresh",
    });
    for (const refresh_token of ["short", 42, ""]) {
      const plain = vi.fn(async () =>
        jsonResponse({ access_token: "new-access", expires_in: 3600, refresh_token }),
      );
      expect(await refresh(plain)).not.toHaveProperty("refreshToken");
    }
  });
});

describe("google reads", () => {
  it("lists inbox metadata and upcoming events", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/messages?")) {
        return jsonResponse({ messages: [{ id: "msg-1" }] });
      }
      if (url.includes("/messages/msg-1")) {
        return jsonResponse({
          id: "msg-1",
          snippet: "Reply needed",
          payload: { headers: [{ name: "Subject", value: "Contract" }] },
        });
      }
      return jsonResponse({
        items: [
          {
            id: "evt-1",
            summary: "Hearing",
            status: "confirmed",
            start: { dateTime: "2026-10-09T09:00:00.000Z" },
            end: { dateTime: "2026-10-09T10:00:00.000Z" },
          },
        ],
      });
    });
    expect(
      await listInboxMessages({ accessToken: "test-access-token", max: 8, fetchImpl }),
    ).toEqual({
      ok: true,
      messages: [{ id: "msg-1", from: "", subject: "Contract", date: "", snippet: "Reply needed" }],
    });
    expect(
      await listUpcomingEvents({
        accessToken: "test-access-token",
        now: NOW,
        hours: 48,
        fetchImpl,
      }),
    ).toMatchObject({ ok: true, events: [{ id: "evt-1", summary: "Hearing" }] });
  });
});

describe("gmail watch", () => {
  it("registers a Pub/Sub topic and rejects a bad topic name", async () => {
    expect(
      await watchGmailInbox({
        accessToken: "test-access-token",
        topicName: "not-a-topic",
      }),
    ).toEqual({ ok: false, status: 400 });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("projects/p/topics/t");
      return jsonResponse({ expiration: "1760000000000" });
    });
    expect(
      await watchGmailInbox({
        accessToken: "test-access-token",
        topicName: "projects/p/topics/t",
        fetchImpl,
      }),
    ).toEqual({ ok: true, expirationMs: 1_760_000_000_000 });
  });
});

describe("gmail send", () => {
  it("sends one plain-text message and keeps the body out of the URL", async () => {
    const raw = buildRawGmailMessage({
      from: "lawyer@example.com",
      to: "paolo@example.com",
      subject: "Più respiro",
      text: "Ciao Paolo,\nperfetto.",
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: paolo@example.com");
    expect(decoded).toContain("Ciao Paolo,");
    expect(decoded).toContain("=?UTF-8?B?");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain(raw);
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "sent-1" });
    });
    expect(
      await sendGmailMessage({
        accessToken: "test-access-token",
        from: "lawyer@example.com",
        to: "paolo@example.com",
        subject: "Più respiro",
        text: "Ciao Paolo,\nperfetto.",
        fetchImpl,
      }),
    ).toEqual({ ok: true, id: "sent-1" });
  });
});

describe("google request timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on a native timer that fake timers cannot advance.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** A fetch that never answers but does honor the abort signal, like the real one. */
  function silentFetch() {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, signals };
  }

  it("still ends a send after 20 seconds when the caller brings its own signal", async () => {
    const { fetchImpl, signals } = silentFetch();
    const caller = new AbortController();
    const pending = sendGmailMessage({
      accessToken: "token",
      from: "a@example.com",
      to: "b@example.com",
      subject: "Hi",
      text: "Body",
      fetchImpl,
      signal: caller.signal,
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, status: 0 });
    expect(signals[0]?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("ends a read, a watch and a token exchange the same way", async () => {
    for (const call of [
      (fetchImpl: typeof fetch, signal: AbortSignal) =>
        listInboxMessages({ accessToken: "token", max: 3, fetchImpl, signal }),
      (fetchImpl: typeof fetch, signal: AbortSignal) =>
        watchGmailInbox({
          accessToken: "token",
          topicName: "projects/p/topics/t",
          fetchImpl,
          signal,
        }),
    ]) {
      const { fetchImpl } = silentFetch();
      const pending = call(fetchImpl, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toMatchObject({ ok: false });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the caller cancel sooner", async () => {
    const { fetchImpl, signals } = silentFetch();
    const caller = new AbortController();
    const pending = sendGmailMessage({
      accessToken: "token",
      from: "a@example.com",
      to: "b@example.com",
      subject: "Hi",
      text: "Body",
      fetchImpl,
      signal: caller.signal,
    });
    caller.abort();
    await expect(pending).resolves.toEqual({ ok: false, status: 0 });
    expect(signals[0]?.aborted).toBe(true);
  });
});
