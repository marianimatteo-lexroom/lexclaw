import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./memory.js", () => ({
  openAdaMemoryFromApi: vi.fn(),
  openAdaMemoryIfExistsFromApi,
  openAdaRegistryFromApi: vi.fn(),
}));

import { OUTLOOK_REMINDER_INTERVAL_MS } from "./outlook-account-contract.js";
import { bindOutlookOwner } from "./outlook-account.js";
import { createSqliteWorkerBackend } from "./outlook-account.worker.js";
import {
  releaseHeldOutlookReminder,
  remindOutlookReconnect,
  runOutlookKeepAlive,
} from "./outlook-reminder.js";
import { loadOutlookAccess } from "./outlook-session.js";
import {
  ANNA,
  BRUNO,
  newMockMicrosoft,
  openOutlookTestDb,
  OUTLOOK_ENV,
  OUTLOOK_PLUGIN_CONFIG,
  signInThroughFlow,
} from "./outlook-test-support.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { recordSenderInbound } from "./research-push.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = new Date("2026-10-20T09:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

async function setup() {
  const mock = newMockMicrosoft();
  const store = openOutlookTestDb(tempDirs.make("ada-outlook-refresh-"));
  const sent: Array<{ to: string; text: string }> = [];
  const api = {
    runtimeSource: "/fake/ada/index.ts",
    config: {},
    pluginConfig: OUTLOOK_PLUGIN_CONFIG,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (params: { to: string; text: string }) => {
              sent.push({ to: params.to, text: params.text });
            },
          }),
        },
      },
    },
  } as never;
  await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now: NOW });
  await signInThroughFlow({ mock, db: store.db, owner: BRUNO, user: "bruno", now: NOW });
  const access = (owner: string, offsetMs: number, extra: { force?: boolean } = {}) => {
    mock.clockMs = at(offsetMs).getTime();
    return loadOutlookAccess({
      db: store.db,
      owner,
      nowMs: at(offsetMs).getTime(),
      env: OUTLOOK_ENV,
      fetchImpl: mock.fetch,
      ...extra,
    });
  };
  return { mock, store, sent, api, access };
}

beforeEach(() => {
  clearInboundLanguages();
});

