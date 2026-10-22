import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  appendAssistantMirrorMessageByIdentity: vi.fn(),
}));

import { handleAdaAnnouncementsAdmin } from "./announcements-http.js";
import type { AnnouncementDeps } from "./announcements.js";
import type { MemoryStore } from "./memory.js";
import { realStore } from "./preference-test-support.js";
import type { WhatsAppSession } from "./transcript-mirror.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TOKEN = "admin-token-0123456789";
const PAOLO = "393331111111";
const ANNA = "393332222222";
const NOW = Date.parse("2026-10-20T09:00:00.000Z");

let registry: MemoryStore;
let send: ReturnType<typeof vi.fn>;
let deps: AnnouncementDeps;

beforeEach(() => {
  registry = realStore(tempDirs.make("ada-announcements-http-"), "memory");
  send = vi.fn(async () => ({ ok: true }));
  deps = {
    registry: async () => registry,
    now: () => NOW,
    windowOpen: async (owner) => owner === PAOLO,
    optedOut: async () => false,
    hasFeature: async () => false,
    language: async (owner) => (owner === PAOLO ? "en" : "it"),
    send: send as AnnouncementDeps["send"],
    recordInHistory: async () => true,
    log: { error: vi.fn(), info: vi.fn() },
  };
});

const recipients = (): WhatsAppSession[] =>
  [PAOLO, ANNA].map((owner) => ({
    owner,
    sessionKey: `agent:main:kapso-whatsapp:direct:${owner}`,
    sessionId: `session-${owner}`,
  }));

