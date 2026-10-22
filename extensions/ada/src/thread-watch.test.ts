import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGmailThread, type ThreadMessage } from "./google-api.js";
import { findOutlookSentConversation, readOutlookConversation } from "./outlook-graph.js";
import { realStore } from "./preference-test-support.js";
import { listWatches, MAX_WATCHES, type ThreadWatch } from "./proactive-store.js";
import {
  findReply,
  OUTLOOK_LOOKUP_PREFIX,
  recordOutlookThread,
  recordSentThread,
} from "./thread-watch.js";

const stores = vi.hoisted(() => ({ memory: null as unknown }));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryFromApi: async () => stores.memory,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const OWNER = "393331111111";
const SENT_AT = Date.parse("2026-10-27T08:00:00.000Z");
const api = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as never;

const message = (id: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id,
  from: "Avv. Verdi <avv.verdi@example.com>",
  subject: "Re: Memoria",
  snippet: "Ricevuta",
  atMs: SENT_AT + 3_600_000,
  own: false,
  ...overrides,
});

const watch = (overrides: Partial<ThreadWatch> = {}): ThreadWatch => ({
  id: "google:t1",
  provider: "google",
  threadId: "t1",
  subject: "Memoria",
  to: "avv.verdi@example.com",
  sentAtMs: SENT_AT,
  seenIds: ["own-1"],
  reply: null,
  state: "pending",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  stores.memory = realStore(tempDirs.make("ada-thread-watch-"), "owner");
});

describe("findReply", () => {
  it("finds the newest message that someone else wrote after the mail went out", () => {
    const reply = findReply(watch(), [
      message("own-1", { own: true, atMs: SENT_AT }),
      message("r1", { snippet: "First", atMs: SENT_AT + 1000 }),
      message("r2", { snippet: "Second", atMs: SENT_AT + 2000 }),
    ]);
    expect(reply).toMatchObject({ snippet: "Second", atMs: SENT_AT + 2000 });
  });

  it("finds nothing when the thread only holds the person's own messages, messages already seen, or older ones", () => {
    expect(
      findReply(watch(), [
        message("own-1", { own: true }),
        message("own-2", { own: true }),
        message("old", { atMs: SENT_AT - 1000 }),
      ]),
    ).toBeNull();
    expect(findReply(watch({ seenIds: ["own-1", "r1"] }), [message("r1")])).toBeNull();
    expect(findReply(watch(), [])).toBeNull();
  });
});

describe("recordSentThread", () => {
  const sent = {
    provider: "google" as const,
    threadId: "t1",
    subject: "Memoria",
    to: "avv.verdi@example.com",
    atMs: SENT_AT,
    ownId: "own-1",
  };

  it("records the thread, with the message just sent as already seen", async () => {
    expect(await recordSentThread(api, OWNER, sent)).toBe(true);
    expect(await listWatches(stores.memory as never)).toMatchObject([
      { id: "google:t1", seenIds: ["own-1"], state: "pending", reply: null },
    ]);
  });

  it("watches one thread once, however many mails go into it", async () => {
    await recordSentThread(api, OWNER, sent);
    await recordSentThread(api, OWNER, { ...sent, atMs: SENT_AT + 1000, ownId: "own-2" });
    expect(await listWatches(stores.memory as never)).toMatchObject([
      { id: "google:t1", sentAtMs: SENT_AT + 1000, seenIds: ["own-2"] },
    ]);
  });

  it("lets the oldest watches give way at the cap", async () => {
    for (let index = 0; index <= MAX_WATCHES; index += 1) {
      await recordSentThread(api, OWNER, {
        ...sent,
        threadId: `t${index}`,
        atMs: SENT_AT + index * 1000,
      });
    }
    const watches = await listWatches(stores.memory as never);
    expect(watches).toHaveLength(MAX_WATCHES);
    expect(watches.map((entry) => entry.threadId)).not.toContain("t0");
    expect(watches.map((entry) => entry.threadId)).toContain(`t${MAX_WATCHES}`);
  });

  it("never throws: a failed note is reported as not watching", async () => {
    stores.memory = {
      listProactive: async () => {
        throw new Error("disk full");
      },
    };
    expect(await recordSentThread(api, OWNER, sent)).toBe(false);
  });
});

const urlOf = (input: RequestInfo | URL | undefined): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");

function graphFetch(routes: Array<[RegExp, unknown]>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    const hit = routes.find(([pattern]) => pattern.test(decodeURIComponent(url)));
    return hit
      ? new Response(JSON.stringify(hit[1]), { status: 200 })
      : new Response("{}", { status: 404 });
  });
}

const SENT_ITEMS = {
  value: [
    {
      conversationId: "AAQk-other",
      subject: "Altro",
      toRecipients: [{ emailAddress: { address: "someone@example.com" } }],
      sentDateTime: "2026-10-27T08:00:30Z",
    },
    {
      conversationId: "AAQk-memoria",
      subject: "Memoria",
      toRecipients: [{ emailAddress: { address: "Avv.Verdi@example.com" } }],
      sentDateTime: "2026-10-27T08:00:10Z",
    },
  ],
};

