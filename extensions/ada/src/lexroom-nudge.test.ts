import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openAdaMemoryFromApi = vi.hoisted(() => vi.fn());
const openAdaLexroomAccountFromApi = vi.hoisted(() => vi.fn());

vi.mock("./memory.js", () => ({ openAdaMemoryFromApi }));
vi.mock("./lexroom-account.js", () => ({ openAdaLexroomAccountFromApi }));

import { connectOfferNote, takeConnectOffers } from "./connect-offers.js";
import {
  LEXROOM_NUDGE_NOTE,
  LEXROOM_OFFER_COOLDOWN_MS,
  LEXROOM_RESEARCH_FIRST_NOTE,
  lexroomNudgeDue,
  registerLexroomNudge,
} from "./lexroom-nudge.js";
import { EMPTY_WAKE_STATE, LEXROOM_OFFER_DECLINED_KEY } from "./memory-contract.js";
import { mintShortLink } from "./short-links.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOON = Date.parse("2026-10-20T10:00:00.000Z");

describe("when the Lexroom offer is due", () => {
  const facts = {
    nowMs: NOON,
    timeZone: "Europe/Rome",
    connected: false,
    linkLive: false,
    lastNudgeAtMs: null,
    declinedAtMs: null,
  };

  it("is due for a number that has not connected and was never asked", () => {
    expect(lexroomNudgeDue(facts)).toBe(true);
  });

  it("is never due once Lexroom is connected or a connect link is still live", () => {
    expect(lexroomNudgeDue({ ...facts, connected: true })).toBe(false);
    expect(lexroomNudgeDue({ ...facts, linkLive: true })).toBe(false);
  });

  it("is due once per local day, counted on the number's own clock", () => {
    const earlierToday = NOON - 3 * 60 * 60 * 1000;
    expect(lexroomNudgeDue({ ...facts, lastNudgeAtMs: earlierToday })).toBe(false);
    expect(lexroomNudgeDue({ ...facts, lastNudgeAtMs: NOON - DAY_MS })).toBe(true);
    // 23:30 in Rome and 00:30 the next day are 1 hour apart but on different local days.
    const lateRome = Date.parse("2026-10-19T21:30:00.000Z");
    const afterMidnightRome = Date.parse("2026-10-19T22:30:00.000Z");
    expect(lexroomNudgeDue({ ...facts, nowMs: afterMidnightRome, lastNudgeAtMs: lateRome })).toBe(
      true,
    );
    expect(
      lexroomNudgeDue({
        ...facts,
        timeZone: "UTC",
        nowMs: afterMidnightRome,
        lastNudgeAtMs: lateRome,
      }),
    ).toBe(false);
  });

  it("stays quiet for seven days after a no, then is due again", () => {
    expect(lexroomNudgeDue({ ...facts, declinedAtMs: NOON - 2 * DAY_MS })).toBe(false);
    expect(lexroomNudgeDue({ ...facts, declinedAtMs: NOON - LEXROOM_OFFER_COOLDOWN_MS + 1 })).toBe(
      false,
    );
    expect(lexroomNudgeDue({ ...facts, declinedAtMs: NOON - LEXROOM_OFFER_COOLDOWN_MS })).toBe(
      true,
    );
  });
});

