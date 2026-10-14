import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDigest, type MatterAlias } from "./collector.js";
import {
  dueReminder,
  parseReminderCadence,
  prepareDeadlineIntake,
  readDeadlineIntakeConfig,
  seedReminders,
  type DeadlineIntakeDeps,
} from "./deadline-intake.js";
import { buildPdf, openTestMemory } from "./deadline-test-support.js";
import { executeVeraDeadlineList, executeVeraDeadlineReply } from "./deadline-tools.js";
import type { CalendarEvent } from "./google-api.js";
import { buildDeadlineResearchQuery } from "./lexroom-tools.js";
import type { DeadlineItem } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const ALIASES: MatterAlias[] = [{ matterId: "rossi", alias: "Rossi", title: "Rossi c. Bianchi" }];
const ENABLED = { deadlineIntake: { enabled: true } };
// 07:40 in Rome is 06:40 UTC once daylight saving ends on 25 October 2026.
const OCT_14 = new Date("2026-10-14T05:40:00.000Z");
const NOV_05 = new Date("2026-11-05T06:40:00.000Z");
const NOV_10 = new Date("2026-11-10T06:40:00.000Z");
const NOV_12 = new Date("2026-11-12T06:40:00.000Z");

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const api = { pluginConfig: ENABLED, logger };
const toolApi = { runtimeSource: undefined, runtime: undefined, logger } as never;

function seed() {
  return openTestMemory(tempDirs.make("vera-intake-"));
}

async function seedMatter(memory: MemoryStore) {
  await memory.upsertRecord(
    {
      id: "rossi-workstream",
      matterId: "rossi",
      folder: "workstreams/active",
      type: "workstream",
      title: "Rossi c. Bianchi",
      aliases: ["Rossi"],
      body: "- Matter: Rossi c. Bianchi",
      validFromMs: 1,
      validToMs: null,
      supersededBy: null,
    },
    "create",
    1,
  );
}

const PEC_EML = [
  'From: "Cancelleria" <cancelleria@pec.example.test>',
  "Subject: Comunicazione di cancelleria - Rossi c. Bianchi RG 1234/2026",
  'Content-Type: multipart/mixed; boundary="B2"',
  "",
  "--B2",
  'Content-Type: text/plain; charset="utf-8"',
  "Content-Transfer-Encoding: 8bit",
  "",
  "Si comunica che l'udienza di comparizione è fissata per il 12 novembre 2026 ore 09:30.",
  "--B2",
  'Content-Type: application/pdf; name="avviso.pdf"',
  'Content-Disposition: attachment; filename="avviso.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  buildPdf([
    "R.G. 1234/2026 Rossi Mario c. Bianchi S.r.l.",
    "Udienza: 12 novembre 2026 ore 09:30",
  ]).toString("base64"),
  "--B2--",
  "",
].join("\r\n");

function hearingEvent(start = "2026-11-12T09:30:00+01:00"): CalendarEvent {
  return {
    id: "evt-1",
    summary: "Udienza Rossi c. Bianchi",
    start,
    end: start,
    status: "confirmed",
  };
}

type FakeGoogle = {
  deps: DeadlineIntakeDeps;
  events: CalendarEvent[];
  attachmentFails: boolean;
  listIds: ReturnType<typeof vi.fn<DeadlineIntakeDeps["listMessageIds"]>>;
  readMessage: ReturnType<typeof vi.fn<DeadlineIntakeDeps["readMessageContent"]>>;
  listEvents: ReturnType<typeof vi.fn<DeadlineIntakeDeps["listUpcomingEvents"]>>;
};

