import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAdaOutreach, type OutreachDeps, type OutreachStore } from "./outreach.js";

const ADMIN = "+390000000001";
const LAWYER = "+390000000002";
const STRANGER = "+390000000003";
const SECOND_ADMIN = "+390000000009";
const ENV = { ADA_ADMIN_NUMBERS: `${ADMIN}, +39 000 000 0009` };
const CHANNEL = "kapso-whatsapp";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function memoryStore<T>() {
  const rows = new Map<string, T>();
  return {
    async register(key: string, value: T) {
      rows.set(key, structuredClone(value));
    },
    async registerIfAbsent(key: string, value: T) {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, structuredClone(value));
      return true;
    },
    async lookup(key: string) {
      return rows.get(key);
    },
    async consume(key: string) {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    async delete(key: string) {
      return rows.delete(key);
    },
    async entries() {
      return [...rows].map(([key, value]) => ({ key, value }));
    },
  };
}

function memoryOutreachStore(): OutreachStore {
  return {
    optOut: memoryStore(),
    sent: memoryStore(),
    pending: memoryStore(),
    batches: memoryStore(),
  };
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Service = { start: () => Promise<void>; stop: () => void };
type Dispatched = { handled: boolean; text?: string } | undefined;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(
  options: {
    env?: NodeJS.ProcessEnv;
    config?: unknown;
    store?: OutreachStore;
    send?: OutreachDeps["send"];
    clock?: { now: number };
  } = {},
) {
  const store = options.store ?? memoryOutreachStore();
  const clock = options.clock ?? { now: Date.UTC(2026, 9, 17, 12) };
  const hooks = new Map<string, Handler>();
  const services: Service[] = [];
  const messages: Array<{ to: string; text: string }> = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const send = vi.fn<OutreachDeps["send"]>(options.send ?? (async () => ({ ok: true })));
  const sleep = vi.fn<OutreachDeps["sleep"]>(async () => undefined);
  const api = createTestPluginApi({
    id: "ada",
    logger,
    config: (options.config ?? {}) as OpenClawPluginApi["config"],
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async ({ to, text }: { to: string; text: string }) => {
              messages.push({ to, text });
            },
          }),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"],
    on: ((name: string, handler: Handler) => {
      hooks.set(name, handler);
    }) as OpenClawPluginApi["on"],
    registerService: ((service: Service) => {
      services.push(service);
    }) as OpenClawPluginApi["registerService"],
  });
  registerAdaOutreach(api, {
    env: options.env ?? ENV,
    store,
    deps: { send, sleep, now: () => clock.now },
  });

  const run = (name: string, event: unknown, ctx: unknown) => {
    const handler = hooks.get(name);
    if (!handler) {
      throw new Error(`hook ${name} is not registered`);
    }
    return handler(event, ctx);
  };
  let counter = 0;
  const say = (from: string, content: string, messageId = `m${(counter += 1)}`) =>
    run(
      "before_dispatch",
      { content, channel: CHANNEL, senderId: from, isGroup: false, messageId },
      { channelId: CHANNEL, senderId: from, messageId },
    ) as Promise<Dispatched>;
  const receive = (from: string, content: string, media?: unknown[], messageId = "m-in") =>
    run(
      "message_received",
      { from, content, messageId, ...(media ? { media } : {}) },
      { channelId: CHANNEL, senderId: from, messageId },
    );
  const lastTo = (to: string) => messages.filter((message) => message.to === to.replace("+", ""));
  const finished = (to: string = ADMIN) =>
    vi.waitFor(() => {
      expect(
        lastTo(to).some((message) => /^Invio (terminato|interrotto)/u.test(message.text)),
      ).toBe(true);
    });
  return {
    store,
    hooks,
    services,
    messages,
    logger,
    send,
    sleep,
    clock,
    say,
    receive,
    finished,
    sentTo: () => send.mock.calls.map(([to]) => to),
    report: () => lastTo(ADMIN).at(-1)?.text ?? "",
  };
}

const LIST = ["333 123 4567, Mario Rossi", "+39 340 111 2222", "0039 347 000 0001,Anna"].join("\n");

