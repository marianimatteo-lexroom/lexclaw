import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const START = resolve(import.meta.dirname, "../../deploy/railway/start.sh");
const PLUGIN_DIR = resolve(import.meta.dirname, "../../extensions/ada");

/**
 * A stand-in for `openclaw.mjs`: config lives in one JSON file as flat dotted paths, and every
 * call is appended to a log, so the boot script can run end to end without a gateway.
 */
const STUB = `
import fs from "node:fs";
const file = process.env.STUB_STORE;
const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(store));
const [cmd, sub, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, [cmd, sub, ...rest.filter((a) => !a.startsWith("--"))].join(" ") + "\\n");
if (process.env.STUB_FAIL && [cmd, sub, ...rest].join(" ").startsWith(process.env.STUB_FAIL)) process.exit(1);
const exists = (p) => p in store || Object.keys(store).some((k) => k.startsWith(p + "."));
if (cmd === "config" && sub === "get") {
  const p = rest[0];
  if (!exists(p)) process.exit(1);
  console.log(p in store ? JSON.stringify(store[p]) : "{}");
} else if (cmd === "config" && sub === "set") {
  store[rest[0]] = JSON.parse(rest[1]);
  save();
} else if (cmd === "config" && sub === "unset") {
  delete store[rest[0]];
  save();
} else if (cmd === "plugins" && sub === "uninstall") {
  const id = rest[0];
  for (const k of Object.keys(store)) if (k.startsWith("plugins.entries." + id + ".")) delete store[k];
  store["plugins.entries." + id + ".enabled"] = false;
  save();
}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function boot(env: Record<string, string>, seed: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ada-start-"));
  dirs.push(dir);
  const app = join(dir, "app");
  mkdirSync(app);
  writeFileSync(join(app, "openclaw.mjs"), STUB);
  const store = join(dir, "store.json");
  writeFileSync(store, JSON.stringify(seed));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const run = () =>
    spawnSync("bash", [START], {
      env: {
        PATH: process.env.PATH ?? "",
        OPENCLAW_APP_DIR: app,
        OPENCLAW_STATE_DIR: join(dir, "state"),
        OPENCLAW_WORKSPACE_DIR: join(dir, "workspace"),
        KAPSO_PHONE_NUMBER_ID: "123",
        KAPSO_DEFAULT_TO: "+390000000000",
        KAPSO_PLUGIN_VERSION: "0.1.4",
        ADA_PLUGIN_DIR: PLUGIN_DIR,
        STUB_STORE: store,
        STUB_LOG: log,
        ...env,
      },
      encoding: "utf8",
    });
  return {
    run,
    workspace: join(dir, "workspace"),
    store: () => JSON.parse(readFileSync(store, "utf8")) as Record<string, unknown>,
    calls: () => readFileSync(log, "utf8").trim().split("\n"),
  };
}

describe("deploy/railway/start.sh after the rename to Ada", () => {
  it("reads legacy VERA_* variables, never prints their values, and keeps the Google URI", () => {
    const secret = "legacy-google-client-secret-value";
    const deploy = boot({
      VERA_PUBLIC_ORIGIN: "https://vera.verus.legal",
      VERA_GOOGLE_CLIENT_ID: "client-id",
      VERA_GOOGLE_CLIENT_SECRET: secret,
      VERA_STATUS_TOKEN: "legacy-status-token-1234",
      VERA_TOKEN_KEY: "legacy-token-key-value",
      VERA_DEADLINE_INTAKE_ENABLED: "true",
    });
    const result = deploy.run();
    expect(result.status).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain("using legacy variables");
    expect(out).toContain("VERA_GOOGLE_CLIENT_SECRET");
    expect(out).not.toContain(secret);

    const config = deploy.store();
    expect(config["plugins.entries.ada.config.googleClientId"]).toBe("client-id");
    expect(config["plugins.entries.ada.config.googleClientSecret"]).toBe(secret);
    expect(config["plugins.entries.ada.config.statusToken"]).toBe("legacy-status-token-1234");
    expect(config["plugins.entries.ada.config.deadlineIntake.enabled"]).toBe(true);
    expect(config["gateway.controlUi.allowedOrigins"]).toEqual(["https://vera.verus.legal"]);
    expect(config["plugins.entries.ada.config.googleRedirectUri"]).toBe(
      "https://vera.verus.legal/vera/google/callback",
    );
    expect(config["plugins.entries.ada.config.lexroomConnectUri"]).toBe(
      "https://vera.verus.legal/ada/lexroom/connect",
    );
    expect(config['channels["kapso-whatsapp"].dmSecurity']).toBe("open");
    expect(config['channels["kapso-whatsapp"].allowFrom']).toEqual(["*"]);
    expect(config['channels["kapso-whatsapp"].defaultTo']).toBe("+390000000000");
    expect(config["session.dmScope"]).toBe("per-channel-peer");
    expect(config["tools.alsoAllow"]).toContain("ada_lexroom_connect");
    expect(JSON.stringify(config["tools.alsoAllow"])).not.toContain("vera_");
  });

  it("gives every WhatsApp number its own session, on every boot, over any saved scope", () => {
    const deploy = boot(
      { ADA_PUBLIC_ORIGIN: "https://ada.example.com" },
      { "session.dmScope": "main" },
    );
    expect(deploy.run().status).toBe(0);
    expect(deploy.store()["session.dmScope"]).toBe("per-channel-peer");

    expect(deploy.run().status).toBe(0);
    expect(deploy.store()["session.dmScope"]).toBe("per-channel-peer");
    expect(
      deploy.calls().filter((call) => call === 'config set session.dmScope "per-channel-peer"'),
    ).toHaveLength(2);
  });

  it("lets ADA_* win over VERA_* when both are set", () => {
    const deploy = boot({
      ADA_PUBLIC_ORIGIN: "https://ada.example.com",
      VERA_PUBLIC_ORIGIN: "https://old.example.com",
      ADA_GOOGLE_CLIENT_ID: "new-id",
      VERA_GOOGLE_CLIENT_ID: "old-id",
    });
    expect(deploy.run().status).toBe(0);
    expect(deploy.store()["plugins.entries.ada.config.googleClientId"]).toBe("new-id");
    expect(deploy.store()["gateway.controlUi.allowedOrigins"]).toEqual(["https://ada.example.com"]);
  });

  it("moves a vera plugin entry to ada once, then retires the old plugin", () => {
    const deploy = boot(
      { ADA_PUBLIC_ORIGIN: "https://ada.example.com" },
      {
        "plugins.entries.vera.enabled": true,
        "plugins.entries.vera.config.timeoutMs": 90000,
        "plugins.entries.vera.config.researchModules": ["Civile", "Societario"],
        "plugins.entries.vera.config.lexroomStateSecret": "[redacted]",
        "plugins.entries.vera.config.accessToken": "[redacted]",
      },
    );
    const first = deploy.run();
    expect(first.status).toBe(0);
    const config = deploy.store();
    expect(config["plugins.entries.ada.config.timeoutMs"]).toBe(90000);
    expect(config["plugins.entries.ada.config.researchModules"]).toEqual(["Civile", "Societario"]);
    expect(config).not.toHaveProperty("plugins.entries.ada.config.accessToken");
    expect(config).not.toHaveProperty("plugins.entries.ada.config.lexroomStateSecret");
    expect(config["plugins.entries.vera.enabled"]).toBe(false);
    expect(config).not.toHaveProperty("plugins.entries.vera.config.timeoutMs");
    expect(`${first.stdout}${first.stderr}`).toContain("lexroomStateSecret");

    const calls = deploy.calls();
    const copied = calls.findIndex((call) => call.includes("plugins.entries.ada.config.timeoutMs"));
    const removed = calls.findIndex((call) => call.startsWith("plugins uninstall vera"));
    expect(copied).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(copied);
    expect(calls.findIndex((call) => call.startsWith("plugins install"))).toBeLessThan(copied);

    const second = deploy.run();
    expect(second.status).toBe(0);
    expect(`${second.stdout}${second.stderr}`).toContain("no legacy vera plugin entry");
    expect(deploy.calls().filter((call) => call.startsWith("plugins uninstall vera"))).toHaveLength(
      1,
    );
  });

  it("does not overwrite a setting that already exists on ada", () => {
    const deploy = boot(
      { ADA_PUBLIC_ORIGIN: "https://ada.example.com" },
      {
        "plugins.entries.vera.config.timeoutMs": 90000,
        "plugins.entries.ada.config.timeoutMs": 120000,
      },
    );
    expect(deploy.run().status).toBe(0);
    expect(deploy.store()["plugins.entries.ada.config.timeoutMs"]).toBe(120000);
  });

  describe("the assistant's name on a volume from before the rename", () => {
    const ENV = { ADA_PUBLIC_ORIGIN: "https://ada.example.com" };
    const IDENTITY =
      "# IDENTITY.md\n\n- **Name:** Vera\n- **Emoji:** ⚖️\n- Theme: Lexroom's assistant for one lawyer\n\nHost vera.verus.legal, route /vera/status, VERA_TOKEN_KEY stay.\n";
    const SOUL = "You are Vera. Do not ask what you should be called.\nVERA never lies.\n";
    const BLOCK =
      "<!-- ada:multi-user -->\n## Who Ada serves\n\nAda serves everyone who writes to her on WhatsApp, each in a private chat, with their own Lexroom, Gmail and Calendar connections. She never says she works for one person only. Any older line saying she works for one lawyer or one person is out of date.\n<!-- /ada:multi-user -->\n";
    const IDENTITY_NOW =
      IDENTITY.replace("**Name:** Vera", "**Name:** Ada").replace(
        "assistant for one lawyer",
        "assistant for everyone who writes to her",
      ) + `\n${BLOCK}`;
    const SOUL_NOW = `You are Ada. Do not ask what you should be called.\nADA never lies.\n\n${BLOCK}`;
    const USER = "Cliente: Vera Bianchi (Rossi SRL)\n";

    function seeded(config: Record<string, unknown> = {}) {
      const deploy = boot(ENV, config);
      mkdirSync(deploy.workspace, { recursive: true });
      writeFileSync(join(deploy.workspace, "IDENTITY.md"), IDENTITY);
      writeFileSync(join(deploy.workspace, "SOUL.md"), SOUL);
      writeFileSync(join(deploy.workspace, "USER.md"), USER);
      return deploy;
    }
    const read = (deploy: { workspace: string }, name: string) =>
      readFileSync(join(deploy.workspace, name), "utf8");

    it("renames the word, drops the one-lawyer wording, keeps a copy, and leaves everything else alone", () => {
      const deploy = seeded();
      const first = deploy.run();
      expect(first.status).toBe(0);
      expect(read(deploy, "IDENTITY.md")).toBe(IDENTITY_NOW);
      expect(read(deploy, "SOUL.md")).toBe(SOUL_NOW);
      expect(read(deploy, "USER.md")).toBe(USER);
      expect(read(deploy, "IDENTITY.md.pre-ada")).toBe(IDENTITY);
      expect(read(deploy, "SOUL.md.pre-ada")).toBe(SOUL);
      expect(`${first.stdout}${first.stderr}`).toContain(
        "updated the assistant identity in IDENTITY.md",
      );
    });

    it("also neutralizes the Italian wording and a file with no trailing newline", () => {
      const deploy = boot(ENV);
      mkdirSync(deploy.workspace, { recursive: true });
      writeFileSync(
        join(deploy.workspace, "SOUL.md"),
        "Lavori per una persona sola e per un solo avvocato.",
      );
      expect(deploy.run().status).toBe(0);
      expect(read(deploy, "SOUL.md")).toBe(
        `Lavori per chiunque le scriva e per chiunque le scriva.\n\n${BLOCK}`,
      );
      expect(read(deploy, "SOUL.md.pre-ada")).toBe(
        "Lavori per una persona sola e per un solo avvocato.",
      );
    });

    it("is idempotent and never overwrites the first copy", () => {
      const deploy = seeded();
      deploy.run();
      const identity = read(deploy, "IDENTITY.md");
      writeFileSync(join(deploy.workspace, "IDENTITY.md"), `${identity}Vera again.\n`);
      const second = deploy.run();
      expect(second.status).toBe(0);
      expect(read(deploy, "IDENTITY.md")).toBe(`${identity}Ada again.\n`);
      expect(read(deploy, "IDENTITY.md.pre-ada")).toBe(IDENTITY);
      const third = deploy.run();
      expect(read(deploy, "IDENTITY.md")).toBe(`${identity}Ada again.\n`);
      expect(read(deploy, "SOUL.md")).toBe(SOUL_NOW);
      expect(read(deploy, "IDENTITY.md").split("<!-- ada:multi-user -->")).toHaveLength(2);
      expect(`${third.stdout}${third.stderr}`).not.toContain("updated the assistant identity");
    });

    it("boots on an empty workspace without creating identity files", () => {
      const deploy = boot(ENV);
      expect(deploy.run().status).toBe(0);
      expect(existsSync(join(deploy.workspace, "IDENTITY.md"))).toBe(false);
    });

    it("renames the configured agent name only when it is Vera", () => {
      const old = boot(ENV, { "agents.entries.main.identity.name": "Vera" });
      expect(old.run().status).toBe(0);
      expect(old.store()["agents.entries.main.identity.name"]).toBe("Ada");
      const custom = boot(ENV, { "agents.entries.main.identity.name": "Ada Legal" });
      expect(custom.run().status).toBe(0);
      expect(custom.store()["agents.entries.main.identity.name"]).toBe("Ada Legal");
      const none = boot(ENV);
      expect(none.run().status).toBe(0);
      expect(none.store()).not.toHaveProperty("agents.entries.main.identity.name");
    });
  });
  describe("Voyage memory search", () => {
    const KEY = "pa-voyage-secret-key-value";
    const ENV = { ADA_PUBLIC_ORIGIN: "https://ada.example.com" };
    const memoryCalls = (deploy: ReturnType<typeof boot>) =>
      deploy
        .calls()
        .filter((call) =>
          /^(plugins install npm:@openclaw\/voyage|memory|config (set|unset) memory)/u.test(call),
        );

    it("installs the pinned provider, selects voyage-law-2 and rebuilds the index, hiding the key", () => {
      const deploy = boot({ ...ENV, VOYAGE_API_KEY: KEY });
      const result = deploy.run();
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
      expect(deploy.store()["memory.search.provider"]).toBe("voyage");
      expect(deploy.store()["memory.search.model"]).toBe("voyage-law-2");
      expect(JSON.stringify(deploy.store())).not.toContain(KEY);
      expect(memoryCalls(deploy)).toEqual([
        "plugins install npm:@openclaw/voyage-provider@2026.9.9",
        'config set memory.search.provider "voyage"',
        'config set memory.search.model "voyage-law-2"',
        "memory index main",
      ]);
    });

    it("takes the plugin version and model from the environment", () => {
      const deploy = boot({
        ...ENV,
        VOYAGE_API_KEY: KEY,
        VOYAGE_PLUGIN_VERSION: "2026.9.33",
        ADA_MEMORY_EMBEDDING_MODEL: "voyage-3",
      });
      expect(deploy.run().status).toBe(0);
      expect(deploy.store()["memory.search.model"]).toBe("voyage-3");
      expect(memoryCalls(deploy)[0]).toBe(
        "plugins install npm:@openclaw/voyage-provider@2026.9.33",
      );
    });

    it("boots with keyword search when the plugin cannot be installed", () => {
      const deploy = boot({
        ...ENV,
        VOYAGE_API_KEY: KEY,
        STUB_FAIL: "plugins install npm:@openclaw/voyage-provider",
      });
      const result = deploy.run();
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("using keyword-only search");
      expect(deploy.store()).not.toHaveProperty("memory.search.provider");
      expect(memoryCalls(deploy)).toEqual([
        "plugins install npm:@openclaw/voyage-provider@2026.9.9",
      ]);
    });

    it("returns to keyword search when a saved voyage config has lost its plugin", () => {
      const deploy = boot(
        { ...ENV, VOYAGE_API_KEY: KEY, STUB_FAIL: "plugins install npm:@openclaw/voyage-provider" },
        { "memory.search.provider": "voyage", "memory.search.model": "voyage-law-2" },
      );
      expect(deploy.run().status).toBe(0);
      expect(deploy.store()).not.toHaveProperty("memory.search.provider");
      expect(deploy.store()).not.toHaveProperty("memory.search.model");
      expect(deploy.calls()).toContain("memory index main");
    });

    it("does not leave the config on voyage when the model cannot be set", () => {
      const deploy = boot({
        ...ENV,
        VOYAGE_API_KEY: KEY,
        STUB_FAIL: "config set memory.search.model",
      });
      expect(deploy.run().status).toBe(0);
      expect(deploy.store()).not.toHaveProperty("memory.search.provider");
      expect(memoryCalls(deploy)).not.toContain("memory index main");
    });

    it("keeps booting when the index rebuild fails", () => {
      const deploy = boot({ ...ENV, VOYAGE_API_KEY: KEY, STUB_FAIL: "memory index" });
      const result = deploy.run();
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("memory index rebuild failed");
      expect(deploy.store()["memory.search.provider"]).toBe("voyage");
    });

    it("turns voyage off and re-indexes once the key is removed", () => {
      const deploy = boot(ENV, {
        "memory.search.provider": "voyage",
        "memory.search.model": "voyage-law-2",
      });
      expect(deploy.run().status).toBe(0);
      expect(deploy.store()).not.toHaveProperty("memory.search.provider");
      expect(deploy.store()).not.toHaveProperty("memory.search.model");
      expect(memoryCalls(deploy)).toEqual([
        "config unset memory.search.provider",
        "config unset memory.search.model",
        "memory index main",
      ]);
    });

    it("does nothing for memory search without a key or a saved voyage config", () => {
      const deploy = boot(ENV);
      const result = deploy.run();
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("skip voyage memory search");
      expect(memoryCalls(deploy)).toEqual([]);
    });
  });
});