function fakeGoogle(overrides: { events?: CalendarEvent[]; ids?: string[] } = {}): FakeGoogle {
  const emlBytes = Buffer.from(PEC_EML, "utf8");
  const listIds = vi.fn<DeadlineIntakeDeps["listMessageIds"]>(async () => ({
    ok: true,
    ids: overrides.ids ?? ["msg-pec", "msg-noise"],
  }));
  const readMessage = vi.fn<DeadlineIntakeDeps["readMessageContent"]>(async ({ id }) => {
    if (id === "msg-noise") {
      return {
        ok: true,
        content: {
          id,
          from: "news@example.com",
          subject: "Weekly newsletter",
          date: "Wed, 14 Oct 2026 03:00:00 +0200",
          snippet: "",
          bodyText: "Offerta valida fino al 30 novembre 2026, scadenza improrogabile.",
          attachments: [],
        },
      };
    }
    return {
      ok: true,
      content: {
        id,
        from: "posta-certificata@pec.example.test",
        subject: "POSTA CERTIFICATA: Comunicazione di cancelleria",
        date: "Wed, 14 Oct 2026 08:00:00 +0200",
        snippet: "Messaggio di posta certificata",
        bodyText: "Messaggio di posta certificata",
        attachments: [
          {
            kind: "eml",
            attachmentId: "a-eml",
            filename: "postacert.eml",
            mimeType: "message/rfc822",
            size: emlBytes.length,
          },
        ],
      },
    };
  });
  const google: FakeGoogle = {
    events: overrides.events ?? [hearingEvent()],
    attachmentFails: false,
    listIds,
    readMessage,
    listEvents: vi.fn<DeadlineIntakeDeps["listUpcomingEvents"]>(async () => ({
      ok: true,
      events: google.events,
    })),
    deps: {
      listMessageIds: listIds,
      readMessageContent: readMessage,
      readAttachmentBytes: async () =>
        google.attachmentFails ? { ok: false, status: 500 } : { ok: true, bytes: emlBytes },
      listUpcomingEvents: async (params) => await google.listEvents(params),
    },
  };
  return google;
}

async function runPass(params: {
  memory: MemoryStore;
  now: Date;
  forceMorning: boolean;
  google: FakeGoogle;
  pluginConfig?: Record<string, unknown>;
}) {
  const intake = await prepareDeadlineIntake({
    api: { pluginConfig: params.pluginConfig ?? ENABLED, logger },
    memory: params.memory,
    now: params.now,
    forceMorning: params.forceMorning,
    aliases: ALIASES,
    timeZone: "Europe/Rome",
    accessToken: "token",
    deps: params.google.deps,
  });
  if (!intake) {
    return { intake, result: null };
  }
  const result = collectDigest({
    now: params.now,
    forceMorning: params.forceMorning,
    inbox: [],
    events: [],
    previousGmail: [],
    previousCalendar: [],
    aliases: ALIASES,
    todos: [],
    deadlines: intake.digest,
  });
  if (result.plan.deliver) {
    await intake.commit(result.plan);
  }
  return { intake, result };
}