describe("admin gate", () => {
  it("registers nothing while ADA_ADMIN_NUMBERS is unset or names nobody", () => {
    for (const env of [{}, { ADA_ADMIN_NUMBERS: " , nope" }]) {
      const ada = setup({ env });
      expect(ada.hooks.size).toBe(0);
      expect(ada.services).toHaveLength(0);
    }
  });

  it("answers an admin in any number format and lets everyone else through untouched", async () => {
    const ada = setup();
    expect(await ada.say("390000000001", "/invia-intro 333 123 4567")).toMatchObject({
      handled: true,
    });
    expect(await ada.say("390000000009", "/invia-intro 333 123 4567")).toMatchObject({
      handled: true,
    });
    for (const stranger of [STRANGER, LAWYER]) {
      expect(await ada.say(stranger, `/invia-intro\n${LIST}`)).toBeUndefined();
      expect(await ada.say(stranger, "CONFERMA")).toBeUndefined();
      expect(await ada.say(stranger, "/annulla")).toBeUndefined();
    }
    expect(ada.send).not.toHaveBeenCalled();
    expect(ada.messages).toHaveLength(0);
  });

  it("ignores groups and other channels, and an admin's ordinary chat", async () => {
    const ada = setup();
    const event = { content: `/invia-intro\n${LIST}`, senderId: ADMIN, isGroup: false };
    expect(
      await ada.hooks.get("before_dispatch")?.({ ...event, isGroup: true }, { channelId: CHANNEL }),
    ).toBeUndefined();
    expect(
      await ada.hooks.get("before_dispatch")?.(
        { ...event, channel: "telegram" },
        { channelId: "telegram", senderId: ADMIN },
      ),
    ).toBeUndefined();
    expect(await ada.say(ADMIN, "Ciao Ada, che udienze ho domani?")).toBeUndefined();
    expect(await ada.say(ADMIN, "CONFERMA")).toBeUndefined();
  });
});

