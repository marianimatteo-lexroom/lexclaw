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
const exists = (p) => p in store || Object.keys(store).some((k) => k.startsWith(p + "."));
if (cmd === "config" && sub === "get") {
  const p = rest[0];
  if (!exists(p)) process.exit(1);
  console.log(p in store ? JSON.stringify(store[p]) : "{}");
} else if (cmd === "config" && sub === "set") {
  store[rest[0]] = JSON.parse(rest[1]);
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

    it("renames the word in the identity files, keeps a copy, and leaves everything else alone", () => {
      const deploy = seeded();
      const first = deploy.run();
      expect(first.status).toBe(0);
      expect(read(deploy, "IDENTITY.md")).toBe(IDENTITY.replace("**Name:** Vera", "**Name:** Ada"));
      expect(read(deploy, "SOUL.md")).toBe(
        "You are Ada. Do not ask what you should be called.\nADA never lies.\n",
      );
      expect(read(deploy, "USER.md")).toBe(USER);
      expect(read(deploy, "IDENTITY.md.pre-ada")).toBe(IDENTITY);
      expect(read(deploy, "SOUL.md.pre-ada")).toBe(SOUL);
      expect(`${first.stdout}${first.stderr}`).toContain("renamed Vera to Ada in IDENTITY.md");
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
      expect(`${third.stdout}${third.stderr}`).not.toContain("renamed Vera to Ada");
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
});
