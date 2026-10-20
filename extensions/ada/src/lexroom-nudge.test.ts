import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openAdaMemoryFromApi = vi.hoisted(() => vi.fn());
const openAdaLexroomAccountFromApi = vi.hoisted(() => vi.fn());
const openAdaGoogleAccountFromApi = vi.hoisted(() => vi.fn());
const openAdaGranolaAccountFromApi = vi.hoisted(() => vi.fn());

vi.mock("./memory.js", () => ({ openAdaMemoryFromApi }));
vi.mock("./lexroom-account.js", () => ({ openAdaLexroomAccountFromApi }));
vi.mock("./google-account.js", () => ({ openAdaGoogleAccountFromApi }));
vi.mock("./granola-account.js", () => ({ openAdaGranolaAccountFromApi }));

import { connectOfferNote, takeConnectOffers } from "./connect-offers.js";
import { unfinishedConnectDue, unfinishedConnectNote } from "./connect-reminder.js";
import {
  LEXROOM_NUDGE_NOTE,
  LEXROOM_OFFER_COOLDOWN_MS,
  LEXROOM_RESEARCH_FIRST_NOTE,
  lexroomNudgeDue,
  registerLexroomNudge,
  replyMadeLexroomOffer,
} from "./lexroom-nudge.js";
import {
  connectDeclinedKey,
  connectRemindedKey,
  EMPTY_WAKE_STATE,
  LEXROOM_OFFER_DECLINED_KEY,
} from "./memory-contract.js";
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
  let google: { account: unknown; linkExpiresAtMs: number | null };
  let granola: { account: unknown; linkExpiresAtMs: number | null };
  let lexroomLinkExpiresAtMs: number | null;
  let clock: number;
  const writeWake = vi.fn(async (patch: Partial<typeof EMPTY_WAKE_STATE>) => {
    wake = { ...wake, ...patch };
  });
  const setPreference = vi.fn(async (key: string, text: string, atMs: number) => {
    preferences = [
      ...preferences.filter((entry) => entry.key !== key),
      { key, text, updatedAtMs: atMs },
    ];
    return { ok: true, replaced: false };
  });

  const LINK = "https://gateway.example/l/AbCdEfGhIj";
  let handlers: Map<string, Handler>;
  /** The reply to a turn went out carrying `text`; the offer counts only if it really was made. */
  const sent = (owner: string, runId: string, text: string, success = true) =>
    handlers.get("message_sent")?.(
      { to: `+${owner}`, content: text, success, runId, sessionKey: sessionOf(owner) },
      { channelId: "kapso-whatsapp" },
    );
  const toolCalled = (owner: string, runId: string, toolName: string, error?: string) =>
    handlers.get("after_tool_call")?.(
      { toolName, params: {}, runId, ...(error ? { error } : {}) },
      { sessionKey: sessionOf(owner) },
    );
  const sessionOf = (owner: string) => `agent:main:kapso-whatsapp:direct:${owner}`;

  function hook(pluginConfig: Record<string, unknown> = PLUGIN_CONFIG): Handler {
    handlers = new Map();
    registerLexroomNudge(
      createTestPluginApi({
        id: "ada",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        pluginConfig,
        config: { channels: { "kapso-whatsapp": { defaultTo: "+390000000000" } } },
        on: ((name: string, registered: Handler) => {
          handlers.set(name, registered);
        }) as OpenClawPluginApi["on"],
      }),
      () => new Date(clock),
    );
    const handler = handlers.get("before_prompt_build");
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
    sessionKey: sessionOf(owner),
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
    google = { account: null, linkExpiresAtMs: null };
    granola = { account: null, linkExpiresAtMs: null };
    lexroomLinkExpiresAtMs = null;
    clock = NOON;
    writeWake.mockClear();
    setPreference.mockClear();
    openAdaLexroomAccountFromApi.mockResolvedValue({
      readAccount: async () => account,
      pendingExpiresAt: async () => lexroomLinkExpiresAtMs,
    });
    openAdaGoogleAccountFromApi.mockResolvedValue({
      readAccount: async () => google.account,
      pendingExpiresAt: async () => google.linkExpiresAtMs,
    });
    openAdaGranolaAccountFromApi.mockResolvedValue({
      readAccount: async () => granola.account,
      pendingExpiresAt: async () => granola.linkExpiresAtMs,
    });
    openAdaMemoryFromApi.mockResolvedValue({
      readWake: async () => wake,
      listPreferences: async () => preferences,
      readProfile: async () => null,
      writeWake,
      setPreference,
    });
  });

  it("offers on the first turn of a number that has not connected Lexroom, and records it once Ada made the offer", async () => {
    const owner = freshNumber();
    await expect(hook()({}, ctxFor(owner))).resolves.toEqual(offered);
    expect(writeWake).not.toHaveBeenCalled();
    await sent(owner, "run-1", `Collega Lexroom per risposte con fonti: ${LINK}`);
    expect(writeWake).toHaveBeenCalledWith({ lastConnectNudgeAtMs: NOON });
  });

  it("asks the next turn of that number to read a yes or a no against the offer, once it was made", async () => {
    const owner = freshNumber();
    await hook()({}, ctxFor(owner));
    expect(takeConnectOffers(owner, { runId: "run-0", inboundAtMs: NOON + 1_000 })).toEqual([]);
    await sent(owner, "run-1", `Collega Lexroom: ${LINK}`);
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
    await sent(owner, "a", `Con Lexroom le risposte hanno le fonti. ${LINK}`);
    clock = NOON + 60 * 60 * 1000;
    await expect(ask({}, ctxFor(owner, { runId: "b" }))).resolves.toBeUndefined();
    clock = NOON + DAY_MS;
    await expect(ask({}, ctxFor(owner, { runId: "c" }))).resolves.toEqual(offered);
  });

  it("repeats the offer for a retry of the same run, and not for another run once it was made", async () => {
    const owner = freshNumber();
    const ask = hook();
    await expect(ask({}, ctxFor(owner, { runId: "r1" }))).resolves.toEqual(offered);
    await expect(ask({}, ctxFor(owner, { runId: "r1" }))).resolves.toEqual(offered);
    await sent(owner, "r1", `Lexroom: ${LINK}`);
    await sent(owner, "r1", "Ed ecco la risposta, con una seconda parte su Lexroom.");
    await expect(ask({}, ctxFor(owner, { runId: "r2" }))).resolves.toBeUndefined();
    expect(writeWake).toHaveBeenCalledTimes(1);
  });

  it("does not use up the day's offer on a turn where Ada did not make it, such as a greeting", async () => {
    const owner = freshNumber();
    const ask = hook();
    await expect(ask({}, ctxFor(owner, { runId: "hello" }))).resolves.toEqual(offered);
    await sent(owner, "hello", "Ciao! Come posso aiutarti oggi?");
    expect(writeWake).not.toHaveBeenCalled();
    expect(takeConnectOffers(owner, { runId: "next", inboundAtMs: NOON + 1_000 })).toEqual([]);
    clock = NOON + 60 * 1000;
    await expect(ask({}, ctxFor(owner, { runId: "question" }))).resolves.toEqual(offered);
    await sent(owner, "question", `Con Lexroom ottieni fonti: ${LINK}\n\nEcco la risposta.`);
    expect(writeWake).toHaveBeenCalledTimes(1);
    clock = NOON + 2 * 60 * 1000;
    await expect(ask({}, ctxFor(owner, { runId: "later" }))).resolves.toBeUndefined();
  });

  it("counts the offer as made when Ada called the connect tool, and only then", async () => {
    const owner = freshNumber();
    const ask = hook();
    await ask({}, ctxFor(owner, { runId: "t1" }));
    await toolCalled(owner, "t1", "ada_research");
    await toolCalled(owner, "t1", "ada_lexroom_connect", "link failed");
    await toolCalled(owner, "other-run", "ada_lexroom_connect");
    expect(writeWake).not.toHaveBeenCalled();
    await toolCalled(owner, "t1", "ada_lexroom_connect");
    expect(writeWake).toHaveBeenCalledWith({ lastConnectNudgeAtMs: NOON });
  });

  it("ignores a failed send, another run's reply, and replies that do not offer", async () => {
    const owner = freshNumber();
    await hook()({}, ctxFor(owner, { runId: "r1" }));
    await sent(owner, "r1", `Lexroom: ${LINK}`, false);
    await sent(owner, "r2", `Lexroom: ${LINK}`);
    await sent(owner, "r1", "Il termine è di trenta giorni dalla notifica.");
    expect(writeWake).not.toHaveBeenCalled();
    expect(replyMadeLexroomOffer(`vai su ${LINK}`)).toBe(true);
    expect(replyMadeLexroomOffer("Posso collegare il tuo account LEXROOM")).toBe(true);
    expect(replyMadeLexroomOffer("https://example.com/x/abc")).toBe(false);
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

  describe("a connection that was started and never finished", () => {
    const connectedLexroom = () => {
      account = { email: "anna@example.com", accessToken: "token" };
    };

    it("adds one gentle line to the next reply, once, for a Google link that ran out", async () => {
      connectedLexroom();
      const owner = freshNumber();
      setGoogleLinkExpired();
      const ask = hook();
      const first = (await ask({}, ctxFor(owner, { runId: "a" }))) as { prependContext: string };
      expect(first.prependContext).toContain(LEXROOM_RESEARCH_FIRST_NOTE);
      expect(first.prependContext).toContain("Gmail and Google Calendar");
      expect(setPreference).toHaveBeenCalledWith(
        connectRemindedKey("google"),
        expect.any(String),
        NOON,
      );
      await expect(ask({}, ctxFor(owner, { runId: "b" }))).resolves.toEqual(researchFirst);
      expect(setPreference).toHaveBeenCalledTimes(1);
    });

    it("asks the number's next turn to read a yes or a no against it", async () => {
      connectedLexroom();
      const owner = freshNumber();
      setGoogleLinkExpired();
      await hook()({}, ctxFor(owner));
      expect(takeConnectOffers(owner, { runId: "next", inboundAtMs: NOON + 1_000 })).toEqual([
        { kind: "connect_reminder", detail: "google" },
      ]);
    });

    it("gives a retry of the same run the same line without marking it twice", async () => {
      connectedLexroom();
      const owner = freshNumber();
      setGoogleLinkExpired();
      const ask = hook();
      const first = await ask({}, ctxFor(owner, { runId: "r1" }));
      const again = await ask({}, ctxFor(owner, { runId: "r1" }));
      expect(again).toEqual(first);
      expect(setPreference).toHaveBeenCalledTimes(1);
    });

    it("stays quiet when the account got connected, the link is still usable, or nothing was ever sent", async () => {
      connectedLexroom();
      const ask = hook();
      setGoogleLinkExpired();
      google.account = { email: "anna@example.com" };
      await expect(ask({}, ctxFor(freshNumber()))).resolves.toEqual(researchFirst);
      google.account = null;
      google.linkExpiresAtMs = NOON + 60_000;
      await expect(ask({}, ctxFor(freshNumber()))).resolves.toEqual(researchFirst);
      google.linkExpiresAtMs = null;
      await expect(ask({}, ctxFor(freshNumber()))).resolves.toEqual(researchFirst);
      expect(setPreference).not.toHaveBeenCalled();
    });

    it("stays quiet after a no, and when the tool is not available to the turn", async () => {
      connectedLexroom();
      setGoogleLinkExpired();
      preferences = [{ key: connectDeclinedKey("google"), text: "Declined.", updatedAtMs: NOON }];
      await expect(hook()({}, ctxFor(freshNumber()))).resolves.toEqual(researchFirst);
      preferences = [];
      const noGoogle = {
        toolAuthority: {
          allows: (tool: string) => tool !== "ada_google_connect",
          assertActive: () => {},
        },
      };
      await expect(hook()({}, ctxFor(freshNumber(), noGoogle))).resolves.toEqual(researchFirst);
      expect(setPreference).not.toHaveBeenCalled();
    });

    it("shows one line per turn and each account once: Google, then Granola, then nothing", async () => {
      connectedLexroom();
      const owner = freshNumber();
      setGoogleLinkExpired();
      granola.linkExpiresAtMs = NOON - 1_000;
      const ask = hook();
      const textOf = async (runId: string) =>
        ((await ask({}, ctxFor(owner, { runId }))) as { prependContext: string }).prependContext;
      expect(await textOf("a")).toContain("Gmail and Google Calendar");
      const second = await textOf("b");
      expect(second).toContain("Granola");
      expect(second).not.toContain("Gmail and Google Calendar");
      expect(await textOf("c")).toBe(LEXROOM_RESEARCH_FIRST_NOTE);
    });

    it("never repeats the Lexroom offer as a reminder in the same turn, but reminds once its link ran out", async () => {
      const owner = freshNumber();
      lexroomLinkExpiresAtMs = NOON - 60_000;
      const ask = hook();
      const turn = (await ask({}, ctxFor(owner, { runId: "a" }))) as { prependContext: string };
      expect(turn).toEqual(offered);
      expect(setPreference).not.toHaveBeenCalled();
      await sent(owner, "a", `Collega Lexroom: ${LINK}`);

      clock = NOON + 60 * 60 * 1000;
      const later = (await ask({}, ctxFor(owner, { runId: "b" }))) as { prependContext: string };
      expect(later.prependContext).toContain("# Unfinished connection");
      expect(later.prependContext).toContain("Lexroom account");
      expect(later.prependContext).not.toContain("# Offer to connect Lexroom");
    });

    it("does not remind a number that declined the Lexroom offer", async () => {
      lexroomLinkExpiresAtMs = NOON - 60_000;
      preferences = [{ key: LEXROOM_OFFER_DECLINED_KEY, text: "Declined.", updatedAtMs: NOON }];
      await expect(hook()({}, ctxFor(freshNumber()))).resolves.toBeUndefined();
      expect(setPreference).not.toHaveBeenCalled();
    });

    it("costs a number that never started a connection nothing but the link reads", async () => {
      connectedLexroom();
      await expect(hook()({}, ctxFor(freshNumber()))).resolves.toEqual(researchFirst);
      expect(setPreference).not.toHaveBeenCalled();
    });

    function setGoogleLinkExpired() {
      google.linkExpiresAtMs = NOON - 60 * 60 * 1000;
    }
  });

  it("offers nothing when this install cannot make a connect link", async () => {
    await expect(hook({})({}, ctxFor(freshNumber()))).resolves.toBeUndefined();
  });

  it("keeps the answer going when the stores fail", async () => {
    openAdaLexroomAccountFromApi.mockRejectedValue(new Error("disk"));
    await expect(hook()({}, ctxFor(freshNumber()))).resolves.toBeUndefined();
  });
});