describe("confirmation flow", () => {
  it("shows the counts and masked examples, and sends nothing until CONFERMA", async () => {
    const ada = setup();
    const reply = await ada.say(
      ADMIN,
      `/invia-intro\n${LIST}\n333-123-4567\nciao\n+39 340 111 2222`,
    );
    expect(reply?.handled).toBe(true);
    expect(reply?.text).toContain("Validi: 3. Non validi: 1. Duplicati: 2. Disiscritti: 0.");
    expect(reply?.text).toContain("+39********67");
    expect(reply?.text).not.toContain("3331234567");
    expect(reply?.text).toContain("CONFERMA");
    expect(ada.send).not.toHaveBeenCalled();

    expect(await ada.say(ADMIN, "conferma")).toMatchObject({ handled: true });
    await ada.finished();
    expect(ada.sentTo()).toEqual(["+393331234567", "+393401112222", "+393470000001"]);
    expect(ada.report()).toContain("3 messaggi inviati, 0 non riusciti");
    expect(await ada.say(ADMIN, "CONFERMA")).toBeUndefined();
  });

  it("sends the configured template with the first name, or the default name when there is none", async () => {
    const ada = setup({
      env: {
        ...ENV,
        ADA_INTRO_TEMPLATE_NAME: "benvenuto",
        ADA_INTRO_TEMPLATE_LANG: "en",
        ADA_INTRO_DEFAULT_NAME: "cliente",
      },
    });
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    expect(ada.send.mock.calls.map(([, template]) => template)).toEqual([
      { name: "benvenuto", language: "en", params: ["Mario"] },
      { name: "benvenuto", language: "en", params: ["cliente"] },
      { name: "benvenuto", language: "en", params: ["Anna"] },
    ]);
  });

  it("defaults to ada_intro in Italian with 'gentile utente', and supports a template without variables", async () => {
    const withParam = setup();
    await withParam.say(ADMIN, "/invia-intro 340 111 2222");
    await withParam.say(ADMIN, "CONFERMA");
    await withParam.finished();
    expect(withParam.send.mock.calls[0]?.[1]).toEqual({
      name: "ada_intro",
      language: "it",
      params: ["gentile utente"],
    });

    const noParam = setup({ env: { ...ENV, ADA_INTRO_TEMPLATE_PARAMS: "0" } });
    await noParam.say(ADMIN, "/invia-intro 340 111 2222,Luca");
    await noParam.say(ADMIN, "CONFERMA");
    await noParam.finished();
    expect(noParam.send.mock.calls[0]?.[1]).toEqual({ name: "ada_intro", language: "it" });
  });

  it("throttles to one message per second", async () => {
    const ada = setup();
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    expect(ada.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000]);
  });

  it("lets the pending batch expire after 30 minutes", async () => {
    const ada = setup();
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    ada.clock.now += 31 * MINUTE;
    const reply = await ada.say(ADMIN, "CONFERMA");
    expect(reply?.text).toContain("troppo tardi");
    expect(ada.send).not.toHaveBeenCalled();
    expect(await ada.say(ADMIN, "CONFERMA")).toBeUndefined();
  });

  it("cancels a pending batch with /annulla", async () => {
    const ada = setup();
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    expect((await ada.say(ADMIN, "/annulla"))?.text).toContain("Annullato");
    expect(await ada.say(ADMIN, "CONFERMA")).toBeUndefined();
    expect((await ada.say(ADMIN, "/annulla"))?.text).toContain("nessun invio");
    expect(ada.send).not.toHaveBeenCalled();
  });

  it("stops a running batch with /annulla and reports what went out", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ada = setup({
      send: async () => {
        await gate;
        return { ok: true };
      },
    });
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    await ada.say(ADMIN, "CONFERMA");
    await vi.waitFor(() => expect(ada.send).toHaveBeenCalledTimes(1));
    expect((await ada.say(ADMIN, "/invia-intro 333 000 1111"))?.text).toContain("già un invio");
    expect((await ada.say(ADMIN, "/annulla"))?.text).toContain("Fermo");
    release();
    await ada.finished();
    expect(ada.send).toHaveBeenCalledTimes(1);
    expect(ada.report()).toContain("Invio interrotto: 1 messaggio inviato");
  });

  it("reads the list from a CSV document attachment", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ada-outreach-"));
    tempDirs.push(dir);
    const file = path.join(dir, "contatti.csv");
    await writeFile(file, "telefono;nome\n333 123 4567;Mario\n340 111 2222;Anna\nxx;Nessuno\n");
    const ada = setup();
    await ada.receive(
      ADMIN,
      "<media:document>",
      [{ path: file, contentType: "text/csv" }],
      "doc-1",
    );
    const reply = await ada.say(ADMIN, "/invia-intro lista in allegato", "doc-1");
    expect(reply?.text).toContain("Validi: 2. Non validi: 1.");
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    expect(ada.send.mock.calls.map(([, template]) => template.params)).toEqual([
      ["Mario"],
      ["Anna"],
    ]);

    const other = setup();
    await other.receive(
      STRANGER,
      "<media:document>",
      [{ path: file, contentType: "text/csv" }],
      "doc-2",
    );
    expect(await other.say(STRANGER, "<media:document>", "doc-2")).toBeUndefined();
  });

  it("leaves an admin's CSV or TXT attachment to Ada unless its caption has /invia-intro", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ada-outreach-"));
    tempDirs.push(dir);
    const file = path.join(dir, "elenco.txt");
    await writeFile(file, "333 123 4567\n340 111 2222\n");
    const ada = setup();
    for (const [index, caption] of ["", "Ecco il fascicolo", "<media:document>"].entries()) {
      const id = `plain-${index}`;
      await ada.receive(ADMIN, caption, [{ path: file, contentType: "text/plain" }], id);
      expect(await ada.say(ADMIN, caption, id)).toBeUndefined();
    }
    expect(await ada.say(ADMIN, "CONFERMA")).toBeUndefined();
    expect(ada.messages).toHaveLength(0);
    expect(ada.send).not.toHaveBeenCalled();

    await ada.receive(ADMIN, "", [{ path: file, contentType: "text/plain" }], "listed");
    expect((await ada.say(ADMIN, "Per favore /invia-intro", "listed"))?.text).toContain(
      "Validi: 2.",
    );
  });

  it("tells the admin when there is nothing to send or the file cannot be read", async () => {
    const ada = setup();
    expect((await ada.say(ADMIN, "/invia-intro"))?.text).toContain("Non ho trovato numeri");
    expect((await ada.say(ADMIN, "/invia-intro\nnon-un-numero"))?.text).toContain(
      "nessun numero da contattare",
    );
    await ada.receive(
      ADMIN,
      "",
      [{ path: "/nonexistent/lista.csv", contentType: "text/csv" }],
      "doc-3",
    );
    expect((await ada.say(ADMIN, "/invia-intro", "doc-3"))?.text).toContain(
      "Non riesco a leggere il file",
    );
    expect(await ada.say(ADMIN, "CONFERMA")).toBeUndefined();
  });
});

