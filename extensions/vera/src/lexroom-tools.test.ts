import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomAccountRecord, LexroomAccountStore } from "./lexroom-account-contract.js";

const openVeraLexroomAccountFromApi = vi.hoisted(() => vi.fn());

vi.mock("./lexroom-account.js", () => ({ openVeraLexroomAccountFromApi }));

import {
  executeVeraLexroomConnect,
  lexroomConnectedText,
  resolveLexroomConfig,
  sendLexroomConnectedNotice,
} from "./lexroom-tools.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const api = { logger, runtimeSource: "/fake/index.ts", runtime: {} } as never;

const CONNECT_CONFIG = {
  lexroomConnectUri: "https://gateway.example/vera/lexroom/connect",
  lexroomStateSecret: "0123456789abcdef",
};

function account(overrides: Partial<LexroomAccountRecord> = {}): LexroomAccountRecord {
  return {
    email: "lawyer@example.com",
    accessToken: "test-account-token",
    refreshToken: "",
    accessExpiresAtMs: NOW.getTime() + 3_600_000,
    connectedAtMs: 1,
    ...overrides,
  };
}

function useStore(readAccount: LexroomAccountStore["readAccount"]) {
  const store: LexroomAccountStore = {
    replacePending: vi.fn(async () => {}),
    hasPending: vi.fn(async () => false),
    consumePending: vi.fn(async () => false),
    upsertAccount: vi.fn(async () => {}),
    readAccount,
    clearAccount: vi.fn(async () => {}),
  };
  openVeraLexroomAccountFromApi.mockResolvedValue(store);
  return store;
}

function expiredJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(NOW.getTime() / 1000) - 10 }));
  return `header.${payload.toString("base64url")}.signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveLexroomConfig", () => {
  it("uses the linked account token and keeps only base URL and timeout from config", async () => {
    useStore(async () => account());
    const resolved = await resolveLexroomConfig({
      config: {
        accessToken: "test-config-token",
        baseUrl: "https://lexroom.example",
        timeoutMs: 5000,
      },
      api,
      now: NOW,
    });
    expect(resolved).toEqual({
      ok: true,
      source: "account",
      email: "lawyer@example.com",
      config: {
        accessToken: "test-account-token",
        baseUrl: "https://lexroom.example",
        timeoutMs: 5000,
      },
    });
  });

  it("asks to reconnect, and ignores the static token, when the linked account expired", async () => {
    useStore(async () =>
      account({ accessExpiresAtMs: NOW.getTime() - 1000, accessToken: "test-stale-token" }),
    );
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "test-config-token" },
      api,
      now: NOW,
    });
    expect(resolved).toEqual({
      ok: false,
      reason: "not_connected",
      error: "The Lexroom connection expired. Call vera_lexroom_connect and send that link.",
    });
  });

  it("falls back to the static config token when no account is linked", async () => {
    useStore(async () => null);
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "  test-config-token  ", baseUrl: "https://lexroom.example" },
      api,
      now: NOW,
    });
    expect(resolved).toEqual({
      ok: true,
      source: "config",
      config: {
        accessToken: "test-config-token",
        baseUrl: "https://lexroom.example",
        timeoutMs: undefined,
      },
    });
  });

  it("reports not connected when there is no account and no usable config token", async () => {
    useStore(async () => null);
    const expected = {
      ok: false,
      reason: "not_connected",
      error: "Lexroom is not connected. Call vera_lexroom_connect and send that link.",
    };
    expect(await resolveLexroomConfig({ config: {}, api, now: NOW })).toEqual(expected);
    expect(await resolveLexroomConfig({ config: { accessToken: "   " }, api, now: NOW })).toEqual(
      expected,
    );
    expect(
      await resolveLexroomConfig({ config: { accessToken: expiredJwt() }, api, now: NOW }),
    ).toEqual(expected);
  });

  it("logs and falls back to the config token when the store cannot open", async () => {
    openVeraLexroomAccountFromApi.mockRejectedValue(new Error("disk full"));
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "test-config-token" },
      api,
      now: NOW,
    });
    expect(resolved).toMatchObject({ ok: true, source: "config" });
    expect(logger.error).toHaveBeenCalledWith("vera lexroom account store failed: disk full");
  });

  it("logs and falls back to the config token when reading the account throws", async () => {
    useStore(async () => {
      throw new Error("read failed");
    });
    const resolved = await resolveLexroomConfig({
      config: { accessToken: "test-config-token" },
      api,
      now: NOW,
    });
    expect(resolved).toMatchObject({ ok: true, source: "config" });
    expect(logger.error).toHaveBeenCalledWith("vera lexroom resolve failed: read failed");
  });
});

describe("executeVeraLexroomConnect", () => {
  it("reports connected without issuing a link when the saved bearer is live", async () => {
    const store = useStore(async () => account());
    const result = await executeVeraLexroomConnect(CONNECT_CONFIG, api, NOW);
    expect(result).toEqual({ ok: true, connected: true, email: "lawyer@example.com" });
    expect(store.replacePending).not.toHaveBeenCalled();
  });

  it("saves a pending nonce and returns a signed link when not connected", async () => {
    const store = useStore(async () => null);
    const result = await executeVeraLexroomConnect(CONNECT_CONFIG, api, NOW);
    expect(result).toMatchObject({ ok: true, connected: false });
    const ask = (result as { ask: { url: string; message: string } }).ask;
    expect(ask.url.startsWith("https://gateway.example/vera/lexroom/connect?state=")).toBe(true);
    expect(ask.message).toContain(ask.url);
    expect(store.replacePending).toHaveBeenCalledTimes(1);
    expect(store.replacePending).toHaveBeenCalledWith(
      expect.any(String),
      NOW.getTime() + 30 * 60 * 1000,
    );
  });

  it("returns the config error and saves nothing when connect is not configured", async () => {
    const store = useStore(async () => null);
    const result = await executeVeraLexroomConnect({}, api, NOW);
    expect(result).toMatchObject({ ok: false });
    expect(store.replacePending).not.toHaveBeenCalled();
  });

  it("returns a generic failure when the store cannot open", async () => {
    openVeraLexroomAccountFromApi.mockRejectedValue(new Error("boom"));
    expect(await executeVeraLexroomConnect(CONNECT_CONFIG, api, NOW)).toEqual({
      ok: false,
      error: "Vera could not open the Lexroom account store.",
    });
  });

  it("returns a generic failure when saving the pending nonce throws", async () => {
    const store = useStore(async () => null);
    vi.mocked(store.replacePending).mockRejectedValue(new Error("write failed"));
    expect(await executeVeraLexroomConnect(CONNECT_CONFIG, api, NOW)).toEqual({
      ok: false,
      error: "Vera could not prepare the Lexroom connect link.",
    });
    expect(logger.error).toHaveBeenCalledWith("vera lexroom connect failed: write failed");
  });
});

describe("sendLexroomConnectedNotice", () => {
  const config = { channels: { "kapso-whatsapp": { defaultTo: "+10000000000" } } } as never;

  it("sends the connected text to the configured WhatsApp target", async () => {
    const sendText = vi.fn(async () => ({}));
    const loadAdapter = vi.fn(async () => ({ sendText }));
    const result = await sendLexroomConnectedNotice({
      config,
      email: "lawyer@example.com",
      loadAdapter,
    });
    expect(result).toEqual({ ok: true });
    expect(loadAdapter).toHaveBeenCalledWith("kapso-whatsapp");
    expect(sendText).toHaveBeenCalledWith({
      cfg: config,
      to: "+10000000000",
      text: lexroomConnectedText("lawyer@example.com"),
    });
    expect(lexroomConnectedText("lawyer@example.com")).not.toContain("lawyer@example.com");
  });

  it("does not load an adapter when no target is configured", async () => {
    const loadAdapter = vi.fn();
    expect(
      await sendLexroomConnectedNotice({
        config: {} as never,
        email: "x@example.com",
        loadAdapter,
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp defaultTo is not set" });
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it("reports an unavailable outbound adapter", async () => {
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => null,
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => ({}),
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
  });

  it("returns adapter load and send failures instead of throwing", async () => {
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => {
          throw new Error("adapter missing");
        },
      }),
    ).toEqual({ ok: false, error: "adapter missing" });
    expect(
      await sendLexroomConnectedNotice({
        config,
        email: "x@example.com",
        loadAdapter: async () => ({
          sendText: async () => {
            throw new Error("send rejected");
          },
        }),
      }),
    ).toEqual({ ok: false, error: "send rejected" });
  });
});