describe("Outlook token refresh", () => {
  it("renews an expired access token and saves the refresh token Microsoft rotated", async () => {
    const { mock, store, access } = await setup();
    const before = await store.db.readAccount(ANNA);
    const live = await access(ANNA, 30 * MINUTE);
    expect(live).toMatchObject({ ok: true, accessToken: before?.accessToken });
    expect(mock.refreshes).toBe(0);

    const renewed = await access(ANNA, 2 * HOUR);
    expect(renewed.ok && renewed.accessToken).not.toBe(before?.accessToken);
    expect(mock.refreshes).toBe(1);
    const after = await store.db.readAccount(ANNA);
    expect(after?.refreshToken).not.toBe(before?.refreshToken);
    expect(after).toMatchObject({
      accessExpiresAtMs: at(2 * HOUR).getTime() + HOUR,
      connectedAtMs: NOW.getTime(),
      email: "anna@contoso.example",
    });
    const refresh = new URLSearchParams(
      mock.requests.find((request) => request.body?.includes("grant_type=refresh_token"))?.body,
    );
    expect(refresh.get("refresh_token")).toBe(before?.refreshToken);
    expect(refresh.get("client_secret")).toBe("app-client-secret");
    // The next renewal presents the rotated token, which Microsoft would refuse a second time.
    await access(ANNA, 4 * HOUR);
    expect((await store.db.readAccount(ANNA))?.refreshToken).not.toBe(after?.refreshToken);
  });

  it("spends a refresh token once when two calls renew at the same moment", async () => {
    const { mock, access } = await setup();
    const [first, second] = await Promise.all([access(ANNA, 2 * HOUR), access(ANNA, 2 * HOUR)]);
    expect(first.ok && second.ok).toBe(true);
    expect(mock.refreshes).toBe(1);
  });

  it("forces a renewal when Graph refused a token that looked live", async () => {
    const { mock, access } = await setup();
    await access(ANNA, 5 * MINUTE, { force: true });
    expect(mock.refreshes).toBe(1);
  });

  it("drops a sign-in Microsoft refuses for good, and keeps one it only failed to renew for now", async () => {
    const { mock, store, access } = await setup();
    mock.refreshFailure = "server_error";
    expect(await access(ANNA, 2 * HOUR)).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.db.listOwners()).toEqual([ANNA, BRUNO]);

    mock.refreshFailure = "invalid_client";
    expect(await access(ANNA, 2 * HOUR)).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.db.listOwners()).toEqual([ANNA, BRUNO]);

    mock.refreshFailure = "invalid_grant";
    expect(await access(ANNA, 2 * HOUR)).toEqual({ ok: false, reason: "reconnect" });
    expect(await store.db.listOwners()).toEqual([BRUNO]);
    expect(await access(ANNA, 2 * HOUR)).toEqual({ ok: false, reason: "not_connected" });

    mock.refreshFailure = "admin_consent";
    expect(await access(BRUNO, 2 * HOUR)).toEqual({ ok: false, reason: "reconnect" });
  });

  it("keeps using a token that is still live when the refresh fails for now", async () => {
    const { mock, store, access } = await setup();
    mock.refreshFailure = "server_error";
    const result = await access(ANNA, 59 * MINUTE + 30_000);
    expect(result.ok).toBe(true);
    expect(await store.db.listOwners()).toContain(ANNA);
  });

  it("never serves one number the tokens of another", async () => {
    const { store, access } = await setup();
    const anna = await access(ANNA, 2 * HOUR);
    const bruno = await access(BRUNO, 2 * HOUR);
    expect(anna.ok && anna.account.email).toBe("anna@contoso.example");
    expect(bruno.ok && bruno.account.email).toBe("bruno@contoso.example");
    expect(anna.ok && bruno.ok && anna.accessToken !== bruno.accessToken).toBe(true);
    expect(await bindOutlookOwner(store.db, BRUNO).readAccount()).toMatchObject({
      email: "bruno@contoso.example",
    });
  });

  it("is off without the Entra app registration", async () => {
    const { store } = await setup();
    expect(
      await loadOutlookAccess({ db: store.db, owner: ANNA, nowMs: NOW.getTime(), env: {} }),
    ).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("Outlook keep-alive and reconnect reminder", () => {
  it("renews tokens that would expire before the next poll, and leaves fresh ones alone", async () => {
    const { mock, store, api, sent } = await setup();
    const anna = await store.db.readAccount(ANNA);
    mock.clockMs = at(HOUR - 10 * MINUTE).getTime();
    await runOutlookKeepAlive(api, at(HOUR - 10 * MINUTE), {
      db: store.db,
      fetchImpl: mock.fetch,
      env: OUTLOOK_ENV,
    });
    expect(mock.refreshes).toBe(2);
    expect((await store.db.readAccount(ANNA))?.accessToken).not.toBe(anna?.accessToken);
    expect((await store.db.readAccount(ANNA))?.refreshToken).not.toBe(anna?.refreshToken);
    await runOutlookKeepAlive(api, at(HOUR - 5 * MINUTE), {
      db: store.db,
      fetchImpl: mock.fetch,
      env: OUTLOOK_ENV,
    });
    expect(mock.refreshes).toBe(2);
    expect(sent).toEqual([]);
  });

  it("keeps a connection nobody uses alive across days, one renewal per hour", async () => {
    const { mock, store, api } = await setup();
    for (let poll = 1; poll <= 96; poll += 1) {
      const clock = at(poll * 15 * MINUTE);
      mock.clockMs = clock.getTime();
      await runOutlookKeepAlive(api, clock, {
        db: store.db,
        fetchImpl: mock.fetch,
        env: OUTLOOK_ENV,
      });
    }
    expect(await store.db.listOwners()).toEqual([ANNA, BRUNO]);
    expect(mock.refreshes).toBeGreaterThanOrEqual(2 * 24);
    expect((await store.db.readAccount(ANNA))?.accessExpiresAtMs).toBeGreaterThan(
      at(24 * HOUR).getTime(),
    );
  });

  it("sends one reminder with a fresh short link to the number whose refresh failed for good", async () => {
    const { mock, store, api, sent } = await setup();
    mock.refreshFailure = "invalid_grant";
    mock.clockMs = at(2 * HOUR).getTime();
    await runOutlookKeepAlive(api, at(2 * HOUR), {
      db: store.db,
      fetchImpl: mock.fetch,
      env: OUTLOOK_ENV,
    });
    expect(sent.map((message) => message.to).toSorted()).toEqual([`+${ANNA}`, `+${BRUNO}`]);
    for (const message of sent) {
      expect(message.text).toContain("Il collegamento a Outlook è scaduto");
      expect(message.text).toMatch(/https:\/\/vera\.example\/o\/[A-Za-z0-9_-]{10}/u);
      expect(message.text).not.toContain("oauth2/v2.0/authorize");
    }
    expect(sent[0]?.text).not.toBe(sent[1]?.text);
    expect(await store.db.listOwners()).toEqual([]);
  });

  it("writes the reminder in the language of the latest message", async () => {
    const { mock, store, api, sent } = await setup();
    recordInboundLanguage(ANNA, "Hello, could you please check my calendar for tomorrow?");
    mock.refreshFailure = "invalid_grant";
    mock.clockMs = at(2 * HOUR).getTime();
    await runOutlookKeepAlive(api, at(2 * HOUR), {
      db: store.db,
      fetchImpl: mock.fetch,
      env: OUTLOOK_ENV,
    });
    expect(sent.find((message) => message.to === `+${ANNA}`)?.text).toContain(
      "The Outlook connection expired",
    );
  });

  it("does not remind about a refresh that only failed for now", async () => {
    const { mock, store, api, sent } = await setup();
    mock.refreshFailure = "server_error";
    mock.clockMs = at(2 * HOUR).getTime();
    await runOutlookKeepAlive(api, at(2 * HOUR), {
      db: store.db,
      fetchImpl: mock.fetch,
      env: OUTLOOK_ENV,
    });
    expect(sent).toEqual([]);
    expect(await store.db.listOwners()).toEqual([ANNA, BRUNO]);
  });

  it("does nothing while the feature is off", async () => {
    const { mock, store, api, sent } = await setup();
    await runOutlookKeepAlive(api, at(5 * HOUR), { db: store.db, fetchImpl: mock.fetch, env: {} });
    expect(mock.refreshes).toBe(0);
    expect(sent).toEqual([]);
  });

  it("sends at most one reminder a day to one number", async () => {
    const { mock, store, api, sent } = await setup();
    const remind = (offsetMs: number, owner = ANNA) =>
      remindOutlookReconnect(api, store.db, owner, at(offsetMs), { env: OUTLOOK_ENV });
    expect(await remind(0)).toBe("sent");
    expect(await remind(HOUR)).toBe("skipped");
    expect(await remind(23 * HOUR)).toBe("skipped");
    expect(sent).toHaveLength(1);
    expect(await remind(24 * HOUR)).toBe("sent");
    expect(sent).toHaveLength(2);
    expect(await remind(25 * HOUR, BRUNO)).toBe("sent");
    expect(sent.at(-1)?.to).toBe(`+${BRUNO}`);
    expect(mock.refreshes).toBe(0);
  });

  it("keeps the reminder for the next message when the WhatsApp window is closed", async () => {
    const { store, api, sent } = await setup();
    recordSenderInbound(ANNA, NOW.getTime() - 30 * HOUR);
    expect(await remindOutlookReconnect(api, store.db, ANNA, NOW, { env: OUTLOOK_ENV })).toBe(
      "held",
    );
    expect(sent).toEqual([]);
    const release = (owner: string, offsetMs: number) =>
      releaseHeldOutlookReminder(api, owner, at(offsetMs).getTime(), {
        db: store.db,
        env: OUTLOOK_ENV,
      });
    await release(ANNA, 2 * HOUR);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`+${ANNA}`);
    await release(ANNA, 3 * HOUR);
    await release(BRUNO, 3 * HOUR);
    expect(sent).toHaveLength(1);
  });

  it("still owes a reminder that could not go out after a restart, and forgets it after three days", async () => {
    const { store, api, sent } = await setup();
    recordSenderInbound(ANNA, NOW.getTime() - 30 * HOUR);
    await remindOutlookReconnect(api, store.db, ANNA, NOW, { env: OUTLOOK_ENV });
    store.close();
    const restarted = openOutlookTestDb(store.dir);
    await releaseHeldOutlookReminder(api, ANNA, at(HOUR).getTime(), {
      db: restarted.db,
      env: OUTLOOK_ENV,
    });
    expect(sent).toHaveLength(1);

    recordSenderInbound(BRUNO, NOW.getTime() - 30 * HOUR);
    await remindOutlookReconnect(api, restarted.db, BRUNO, NOW, { env: OUTLOOK_ENV });
    await releaseHeldOutlookReminder(api, BRUNO, at(73 * HOUR).getTime(), {
      db: restarted.db,
      env: OUTLOOK_ENV,
    });
    expect(sent).toHaveLength(1);
    restarted.close();
  });

  it("has a reminder interval of one day", () => {
    expect(OUTLOOK_REMINDER_INTERVAL_MS).toBe(24 * HOUR);
  });
});

describe("Outlook account store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encrypts the tokens and the PKCE verifier at rest with ADA_TOKEN_KEY", () => {
    vi.stubEnv("ADA_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
    const databasePath = path.join(tempDirs.make("ada-outlook-store-"), "outlook-account.sqlite");
    const backend = createSqliteWorkerBackend(undefined, { databasePath });
    try {
      backend.execute({
        type: "upsertAccount",
        input: {
          owner: ANNA,
          account: {
            email: "anna@contoso.example",
            accessToken: "access-token-secret-anna",
            refreshToken: "refresh-token-secret-anna",
            accessExpiresAtMs: 5_000,
            scope: "Mail.Send",
            connectedAtMs: 1_000,
          },
        },
      });
      backend.execute({
        type: "replacePending",
        input: {
          owner: ANNA,
          nonce: "pending-nonce-aaaaaa",
          expiresAtMs: 9_000,
          pending: { codeVerifier: "verifier-secret-value" },
        },
      });
      expect(backend.execute({ type: "readAccount", input: { owner: ANNA } })).toMatchObject({
        accessToken: "access-token-secret-anna",
        refreshToken: "refresh-token-secret-anna",
      });
      expect(
        backend.execute({
          type: "consumePending",
          input: { owner: BRUNO, nonce: "pending-nonce-aaaaaa", nowMs: 1 },
        }),
      ).toBeNull();
      const raw = new DatabaseSync(databasePath);
      const stored = JSON.stringify([
        raw.prepare("SELECT * FROM ada_outlook_account").all(),
        raw.prepare("SELECT * FROM ada_outlook_pending").all(),
      ]);
      raw.close();
      for (const secret of ["access-token-secret", "refresh-token-secret", "verifier-secret"]) {
        expect(stored).not.toContain(secret);
      }
      expect(stored).toContain("enc:v1:");
    } finally {
      backend.close();
    }
  });
});