describe("Outlook sent threads", () => {
  it("finds the conversation of the mail just sent in Sent Items, by subject and recipient", async () => {
    const fetchImpl = graphFetch([[/mailFolders\/sentitems\/messages/u, SENT_ITEMS]]);
    expect(
      await findOutlookSentConversation({
        accessToken: "t",
        subject: "Memoria",
        to: "avv.verdi@example.com",
        sinceMs: SENT_AT - 60_000,
        fetchImpl: fetchImpl as never,
      }),
    ).toEqual({ ok: true, conversationId: "AAQk-memoria" });
  });

  it("watches that conversation, and falls back to a lookup the poll finishes when Sent Items has no copy yet", async () => {
    const found = graphFetch([[/mailFolders\/sentitems\/messages/u, SENT_ITEMS]]);
    expect(
      await recordOutlookThread(api, OWNER, {
        accessToken: "t",
        subject: "Memoria",
        to: "avv.verdi@example.com",
        atMs: SENT_AT,
        fetchImpl: found as never,
      }),
    ).toBe(true);
    const missing = graphFetch([[/mailFolders\/sentitems\/messages/u, { value: [] }]]);
    await recordOutlookThread(api, OWNER, {
      accessToken: "t",
      subject: "Contratto",
      to: "avv.verdi@example.com",
      atMs: SENT_AT + 5000,
      fetchImpl: missing as never,
    });
    expect(await listWatches(stores.memory as never)).toMatchObject([
      { id: "outlook:AAQk-memoria", provider: "outlook" },
      { id: `outlook:${OUTLOOK_LOOKUP_PREFIX}${SENT_AT + 5000}`, subject: "Contratto" },
    ]);
  });

  it("watches the conversation a reply goes into, under the subject of the mail answered", async () => {
    await recordOutlookThread(api, OWNER, {
      accessToken: "t",
      subject: "Re: Memoria",
      to: "",
      atMs: SENT_AT,
      repliedTo: { conversationId: "AAQk-memoria", subject: "Memoria" },
    });
    expect(await listWatches(stores.memory as never)).toMatchObject([
      { id: "outlook:AAQk-memoria", subject: "Memoria" },
    ]);
  });

  it("reads a conversation and tells the person's own messages from the others'", async () => {
    const fetchImpl = graphFetch([
      [
        /\/me\/messages\?/u,
        {
          value: [
            {
              id: "m1",
              subject: "Memoria",
              from: { emailAddress: { address: "Anna@contoso.example", name: "Anna" } },
              sentDateTime: "2026-10-27T08:00:10Z",
              bodyPreview: "Ecco",
            },
            {
              id: "m2",
              subject: "Re: Memoria",
              from: { emailAddress: { address: "avv.verdi@example.com", name: "Avv. Verdi" } },
              receivedDateTime: "2026-10-27T09:00:00Z",
              bodyPreview: "Ricevuta",
            },
            { id: "draft", isDraft: true, receivedDateTime: "2026-10-27T09:10:00Z" },
          ],
        },
      ],
    ]);
    const read = await readOutlookConversation({
      accessToken: "t",
      conversationId: "AAQk-o'brien",
      selfEmail: "anna@contoso.example",
      fetchImpl: fetchImpl as never,
    });
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && read.messages.map((entry) => [entry.id, entry.own])).toEqual([
      ["m1", true],
      ["m2", false],
    ]);
    expect(decodeURIComponent(urlOf(fetchImpl.mock.calls[0]?.[0]))).toContain(
      "conversationId eq 'AAQk-o''brien'",
    );
  });
});

describe("Gmail threads", () => {
  it("reads the messages of a thread and marks the SENT ones as the person's own", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "own-1",
                snippet: "Ecco",
                internalDate: String(SENT_AT),
                labelIds: ["SENT"],
                payload: { headers: [{ name: "From", value: "me@example.com" }] },
              },
              {
                id: "r1",
                snippet: "Ricevuta",
                internalDate: String(SENT_AT + 1000),
                labelIds: ["INBOX", "UNREAD"],
                payload: {
                  headers: [
                    { name: "From", value: "Avv. Verdi <avv.verdi@example.com>" },
                    { name: "Subject", value: "Re: Memoria" },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const read = await readGmailThread({
      accessToken: "t",
      threadId: "t1",
      fetchImpl: fetchImpl as never,
    });
    expect(read.ok && read.messages.map((entry) => [entry.id, entry.own])).toEqual([
      ["own-1", true],
      ["r1", false],
    ]);
    expect(urlOf(fetchImpl.mock.calls[0]?.[0])).toContain("/threads/t1?format=metadata");
  });

  it("reports a missing thread by its status", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(
      await readGmailThread({ accessToken: "t", threadId: "gone", fetchImpl: fetchImpl as never }),
    ).toEqual({ ok: false, status: 404 });
  });
});
