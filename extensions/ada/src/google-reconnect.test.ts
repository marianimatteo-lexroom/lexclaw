import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAccountRecord } from "./google-account-contract.js";
import type { WakeState } from "./memory-contract.js";
import type { MemoryStore } from "./memory.js";

const google = vi.hoisted(() => ({ loadAccessToken: vi.fn() }));
vi.mock("./google-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-api.js")>()),
  loadAccessToken: (...args: unknown[]) => google.loadAccessToken(...args),
  listInboxMessages: async () => ({ ok: false, status: 500 }),
}));

const stores = vi.hoisted(() => ({ account: null as null | Record<string, unknown> }));
const clearAccount = vi.hoisted(() => vi.fn(async (_expected: unknown) => true));
const updateTokens = vi.hoisted(() => vi.fn(async (_expected: unknown, _tokens: unknown) => true));
const replacePending = vi.hoisted(() => vi.fn(async (_nonce: string, _expiresAtMs: number) => {}));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async () => ({
    readAccount: async () => stores.account,
    clearAccount: async () => {},
    clearAccountIfStill: clearAccount,
    replacePending,
    upsertAccount: vi.fn(async () => {}),
    updateTokensIfStill: updateTokens,
    consumePending: vi.fn(async () => false),
  }),
  openAdaGoogleAccountDbFromApi: async () => ({ listOwners: async () => [] }),
}));

import { executeAdaGoogleConnect } from "./google-tools.js";
vi.mock("./memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory.js")>()),
  openAdaMemoryIfExistsFromApi: async () => null,
}));

import { clearSentDigests } from "./dispatch-digest.js";
import { clearHeldReconnectNotes } from "./held-reconnect.js";
import { recordSenderInbound, runAdaCollectPass } from "./service.js";

const OWNER = "393331111111";
const NOW = new Date("2026-10-18T07:40:00.000Z");
const HOUR_MS = 3_600_000;
const CONFIG = {
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-0123456789",
};

const savedAccount = (overrides: Partial<GoogleAccountRecord> = {}): GoogleAccountRecord => ({
  email: "anna@example.com",
  refreshToken: "saved-refresh-token",
  accessToken: "stale-access-token",
  accessExpiresAtMs: NOW.getTime() - HOUR_MS,
  connectedAtMs: 1,
  scopes: "openid email https://www.googleapis.com/auth/gmail.send",
  ...overrides,
});

const api = createTestPluginApi({
  id: "ada",
  pluginConfig: CONFIG,
  config: {} as OpenClawPluginApi["config"],
  runtimeSource: "/fake/index.ts",
}) as OpenClawPluginApi;

const tokenEndpoint = (response: Response) =>
  vi.fn(async () => response) as unknown as typeof fetch;
const invalidGrant = () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  clearHeldReconnectNotes();
  clearSentDigests();
  stores.account = null;
  google.loadAccessToken.mockReset();
});

describe("a Google sign-in Google no longer accepts is not a connection", () => {
  it("ada_google_connect drops it and issues a fresh link for that number, not 'connected'", async () => {
    google.loadAccessToken.mockImplementation(
      async (params: Parameters<(typeof import("./google-api.js"))["loadAccessToken"]>[0]) =>
        (
          await vi.importActual<typeof import("./google-api.js")>("./google-api.js")
        ).loadAccessToken(params),
    );
    stores.account = savedAccount();
    const result = await executeAdaGoogleConnect(OWNER, CONFIG, api, NOW, {
      fetchImpl: tokenEndpoint(invalidGrant()),
    });
    expect(clearAccount).toHaveBeenCalledTimes(1);
    expect(replacePending).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, connected: false });
    if (result.ok && !result.connected) {
      const state = new URL(result.ask.url).searchParams.get("state") ?? "";
      const payload = JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString());
      expect(payload.owner).toBe(OWNER);
    }
  });

  it("still answers 'connected' when the access token is live or Google is only unreachable", async () => {
    const real = await vi.importActual<typeof import("./google-api.js")>("./google-api.js");
    google.loadAccessToken.mockImplementation(real.loadAccessToken);
    stores.account = savedAccount({ accessExpiresAtMs: NOW.getTime() + HOUR_MS });
    const live = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(
      await executeAdaGoogleConnect(OWNER, CONFIG, api, NOW, { fetchImpl: live }),
    ).toMatchObject({
      ok: true,
      connected: true,
    });
    expect(live).not.toHaveBeenCalled();

    stores.account = savedAccount();
    const down = tokenEndpoint(new Response("{}", { status: 500 }));
    expect(
      await executeAdaGoogleConnect(OWNER, CONFIG, api, NOW, { fetchImpl: down }),
    ).toMatchObject({
      ok: true,
      connected: true,
    });
    expect(clearAccount).not.toHaveBeenCalled();
  });

  it("keeps the token it refreshed while checking, with a rotated refresh token", async () => {
    const real = await vi.importActual<typeof import("./google-api.js")>("./google-api.js");
    google.loadAccessToken.mockImplementation(real.loadAccessToken);
    stores.account = savedAccount();
    const refresh = tokenEndpoint(
      new Response(
        JSON.stringify({ access_token: "new", expires_in: 3600, refresh_token: "rotated-refresh" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(
      await executeAdaGoogleConnect(OWNER, CONFIG, api, NOW, { fetchImpl: refresh }),
    ).toMatchObject({
      ok: true,
      connected: true,
    });
    expect(updateTokens).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ refreshToken: "saved-refresh-token", connectedAtMs: 1 }),
      expect.objectContaining({
        accessToken: "new",
        refreshToken: "rotated-refresh",
        accessExpiresAtMs: NOW.getTime() + HOUR_MS,
      }),
    );
  });

  it("asks for send permission, not a reconnect, when the sign-in works but cannot send", async () => {
    const real = await vi.importActual<typeof import("./google-api.js")>("./google-api.js");
    google.loadAccessToken.mockImplementation(real.loadAccessToken);
    stores.account = savedAccount({ scopes: null, accessExpiresAtMs: NOW.getTime() + HOUR_MS });
    const result = await executeAdaGoogleConnect(OWNER, CONFIG, api, NOW);
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(clearAccount).not.toHaveBeenCalled();
  });
});