describe("the offer note", () => {
  it("opens the reply with the offer and the link, in the person's language, with no command phrase", () => {
    expect(LEXROOM_NUDGE_NOTE).toMatch(/open your reply with one or two short, natural sentences/u);
    expect(LEXROOM_NUDGE_NOTE).toMatch(/case law and doctrine research, with the sources/u);
    expect(LEXROOM_NUDGE_NOTE).toMatch(/Call ada_lexroom_connect first and put the short link/u);
    expect(LEXROOM_NUDGE_NOTE).toMatch(/offer to send the link instead/u);
    expect(LEXROOM_NUDGE_NOTE).toMatch(/language of their latest message/u);
    expect(LEXROOM_NUDGE_NOTE).toMatch(/do not sign/u);
    expect(LEXROOM_NUDGE_NOTE).toMatch(/Never tell them to type a word or phrase/u);
  });

  it("gives the full answer in the same reply, never waiting on the offer", () => {
    expect(LEXROOM_NUDGE_NOTE).toMatch(/in the same reply, give your full answer/u);
    expect(LEXROOM_NUDGE_NOTE).toMatch(/never waits for them to connect or to reply/u);
    expect(LEXROOM_NUDGE_NOTE.indexOf("open your reply")).toBeLessThan(
      LEXROOM_NUDGE_NOTE.indexOf("give your full answer"),
    );
  });

  it("says nothing about Lexroom, and calls no tool, for a message that is not a legal question", () => {
    expect(LEXROOM_NUDGE_NOTE).toMatch(
      /not a legal question[^.]*do not mention Lexroom at all and do not call the tool/u,
    );
  });

  it("carries a yes to the connect tool and a no to the declined preference on the next turn", () => {
    const note = connectOfferNote([{ kind: "lexroom_nudge" }]) ?? "";
    expect(note).toContain("ada_lexroom_connect");
    expect(note).toContain("opened with an offer");
    expect(note).toContain("did not send the link");
    expect(note).toContain(`ada_set_preference with key ${LEXROOM_OFFER_DECLINED_KEY}`);
    expect(note).toContain("ignore this if it did not");
  });
});

describe("the research-first note", () => {
  it("tells the model to call ada_research before any answer, and not to answer from memory first", () => {
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/Lexroom is always the preferred way/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/call ada_research before you write any answer/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/do not answer from your own knowledge first/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/otherwise "general"/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/end the turn with exactly NO_REPLY/u);
  });

  it("allows Ada's own knowledge only when Lexroom fails or times out, and says so briefly", () => {
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(
      /Only if ada_research cannot start or returns an error, or reason timeout, answer from your own knowledge/u,
    );
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/say so in one short sentence/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/no invented sources/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/not_connected or forbidden/u);
  });

  it("leaves non-legal messages and follow-ups alone, in the person's language, unsigned", () => {
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/needs no new research/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/not a legal question[^.]*do not call it/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/language of their latest message/u);
    expect(LEXROOM_RESEARCH_FIRST_NOTE).toMatch(/do not sign/u);
  });

  it("is never mixed up with the offer note", () => {
    expect(LEXROOM_RESEARCH_FIRST_NOTE).not.toContain("Offer to connect");
    expect(LEXROOM_NUDGE_NOTE).not.toContain("Lexroom research first");
  });
});