async function call(params: {
  method?: string;
  url?: string;
  authorization?: string;
  body?: unknown;
  env?: NodeJS.ProcessEnv;
}) {
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    end: (chunk?: string) => {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const payload = params.body === undefined ? [] : [JSON.stringify(params.body)];
  const req = Object.assign(Readable.from(payload), {
    method: params.method ?? "GET",
    url: params.url ?? "/ada/admin/announcements",
    headers: params.authorization ? { authorization: params.authorization } : {},
  }) as unknown as IncomingMessage;
  const handled = await handleAdaAnnouncementsAdmin(req, res, {
    env: params.env ?? { ADA_ADMIN_TOKEN: TOKEN },
    delivery: deps,
    recipients,
    log: { error: vi.fn() },
  });
  return { handled, res, headers, json: () => JSON.parse(body) as Record<string, unknown>, body };
}

const auth = { authorization: `Bearer ${TOKEN}` };
const newAnnouncement = {
  id: "granola",
  feature: "granola",
  texts: { it: "Novità: Granola. Vuoi il link?", en: "New: Granola. Want the link?" },
};

describe("admin announcements endpoint: access", () => {
  it("does not exist, as a 404, while ADA_ADMIN_TOKEN is unset or too short", async () => {
    for (const env of [{}, { ADA_ADMIN_TOKEN: "short" }]) {
      const result = await call({ env, authorization: "Bearer short" });
      expect(result.res.statusCode).toBe(404);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 401 without the bearer token or with a wrong one, on every route and method", async () => {
    for (const url of [
      "/admin/announcements",
      "/ada/admin/announcements",
      "/vera/admin/announcements",
    ]) {
      for (const method of ["GET", "POST"]) {
        for (const authorization of [undefined, "Bearer wrong-token-0123456789", TOKEN]) {
          const result = await call({ url, method, authorization, body: newAnnouncement });
          expect(result.res.statusCode).toBe(401);
          expect(result.headers.get("www-authenticate")).toBe("Bearer");
        }
      }
    }
    expect(send).not.toHaveBeenCalled();
    expect(await registry.listAnnouncements()).toEqual([]);
  });

  it("accepts the token on the plain and both prefixed paths and leaves other paths alone", async () => {
    for (const url of [
      "/admin/announcements",
      "/ada/admin/announcements",
      "/vera/admin/announcements/",
    ]) {
      expect((await call({ url, ...auth })).res.statusCode).toBe(200);
    }
    expect((await call({ url: "/ada/admin/announcements/x", ...auth })).res.statusCode).toBe(404);
    expect((await call({ method: "DELETE", ...auth })).res.statusCode).toBe(405);
  });
});

describe("admin announcements endpoint: create", () => {
  it("answers a dry run with each number's resolved text and neither sends nor saves", async () => {
    const result = await call({
      method: "POST",
      body: { ...newAnnouncement, dryRun: true },
      ...auth,
    });
    expect(result.res.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      ok: true,
      dryRun: true,
      announcement: { id: "granola", feature: "granola", languages: ["it", "en"] },
      recipients: [
        {
          numberLast4: "1111",
          status: "would_send",
          language: "en",
          text: newAnnouncement.texts.en,
        },
        {
          numberLast4: "2222",
          status: "pending",
          reason: "window_closed",
          language: "it",
          text: newAnnouncement.texts.it,
        },
      ],
    });
    expect(result.body).not.toContain(PAOLO);
    expect(send).not.toHaveBeenCalled();
    expect(await registry.listAnnouncements()).toEqual([]);
    expect(await registry.listAnnouncementDeliveries()).toEqual([]);
  });

  it("shows excluded numbers as skipped in a dry run, without saving anything", async () => {
    const result = await call({
      method: "POST",
      body: { ...newAnnouncement, dryRun: true, exclude: [PAOLO, "+39 333 999 9999"] },
      ...auth,
    });
    expect(result.res.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      dryRun: true,
      excluded: 2,
      recipients: [
        { numberLast4: "1111", status: "skipped", reason: "excluded", text: null },
        { numberLast4: "2222", status: "pending", reason: "window_closed" },
        { numberLast4: "9999", status: "skipped", reason: "excluded" },
      ],
    });
    expect(result.body).not.toContain(PAOLO);
    expect(result.body).not.toContain("393339999999");
    expect(send).not.toHaveBeenCalled();
    expect(await registry.listAnnouncementDeliveries()).toEqual([]);
  });

  it("does not send to an excluded number, marks it skipped for good, and lists it that way", async () => {
    const created = await call({
      method: "POST",
      body: { ...newAnnouncement, exclude: [PAOLO, "393339999999"] },
      ...auth,
    });
    expect(created.res.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      recipients: [
        { numberLast4: "1111", status: "skipped", reason: "excluded" },
        { numberLast4: "2222", status: "pending", reason: "window_closed" },
        { numberLast4: "9999", status: "skipped", reason: "excluded" },
      ],
    });
    expect(send).not.toHaveBeenCalled();
    expect(await registry.listAnnouncementDeliveries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: PAOLO, status: "skipped", reason: "excluded" }),
        expect.objectContaining({ number: "393339999999", status: "skipped", reason: "excluded" }),
      ]),
    );
    const [listed] = (await call({ ...auth })).json().announcements as Array<
      Record<string, unknown>
    >;
    expect(listed?.counts).toEqual({ sent: 0, skipped: 2, pending: 1 });
  });

  it("refuses an exclude list that is not numbers", async () => {
    for (const exclude of ["393331111111", ["paolo"], [""]]) {
      const result = await call({ method: "POST", body: { ...newAnnouncement, exclude }, ...auth });
      expect(result.res.statusCode).toBe(400);
    }
    expect(await registry.listAnnouncements()).toEqual([]);
  });

  it("saves the announcement, sends inside the window, leaves the rest pending, and refuses a repeat id", async () => {
    const created = await call({ method: "POST", body: newAnnouncement, ...auth });
    expect(created.res.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      dryRun: false,
      recipients: [
        { numberLast4: "1111", status: "sent", recordedInHistory: true },
        { numberLast4: "2222", status: "pending", reason: "window_closed" },
      ],
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(PAOLO, newAnnouncement.texts.en);

    const repeated = await call({ method: "POST", body: newAnnouncement, ...auth });
    expect(repeated.res.statusCode).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a body without Italian and English or with an unknown feature", async () => {
    for (const body of [
      { ...newAnnouncement, texts: { it: "solo italiano" } },
      { ...newAnnouncement, feature: "nope" },
      { ...newAnnouncement, id: "Bad Id" },
    ]) {
      const result = await call({ method: "POST", body, ...auth });
      expect(result.res.statusCode).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  });
});

describe("admin announcements endpoint: list", () => {
  it("lists announcements with each number's delivery status", async () => {
    await call({ method: "POST", body: newAnnouncement, ...auth });
    const result = await call({ ...auth });
    expect(result.res.statusCode).toBe(200);
    const [listed] = result.json().announcements as Array<Record<string, unknown>>;
    expect(listed).toMatchObject({
      id: "granola",
      feature: "granola",
      counts: { sent: 1, skipped: 0, pending: 1 },
      recipients: [
        { numberLast4: "1111", status: "sent", reason: null },
        { numberLast4: "2222", status: "pending", reason: null, at: null },
      ],
    });
    expect(result.body).not.toContain(PAOLO);
  });
});
