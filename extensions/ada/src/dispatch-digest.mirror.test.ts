import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestDeadlineLine, DigestPlan } from "./digest.js";
import { SHORT_TEXTS_KEY } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";
import { realStore } from "./preference-test-support.js";
import { mentionedOn } from "./proactive-store.js";
import type { QuietBrief } from "./quiet-brief.js";

const mocks = vi.hoisted(() => ({
  memory: null as unknown,
  mirror: vi.fn(async () => true),
  connect: vi.fn(),
  send: vi.fn(async (_params: { to: string; text: string }) => undefined),
}));

vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryIfExistsFromApi: async () => mocks.memory,
}));
vi.mock("./transcript-mirror.js", () => ({ mirrorSentText: mocks.mirror }));
vi.mock("./google-tools.js", () => ({ executeAdaGoogleConnect: mocks.connect }));

import { clearSentDigests, dispatchDigest } from "./dispatch-digest.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const OWNER = "393331111111";
/** 11:00 in Rome. */
const NOW = Date.parse("2026-10-27T10:00:00.000Z");

const api = {
  config: {},
  pluginConfig: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  runtime: {
    channel: { outbound: { loadAdapter: async () => ({ sendText: mocks.send }) } },
  },
} as never;

const line = (id: string, matterId: string, no: number): DigestDeadlineLine => ({
  id,
  no,
  matterId,
  matterLabel: matterId === "rossi" ? "Rossi SRL" : "Bianchi",
  type: "hearing",
  title: "Udienza",
  dueAt: "2026-10-28T08:30:00.000Z",
  due: "2026-10-28 09:30",
  daysLeft: 1,
  status: "tracked",
  confidence: 0.9,
  source: "",
  briefReady: false,
});

const item = (matterId: string) => ({
  matterId,
  matterLabel: matterId === "rossi" ? "Rossi SRL" : "Bianchi",
  kind: "deadline" as const,
  summary: "Udienza domani",
  cost: 100,
  dueAt: "2026-10-28T08:30:00.000Z",
});

const step = (action: "research" | "draft_if_confirmed", matterId: string) => ({
  action,
  matterId,
  matterLabel: matterId === "rossi" ? "Rossi SRL" : "Bianchi",
  instruction: "x",
});

const PLAN: DigestPlan = {
  deliver: true,
  items: [item("rossi"), item("bianchi")],
  nextSteps: [step("research", "rossi"), step("draft_if_confirmed", "bianchi")],
  deadlines: [line("d-rossi", "rossi", 1), line("d-bianchi", "bianchi", 2)],
};

const BRIEF: QuietBrief = {
  agenda: true,
  alertedToday: false,
  events: [{ time: "12:30", summary: "Pranzo" }],
  unreadMail: 0,
  unreadMailCapped: false,
  mailHighlights: [],
  deadlines: [
    { id: "d-rossi", matter: "Rossi SRL", type: "hearing", due: "2026-10-28 09:30", daysLeft: 1 },
  ],
};

let memory: MemoryStore;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearSentDigests();
  clearInboundLanguages();
  recordInboundLanguage(OWNER, "Please tell me what is on today");
  memory = realStore(tempDirs.make("ada-dispatch-"), "owner");
  mocks.memory = memory;
  await memory.setProfileTimezone("Europe/Rome", 1, "English");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what the digest and the brief send is written into the conversation", () => {
  it("writes the digest, exactly as sent, into the number's conversation", async () => {
    expect(await dispatchDigest(api, { owner: OWNER, plan: PLAN, idempotencyKey: "d-1" })).toEqual({
      ok: true,
    });
    const sentText = mocks.send.mock.calls[0]?.[0].text;
    expect(mocks.mirror).toHaveBeenCalledExactlyOnceWith(api, OWNER, sentText, "ada-digest:d-1");
  });

  it("writes the brief, and the Google connect ask, the same way", async () => {
    await dispatchDigest(api, {
      owner: OWNER,
      plan: { deliver: false, reason: "nothing_cleared_the_bar" },
      brief: BRIEF,
      idempotencyKey: "b-1",
    });
    expect(mocks.mirror).toHaveBeenLastCalledWith(
      api,
      OWNER,
      mocks.send.mock.calls[0]?.[0].text,
      "ada-digest:b-1",
    );
    mocks.connect.mockResolvedValue({
      ok: true,
      connected: false,
      ask: { url: "https://x.example/g/abc" },
    });
    await dispatchDigest(api, {
      owner: OWNER,
      plan: { deliver: false, reason: "nothing_cleared_the_bar" },
      connectOnly: true,
      idempotencyKey: "c-1",
    });
    expect(mocks.mirror).toHaveBeenLastCalledWith(
      api,
      OWNER,
      expect.stringContaining("https://x.example/g/abc"),
      "ada-digest:c-1",
    );
  });

  it("writes nothing when the send failed, and the same digest is never written twice", async () => {
    mocks.send.mockRejectedValueOnce(new Error("kapso down"));
    expect(
      await dispatchDigest(api, { owner: OWNER, plan: PLAN, idempotencyKey: "d-2" }),
    ).toMatchObject({
      ok: false,
    });
    expect(mocks.mirror).not.toHaveBeenCalled();
    await dispatchDigest(api, { owner: OWNER, plan: PLAN, idempotencyKey: "d-2" });
    await dispatchDigest(api, { owner: OWNER, plan: PLAN, idempotencyKey: "d-2" });
    expect(mocks.mirror).toHaveBeenCalledOnce();
  });
});

describe("what a digest or a brief named is told for the day", () => {
  it("records the deadlines of the digest and of the brief as mentioned today, in the number's own day", async () => {
    await dispatchDigest(api, { owner: OWNER, plan: PLAN, idempotencyKey: "d-3" });
    expect([...(await mentionedOn(memory, "2026-10-27"))].toSorted()).toEqual([
      "d-bianchi",
      "d-rossi",
    ]);

    const other = realStore(tempDirs.make("ada-dispatch-"), "other");
    mocks.memory = other;
    await dispatchDigest(api, {
      owner: OWNER,
      plan: { deliver: false, reason: "nothing_cleared_the_bar" },
      brief: BRIEF,
      idempotencyKey: "b-3",
    });
    expect([...(await mentionedOn(other, "2026-10-27"))]).toEqual(["d-rossi"]);
    expect(await mentionedOn(other, "2026-10-28")).toEqual(new Set());
  });
});

describe("brevity", () => {
  it("drops the sentence that offers another item for a person who asked for shorter texts", async () => {
    await dispatchDigest(api, { owner: OWNER, plan: PLAN, idempotencyKey: "d-4" });
    const long = mocks.send.mock.calls[0]?.[0].text ?? "";
    expect(long).toContain("Tell me if you would rather take another item, or skip it.");

    await memory.setPreference(SHORT_TEXTS_KEY, "Keep it short.", 1);
    await dispatchDigest(api, { owner: OWNER, plan: PLAN, idempotencyKey: "d-5" });
    const short = mocks.send.mock.calls[1]?.[0].text ?? "";
    expect(short).not.toContain("Tell me if you would rather");
    expect(short).toContain("Shall I run it?");
  });
});