describe("the offer hook", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

  const PLUGIN_CONFIG = {
    googleRedirectUri: "https://gateway.example/ada/google/callback",
    googleStateSecret: "state-secret-test-value",
  };
  let number = 0;
  const freshNumber = () => `39333${String(1_000_000 + ++number)}`;

  let preferences: Array<{ key: string; text: string; updatedAtMs: number }>;
  let wake: typeof EMPTY_WAKE_STATE;
  let account: unknown;
  let clock: number;
  const writeWake = vi.fn(async (patch: Partial<typeof EMPTY_WAKE_STATE>) => {
    wake = { ...wake, ...patch };
  });

  function hook(pluginConfig: Record<string, unknown> = PLUGIN_CONFIG): Handler {
    let handler: Handler | undefined;
    registerLexroomNudge(
      createTestPluginApi({
        id: "ada",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        pluginConfig,
        config: { channels: { "kapso-whatsapp": { defaultTo: "+390000000000" } } },
        on: ((_name: string, registered: Handler) => {
          handler = registered;
        }) as OpenClawPluginApi["on"],
      }),
      () => new Date(clock),
    );
    if (!handler) {
      throw new Error("offer hook missing");
    }
    return handler;
  }

  const ctxFor = (owner: string, extra: Record<string, unknown> = {}) => ({
    senderId: owner,
    channel: "kapso-whatsapp",
    // In an agent hook context the channel id is the conversation: the number, in a private chat.
    channelId: owner,
    sessionKey: `agent:main:kapso-whatsapp:direct:${owner}`,
    runId: "run-1",
    trigger: "user",
    toolAuthority: { allows: () => true, assertActive: () => {} },
    ...extra,
  });
  const offered = { prependContext: LEXROOM_NUDGE_NOTE };
  const researchFirst = { prependContext: LEXROOM_RESEARCH_FIRST_NOTE };

  beforeEach(() => {
    preferences = [];
    wake = { ...EMPTY_WAKE_STATE };
    account = null;
    clock = NOON;
    writeWake.mockClear();
    openAdaLexroomAccountFromApi.mockResolvedValue({ readAccount: async () => account });
    openAdaMemoryFromApi.mockResolvedValue({
      readWake: async () => wake,
      listPreferences: async () => preferences,
      readProfile: async () => null,
      writeWake,
    });
  });

  it("offers on the first turn of a number that has not connected Lexroom, and records it", async () => {
    const owner = freshNumber();
    await expect(hook()({}, ctxFor(owner))).resolves.toEqual(offered);
    expect(writeWake).toHaveBeenCalledWith({ lastConnectNudgeAtMs: NOON });
  });

  it("asks the next turn of that number to read a yes or a no against the offer", async () => {
    const owner = freshNumber();
    await hook()({}, ctxFor(owner));
    const taken = takeConnectOffers(owner, { runId: "run-2", inboundAtMs: NOON + 60_000 });
    expect(taken).toEqual([{ kind: "lexroom_nudge", detail: undefined }]);
  });

  it("does not offer when Lexroom is already connected, and asks for Lexroom research first instead", async () => {
    account = { email: "anna@example.com", accessToken: "token" };
    await expect(hook()({}, ctxFor(freshNumber()))).resolves.toEqual(researchFirst);
    expect(writeWake).not.toHaveBeenCalled();
  });

  it("asks for Lexroom research first on every turn while connected, not once a day", async () => {
    account = { email: "anna@example.com", accessToken: "token" };
    const owner = freshNumber();
    const ask = hook();
    await expect(ask({}, ctxFor(owner, { runId: "a" }))).resolves.toEqual(researchFirst);
    clock = NOON + 60 * 1000;
    await expect(ask({}, ctxFor(owner, { runId: "b" }))).resolves.toEqual(researchFirst);
    clock = NOON + 3 * DAY_MS;
    await expect(ask({}, ctxFor(owner, { runId: "c" }))).resolves.toEqual(researchFirst);
  });

  it("asks for it even when the person once declined the offer or a link is still live", async () => {
    account = { email: "anna@example.com", accessToken: "token" };
    preferences = [{ key: LEXROOM_OFFER_DECLINED_KEY, text: "Declined.", updatedAtMs: NOON }];
    await expect(hook()({}, ctxFor(freshNumber()))).resolves.toEqual(researchFirst);
  });

  it("asks for it for the configured lawyer who uses the static token", async () => {
    const lawyer = "390000000000";
    await expect(
      hook({ ...PLUGIN_CONFIG, accessToken: "static-lexroom-token" })({}, ctxFor(lawyer)),
    ).resolves.toEqual(researchFirst);
  });

  it("never asks for research first of a number without Lexroom, and never offers to one with it", async () => {
    const ask = hook();
    const without = await ask({}, ctxFor(freshNumber()));
    expect(without).toEqual(offered);
    expect(JSON.stringify(without)).not.toContain("Lexroom research first");
    account = { email: "anna@example.com", accessToken: "token" };
    const withLexroom = await ask({}, ctxFor(freshNumber()));
    expect(JSON.stringify(withLexroom)).not.toContain("Offer to connect Lexroom");
  });

  it("asks for research only when ada_research is available to the turn", async () => {
    account = { email: "anna@example.com", accessToken: "token" };
    const only = (name: string) => ({
      toolAuthority: { allows: (tool: string) => tool === name, assertActive: () => {} },
    });
    await expect(
      hook()({}, ctxFor(freshNumber(), only("ada_lexroom_connect"))),
    ).resolves.toBeUndefined();
    await expect(hook()({}, ctxFor(freshNumber(), only("ada_research")))).resolves.toEqual(
      researchFirst,
    );
  });

  it("adds the research instruction to a person's own private turn only", async () => {
    account = { email: "anna@example.com", accessToken: "token" };
    const owner = freshNumber();
    const ask = hook();
    await expect(ask({}, ctxFor(owner, { channel: "telegram" }))).resolves.toBeUndefined();
    await expect(
      ask({}, ctxFor(owner, { sessionKey: `agent:main:kapso-whatsapp:group:${owner}` })),
    ).resolves.toBeUndefined();
    await expect(ask({}, ctxFor(owner, { trigger: "cron" }))).resolves.toBeUndefined();
    await expect(ask({}, ctxFor(owner, { trigger: "heartbeat" }))).resolves.toBeUndefined();
  });

  it("does not offer while a connect link sent a moment ago is still usable", async () => {
    const owner = freshNumber();
    mintShortLink({
      kind: "l",
      owner,
      nonce: "n",
      target: "https://gateway.example/ada/lexroom/connect?state=x",
      expiresAtMs: NOON + 30 * 60 * 1000,
      now: new Date(NOON),
    });
    await expect(hook()({}, ctxFor(owner))).resolves.toBeUndefined();
    clock = NOON + 31 * 60 * 1000;
    await expect(hook()({}, ctxFor(owner))).resolves.toEqual(offered);
  });

  it("offers at most once per local day and again the day after", async () => {
    const owner = freshNumber();
    const ask = hook();
    await expect(ask({}, ctxFor(owner, { runId: "a" }))).resolves.toEqual(offered);
    clock = NOON + 60 * 60 * 1000;
    await expect(ask({}, ctxFor(owner, { runId: "b" }))).resolves.toBeUndefined();
    clock = NOON + DAY_MS;
    await expect(ask({}, ctxFor(owner, { runId: "c" }))).resolves.toEqual(offered);
  });

  it("repeats the offer for a retry of the same run, never for another run", async () => {
    const owner = freshNumber();
    const ask = hook();
    await expect(ask({}, ctxFor(owner, { runId: "r1" }))).resolves.toEqual(offered);
    await expect(ask({}, ctxFor(owner, { runId: "r1" }))).resolves.toEqual(offered);
    await expect(ask({}, ctxFor(owner, { runId: "r2" }))).resolves.toBeUndefined();
    expect(writeWake).toHaveBeenCalledTimes(1);
  });

  it("stops offering for seven days after a no", async () => {
    const owner = freshNumber();
    preferences = [{ key: LEXROOM_OFFER_DECLINED_KEY, text: "Declined.", updatedAtMs: NOON }];
    const ask = hook();
    clock = NOON + 3 * DAY_MS;
    await expect(ask({}, ctxFor(owner))).resolves.toBeUndefined();
    clock = NOON + LEXROOM_OFFER_COOLDOWN_MS + 1_000;
    await expect(ask({}, ctxFor(owner))).resolves.toEqual(offered);
  });

  it("offers to nobody it cannot name: other channels, groups, cron runs, no connect tool", async () => {
    const owner = freshNumber();
    const ask = hook();
    await expect(ask({}, ctxFor(owner, { channel: "telegram" }))).resolves.toBeUndefined();
    await expect(
      ask({}, ctxFor(owner, { sessionKey: `agent:main:kapso-whatsapp:group:${owner}` })),
    ).resolves.toBeUndefined();
    await expect(ask({}, ctxFor(owner, { trigger: "cron" }))).resolves.toBeUndefined();
    await expect(
      ask({}, ctxFor(owner, { toolAuthority: { allows: () => false, assertActive: () => {} } })),
    ).resolves.toBeUndefined();
    expect(writeWake).not.toHaveBeenCalled();
  });

  it("offers nothing when this install cannot make a connect link", async () => {
    await expect(hook({})({}, ctxFor(freshNumber()))).resolves.toBeUndefined();
  });

  it("keeps the answer going when the stores fail", async () => {
    openAdaLexroomAccountFromApi.mockRejectedValue(new Error("disk"));
    await expect(hook()({}, ctxFor(freshNumber()))).resolves.toBeUndefined();
  });
});