function researchFetch(answer = "Brief: verificare i termini ex art. 183 c.p.c. [1]") {
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "POST" && url.endsWith("/v1/ask_me_anything")) {
      bodies.push(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
      const line = JSON.stringify({
        research: {
          id: "res-1",
          status: "DONE",
          answer: { text: answer },
          documents: [{ files: [{ citation_id: 1, title: "Cass. civ. 1111/2024" }] }],
        },
      });
      return new Response(`${line}\n`, { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

const LEXROOM_CONFIG = { ...ENABLED, accessToken: "opaque-test-token" };

describe("deadline intake config", () => {
  it("is off unless enabled and falls back to the default cadence", () => {
    expect(readDeadlineIntakeConfig(undefined).enabled).toBe(false);
    expect(readDeadlineIntakeConfig({ deadlineIntake: { enabled: "yes" } }).enabled).toBe(false);
    const on = readDeadlineIntakeConfig(ENABLED);
    expect(on).toMatchObject({ enabled: true, horizonDays: 60, minConfidence: 0.6 });
    expect(on.reminders.map((step) => step.id)).toEqual(["7d", "2d", "morning-of"]);
  });

  it("parses a custom cadence, drops junk, and orders it earliest first", () => {
    expect(
      parseReminderCadence(["morning-of", "1d", "14d", "soon", "0d", 3, "14D"]).map(
        (step) => `${step.id}:${step.daysBefore}`,
      ),
    ).toEqual(["14d:14", "1d:1", "morning-of:0"]);
    expect(parseReminderCadence("7d").length).toBe(3);
    expect(
      readDeadlineIntakeConfig({
        deadlineIntake: { enabled: true, horizonDays: 9999, minConfidence: 2 },
      }),
    ).toMatchObject({ horizonDays: 60, minConfidence: 0.6 });
  });
});

describe("prepareDeadlineIntake", () => {
  it("does nothing and reads nothing while the flag is off", async () => {
    const { memory, close } = seed();
    try {
      const google = fakeGoogle();
      for (const pluginConfig of [{}, { deadlineIntake: { enabled: false } }]) {
        const { intake } = await runPass({
          memory,
          now: OCT_14,
          forceMorning: true,
          google,
          pluginConfig,
        });
        expect(intake).toBeNull();
      }
      expect(google.listIds).not.toHaveBeenCalled();
      expect(google.listEvents).not.toHaveBeenCalled();
      expect(await memory.listDeadlines()).toEqual([]);
    } finally {
      close();
    }
  });

  it("merges a PEC envelope, its PDF, and the calendar into one candidate and lists it with a reply number", async () => {
    const { memory, close } = seed();
    try {
      await seedMatter(memory);
      const google = fakeGoogle();
      const { intake, result } = await runPass({
        memory,
        now: OCT_14,
        forceMorning: false,
        google,
      });

      const items = await memory.listDeadlines();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        matterId: "rossi",
        type: "hearing",
        dueDate: "2026-11-12",
        dueTime: "09:30",
        status: "candidate",
      });
      expect(items[0]?.sources.map((source) => source.kind).toSorted()).toEqual([
        "calendar",
        "email",
        "pdf",
      ]);
      expect(items[0]?.confidence).toBeGreaterThanOrEqual(0.95);

      expect(intake?.digest.signals).toEqual([
        expect.objectContaining({
          kind: "decision_waiting",
          matterId: "rossi",
          needsDecision: true,
          summary: expect.stringContaining("Confirm tracking Hearing 2026-11-12 09:30"),
        }),
      ]);
      expect(result?.plan.deliver).toBe(true);
      if (result?.plan.deliver) {
        expect(result.plan.deadlines).toEqual([
          expect.objectContaining({
            no: 1,
            status: "candidate",
            type: "hearing",
            due: "2026-11-12 09:30",
            replyHint: "reply 1 to run research",
            matterLabel: "Rossi c. Bianchi",
          }),
        ]);
      }
      expect(await memory.listDeadlines()).toEqual([
        expect.objectContaining({ offerNo: 1, offeredCount: 0 + 1 }),
      ]);
    } finally {
      close();
    }
  });

  it("never re-reads a scanned message and never duplicates the item", async () => {
    const { memory, close } = seed();
    try {
      await seedMatter(memory);
      const google = fakeGoogle();
      await runPass({ memory, now: OCT_14, forceMorning: false, google });
      expect(google.readMessage).toHaveBeenCalledTimes(2);
      await runPass({
        memory,
        now: new Date(OCT_14.getTime() + 15 * 60_000),
        forceMorning: false,
        google,
      });
      expect(google.readMessage).toHaveBeenCalledTimes(2);
      expect(await memory.listDeadlines()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("retries a message whose attachment could not be fetched", async () => {
    const { memory, close } = seed();
    try {
      await seedMatter(memory);
      const google = fakeGoogle({ events: [], ids: ["msg-pec"] });
      google.attachmentFails = true;
      await runPass({ memory, now: OCT_14, forceMorning: false, google });
      expect(await memory.filterUnscannedMessages(["msg-pec"])).toEqual(["msg-pec"]);
      google.attachmentFails = false;
      await runPass({ memory, now: OCT_14, forceMorning: false, google });
      expect(await memory.filterUnscannedMessages(["msg-pec"])).toEqual([]);
      expect(await memory.listDeadlines()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("ignores low-confidence and already-past dates", async () => {
    const { memory, close } = seed();
    try {
      await seedMatter(memory);
      const google = fakeGoogle({
        ids: [],
        events: [
          hearingEvent("2026-10-01T09:30:00+02:00"),
          { ...hearingEvent(), id: "evt-2", summary: "Scadenza Rossi", start: "2026-12-01" },
        ],
      });
      await runPass({
        memory,
        now: OCT_14,
        forceMorning: false,
        google,
        pluginConfig: { deadlineIntake: { enabled: true, minConfidence: 0.95 } },
      });
      expect(await memory.listDeadlines()).toEqual([]);
    } finally {
      close();
    }
  });

  it("keeps the digest running and logs when a scan step fails", async () => {
    const { memory, close } = seed();
    try {
      const google = fakeGoogle();
      google.listEvents.mockRejectedValue(new Error("calendar exploded"));
      const { intake } = await runPass({ memory, now: OCT_14, forceMorning: true, google });
      expect(intake?.digest).toEqual({ signals: [], lines: [] });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("calendar exploded"));
      expect(await memory.filterUnscannedMessages(["msg-pec"])).toEqual(["msg-pec"]);
    } finally {
      close();
    }
  });

  it("clips a very long subject instead of losing the batch", async () => {
    const { memory, close } = seed();
    try {
      await seedMatter(memory);
      const google = fakeGoogle({ ids: ["msg-long"], events: [] });
      google.readMessage.mockResolvedValue({
        ok: true,
        content: {
          id: "msg-long",
          from: "counsel@example.com",
          subject: `Rossi udienza ${"x".repeat(900)}`,
          date: "Wed, 14 Oct 2026 08:00:00 +0200",
          snippet: "",
          bodyText: "L'udienza è fissata per il 12 novembre 2026 alle ore 09:30.",
          attachments: [],
        },
      });
      await runPass({ memory, now: OCT_14, forceMorning: false, google });
      const [item] = await memory.listDeadlines();
      expect(item?.title.length).toBeLessThanOrEqual(200);
      expect(await memory.filterUnscannedMessages(["msg-long"])).toEqual([]);
    } finally {
      close();
    }
  });

  it("retries mail whose items could not be stored, and gives up on mail that is gone", async () => {
    const { memory, close } = seed();
    try {
      await seedMatter(memory);
      const google = fakeGoogle({ ids: ["msg-pec", "msg-gone"], events: [] });
      const original = google.readMessage.getMockImplementation();
      google.readMessage.mockImplementation(async (params) =>
        params.id === "msg-gone"
          ? { ok: false, status: 404 }
          : (original?.(params) ?? { ok: false, status: 500 }),
      );
      const upsert = vi.spyOn(memory, "upsertDeadlines").mockRejectedValueOnce(new Error("busy"));
      await runPass({ memory, now: OCT_14, forceMorning: false, google });
      expect(await memory.filterUnscannedMessages(["msg-pec"])).toEqual(["msg-pec"]);
      upsert.mockRestore();
      await runPass({ memory, now: OCT_14, forceMorning: false, google });
      expect(await memory.filterUnscannedMessages(["msg-gone"])).toEqual([]);
      expect(await memory.listDeadlines()).toHaveLength(1);
      expect(await memory.filterUnscannedMessages(["msg-pec"])).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("replying to a digest line", () => {
  async function offered() {
    const { memory, close } = seed();
    await seedMatter(memory);
    const google = fakeGoogle();
    await runPass({ memory, now: OCT_14, forceMorning: false, google });
    return { memory, close, google };
  }

  it("runs Lexroom research on 'reply 1', confirms tracking, and returns the brief", async () => {
    const { memory, close } = await offered();
    try {
      const lexroom = researchFetch();
      const reply = await executeVeraDeadlineReply(
        { ref: "1", action: "research" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        OCT_14,
        { memory, fetchImpl: lexroom.fetchImpl },
      );
      expect(reply).toMatchObject({
        ok: true,
        item: {
          offerNo: 1,
          status: "tracked",
          briefReady: true,
          reminders: [
            { step: "7d", state: "scheduled", at: "2026-11-05T06:40:00.000Z" },
            { step: "2d", state: "scheduled", at: "2026-11-10T06:40:00.000Z" },
            { step: "morning-of", state: "scheduled", at: "2026-11-12T06:40:00.000Z" },
          ],
        },
        brief: {
          answer: "Brief: verificare i termini ex art. 183 c.p.c. [Cass. civ. 1111/2024]",
          sources: [{ title: "Cass. civ. 1111/2024" }],
          researchId: "res-1",
        },
      });
      const query = (lexroom.bodies[0] as { query: string; search_on_user_data: boolean }).query;
      expect(query).toContain('matter "Rossi c. Bianchi"');
      expect(query).toContain("hearing on 2026-11-12 09:30 (Europe/Rome)");
      expect((lexroom.bodies[0] as { search_on_user_data: boolean }).search_on_user_data).toBe(
        false,
      );

      const [stored] = await memory.listDeadlines();
      expect(stored).toMatchObject({
        status: "tracked",
        researchStatus: "done",
        briefAtMs: OCT_14.getTime(),
      });
      expect(stored?.brief).toContain("art. 183");
    } finally {
      close();
    }
  });

  it("resends the stored brief without calling Lexroom again", async () => {
    const { memory, close } = await offered();
    try {
      const lexroom = researchFetch();
      const deps = { memory, fetchImpl: lexroom.fetchImpl };
      const none = await executeVeraDeadlineReply(
        { ref: "1", action: "brief" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        OCT_14,
        deps,
      );
      expect(none).toMatchObject({ ok: false });
      await executeVeraDeadlineReply(
        { ref: "1", action: "research" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        OCT_14,
        deps,
      );
      const again = await executeVeraDeadlineReply(
        { ref: "1", action: "brief" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        OCT_14,
        deps,
      );
      expect(again).toMatchObject({
        ok: true,
        brief: {
          stored: true,
          answer: expect.stringContaining("Sources: Cass. civ. 1111/2024"),
        },
      });
      expect(lexroom.bodies).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("keeps the item tracked and asks to reconnect when Lexroom is not connected", async () => {
    const { memory, close } = await offered();
    try {
      const reply = await executeVeraDeadlineReply(
        { ref: "1", action: "research" },
        ENABLED,
        toolApi,
        undefined,
        OCT_14,
        { memory },
      );
      expect(reply).toMatchObject({ ok: false, reason: "not_connected", tracking: true });
      expect((await memory.listDeadlines())[0]).toMatchObject({
        status: "tracked",
        researchStatus: "failed",
      });
    } finally {
      close();
    }
  });

  it("tracks without research, dismisses, and refuses stale or unknown references", async () => {
    const { memory, close } = await offered();
    try {
      const lexroom = researchFetch();
      const deps = { memory, fetchImpl: lexroom.fetchImpl };
      const track = await executeVeraDeadlineReply(
        { ref: "1", action: "track" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        OCT_14,
        deps,
      );
      expect(track).toMatchObject({ ok: true, item: { status: "tracked", briefReady: false } });

      const unknown = await executeVeraDeadlineReply(
        { ref: "7", action: "research" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        OCT_14,
        deps,
      );
      expect(unknown).toMatchObject({ ok: false, reason: "not_found" });

      const dismiss = await executeVeraDeadlineReply(
        { ref: "1", action: "dismiss" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        OCT_14,
        deps,
      );
      expect(dismiss).toMatchObject({ ok: true, item: { status: "dismissed" } });

      const id = (await memory.listDeadlines())[0]?.id ?? "";
      const late = await executeVeraDeadlineReply(
        { ref: id, action: "research" },
        LEXROOM_CONFIG,
        toolApi,
        undefined,
        new Date("2026-11-13T10:00:00.000Z"),
        deps,
      );
      expect(late).toMatchObject({ ok: false, reason: "passed" });
      expect(lexroom.fetchImpl).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("refuses everything while the flag is off", async () => {
    const { memory, close } = await offered();
    try {
      const off = { accessToken: "opaque-test-token" };
      expect(
        await executeVeraDeadlineReply(
          { ref: "1", action: "research" },
          off,
          toolApi,
          undefined,
          OCT_14,
          { memory },
        ),
      ).toMatchObject({ ok: false, reason: "disabled" });
      expect(await executeVeraDeadlineList(off, toolApi, OCT_14, { memory })).toMatchObject({
        ok: false,
        reason: "disabled",
      });
      expect((await memory.listDeadlines())[0]?.status).toBe("candidate");
    } finally {
      close();
    }
  });

  it("lists upcoming open items with their numbers", async () => {
    const { memory, close } = await offered();
    try {
      const list = await executeVeraDeadlineList(ENABLED, toolApi, OCT_14, { memory });
      expect(list).toMatchObject({
        ok: true,
        items: [{ offerNo: 1, status: "candidate", due: "2026-11-12 09:30", reminders: [] }],
      });
    } finally {
      close();
    }
  });
});

describe("reminders", () => {
  async function tracked() {
    const { memory, close } = seed();
    await seedMatter(memory);
    const google = fakeGoogle();
    await runPass({ memory, now: OCT_14, forceMorning: false, google });
    await executeVeraDeadlineReply(
      { ref: "1", action: "track" },
      ENABLED,
      toolApi,
      undefined,
      OCT_14,
      { memory },
    );
    return { memory, close, google };
  }

  function reminderOf(result: Awaited<ReturnType<typeof runPass>>["result"]) {
    if (!result?.plan.deliver) {
      return null;
    }
    return result.plan.deadlines?.[0]?.reminder ?? null;
  }

  it("sends nothing for an item the lawyer has not confirmed", async () => {
    const { memory, close } = seed();
    try {
      await seedMatter(memory);
      const google = fakeGoogle();
      await runPass({ memory, now: OCT_14, forceMorning: false, google });
      for (const now of [NOV_05, NOV_10, NOV_12]) {
        const { result } = await runPass({ memory, now, forceMorning: true, google });
        expect(reminderOf(result)).toBeNull();
        expect((await memory.listDeadlines())[0]?.remindersSent).toEqual([]);
      }
    } finally {
      close();
    }
  });

  it("fires 7d, 2d, and morning-of once each, in the morning slot of that day", async () => {
    const { memory, close, google } = await tracked();
    try {
      const early = await runPass({
        memory,
        now: new Date("2026-11-05T06:00:00.000Z"),
        forceMorning: false,
        google,
      });
      expect(reminderOf(early.result)).toBeNull();

      const seven = await runPass({ memory, now: NOV_05, forceMorning: true, google });
      expect(reminderOf(seven.result)).toEqual({ step: "7d", covers: ["7d"] });
      expect(seven.result?.plan.deliver && seven.result.plan.deadlines?.[0]).toMatchObject({
        status: "tracked",
        daysLeft: 7,
      });

      const again = await runPass({
        memory,
        now: new Date(NOV_05.getTime() + 15 * 60_000),
        forceMorning: false,
        google,
      });
      expect(reminderOf(again.result)).toBeNull();

      const two = await runPass({ memory, now: NOV_10, forceMorning: true, google });
      expect(reminderOf(two.result)).toEqual({ step: "2d", covers: ["2d"] });

      const today = await runPass({ memory, now: NOV_12, forceMorning: true, google });
      expect(reminderOf(today.result)).toEqual({ step: "morning-of", covers: ["morning-of"] });
      expect(today.result?.plan.deliver && today.result.plan.items[0]).toMatchObject({
        kind: "deadline",
        cost: 100,
      });

      expect((await memory.listDeadlines())[0]?.remindersSent).toEqual(["7d", "2d", "morning-of"]);
    } finally {
      close();
    }
  });

  it("sends only the latest overdue reminder after a quiet stretch and settles the earlier ones", async () => {
    const { memory, close, google } = await tracked();
    try {
      const { result } = await runPass({
        memory,
        now: new Date("2026-11-11T09:00:00.000Z"),
        forceMorning: true,
        google,
      });
      expect(reminderOf(result)).toEqual({ step: "2d", covers: ["7d", "2d"] });
      expect((await memory.listDeadlines())[0]?.remindersSent).toEqual(["7d", "2d"]);
    } finally {
      close();
    }
  });

  it("does not commit reminders for a digest that was never delivered", async () => {
    const { memory, close, google } = await tracked();
    try {
      const intake = await prepareDeadlineIntake({
        api,
        memory,
        now: NOV_05,
        forceMorning: true,
        aliases: ALIASES,
        timeZone: "Europe/Rome",
        accessToken: "token",
        deps: google.deps,
      });
      expect(intake?.digest.lines[0]?.reminder).toEqual({ step: "7d", covers: ["7d"] });
      expect((await memory.listDeadlines())[0]?.remindersSent).toEqual([]);
      const held = collectDigest({
        now: NOV_05,
        forceMorning: true,
        inbox: [],
        events: [],
        previousGmail: [],
        previousCalendar: [],
        aliases: ALIASES,
        todos: [],
        deadlines: intake?.digest,
      });
      expect(held.plan.deliver).toBe(true);
      const next = await prepareDeadlineIntake({
        api,
        memory,
        now: new Date(NOV_05.getTime() + 60 * 60_000),
        forceMorning: true,
        aliases: ALIASES,
        timeZone: "Europe/Rome",
        accessToken: "token",
        deps: google.deps,
      });
      expect(next?.digest.lines[0]?.reminder).toEqual({ step: "7d", covers: ["7d"] });
    } finally {
      close();
    }
  });

  it("follows a moved hearing: new date, tracking carried over, past steps settled", async () => {
    const { memory, close, google } = await tracked();
    try {
      google.events = [hearingEvent("2026-11-16T10:00:00+01:00")];
      const { result } = await runPass({
        memory,
        now: new Date("2026-11-11T09:00:00.000Z"),
        forceMorning: true,
        google,
      });
      const items = await memory.listDeadlines();
      expect(items.map((item) => `${item.dueDate}:${item.status}`)).toEqual([
        "2026-11-12:superseded",
        "2026-11-16:tracked",
      ]);
      expect(items[1]).toMatchObject({ dueTime: "10:00", remindersSent: ["7d"] });
      expect(result?.plan.deliver && result.plan.deadlines).toEqual([
        expect.objectContaining({ due: "2026-11-16 10:00", moved: true, status: "tracked" }),
      ]);
    } finally {
      close();
    }
  });

  it("still reminds about a confirmed item when the scan fails", async () => {
    const { memory, close, google } = await tracked();
    try {
      google.listIds.mockRejectedValue(new Error("gmail exploded"));
      const { result } = await runPass({ memory, now: NOV_05, forceMorning: true, google });
      expect(reminderOf(result)).toEqual({ step: "7d", covers: ["7d"] });
    } finally {
      close();
    }
  });

  it("stops listing a dismissed item", async () => {
    const { memory, close, google } = await tracked();
    try {
      await executeVeraDeadlineReply(
        { ref: "1", action: "dismiss" },
        ENABLED,
        toolApi,
        undefined,
        OCT_14,
        { memory },
      );
      const { intake } = await runPass({ memory, now: NOV_05, forceMorning: true, google });
      expect(intake?.digest).toEqual({ signals: [], lines: [] });
    } finally {
      close();
    }
  });
});

describe("reminder schedule helpers", () => {
  const item: DeadlineItem = {
    id: "dl-x",
    dedupeKey: "rossi|hearing|2026-11-12",
    matterId: "rossi",
    type: "hearing",
    title: "t",
    dueAtMs: Date.parse("2026-11-12T08:30:00.000Z"),
    dueDate: "2026-11-12",
    dueTime: "09:30",
    timeZone: "Europe/Rome",
    confidence: 0.9,
    sources: [],
    status: "tracked",
    offerNo: null,
    offeredCount: 0,
    remindersSent: [],
    researchStatus: "none",
    brief: null,
    briefAtMs: null,
    movedFromMs: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  const steps = parseReminderCadence(undefined);

  it("settles steps whose slot already passed when the lawyer confirms late", () => {
    expect(seedReminders(item, steps, Date.parse("2026-11-11T09:00:00.000Z"))).toEqual([
      "7d",
      "2d",
    ]);
    expect(seedReminders(item, steps, OCT_14.getTime())).toEqual([]);
  });

  it("owes nothing once the item has passed", () => {
    expect(dueReminder(item, steps, Date.parse("2026-11-12T09:00:00.000Z"))).toBeNull();
    expect(dueReminder({ ...item, status: "candidate" }, steps, NOV_10.getTime())).toBeNull();
  });

  it("keeps 7d at 07:40 Rome in summer time too", () => {
    const summer = {
      ...item,
      dueDate: "2026-09-16",
      dueAtMs: Date.parse("2026-09-16T07:30:00.000Z"),
    };
    expect(dueReminder(summer, steps, Date.parse("2026-09-09T05:39:00.000Z"))).toBeNull();
    expect(dueReminder(summer, steps, Date.parse("2026-09-09T05:40:00.000Z"))?.step.id).toBe("7d");
  });
});

describe("buildDeadlineResearchQuery", () => {
  it("quotes only a short excerpt and asks for the lawyer's language", () => {
    const query = buildDeadlineResearchQuery({
      item: {
        type: "deadline",
        dueDate: "2026-12-07",
        dueTime: null,
        timeZone: "Europe/Rome",
        title: "Atti",
        sources: [{ kind: "pdf", ref: "m#a.pdf", label: "a", excerpt: "x".repeat(900) }],
      },
      matterLabel: "Verdi",
      language: "Italian",
    });
    expect(query).toContain("filing deadline on 2026-12-07 (Europe/Rome)");
    expect(query).toContain("Answer in Italian.");
    expect(query.length).toBeLessThan(900);
  });
});
