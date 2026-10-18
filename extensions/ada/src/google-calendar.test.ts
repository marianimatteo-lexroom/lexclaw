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
  start: { dateTime: "2026-10-20T15:00:00+02:00", timeZone: "Europe/Rome" },
  end: { dateTime: "2026-10-20T16:00:00+02:00", timeZone: "Europe/Rome" },
};

const ANNA = { email: "anna@example.com", displayName: "Anna Bianchi", responseStatus: "accepted" };
const LUCA = { email: "luca@example.com", responseStatus: "needsAction", optional: true };

/** What Google holds for evt-1 before an update. */
function existing(overrides: Record<string, unknown> = {}) {
  return { ...SAVED, attendees: [ANNA, LUCA], ...overrides };
}

/** A Google that answers the GET of the event, then the write, and remembers both. */
function google(options: { event?: unknown; write?: () => Response } = {}) {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    if (method === "GET") {
      return json(options.event ?? existing());
    }
    return options.write?.() ?? json(SAVED);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const CREATE: CalendarEventArgs = {
  title: "Udienza Rossi",
  start: "2026-10-20T15:00:00",
  end: "2026-10-20T16:00:00",
  confirmed: true,
};

function run(
  args: CalendarEventArgs,
  options: {
    account?: GoogleAccountRecord | null;
    fetchImpl?: typeof fetch;
    profileTimeZone?: string;
  } = {},
) {
  const store = storeWith(options.account === undefined ? account(WRITE_SCOPES) : options.account);
  const fetchImpl = options.fetchImpl ?? google().fetchImpl;
  return {
    store,
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    result: changeConnectedCalendarEvent({
      config: CONFIG,
      store,
      args,
      fetchImpl,
      profileTimeZone: options.profileTimeZone,
    }),
  };
}

describe("creating a calendar event", () => {
  it("posts the event to the primary calendar once confirmed, inviting the guests", async () => {
    const g = google();
    const { result } = run(
      {
        ...CREATE,
        timeZone: "Europe/London",
        description: "Prima udienza",
        location: "Tribunale di Milano",
        attendees: ["paolo@example.com", "PAOLO@example.com"],
      },
      { fetchImpl: g.fetchImpl },
    );
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
    expect(g.calls).toEqual([
      {
        method: "POST",
        url: `${EVENTS_URL}?sendUpdates=all`,
        body: {
          summary: "Udienza Rossi",
          description: "Prima udienza",
          location: "Tribunale di Milano",
          start: { dateTime: "2026-10-20T15:00:00", timeZone: "Europe/London" },
          end: { dateTime: "2026-10-20T16:00:00", timeZone: "Europe/London" },
          attendees: [{ email: "paolo@example.com" }],
        },
      },
    ]);
  });

  it("uses the person's profile time zone, and Europe/Rome without one, and invites nobody", async () => {
    for (const [profileTimeZone, zone] of [
      ["America/New_York", "America/New_York"],
      [undefined, "Europe/Rome"],
    ] as const) {
      const g = google();
      expect(await run(CREATE, { fetchImpl: g.fetchImpl, profileTimeZone }).result).toMatchObject({
        ok: true,
      });
      expect(g.calls[0]?.url).toBe(`${EVENTS_URL}?sendUpdates=none`);
      expect(g.calls[0]?.body).toMatchObject({
        start: { dateTime: "2026-10-20T15:00:00", timeZone: zone },
        end: { dateTime: "2026-10-20T16:00:00", timeZone: zone },
      });
    }
  });

  it("completes times given without seconds", async () => {
    const g = google();
    await run(
      { ...CREATE, start: "2026-10-20T15:00", end: "2026-10-20T16:30+02:00" },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(g.calls[0]?.body).toMatchObject({
      start: { dateTime: "2026-10-20T15:00:00" },
      end: { dateTime: "2026-10-20T16:30:00+02:00" },
    });
  });

  it.each([false, undefined, null, 0, "", "true", 1])(
    "does nothing, not even read the account, when confirmed is %j",
    async (confirmed) => {
      const g = google();
      const { result, store } = run(
        { ...CREATE, confirmed: confirmed as unknown as boolean },
        { fetchImpl: g.fetchImpl },
      );
      expect(await result).toMatchObject({ ok: false, reason: "confirmation_required" });
      expect(store.readAccount).not.toHaveBeenCalled();
      expect(g.calls).toEqual([]);
    },
  );

  it.each([
    ["a missing title", { title: undefined }],
    ["a multi-line title", { title: "Udienza\nRossi" }],
    ["a missing end", { end: undefined }],
    ["an end before the start", { end: "2026-10-20T14:00:00" }],
    ["a start that is not a date-time", { start: "domani alle 15" }],
    ["an impossible date", { start: "2026-13-45T10:00:00" }],
    ["an unknown time zone", { timeZone: "Mars/Olympus" }],
    ["an invalid guest", { attendees: ["not-an-email"] }],
  ])("rejects %s even when confirmed", async (_label, override) => {
    const g = google();
    expect(await run({ ...CREATE, ...override }, { fetchImpl: g.fetchImpl }).result).toMatchObject({
      ok: false,
    });
    expect(g.calls).toEqual([]);
  });
});

describe("updating a calendar event", () => {
  it("patches only the fields that change, and leaves the guests out of it", async () => {
    const g = google();
    const result = await run(
      { eventId: "evt/1", location: "Aula 5", confirmed: true },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(g.calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${EVENTS_URL}/evt%2F1`],
      ["PATCH", `${EVENTS_URL}/evt%2F1?sendUpdates=none`],
    ]);
    expect(g.calls[1]?.body).toEqual({ location: "Aula 5" });
    expect(result).toMatchObject({ ok: true, guestsNotified: false });
  });

  it("keeps every existing guest and adds the new one", async () => {
    const g = google();
    const result = await run(
      { eventId: "evt-1", addAttendees: ["paolo@example.com"], confirmed: true },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(g.calls[1]?.url).toBe(`${EVENTS_URL}/evt-1?sendUpdates=all`);
    expect(g.calls[1]?.body).toEqual({
      attendees: [ANNA, LUCA, { email: "paolo@example.com" }],
    });
    expect(result).toMatchObject({ ok: true, guestsNotified: true });
    expect(result).not.toHaveProperty("notice");
  });

  it("does not duplicate a guest who is already invited, whatever the case", async () => {
    const g = google();
    await run(
      {
        eventId: "evt-1",
        addAttendees: ["ANNA@example.com", "paolo@example.com", "Paolo@example.com"],
        confirmed: true,
      },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(g.calls[1]?.body).toEqual({ attendees: [ANNA, LUCA, { email: "paolo@example.com" }] });
  });

  it("has no way to remove anyone: an empty or repeated list changes nothing", async () => {
    const g = google();
    const none = await run(
      { eventId: "evt-1", addAttendees: [], confirmed: true },
      { fetchImpl: g.fetchImpl },
    ).result;
    const same = await run(
      { eventId: "evt-1", addAttendees: [ANNA.email], confirmed: true },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(none).toMatchObject({ ok: false });
    expect(same).toMatchObject({ ok: false });
    expect(g.calls.filter((call) => call.method !== "GET")).toEqual([]);

    for (const attendees of [[], [LUCA.email], ["paolo@example.com"]]) {
      const written = google();
      await run(
        { eventId: "evt-1", title: "Nuovo", addAttendees: attendees, confirmed: true },
        { fetchImpl: written.fetchImpl },
      ).result;
      const sent = (written.calls[1]?.body?.attendees ?? [ANNA, LUCA]) as Array<{ email: string }>;
      expect(sent.map((guest) => guest.email)).toEqual(
        expect.arrayContaining([ANNA.email, LUCA.email]),
      );
    }
  });

  it("does not take a guest list under the create name as a way to replace the guests", async () => {
    const g = google();
    await run(
      { eventId: "evt-1", title: "Nuovo", attendees: ["x@example.com"], confirmed: true },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(g.calls[1]?.body).toEqual({ summary: "Nuovo" });
  });

  it("says the guests were not told when an event with guests is moved", async () => {
    const g = google();
    const result = await run(
      { eventId: "evt-1", start: "2026-10-21T09:00", end: "2026-10-21T10:00", confirmed: true },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(g.calls[1]?.url).toBe(`${EVENTS_URL}/evt-1?sendUpdates=none`);
    expect(result).toMatchObject({
      ok: true,
      guestsNotified: false,
      notice: expect.stringContaining("The 2 guests already on this event were not notified"),
    });
  });

  it("has nothing to say about guests when the event has none", async () => {
    const g = google({ event: existing({ attendees: undefined }) });
    const result = await run(
      { eventId: "evt-1", title: "Nuovo", confirmed: true },
      { fetchImpl: g.fetchImpl },
    ).result;
    expect(result).not.toHaveProperty("guestsNotified");
    expect(result).not.toHaveProperty("notice");
  });

  it("keeps the event's own time zone when moving it without naming one", async () => {
    const g = google({
      event: existing({
        start: { dateTime: "2026-10-20T15:00:00+01:00", timeZone: "Europe/London" },
      }),
    });
    await run(
      {
        eventId: "evt-1",
        start: "2026-10-21T09:00:00",
        end: "2026-10-21T10:00:00",
        confirmed: true,
      },
      { fetchImpl: g.fetchImpl, profileTimeZone: "America/New_York" },
    ).result;
    expect(g.calls[1]?.body).toEqual({
      start: { dateTime: "2026-10-21T09:00:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-10-21T10:00:00", timeZone: "Europe/London" },
    });
  });

  it("uses a time zone the person names, then the profile when the event has none", async () => {
    const named = google();
    await run(
      {
        eventId: "evt-1",
        start: "2026-10-21T09:00:00",
        end: "2026-10-21T10:00:00",
        timeZone: "Europe/Paris",
        confirmed: true,
      },
      { fetchImpl: named.fetchImpl },
    ).result;
    expect(named.calls[1]?.body).toMatchObject({ start: { timeZone: "Europe/Paris" } });

    const bare = google({ event: existing({ start: { dateTime: "2026-10-20T15:00:00+02:00" } }) });
    await run(
      {
        eventId: "evt-1",
        start: "2026-10-21T09:00:00",
        end: "2026-10-21T10:00:00",
        confirmed: true,
      },
      { fetchImpl: bare.fetchImpl, profileTimeZone: "America/New_York" },
    ).result;
    expect(bare.calls[1]?.body).toMatchObject({ start: { timeZone: "America/New_York" } });
  });

  it("does nothing until confirmed, without even reading the event", async () => {
    const g = google();
    const { result, store } = run(
      { eventId: "evt-1", title: "Nuovo", confirmed: false },
      { fetchImpl: g.fetchImpl },
    );
    expect(await result).toMatchObject({ ok: false, reason: "confirmation_required" });
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(g.calls).toEqual([]);
  });

  it.each([
    ["no change at all", { eventId: "evt-1" }],
    ["a start without an end", { eventId: "evt-1", start: "2026-10-21T09:00:00" }],
    ["a blank event id", { eventId: "  ", title: "Nuovo" }],
  ])("rejects %s", async (_label, args) => {
    const g = google();
    expect(
      await run({ ...args, confirmed: true }, { fetchImpl: g.fetchImpl }).result,
    ).toMatchObject({ ok: false });
    expect(g.calls).toEqual([]);
  });

  it("says so when the event does not exist or was cancelled", async () => {
    const missing = vi.fn(async () => json({ error: { code: 404 } }, 404));
    expect(
      await run(
        { eventId: "gone", title: "Nuovo", confirmed: true },
        { fetchImpl: missing as unknown as typeof fetch },
      ).result,
    ).toEqual({ ok: false, error: "Ada could not find that event in the calendar." });
    const cancelled = google({ event: existing({ status: "cancelled" }) });
    expect(
      await run(
        { eventId: "evt-1", title: "Nuovo", confirmed: true },
        { fetchImpl: cancelled.fetchImpl },
      ).result,
    ).toEqual({ ok: false, error: "Ada could not find that event in the calendar." });
    expect(cancelled.calls.map((call) => call.method)).toEqual(["GET"]);
  });
});

describe("a connection without permission to edit the calendar", () => {
  it.each([
    ["only the old read-only calendar scope", READ_ONLY_SCOPES],
    ["no recorded scopes", null],
  ])("is not asked to write, with %s", async (_label, scopes) => {
    const g = google();
    const { result, store } = run(CREATE, { account: account(scopes), fetchImpl: g.fetchImpl });
    expect(await result).toMatchObject({
      ok: false,
      reason: "needs_calendar_scope",
      error: expect.stringContaining("fresh Google permission"),
    });
    expect(g.calls).toEqual([]);
    expect(store.clearAccountIfStill).not.toHaveBeenCalled();
  });

  it("is sent to reconnect when Google says the token's scopes are insufficient", async () => {
    const g = google({
      write: () =>
        json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              errors: [{ reason: "insufficientPermissions" }],
              status: "PERMISSION_DENIED",
              details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
            },
          },
          403,
        ),
    });
    const { result, store } = run(CREATE, { fetchImpl: g.fetchImpl });
    expect(await result).toMatchObject({ ok: false, reason: "needs_calendar_scope" });
    expect(store.clearAccountIfStill).not.toHaveBeenCalled();
  });

  it("gives a plain no-write-access error, not a reconnect offer, for a calendar it cannot write", async () => {
    const g = google({
      write: () =>
        json(
          {
            error: {
              code: 403,
              message: "The caller does not have permission",
              errors: [{ reason: "insufficientPermissions" }],
            },
          },
          403,
        ),
    });
    const { result, store } = run(CREATE, { fetchImpl: g.fetchImpl });
    const failed = await result;
    expect(failed).toMatchObject({
      ok: false,
      error: expect.stringContaining("no write access to that calendar"),
    });
    expect(failed).not.toHaveProperty("reason");
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
    const g = google({ write: () => json({ error: { code: 401 } }, 401) });
    const { result, store } = run(CREATE, { fetchImpl: g.fetchImpl });
    expect(await result).toMatchObject({ ok: false, reason: "not_connected" });
    expect(store.clearAccountIfStill).toHaveBeenCalledTimes(1);
  });

  it("does not treat a rate limit as a permission problem", async () => {
    const g = google({
      write: () => json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403),
    });
    expect(await run(CREATE, { fetchImpl: g.fetchImpl }).result).toEqual({
      ok: false,
      error: "Ada could not create the event. Try again shortly.",
    });
  });

  it("reports a network failure without claiming success", async () => {
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await run(CREATE, { fetchImpl: offline as unknown as typeof fetch }).result).toEqual({
      ok: false,
      error: "Ada could not create the event. Try again shortly.",
    });
  });

  it("is not connected without an account", async () => {
    const g = google();
    const { result } = run(CREATE, { account: null, fetchImpl: g.fetchImpl });
    expect(await result).toMatchObject({ ok: false, reason: "not_connected" });
    expect(g.calls).toEqual([]);
  });
});
