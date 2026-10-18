import { describe, expect, it, vi } from "vitest";
import type { GoogleAccountRecord, GoogleAccountStore } from "./google-account-contract.js";
import { changeConnectedCalendarEvent, type CalendarEventArgs } from "./google-tools.js";

const CONFIG = {
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const WRITE_SCOPES =
  "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
const READ_ONLY_SCOPES =
  "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly";

function account(scopes: string | null): GoogleAccountRecord {
  return {
    email: "lawyer@example.com",
    refreshToken: "test-refresh-token",
    accessToken: "test-access-token",
    accessExpiresAtMs: Date.now() + 3_600_000,
    connectedAtMs: 1,
    scopes,
  };
}

function storeWith(record: GoogleAccountRecord | null) {
  const store = {
    replacePending: vi.fn(async () => {}),
    consumePending: vi.fn(async () => false),
    upsertAccount: vi.fn(async () => {}),
    readAccount: vi.fn(async () => record),
    clearAccount: vi.fn(async () => {}),
    updateTokensIfStill: vi.fn(async () => true),
    clearAccountIfStill: vi.fn(async () => true),
  } satisfies GoogleAccountStore;
  return store;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAVED = {
  id: "evt-1",
  status: "confirmed",
  summary: "Udienza Rossi",
  start: { dateTime: "2026-10-20T15:00:00+02:00" },
  end: { dateTime: "2026-10-20T16:00:00+02:00" },
};

const CREATE: CalendarEventArgs = {
  title: "Udienza Rossi",
  start: "2026-10-20T15:00:00",
  end: "2026-10-20T16:00:00",
  confirmed: true,
};

function run(
  args: CalendarEventArgs,
  options: { account?: GoogleAccountRecord | null; fetchImpl?: typeof fetch } = {},
) {
  const store = storeWith(options.account === undefined ? account(WRITE_SCOPES) : options.account);
  const fetchImpl = options.fetchImpl ?? vi.fn(async () => json(SAVED));
  return {
    store,
    fetchImpl: fetchImpl as ReturnType<typeof vi.fn>,
    result: changeConnectedCalendarEvent({ config: CONFIG, store, args, fetchImpl }),
  };
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

describe("creating a calendar event", () => {
  it("posts the event to the primary calendar once confirmed", async () => {
    const { result, fetchImpl } = run({
      ...CREATE,
      timeZone: "Europe/Rome",
      description: "Prima udienza",
      location: "Tribunale di Milano",
      attendees: ["paolo@example.com"],
    });
    expect(await result).toEqual({
      ok: true,
      email: "lawyer@example.com",
      event: {
        id: "evt-1",
        summary: "Udienza Rossi",
        start: "2026-10-20T15:00:00+02:00",
        end: "2026-10-20T16:00:00+02:00",
        status: "confirmed",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${EVENTS_URL}?sendUpdates=all`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-access-token");
    expect(sentBody(fetchImpl)).toEqual({
      summary: "Udienza Rossi",
      description: "Prima udienza",
      location: "Tribunale di Milano",
      start: { dateTime: "2026-10-20T15:00:00", timeZone: "Europe/Rome" },
      end: { dateTime: "2026-10-20T16:00:00", timeZone: "Europe/Rome" },
      attendees: [{ email: "paolo@example.com" }],
    });
  });

  it("defaults the time zone to Europe/Rome and invites nobody without attendees", async () => {
    const { result, fetchImpl } = run(CREATE);
    expect(await result).toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(EVENTS_URL);
    expect(sentBody(fetchImpl)).toEqual({
      summary: "Udienza Rossi",
      start: { dateTime: "2026-10-20T15:00:00", timeZone: "Europe/Rome" },
      end: { dateTime: "2026-10-20T16:00:00", timeZone: "Europe/Rome" },
    });
  });

  it.each([false, undefined, null, 0, ""])(
    "does nothing, not even read the account, when confirmed is %j",
    async (confirmed) => {
      const { result, store, fetchImpl } = run({
        ...CREATE,
        confirmed: confirmed as unknown as boolean,
      });
      expect(await result).toMatchObject({ ok: false, reason: "confirmation_required" });
      expect(store.readAccount).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a missing title", { title: undefined }],
    ["a multi-line title", { title: "Udienza\nRossi" }],
    ["a missing end", { end: undefined }],
    ["an end before the start", { end: "2026-10-20T14:00:00" }],
    ["a start that is not a date-time", { start: "domani alle 15" }],
    ["an unknown time zone", { timeZone: "Mars/Olympus" }],
    ["an invalid attendee", { attendees: ["not-an-email"] }],
  ])("rejects %s even when confirmed", async (_label, override) => {
    const { result, fetchImpl } = run({ ...CREATE, ...override });
    expect(await result).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("updating a calendar event", () => {
  it("patches only the fields that change", async () => {
    const { result, fetchImpl } = run({ eventId: "evt/1", location: "Aula 5", confirmed: true });
    expect(await result).toMatchObject({ ok: true, event: { id: "evt-1" } });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${EVENTS_URL}/evt%2F1`);
    expect(init?.method).toBe("PATCH");
    expect(sentBody(fetchImpl)).toEqual({ location: "Aula 5" });
  });

  it("moves an event by its start and end together", async () => {
    const { result, fetchImpl } = run({
      eventId: "evt-1",
      start: "2026-10-21T09:00:00",
      end: "2026-10-21T10:00:00",
      timeZone: "Europe/London",
      confirmed: true,
    });
    expect(await result).toMatchObject({ ok: true });
    expect(sentBody(fetchImpl)).toEqual({
      start: { dateTime: "2026-10-21T09:00:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-10-21T10:00:00", timeZone: "Europe/London" },
    });
  });

  it("does nothing until confirmed", async () => {
    const { result, store, fetchImpl } = run({
      eventId: "evt-1",
      title: "Nuovo",
      confirmed: false,
    });
    expect(await result).toMatchObject({ ok: false, reason: "confirmation_required" });
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["no change at all", { eventId: "evt-1" }],
    ["a start without an end", { eventId: "evt-1", start: "2026-10-21T09:00:00" }],
    ["a blank event id", { eventId: "  ", title: "Nuovo" }],
  ])("rejects %s", async (_label, args) => {
    const { result, fetchImpl } = run({ ...args, confirmed: true });
    expect(await result).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says so when the event does not exist", async () => {
    const { result } = run(
      { eventId: "gone", title: "Nuovo", confirmed: true },
      { fetchImpl: vi.fn(async () => json({ error: { code: 404 } }, 404)) },
    );
    expect(await result).toEqual({
      ok: false,
      error: "Ada could not find that event in the calendar.",
    });
  });
});

describe("a connection without permission to edit the calendar", () => {
  it.each([
    ["only the old read-only calendar scope", READ_ONLY_SCOPES],
    ["no recorded scopes", null],
  ])("is not asked to write, with %s", async (_label, scopes) => {
    const { result, store, fetchImpl } = run(CREATE, { account: account(scopes) });
    expect(await result).toMatchObject({
      ok: false,
      reason: "needs_calendar_scope",
      error: expect.stringContaining("fresh Google permission"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.clearAccountIfStill).not.toHaveBeenCalled();
  });

  it("is sent to reconnect when Google answers with insufficient scope", async () => {
    const { result, store } = run(CREATE, {
      account: account(WRITE_SCOPES),
      fetchImpl: vi.fn(async () =>
        json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
              details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
            },
          },
          403,
        ),
      ),
    });
    expect(await result).toMatchObject({ ok: false, reason: "needs_calendar_scope" });
    expect(store.clearAccountIfStill).not.toHaveBeenCalled();
  });

  it("keeps the saved connection, and the refresh token, for later reads", async () => {
    const { result, store } = run(CREATE, { account: account(READ_ONLY_SCOPES) });
    await result;
    expect(store.clearAccount).not.toHaveBeenCalled();
    expect(store.clearAccountIfStill).not.toHaveBeenCalled();
    expect(store.upsertAccount).not.toHaveBeenCalled();
  });
});

describe("other Google failures", () => {
  it("asks to reconnect, and drops the saved account, on a 401", async () => {
    const { result, store } = run(CREATE, {
      fetchImpl: vi.fn(async () => json({ error: { code: 401 } }, 401)),
    });
    expect(await result).toMatchObject({ ok: false, reason: "not_connected" });
    expect(store.clearAccountIfStill).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unrelated 403 as a missing permission", async () => {
    const { result } = run(CREATE, {
      fetchImpl: vi.fn(async () =>
        json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403),
      ),
    });
    expect(await result).toEqual({
      ok: false,
      error: "Ada could not create the event. Try again shortly.",
    });
  });

  it("reports a network failure without claiming success", async () => {
    const { result } = run(CREATE, {
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    expect(await result).toEqual({
      ok: false,
      error: "Ada could not create the event. Try again shortly.",
    });
  });

  it("is not connected without an account", async () => {
    const { result, fetchImpl } = run(CREATE, { account: null });
    expect(await result).toMatchObject({ ok: false, reason: "not_connected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