/** The number last wrote an hour before NOW, so its 24-hour window is open unless said otherwise. */
function memory(lastLawyerInboundAtMs: number | null = NOW.getTime() - HOUR_MS): MemoryStore {
  const wake: WakeState = {
    lastLawyerInboundAtMs,
    lastReconcileAtMs: null,
    lastCollectAtMs: null,
    lastDigestAtMs: null,
    heldPlanJson: null,
    heldPlanAtMs: null,
    heldPlanAttempts: 0,
    heldPlanNextAttemptAtMs: null,
    heldPlanTemplateAttemptedAtMs: null,
    watchExpirationMs: null,
    openTodoIdsJson: null,
  };
  return { readWake: async () => ({ ...wake }) } as unknown as MemoryStore;
}

describe("the background pass tells a number whose Google sign-in expired", () => {
  const pass = (
    now: Date,
    dispatch: ReturnType<typeof vi.fn>,
    owner = OWNER,
    lastInboundAtMs: number | null = now.getTime() - HOUR_MS,
  ) =>
    runAdaCollectPass({
      api,
      owner,
      memory: memory(lastInboundAtMs),
      now,
      forceMorning: false,
      trigger: "poll",
      dispatchDigestTurn: dispatch as never,
    });

  beforeEach(() => {
    google.loadAccessToken.mockResolvedValue({ ok: false, reason: "reconnect" });
    stores.account = savedAccount();
  });

  it("drops the dead account and sends that owner one plain note with a fresh link", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const outcome = await pass(NOW, dispatch);

    expect(clearAccount).toHaveBeenCalledExactlyOnceWith(savedAccount());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: OWNER, connectOnly: true, reconnect: true }),
    );
    expect(outcome).toMatchObject({
      delivered: true,
      decision: "connect",
      reason: "reconnect_dispatched",
    });
  });

  it("stays silent for a number with no account, which the morning ask already covers", async () => {
    stores.account = null;
    const dispatch = vi.fn(async () => ({ ok: true }));
    expect(await pass(NOW, dispatch)).toMatchObject({ decision: "none", reason: "not_connected" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(clearAccount).not.toHaveBeenCalled();
  });

  describe("when the note cannot be sent", () => {
    const send = vi.fn();
    const inbound = (atMs: number, owner = OWNER) =>
      recordSenderInbound({
        api: {
          ...api,
          runtime: {
            channel: { outbound: { loadAdapter: async () => ({ sendText: send }) } },
          },
        } as unknown as OpenClawPluginApi,
        atMs,
        channelId: "kapso-whatsapp",
        senders: [`+${owner}`],
      });

    beforeEach(() => {
      send.mockReset();
      stores.account = null;
    });

    it("holds it without sending when the 24-hour window is closed, and sends it with a link made then when that number next writes", async () => {
      stores.account = savedAccount();
      const dispatch = vi.fn(async () => ({ ok: true }));
      for (const lastInbound of [null, NOW.getTime() - 25 * HOUR_MS]) {
        clearHeldReconnectNotes();
        expect(await pass(NOW, dispatch, OWNER, lastInbound)).toMatchObject({
          delivered: false,
          reason: "reconnect_held",
        });
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(clearAccount).toHaveBeenCalledTimes(2);

      stores.account = null;
      await inbound(NOW.getTime() + 5 * HOUR_MS);
      expect(send).toHaveBeenCalledTimes(1);
      const call = send.mock.calls[0]?.[0] as { to: string; text: string };
      expect(call.to).toBe(`+${OWNER}`);
      expect(call.text).toMatch(/^Il collegamento al tuo Gmail è scaduto/u);
      expect(call.text).toContain("accounts.google.com");
      expect(replacePending).toHaveBeenCalledTimes(1);

      send.mockClear();
      await inbound(NOW.getTime() + 6 * HOUR_MS);
      expect(send).not.toHaveBeenCalled();
    });

    it("holds it too when the window is open but the send fails", async () => {
      stores.account = savedAccount();
      const down = vi.fn(async () => ({ ok: false, reason: "down" }));
      expect(await pass(NOW, down)).toMatchObject({ reason: "reconnect_held" });
      expect(down).toHaveBeenCalledTimes(1);
      stores.account = null;
      await inbound(NOW.getTime() + HOUR_MS);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("keeps holding while the send keeps failing, and drops it once the person reconnected", async () => {
      stores.account = savedAccount();
      await pass(
        NOW,
        vi.fn(async () => ({ ok: false, reason: "down" })),
      );
      stores.account = null;
      send.mockRejectedValueOnce(new Error("window closed"));
      await inbound(NOW.getTime() + HOUR_MS);
      expect(send).toHaveBeenCalledTimes(1);

      google.loadAccessToken.mockResolvedValue({
        ok: true,
        accessToken: "a",
        accessExpiresAtMs: NOW.getTime() + 9 * HOUR_MS,
      });
      stores.account = savedAccount({
        accessToken: "a",
        accessExpiresAtMs: NOW.getTime() + 9 * HOUR_MS,
      });
      send.mockClear();
      await inbound(NOW.getTime() + 2 * HOUR_MS);
      expect(send).not.toHaveBeenCalled();
      await inbound(NOW.getTime() + 3 * HOUR_MS);
      expect(send).not.toHaveBeenCalled();
    });

    it("holds per number: another number's message releases nothing of it", async () => {
      stores.account = savedAccount();
      await pass(
        NOW,
        vi.fn(async () => ({ ok: false, reason: "down" })),
      );
      stores.account = null;
      await inbound(NOW.getTime() + HOUR_MS, "393332222222");
      expect(send).not.toHaveBeenCalled();
    });
  });
});

describe("a refreshed Google token is kept", () => {
  const collect = () =>
    runAdaCollectPass({
      api,
      owner: OWNER,
      memory: memory(),
      now: NOW,
      forceMorning: false,
      trigger: "poll",
      dispatchDigestTurn: vi.fn(async () => ({ ok: true })) as never,
    });
  const refreshed = {
    ok: true,
    accessToken: "fresh-access",
    accessExpiresAtMs: NOW.getTime() + HOUR_MS,
  };

  it("saves the new access token for that number, so the next pass need not refresh", async () => {
    stores.account = savedAccount();
    google.loadAccessToken.mockResolvedValue(refreshed);
    await collect();
    expect(updateTokens).toHaveBeenCalledExactlyOnceWith(
      savedAccount(),
      expect.objectContaining({
        accessToken: "fresh-access",
        accessExpiresAtMs: NOW.getTime() + HOUR_MS,
      }),
    );
  });

  it("saves a refresh token Google rotated, and keeps the old one when it did not", async () => {
    stores.account = savedAccount();
    google.loadAccessToken.mockResolvedValue({ ...refreshed, refreshToken: "rotated-refresh" });
    await collect();
    expect(updateTokens).toHaveBeenCalledWith(
      savedAccount(),
      expect.objectContaining({ refreshToken: "rotated-refresh", accessToken: "fresh-access" }),
    );
    updateTokens.mockClear();
    google.loadAccessToken.mockResolvedValue(refreshed);
    await collect();
    expect(updateTokens.mock.calls[0]?.[1]).not.toHaveProperty("refreshToken");
  });

  it("writes nothing when the stored access token was still live", async () => {
    const live = savedAccount({ accessToken: "live", accessExpiresAtMs: NOW.getTime() + HOUR_MS });
    stores.account = live;
    google.loadAccessToken.mockResolvedValue({
      ok: true,
      accessToken: "live",
      accessExpiresAtMs: NOW.getTime() + HOUR_MS,
    });
    await collect();
    expect(updateTokens).not.toHaveBeenCalled();
  });

  it("still collects when saving fails, and says so", async () => {
    stores.account = savedAccount();
    google.loadAccessToken.mockResolvedValue(refreshed);
    updateTokens.mockRejectedValueOnce(new Error("disk full"));
    await expect(collect()).resolves.toMatchObject({ reason: "gmail_500" });
  });
});
