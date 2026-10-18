import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "./memory.js";
import { createSqliteWorkerBackend } from "./memory.worker.js";
import { greetingLanguage, registerWelcomeHook, welcomeEnabled, welcomeText } from "./welcome.js";

const stores = vi.hoisted(() => ({ open: undefined as undefined | (() => MemoryStore) }));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryFromApi: async () => stores.open?.(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const LAWYER = "393330000000";
const ANNA = "393331111111";
const BRUNO = "393332222222";
const DEFAULT_TO = `+${LAWYER}`;
const NOW = 1_800_000_000_000;

type BackendCommand = { type: string; input: unknown };
type Backend = ReturnType<typeof createSqliteWorkerBackend>;

/** Ada's real memory database in `databasePath`, opened the way a gateway process opens it. */
function openStore(databasePath: string): { store: MemoryStore; backend: Backend } {
  const backend = createSqliteWorkerBackend(undefined, { databasePath });
  const run = async (command: BackendCommand) =>
    (backend.execute as (command: BackendCommand) => unknown)(command);
  const store = {
    claimWelcome: (number: string, atMs: number) =>
      run({ type: "claimWelcome", input: { number, atMs } }),
    releaseWelcome: (number: string) => run({ type: "releaseWelcome", input: { number } }),
  } as unknown as MemoryStore;
  return { store, backend };
}

type Entry = { createdAt?: number; sessionStartedAt?: number; updatedAt?: number };
type Inbound = {
  text: string;
  from?: string;
  sessionKey?: string;
  channel?: string;
  group?: boolean;
};

function setup(options: { databasePath?: string } = {}) {
  const databasePath =
    options.databasePath ?? path.join(tempDirs.make("ada-welcome-"), "memory.sqlite");
  const opened = openStore(databasePath);
  stores.open = () => opened.store;

  const sent: Array<{ to: string; text: string }> = [];
  const sendText = vi.fn(async (params: { to: string; text: string }) => {
    sent.push({ to: params.to, text: params.text });
  });
  const sessions = new Map<string, Entry>();
  const warn = vi.fn();
  const info = vi.fn();
  const answered = vi.fn();
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const api = createTestPluginApi({
    id: "ada",
    logger: { info, warn, error: vi.fn(), debug: vi.fn() },
    config: {
      channels: { "kapso-whatsapp": { defaultTo: DEFAULT_TO } },
    } as OpenClawPluginApi["config"],
    runtime: {
      channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
      agent: {
        session: {
          getSessionEntryAsync: async (params: { sessionKey: string }) =>
            sessions.get(params.sessionKey),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"],
    on: ((name: string, hook: typeof handler) => {
      if (name === "before_dispatch") {
        handler = hook;
      }
    }) as OpenClawPluginApi["on"],
  });
  registerWelcomeHook(api, { onGreetingAnswered: answered });

  return {
    databasePath,
    backend: opened.backend,
    sent,
    sendText,
    sessions,
    warn,
    info,
    answered,
    textsTo: (number: string) => sent.filter((entry) => entry.to === `+${number}`),
    async inbound({ text, from = ANNA, sessionKey, channel = "kapso-whatsapp", group }: Inbound) {
      return await handler?.(
        { content: text, body: text, channel, senderId: from, sessionKey, isGroup: group ?? false },
        { channelId: channel, senderId: from, sessionKey },
      );
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("ADA_WELCOME_ENABLED", "");
  vi.stubEnv("VERA_WELCOME_ENABLED", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  stores.open = undefined;
});

describe("first-message welcome", () => {
  it("answers a first greeting with the welcome only and ends the turn", async () => {
    const ada = setup();

    expect(await ada.inbound({ text: "Ciao Ada" })).toEqual({ handled: true });

    expect(ada.textsTo(ANNA).map((entry) => entry.text)).toEqual([welcomeText("it")]);
    expect(ada.answered).toHaveBeenCalledTimes(1);
    void ada.backend.close();
  });

  it("sends the welcome and then lets a first question be answered normally", async () => {
    const ada = setup();

    expect(await ada.inbound({ text: "Entro quanto devo impugnare una multa?" })).toBeUndefined();

    expect(ada.textsTo(ANNA).map((entry) => entry.text)).toEqual([welcomeText("it")]);
    expect(ada.answered).not.toHaveBeenCalled();
    void ada.backend.close();
  });

  it("welcomes a number only once", async () => {
    const ada = setup();
    await ada.inbound({ text: "Ciao" });

    expect(await ada.inbound({ text: "Ciao di nuovo" })).toBeUndefined();
    expect(await ada.inbound({ text: "Cos'è la prescrizione?" })).toBeUndefined();

    expect(ada.textsTo(ANNA)).toHaveLength(1);
    expect(await ada.inbound({ text: "Ciao", from: BRUNO })).toEqual({ handled: true });
    expect(ada.textsTo(BRUNO)).toHaveLength(1);
    void ada.backend.close();
  });

  it("does not welcome a number that already has a conversation, and marks it", async () => {
    const ada = setup();
    const sessionKey = `agent:main:kapso-whatsapp:direct:+${ANNA}`;
    ada.sessions.set(sessionKey, { createdAt: NOW - 3 * 24 * 60 * 60 * 1000 });

    expect(await ada.inbound({ text: "Ciao Ada", sessionKey })).toBeUndefined();
    ada.sessions.clear();
    expect(await ada.inbound({ text: "Ciao Ada", sessionKey })).toBeUndefined();

    expect(ada.sent).toEqual([]);
    void ada.backend.close();
  });

  it("counts a session the host just created for this very message as new", async () => {
    const ada = setup();
    const sessionKey = `agent:main:kapso-whatsapp:direct:${ANNA}`;
    ada.sessions.set(sessionKey, { createdAt: NOW - 500 });

    expect(await ada.inbound({ text: "Ciao", sessionKey })).toEqual({ handled: true });
    void ada.backend.close();
  });

  it("does not read a session shared by every DM as one number's history", async () => {
    const ada = setup();
    ada.sessions.set("agent:main:main", { createdAt: NOW - 30 * 24 * 60 * 60 * 1000 });

    expect(await ada.inbound({ text: "Ciao", sessionKey: "agent:main:main" })).toEqual({
      handled: true,
    });
    void ada.backend.close();
  });

  it("never welcomes the configured lawyer", async () => {
    const ada = setup();

    expect(await ada.inbound({ text: "Ciao Ada", from: DEFAULT_TO })).toBeUndefined();
    expect(await ada.inbound({ text: "Ciao Ada", from: `whatsapp:${LAWYER}` })).toBeUndefined();

    expect(ada.sent).toEqual([]);
    void ada.backend.close();
  });

  it("remembers who was welcomed across a restart", async () => {
    const first = setup();
    await first.inbound({ text: "Ciao" });
    void first.backend.close();

    const second = setup({ databasePath: first.databasePath });
    expect(await second.inbound({ text: "Ciao" })).toBeUndefined();
    expect(second.sent).toEqual([]);
    expect(await second.inbound({ text: "Ciao", from: BRUNO })).toEqual({ handled: true });
    void second.backend.close();
  });

  it.each(["false", "FALSE", "0", "off"])("is off when ADA_WELCOME_ENABLED=%s", async (value) => {
    vi.stubEnv("ADA_WELCOME_ENABLED", value);
    const ada = setup();

    expect(await ada.inbound({ text: "Ciao Ada" })).toBeUndefined();
    expect(ada.sent).toEqual([]);

    vi.stubEnv("ADA_WELCOME_ENABLED", "true");
    expect(await ada.inbound({ text: "Ciao Ada" })).toEqual({ handled: true });
    void ada.backend.close();
  });

  it("still reads the pre-rename VERA_WELCOME_ENABLED", () => {
    expect(welcomeEnabled({})).toBe(true);
    expect(welcomeEnabled({ ADA_WELCOME_ENABLED: "true" })).toBe(true);
    expect(welcomeEnabled({ VERA_WELCOME_ENABLED: "false" })).toBe(false);
  });

  it("lets the model answer a greeting when the welcome could not be sent, and retries later", async () => {
    const ada = setup();
    ada.sendText.mockRejectedValueOnce(new Error("kapso down"));

    expect(await ada.inbound({ text: "Ciao" })).toBeUndefined();
    expect(ada.warn).toHaveBeenCalled();
    expect(await ada.inbound({ text: "Ciao" })).toEqual({ handled: true });

    expect(ada.textsTo(ANNA)).toHaveLength(1);
    void ada.backend.close();
  });

  it("logs every skip with the reason and a masked sender, never the full number", async () => {
    const ada = setup();
    await ada.inbound({ text: "Ciao", from: DEFAULT_TO });
    await ada.inbound({ text: "Ciao", group: true });
    await ada.inbound({ text: "Ciao", channel: "telegram" });
    await ada.inbound({ text: "Ciao", from: "not-a-number" });
    await ada.inbound({ text: "Ciao" });
    await ada.inbound({ text: "Ciao" });
    vi.stubEnv("ADA_WELCOME_ENABLED", "false");
    await ada.inbound({ text: "Ciao", from: BRUNO });

    const lines = ada.info.mock.calls.map(([line]) => String(line));
    const reasons = lines.flatMap((line) => /stage=welcome reason=(\w+)/u.exec(line)?.[1] ?? []);
    expect(reasons).toEqual([
      "configured_lawyer",
      "group_chat",
      "not_whatsapp_channel",
      "sender_not_a_phone_number",
      "already_welcomed",
      "welcome_disabled",
    ]);
    expect(lines.join("\n")).toContain("sender=+39…1111");
    expect(lines.join("\n")).not.toContain(ANNA);
    expect(lines.join("\n")).not.toContain(LAWYER);
    void ada.backend.close();
  });

  it("ignores groups and other channels", async () => {
    const ada = setup();

    expect(await ada.inbound({ text: "Ciao", group: true })).toBeUndefined();
    expect(await ada.inbound({ text: "Ciao", channel: "telegram" })).toBeUndefined();

    expect(ada.sent).toEqual([]);
    void ada.backend.close();
  });

  it("writes the welcome in the language of the first message", async () => {
    const ada = setup();

    await ada.inbound({ text: "Hello Ada", from: "393331000001" });
    await ada.inbound({ text: "hola", from: "393331000002" });
    await ada.inbound({
      text: "What is the deadline for the appeal and is it possible to extend it?",
      from: "393331000003",
    });
    await ada.inbound({ text: "???", from: "393331000004" });

    expect(ada.sent.map((entry) => entry.text)).toEqual([
      welcomeText("en"),
      welcomeText("es"),
      welcomeText("en"),
      welcomeText("it"),
    ]);
    void ada.backend.close();
  });
});

describe("greetingLanguage", () => {
  it.each([
    ["Ciao Ada", "it"],
    ["ciao", "it"],
    ["  CIAO,   ADA!!! ", "it"],
    ["Ciao 👋", "it"],
    ["salve", "it"],
    ["Buongiorno", "it"],
    ["buon pomeriggio Ada", "it"],
    ["Buondì!", "it"],
    ["hi", "en"],
    ["Hello", "en"],
    ["hey Ada", "en"],
    ["Good morning, Ada.", "en"],
    ["hola", "es"],
    ["Buenos días Ada", "es"],
    ["Bonjour", "fr"],
    ["salut ada", "fr"],
    ["Hallo Ada", "de"],
    ["Guten Tag", "de"],
  ])("reads %j as a greeting in %s", (text, language) => {
    expect(greetingLanguage(text)).toBe(language);
  });

  it.each([
    "",
    "👋",
    "Ada",
    "Ciao Ada, mi serve una consulenza",
    "ciao, posso farti una domanda?",
    "Hello Ada can you help me with a contract",
    "buongiorno vorrei sapere i termini di appello",
    "ciao ciao ciao ciao ciao ciao",
    "giorno",
    "Ho bisogno di aiuto",
  ])("reads %j as more than a greeting", (text) => {
    expect(greetingLanguage(text)).toBeUndefined();
  });
});

describe("welcome text", () => {
  const LANGUAGES = ["it", "en", "es", "fr", "de"] as const;

  it("is signed Ada in every language and never says Vera", () => {
    for (const language of LANGUAGES) {
      const text = welcomeText(language);
      expect(text, language).toContain("Ada");
      expect(text, language).toContain("Lexroom");
      expect(text, language).not.toMatch(/vera/iu);
    }
  });

  it("tells the user how to connect Lexroom and Gmail with phrases the connect skills answer", () => {
    const phrases = {
      it: ["«collega Lexroom»", "«collega Gmail»"],
      en: ['"connect Lexroom"', '"connect Gmail"'],
      es: ['"conecta Lexroom"', '"conecta Gmail"'],
      fr: ['"connecte Lexroom"', '"connecte Gmail"'],
      de: ['"Lexroom verbinden"', '"Gmail verbinden"'],
    } as const;
    for (const language of LANGUAGES) {
      for (const phrase of phrases[language]) {
        expect(welcomeText(language), `${language} ${phrase}`).toContain(phrase);
      }
    }
  });

  it("lists legal questions, then Lexroom research, then Gmail and calendar", () => {
    for (const language of LANGUAGES) {
      const text = welcomeText(language);
      const bullets = text.split("\n").filter((line) => line.startsWith("•"));
      expect(bullets.slice(0, 3).map((line) => /Lexroom|Gmail/u.exec(line)?.[0])).toEqual([
        undefined,
        "Lexroom",
        "Gmail",
      ]);
    }
  });

  it("fits one WhatsApp message", () => {
    for (const language of LANGUAGES) {
      expect(welcomeText(language).length, language).toBeLessThan(1200);
    }
  });
});