describe("the unfinished-connection line", () => {
  const facts = {
    nowMs: NOON,
    connected: false,
    linkExpiresAtMs: NOON - 60_000,
    reminded: false,
    declined: false,
    offeredThisTurn: false,
  };

  it("is due for a link that ran out unused on an account that is still not connected", () => {
    expect(unfinishedConnectDue(facts)).toBe(true);
    expect(unfinishedConnectDue({ ...facts, linkExpiresAtMs: NOON })).toBe(true);
  });

  it("is not due when connected, when no link was sent or it is still usable, when shown or declined, or when the offer covers it", () => {
    for (const change of [
      { connected: true },
      { linkExpiresAtMs: null },
      { linkExpiresAtMs: NOON + 1 },
      { reminded: true },
      { declined: true },
      { offeredThisTurn: true },
    ]) {
      expect(unfinishedConnectDue({ ...facts, ...change })).toBe(false);
    }
  });

  it("asks for one short line in the person's language, with no phrase to type and no link yet", () => {
    const note = unfinishedConnectNote("google");
    expect(note).toContain("ONE short, gentle line");
    expect(note).toContain("language of their latest message");
    expect(note).toContain("Gmail and Google Calendar");
    expect(note).toContain(
      "Do not call ada_google_connect and do not write a link until they say yes",
    );
    expect(note).toContain("Never tell them to type a word or phrase");
    expect(note).toContain("do not sign");
    expect(unfinishedConnectNote("granola")).toContain("ada_granola_connect");
  });

  it("carries a yes to the connect tool and a no to a decline preference on the next turn", () => {
    const note = connectOfferNote([{ kind: "connect_reminder", detail: "google" }]) ?? "";
    expect(note).toContain("ada_google_connect");
    expect(note).toContain(`ada_set_preference with key ${connectDeclinedKey("google")}`);
    expect(connectOfferNote([{ kind: "connect_reminder", detail: "nonsense" }])).toBeUndefined();
  });
});
