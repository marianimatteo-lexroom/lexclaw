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
}));

const stores = vi.hoisted(() => ({ account: null as null | Record<string, unknown> }));
const clearAccount = vi.hoisted(() => vi.fn(async () => {}));
const replacePending = vi.hoisted(() => vi.fn(async (_nonce: string, _expiresAtMs: number) => {}));
vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountFromApi: async () => ({
    readAccount: async () => stores.account,
    clearAccount,
    replacePending,
    upsertAccount: vi.fn(async () => {}),
    consumePending: vi.fn(async () => false),
  }),
  openAdaGoogleAccountDbFromApi: async () => ({ listOwners: async () => [] }),
}));

import { executeAdaGoogleConnect } from "./google-tools.js";
import { clearReconnectNotes, runAdaCollectPass } from "./service.js";

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
  clearReconnectNotes();
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

  it("asks for send permission, not a reconnect, when the sign-in works but cannot send", async () => {
    const real = await vi.importActual<typeof import("./google-api.js")>("./google-api.js");
    google.loadAccessToken.mockImplementation(real.loadAccessToken);
    stores.account = savedAccount({ scopes: null, accessExpiresAtMs: NOW.getTime() + HOUR_MS });
    const result = await executeAdaGoogleConnect(OWNER, CONFIG, api, NOW);
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(clearAccount).not.toHaveBeenCalled();
  });
});

function memory(): MemoryStore {
  const wake: WakeState = {
    lastLawyerInboundAtMs: null,
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

describe("the background pass tells a number whose Google sign-in expired, once a day", () => {
  const pass = (now: Date, dispatch: ReturnType<typeof vi.fn>, owner = OWNER) =>
    runAdaCollectPass({
      api,
      owner,
      memory: memory(),
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

    expect(clearAccount).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: OWNER, connectOnly: true, reconnect: true }),
    );
    expect(outcome).toMatchObject({
      delivered: true,
      decision: "connect",
      reason: "reconnect_dispatched",
    });
  });

  it("goes out at most once per 24 hours per number, and other numbers are told on their own", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    await pass(NOW, dispatch);
    const again = await pass(new Date(NOW.getTime() + 15 * 60_000), dispatch);
    const later = await pass(new Date(NOW.getTime() + 23 * HOUR_MS), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ delivered: false, reason: "reconnect_note_recent" });
    expect(later).toMatchObject({ reason: "reconnect_note_recent" });

    await pass(new Date(NOW.getTime() + 15 * 60_000), dispatch, "393332222222");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({ owner: "393332222222" });

    await pass(new Date(NOW.getTime() + 25 * HOUR_MS), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("does not start the 24-hour wait when the note could not be sent", async () => {
    const dispatch = vi.fn(async () => ({ ok: false, reason: "kapso down" }));
    expect(await pass(NOW, dispatch)).toMatchObject({ delivered: false, reason: "kapso down" });
    dispatch.mockResolvedValue({ ok: true });
    await pass(new Date(NOW.getTime() + 15 * 60_000), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("stays silent for a number with no account, which the morning ask already covers", async () => {
    stores.account = null;
    const dispatch = vi.fn(async () => ({ ok: true }));
    expect(await pass(NOW, dispatch)).toMatchObject({ decision: "none", reason: "not_connected" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(clearAccount).not.toHaveBeenCalled();
  });
});