describe("dedupe, opt-out and recent sends", () => {
  it("never writes to a number that replied STOP, BASTA or annulla iscrizione", async () => {
    const ada = setup();
    for (const [index, phrase] of ["STOP", "Basta!", "annulla iscrizione"].entries()) {
      const from = `+39340111220${index}`;
      await ada.receive(from, phrase);
      expect(ada.messages.at(-1)?.to).toBe(from.replace("+", ""));
      expect(await ada.say(from, phrase)).toEqual({ handled: true });
    }
    const confirmation = ada.messages.at(-1)?.text ?? "";
    expect(confirmation).toContain("non ti scriverò più");
    expect(confirmation).toMatch(/Ada$/u);
    expect(confirmation).not.toMatch(/vera/iu);

    const reply = await ada.say(
      ADMIN,
      "/invia-intro\n340 111 2200\n+39 340 111 2201\n0039 340 111 2202\n340 111 2203",
    );
    expect(reply?.text).toContain("Validi: 1. Non validi: 0. Duplicati: 0. Disiscritti: 3.");
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    expect(ada.sentTo()).toEqual(["+393401112203"]);
    expect(ada.logger.info.mock.calls.every(([line]) => !String(line).includes("3401112200"))).toBe(
      true,
    );
  });

  it("keeps the opt-out across a restart, and does not opt out the lawyer who types stop", async () => {
    const store = memoryOutreachStore();
    await setup({ store }).receive(STRANGER, "STOP");
    const restarted = setup({ store });
    expect((await restarted.say(ADMIN, `/invia-intro ${STRANGER}`))?.text).toContain(
      "Disiscritti: 1",
    );

    const lawyer = setup({ config: { channels: { [CHANNEL]: { defaultTo: LAWYER } } } });
    await lawyer.receive(LAWYER, "stop");
    expect(lawyer.messages).toHaveLength(0);
    expect(await lawyer.say(LAWYER, "stop")).toBeUndefined();
    expect((await lawyer.say(ADMIN, `/invia-intro ${LAWYER}`))?.text).toContain("Disiscritti: 0");
  });

  it("skips numbers sent the intro in the last 30 days, and writes again after that", async () => {
    const ada = setup();
    await ada.say(ADMIN, "/invia-intro 333 123 4567\n340 111 2222");
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    expect(ada.sentTo()).toHaveLength(2);

    ada.messages.length = 0;
    ada.clock.now += 29 * DAY;
    const again = await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    expect(again?.text).toContain("Validi: 1.");
    expect(again?.text).toContain("Già contattati negli ultimi 30 giorni (saltati): 2.");

    ada.clock.now += 2 * DAY;
    expect((await ada.say(ADMIN, `/invia-intro\n${LIST}`))?.text).toContain("Validi: 3.");
  });

  it("reports failures with their reasons and lets a failed number be tried again later", async () => {
    const ada = setup({
      send: async (to) =>
        to === "+393401112222"
          ? { ok: false, error: "kapso template returned HTTP 400" }
          : { ok: true },
    });
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    expect(ada.report()).toContain("2 messaggi inviati, 1 non riuscito");
    expect(ada.report()).toContain("kapso template returned HTTP 400 (1)");
    expect((await ada.say(ADMIN, `/invia-intro\n${LIST}`))?.text).toContain("Validi: 1.");
  });
});

describe("resume after a restart", () => {
  it("picks a batch up at its saved row and never sends to the same number twice", async () => {
    const store = memoryOutreachStore();
    const stopService = { now: () => undefined as void };
    const first = setup({
      store,
      send: async (to) => {
        if (to === "+393401112222") {
          stopService.now();
          throw new Error("process died mid-send");
        }
        return { ok: true };
      },
    });
    stopService.now = () => first.services[0]?.stop();
    await first.say(ADMIN, `/invia-intro\n${LIST}`);
    await first.say(ADMIN, "CONFERMA");
    await vi.waitFor(() => expect(first.logger.error).toHaveBeenCalled());
    expect(first.sentTo()).toEqual(["+393331234567", "+393401112222"]);
    expect(first.report()).not.toContain("Invio terminato");

    const second = setup({ store });
    await second.services[0]?.start();
    await second.finished();
    expect(second.sentTo()).toEqual(["+393470000001"]);
    expect(second.report()).toContain("2 messaggi inviati, 0 non riusciti");
    expect(second.report()).toContain("Non confermati: 1");
    expect(await store.batches.lookup("active")).toBeUndefined();

    const third = setup({ store });
    await third.services[0]?.start();
    expect(third.send).not.toHaveBeenCalled();
    expect(third.messages).toHaveLength(0);
  });

  it("resumes a batch stopped between two rows and counts each number once", async () => {
    const store = memoryOutreachStore();
    const stopService = { now: () => undefined as void };
    const first = setup({
      store,
      send: async (to) => {
        if (to === "+393401112222") {
          stopService.now();
        }
        return { ok: true };
      },
    });
    stopService.now = () => first.services[0]?.stop();
    await first.say(ADMIN, `/invia-intro\n${LIST}`);
    await first.say(ADMIN, "CONFERMA");
    await vi.waitFor(async () => expect((await store.batches.lookup("active"))?.cursor).toBe(2));

    const second = setup({ store });
    await second.services[0]?.start();
    await second.finished();
    expect(second.sentTo()).toEqual(["+393470000001"]);
    expect(second.report()).toContain("3 messaggi inviati, 0 non riusciti");
  });
});

