import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestDispatchRequest } from "./dispatch-digest.js";
import type { WakeState } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";

const google = vi.hoisted(() => ({
  account: null as { email: string } | null,
  failure: null as "gmail_503" | null,
  events: [] as Array<{ id: string; summary: string; start: string; end: string; status: string }>,
  messages: [] as Array<{
    id: string;
    from: string;
    subject: string;
    date: string;
    snippet: string;
    unread?: true;
  }>,
}));
const outlookDb = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async () => ({
    readAccount: async () => google.account,
    clearAccountIfStill: async () => true,
  }),
  openAdaGoogleAccountDbFromApi: async () => ({ listOwners: async () => [] }),
}));
vi.mock("./google-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-api.js")>()),
  loadAccessToken: async () => ({ ok: true, accessToken: "token" }),
  listInboxMessages: async () =>
    google.failure ? { ok: false, status: 503 } : { ok: true, messages: google.messages },
  listUpcomingEvents: async () => ({ ok: true, events: google.events }),
  watchGmailInbox: async () => ({ ok: false }),
}));
vi.mock("./outlook-account.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./outlook-account.js")>()),
  openAdaOutlookAccountDbFromApi: async () => outlookDb.current,
}));

import {
  ANNA,
  newMockMicrosoft,
  openOutlookTestDb,
  OUTLOOK_ENV,
  signInThroughFlow,
  type MockMicrosoft,
} from "./outlook-test-support.js";
import { listCollectOwners, runAdaCollectPass } from "./service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const now = new Date("2026-10-14T09:00:00.000Z");
const googleConfig = {
  googleClientId: "client",
  googleClientSecret: "secret",
  googleRedirectUri: "https://vera.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

let mock: MockMicrosoft;
let store: ReturnType<typeof openOutlookTestDb>;

function setup() {
  const api = {
    pluginConfig: googleConfig,
    config: {},
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as OpenClawPluginApi;
  let wake: WakeState = {
    lastLawyerInboundAtMs: now.getTime() - 60 * 60 * 1000,
    lastReconcileAtMs: null,
    lastCollectAtMs: null,
    lastDigestAtMs: null,
    lastMorningBriefAtMs: null,
    heldPlanJson: null,
    heldPlanAtMs: null,
    watchExpirationMs: null,
    openTodoIdsJson: null,
  } as WakeState;
  let gmailSnapshot: Awaited<ReturnType<MemoryStore["readGmailSnapshot"]>> = [];
  let calendarSnapshot: Awaited<ReturnType<MemoryStore["readCalendarSnapshot"]>> = [];
  const memory = {
    readGmailSnapshot: async () => gmailSnapshot,
    readCalendarSnapshot: async () => calendarSnapshot,
    listMatterAliases: async () => [{ matterId: "verdi", alias: "Verdi", title: "Verdi" }],
    listTodos: async () => [],
    readProfile: async () => ({ timezone: "Europe/Rome" }),
    listPreferences: async () => [],
    replaceGmailSnapshot: async (rows: typeof gmailSnapshot) => {
      gmailSnapshot = rows;
    },
    replaceCalendarSnapshot: async (rows: typeof calendarSnapshot) => {
      calendarSnapshot = rows;
    },
    readWake: async () => wake,
    writeWake: async (patch: Partial<WakeState>) => {
      wake = { ...wake, ...patch };
    },
  } as unknown as MemoryStore;
  const dispatched: DigestDispatchRequest[] = [];
  const run = (trigger: "poll" | "morning" = "morning", at = now) => {
    mock.clockMs = at.getTime();
    return runAdaCollectPass({
      api,
      memory,
      owner: ANNA,
      now: at,
      forceMorning: trigger === "morning",
      trigger,
      dispatchDigestTurn: async (request) => {
        dispatched.push(request);
        return { ok: true };
      },
    });
  };
  return { run, dispatched, gmail: () => gmailSnapshot, calendar: () => calendarSnapshot };
}

beforeEach(async () => {
  vi.stubEnv("ADA_MS_CLIENT_ID", OUTLOOK_ENV.ADA_MS_CLIENT_ID ?? "");
  vi.stubEnv("ADA_MS_CLIENT_SECRET", OUTLOOK_ENV.ADA_MS_CLIENT_SECRET ?? "");
  mock = newMockMicrosoft();
  vi.stubGlobal("fetch", mock.fetch);
  store = openOutlookTestDb(tempDirs.make("ada-outlook-brief-"));
  outlookDb.current = store.db;
  google.account = { email: "lawyer@example.com" };
  google.failure = null;
  google.events = [
    {
      id: "g-lunch",
      summary: "Pranzo con Bianchi",
      start: "2026-10-14T10:30:00.000Z",
      end: "2026-10-14T11:30:00.000Z",
      status: "confirmed",
    },
  ];
  google.messages = [
    {
      id: "g-1",
      from: "Verdi <verdi@example.com>",
      subject: "Nuova memoria Verdi",
      date: "Wed, 14 Oct 2026 07:00:00 +0200",
      snippet: "Allego la memoria",
      unread: true,
    },
  ];
  mock.mail.set("anna", [
    {
      id: "AAMk-outlook-1",
      from: "verdi.collega@studio.example",
      subject: "Verdi: udienza spostata",
      receivedAt: "2026-10-14T06:30:00Z",
      preview: "Vi scrivo per Verdi",
      unread: true,
    },
  ]);
  mock.events.set("anna", [
    {
      id: "ev-outlook",
      subject: "Colloquio con cliente",
      start: "2026-10-14T13:00:00Z",
      end: "2026-10-14T14:00:00Z",
    },
  ]);
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function connectOutlook() {
  await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now });
}

describe("the morning brief and the polls with Outlook connected", () => {
  it("merges Outlook and Google mail and calendar when both are connected", async () => {
    await connectOutlook();
    const t = setup();
    await t.run("morning");
    expect(t.dispatched).toHaveLength(1);
    expect(t.dispatched[0]).toMatchObject({
      plan: { deliver: false },
      brief: {
        events: [
          { time: "12:30", summary: "Pranzo con Bianchi" },
          { time: "15:00", summary: "Colloquio con cliente" },
        ],
        unreadMail: 2,
        mailHighlights: [
          { matter: "Verdi", subject: "Nuova memoria Verdi" },
          { matter: "Verdi", subject: "Verdi: udienza spostata" },
        ],
      },
    });
    expect(t.gmail().map((row) => row.messageId)).toEqual(["g-1", "outlook:AAMk-outlook-1"]);
    expect(t.calendar().map((row) => row.eventId)).toEqual(["g-lunch", "outlook:ev-outlook"]);
  });

  it("feeds the brief from Outlook alone, with no Google connect ask", async () => {
    await connectOutlook();
    google.account = null;
    const t = setup();
    await t.run("morning");
    expect(t.dispatched).toHaveLength(1);
    expect(t.dispatched[0]).toMatchObject({
      brief: {
        events: [{ time: "15:00", summary: "Colloquio con cliente" }],
        unreadMail: 1,
      },
    });
    expect(t.dispatched[0]?.connectOnly).toBeUndefined();
  });

  it("still asks to connect Google at the morning pass when Outlook is not connected either", async () => {
    google.account = null;
    const t = setup();
    await t.run("morning");
    expect(t.dispatched).toEqual([expect.objectContaining({ connectOnly: true })]);
  });

  it("sends an urgent Outlook calendar item on a poll", async () => {
    await connectOutlook();
    google.account = null;
    google.events = [];
    mock.events.set("anna", [
      {
        id: "ev-verdi",
        subject: "Verdi udienza",
        start: "2026-10-14T11:00:00Z",
        end: "2026-10-14T12:00:00Z",
      },
    ]);
    const t = setup();
    const outcome = await t.run("poll");
    expect(outcome).toMatchObject({ collected: true, delivered: true, decision: "dispatch" });
    expect(t.dispatched[0]).toMatchObject({
      plan: { deliver: true, items: [expect.objectContaining({ matterId: "verdi" })] },
    });
  });

  it("does not announce mail it already saw, and keeps Outlook's rows while Outlook is down for a moment", async () => {
    await connectOutlook();
    google.messages = [];
    google.events = [];
    const t = setup();
    await t.run("poll");
    expect(t.gmail().map((row) => row.messageId)).toEqual(["outlook:AAMk-outlook-1"]);

    // Microsoft cannot be reached; the pass goes on with Google and keeps what Outlook showed.
    const original = mock.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith("https://graph.microsoft.com")
        ? new Response("unavailable", { status: 503 })
        : original(input, init);
    });
    await t.run("poll", new Date(now.getTime() + 15 * 60_000));
    expect(t.gmail().map((row) => row.messageId)).toEqual(["outlook:AAMk-outlook-1"]);

    // Back again: the same message is not new, so nothing is announced.
    vi.stubGlobal("fetch", original);
    const outcome = await t.run("poll", new Date(now.getTime() + 30 * 60_000));
    expect(outcome.result?.signals.filter((signal) => signal.kind === "overnight_email")).toEqual(
      [],
    );
  });

  it("still serves Outlook when Gmail cannot be read for a moment", async () => {
    await connectOutlook();
    google.failure = "gmail_503";
    const t = setup();
    const outcome = await t.run("morning");
    expect(outcome.collected).toBe(true);
    expect(t.dispatched[0]).toMatchObject({ brief: { unreadMail: 1 } });
  });

  it("includes every number with Outlook connected in the polls, and only while the feature is on", async () => {
    await connectOutlook();
    const api = { config: {}, runtimeSource: "/x", runtime: {} } as unknown as OpenClawPluginApi;
    expect(await listCollectOwners(api)).toEqual([ANNA]);
    vi.stubEnv("ADA_MS_CLIENT_ID", "");
    expect(await listCollectOwners(api)).toEqual([]);
  });
});

describe("the brief without the Entra app registration", () => {
  it("is exactly what Google feeds, and never touches Microsoft", async () => {
    vi.stubEnv("ADA_MS_CLIENT_ID", "");
    vi.stubEnv("ADA_MS_CLIENT_SECRET", "");
    const t = setup();
    await t.run("morning");
    expect(t.dispatched[0]).toMatchObject({ brief: { unreadMail: 1 } });
    expect(mock.requests).toEqual([]);
    expect(t.gmail().map((row) => row.messageId)).toEqual(["g-1"]);
  });
});
