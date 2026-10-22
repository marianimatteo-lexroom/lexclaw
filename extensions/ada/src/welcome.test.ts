import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeConnectOffers } from "./connect-offers.js";
import type { MemoryStore } from "./memory.js";
import { createSqliteWorkerBackend } from "./memory.worker.js";
import { greetingLanguage, registerWelcomeHook, welcomeEnabled, welcomeText } from "./welcome.js";

const stores = vi.hoisted(() => ({ open: undefined as undefined | (() => MemoryStore) }));
const mirror = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./transcript-mirror.js", () => ({ mirrorToSessionKey: mirror }));
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaRegistryFromApi: async () => stores.open?.(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const LAWYER = "393330000000";
const ANNA = "393331111111";
const BRUNO = "393332222222";
const DEFAULT_TO = `+${LAWYER}`;
const NOW = 1_800_000_000_000;
const ALL = { outlook: true, reminders: true, question: true };
const NONE = { outlook: false, reminders: false, question: true };
const NO_QUESTION = { outlook: false, reminders: false, question: false };

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

function setup(options: { databasePath?: string; pluginConfig?: Record<string, unknown> } = {}) {
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
    ...(options.pluginConfig ? { pluginConfig: options.pluginConfig } : {}),
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
  mirror.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("ADA_WELCOME_ENABLED", "");
  vi.stubEnv("VERA_WELCOME_ENABLED", "");
  for (const name of ["MS_CLIENT_ID", "MS_CLIENT_SECRET"]) {
    vi.stubEnv(`ADA_${name}`, "");
    vi.stubEnv(`VERA_${name}`, "");
  }
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

    expect(ada.textsTo(ANNA).map((entry) => entry.text)).toEqual([welcomeText("it", NONE)]);
    expect(ada.answered).toHaveBeenCalledTimes(1);
    // Their reply to the closing question reaches the model with a note saying what it answers.
    expect(
      takeConnectOffers(ANNA, { inboundAtMs: NOW + 1_000, nowMs: NOW + 1_000 }).map(
        (offer) => offer.kind,
      ),
    ).toEqual(["welcome_question"]);
    void ada.backend.close();
  });

  it("sends the welcome and then lets a first question be answered normally", async () => {
    const ada = setup();

    expect(await ada.inbound({ text: "Entro quanto devo impugnare una multa?" })).toBeUndefined();

    expect(ada.textsTo(ANNA).map((entry) => entry.text)).toEqual([welcomeText("it", NO_QUESTION)]);
    expect(ada.textsTo(ANNA)[0]?.text).not.toContain("?");
    expect(ada.answered).not.toHaveBeenCalled();
    expect(takeConnectOffers(ANNA, { inboundAtMs: NOW + 1_000, nowMs: NOW + 1_000 })).toEqual([]);
    void ada.backend.close();
  });

  it("names Outlook and deadline reminders only when this deployment has them", async () => {
    vi.stubEnv("ADA_MS_CLIENT_ID", "client");
    vi.stubEnv("ADA_MS_CLIENT_SECRET", "secret");
    const ada = setup({ pluginConfig: { deadlineIntake: { enabled: true } } });
    await ada.inbound({ text: "Ciao Ada" });
    expect(ada.textsTo(ANNA).map((entry) => entry.text)).toEqual([welcomeText("it", ALL)]);
    expect(ada.textsTo(ANNA)[0]?.text).toMatch(/Gmail o Outlook[\s\S]*udienze e scadenze/u);
    void ada.backend.close();

    vi.stubEnv("ADA_MS_CLIENT_ID", "");
    vi.stubEnv("ADA_MS_CLIENT_SECRET", "");
    const bare = setup();
    await bare.inbound({ text: "Ciao Ada", from: BRUNO });
    expect(bare.textsTo(BRUNO)[0]?.text).not.toMatch(/Outlook|udienze e scadenze/u);
    void bare.backend.close();
  });

  it("writes the welcome into the conversation, so the answer that follows knows it was said", async () => {
    const ada = setup();
    const sessionKey = `agent:main:kapso-whatsapp:direct:${ANNA}`;
    await ada.inbound({ text: "Entro quanto devo impugnare una multa?", sessionKey });
    expect(mirror).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      sessionKey,
      welcomeText("it", NO_QUESTION),
      `ada-welcome:${ANNA}`,
    );
    void ada.backend.close();
  });

  it("writes nothing into a conversation when there is no session, or when the welcome was not sent", async () => {
    const ada = setup();
    await ada.inbound({ text: "Ciao Ada" });
    expect(mirror).not.toHaveBeenCalled();
    ada.sendText.mockRejectedValueOnce(new Error("kapso down"));
    await ada.inbound({
      text: "Ciao Ada",
      from: BRUNO,
      sessionKey: `agent:main:kapso-whatsapp:direct:${BRUNO}`,
    });
    expect(mirror).not.toHaveBeenCalled();
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
      welcomeText("en", NONE),
      welcomeText("es", NONE),
      welcomeText("en", NO_QUESTION),
      welcomeText("it", NO_QUESTION),
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
      const text = welcomeText(language, ALL);
      expect(text, language).toContain("Ada");
      expect(text, language).toContain("Lexroom");
      expect(text, language).not.toMatch(/vera/iu);
    }
  });

  it("never teaches a command: no quoted phrase, no keyword, in any language", () => {
    for (const language of LANGUAGES) {
      const text = welcomeText(language, ALL);
      expect(text, language).not.toMatch(/«|»/u);
      expect(text, language).not.toMatch(
        /collega Lexroom|collega Gmail|connect Lexroom|connect Gmail|conecta Lexroom|conecta Gmail|connecte Lexroom|connecte Gmail|Lexroom verbinden|Gmail verbinden/iu,
      );
      expect(text, language).not.toMatch(
        /scrivimi|write to me|escríbeme|écrivez-moi|schreiben Sie mir/iu,
      );
    }
  });

  it("is short and in the first person from the first word, with no third-person introduction", () => {
    const openings = {
      it: "Sono Ada, l'assistente legale di Lexroom su WhatsApp. Posso:",
      en: "I'm Ada, Lexroom's legal assistant on WhatsApp. I can:",
      es: "Soy Ada, la asistente legal de Lexroom en WhatsApp. Puedo:",
      fr: "Je suis Ada, l'assistante juridique de Lexroom sur WhatsApp. Je peux :",
      de: "Ich bin Ada, die juristische Assistentin von Lexroom auf WhatsApp. Ich kann:",
    } as const;
    for (const language of LANGUAGES) {
      const text = welcomeText(language, ALL);
      expect(text.startsWith(openings[language]), language).toBe(true);
      expect(text, language).not.toMatch(
        /Ti diamo il benvenuto|Welcome to Ada|Te damos la bienvenida|Bienvenue sur Ada|Willkommen bei Ada|farle|ask her|hacerle|lui poser|ihr Rechtsfragen/iu,
      );
      expect(text.length, language).toBeLessThan(650);
    }
  });

  it("leaves out Outlook and the reminder bullet when they are not available, in every language", () => {
    for (const language of LANGUAGES) {
      const bullets = (features: { outlook: boolean; reminders: boolean; question: boolean }) =>
        welcomeText(language, features)
          .split("\n\n")[0]!
          .split("\n")
          .filter((line) => line.startsWith("•"));
      expect(bullets(ALL), language).toHaveLength(4);
      expect(bullets({ ...ALL, outlook: false }).join("\n"), language).not.toContain("Outlook");
      expect(bullets({ ...ALL, outlook: false }), language).toHaveLength(4);
      expect(bullets({ ...ALL, reminders: false }), language).toHaveLength(3);
      expect(bullets({ ...ALL, reminders: false }).join("\n"), language).toContain("Outlook");
      const none = welcomeText(language, NONE);
      expect(none, language).not.toContain("Outlook");
      expect(bullets(NONE), language).toHaveLength(3);
      expect(bullets(NONE)[1], language).toContain("Gmail");
      expect(none.match(/\?/gu), language).toHaveLength(1);
    }
  });

  it("lists what Ada can do: legal questions and Lexroom research, mail and calendar, Granola, deadline reminders", () => {
    for (const language of LANGUAGES) {
      const bullets = welcomeText(language, ALL)
        .split("\n\n")[0]!
        .split("\n")
        .filter((line) => line.startsWith("•"));
      expect(bullets, language).toHaveLength(4);
      expect(bullets[0], language).toContain("Lexroom");
      expect(bullets[1], language).toMatch(/Gmail/u);
      expect(bullets[1], language).toMatch(/Outlook/u);
      expect(bullets[2], language).toContain("Granola");
      expect(bullets[3], language).toMatch(/udienz|hearing|audiencia|audience|Termin/u);
    }
  });

  it("keeps the lawyer and privacy disclaimer and says accounts are connected only when needed", () => {
    const [, notes] = welcomeText("it", ALL).split("\n\n");
    expect(notes).toBe(
      "I tuoi account li collego solo quando serve, e le mie risposte non sostituiscono quelle di un avvocato. Le chat di ognuno restano private.",
    );
    expect(welcomeText("en", ALL).split("\n\n")[1]).toBe(
      "I only connect your accounts when it's needed, and my answers don't replace a lawyer. Everyone's chats stay private.",
    );
    for (const language of LANGUAGES) {
      expect(welcomeText(language, ALL).split("\n\n")[1], language).toMatch(
        /avvocato|lawyer|abogado|avocat|Anwalt/u,
      );
    }
  });

  it("leaves the question out when a model reply follows, and still ends with the privacy line", () => {
    for (const language of LANGUAGES) {
      const text = welcomeText(language, { ...ALL, question: false });
      expect(text, language).not.toContain("?");
      expect(text, language).toBe(
        welcomeText(language, ALL).split("\n\n").slice(0, -1).join("\n\n"),
      );
    }
  });

  it("ends with one question that starts the conversation, and asks nothing else", () => {
    const questions = {
      it: "Su cosa stai lavorando adesso?",
      en: "What's on your plate right now?",
      es: "¿En qué estás trabajando ahora mismo?",
      fr: "Sur quoi travaillez-vous en ce moment ?",
      de: "Woran arbeiten Sie gerade?",
    } as const;
    for (const language of LANGUAGES) {
      const text = welcomeText(language, ALL);
      expect(text.endsWith(`\n\n${questions[language]}`), language).toBe(true);
      expect(text.match(/\?/gu), language).toHaveLength(1);
    }
  });

  it("fits one WhatsApp message", () => {
    for (const language of LANGUAGES) {
      expect(welcomeText(language, ALL).length, language).toBeLessThan(1200);
    }
  });
});
