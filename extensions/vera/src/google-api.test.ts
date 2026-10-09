import { describe, expect, it, vi } from "vitest";
import {
  exchangeAuthorizationCode,
  listInboxMessages,
  listUpcomingEvents,
  loadAccessToken,
  parseCalendarEvents,
  parseGmailMessage,
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
            "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
        });
      }
      return jsonResponse({ email: "lawyer@example.com" });
    });
    const result = await exchangeAuthorizationCode({
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: "test-client-secret-value",
      redirectUri: "https://gateway.example/vera/google/callback",
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
      },
    });
  });

  it("refuses a grant that omitted a refresh token or either read scope", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: "test-access-token",
        expires_in: 3600,
        scope:
          "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
      }),
    );
    expect(
      await exchangeAuthorizationCode({
        clientId: "test-client",
        clientSecret: "test-client-secret-value",
        redirectUri: "https://gateway.example/vera/google/callback",
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
        redirectUri: "https://gateway.example/vera/google/callback",
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
        },
        clientId: "test-client",
        clientSecret: "test-client-secret-value",
        now: NOW,
        fetchImpl,
      }),
    ).toEqual({ ok: false, reason: "reconnect" });
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