describe("sending safeguards", () => {
  function gatedSend() {
    const gate = { release: () => undefined as void };
    const open = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    return {
      gate,
      send: async (): Promise<{ ok: true }> => {
        await open;
        return { ok: true };
      },
    };
  }

  it("checks the opt-out list again right before each send", async () => {
    const { gate, send } = gatedSend();
    const ada = setup({ send });
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    await ada.say(ADMIN, "CONFERMA");
    await vi.waitFor(() => expect(ada.send).toHaveBeenCalledTimes(1));
    await ada.receive("393470000001", "BASTA");
    gate.release();
    await ada.finished();
    expect(ada.sentTo()).toEqual(["+393331234567", "+393401112222"]);
    expect(ada.report()).toContain("2 messaggi inviati");
    expect(ada.report()).toContain("disiscritti nel frattempo: 1");
  });

  it("masks phone numbers in the failure reason, in the report and in the logs", async () => {
    const ada = setup({
      send: async (to) => ({ ok: false, error: `recipient ${to} (39 340 111 2222) is not valid` }),
    });
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    expect(ada.report()).toContain("recipient +39********67 (+39********22) is not valid");
    const logged = [ada.logger.debug, ada.logger.info, ada.logger.warn, ada.logger.error]
      .flatMap((fn) => fn.mock.calls.map(([line]) => String(line)))
      .join("\n");
    expect(logged).toContain("is not valid");
    for (const digits of ["3331234567", "3401112222", "3470000001"]) {
      expect(`${logged}\n${ada.report()}`).not.toContain(digits);
    }
  });

  it("runs one batch at a time across admins, even when both confirm at once", async () => {
    const { gate, send } = gatedSend();
    const ada = setup({ send });
    await ada.say(ADMIN, "/invia-intro 333 123 4567\n340 111 2222");
    await ada.say(SECOND_ADMIN, "/invia-intro 347 000 0001");
    const [first, second] = await Promise.all([
      ada.say(ADMIN, "CONFERMA"),
      ada.say(SECOND_ADMIN, "CONFERMA"),
    ]);
    expect(
      [first?.text, second?.text].filter((text) => text?.startsWith("Confermato")),
    ).toHaveLength(1);
    expect([first?.text, second?.text].join("\n")).toContain("ne parte uno solo alla volta");
    await vi.waitFor(() => expect(ada.send).toHaveBeenCalledTimes(1));
    expect((await ada.say(SECOND_ADMIN, "/invia-intro 340 999 0000"))?.text).toContain(
      "già un invio",
    );
    gate.release();
    await vi.waitFor(async () => expect(await ada.store.batches.lookup("active")).toBeUndefined());
    expect(new Set(ada.sentTo()).size).toBe(ada.sentTo().length);
  });

  it("keeps the second admin's list pending and runs it once the first batch is done", async () => {
    const { gate, send } = gatedSend();
    const ada = setup({ send });
    await ada.say(ADMIN, "/invia-intro 333 123 4567");
    await ada.say(SECOND_ADMIN, "/invia-intro 347 000 0001");
    await ada.say(ADMIN, "CONFERMA");
    await vi.waitFor(() => expect(ada.send).toHaveBeenCalledTimes(1));
    expect((await ada.say(SECOND_ADMIN, "CONFERMA"))?.text).toContain("solo alla volta");
    gate.release();
    await vi.waitFor(async () => expect(await ada.store.batches.lookup("active")).toBeUndefined());
    expect((await ada.say(SECOND_ADMIN, "CONFERMA"))?.text).toContain("Confermato");
    await ada.finished(SECOND_ADMIN);
    expect(ada.sentTo()).toEqual(["+393331234567", "+393470000001"]);
  });
});

describe("privacy and voice", () => {
  it("never logs a full number at info level and never calls Ada anything else", async () => {
    const ada = setup({
      send: async () => ({ ok: false, error: "kapso template returned HTTP 400" }),
    });
    await ada.receive(STRANGER, "basta");
    await ada.say(ADMIN, `/invia-intro\n${LIST}`);
    await ada.say(ADMIN, "CONFERMA");
    await ada.finished();
    const logged = [ada.logger.info, ada.logger.warn, ada.logger.error]
      .flatMap((fn) => fn.mock.calls.map(([line]) => String(line)))
      .join("\n");
    for (const digits of ["3331234567", "3401112222", "3470000001", "390000000003"]) {
      expect(logged).not.toContain(digits);
    }
    expect(ada.messages.map((message) => message.text).join("\n")).not.toMatch(/vera/iu);
  });
});
