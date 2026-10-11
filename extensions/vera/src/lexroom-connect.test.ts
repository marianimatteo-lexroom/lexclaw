import { describe, expect, it } from "vitest";
import {
  accessTokenExpiresAtMs,
  buildLexroomConnectUrl,
  createConnectState,
  isLexroomAccessLive,
  planLexroomConnect,
  prepareLexroomConnect,
  readConnectState,
  readLexroomConnectConfig,
  sameStoredAccessToken,
} from "./lexroom-connect.js";

const SECRET = "0123456789abcdef";
const CONNECT_URI = "https://gateway.example/vera/lexroom/connect";

describe("lexroom connect config", () => {
  it("derives the connect URI from the Google redirect origin", () => {
    expect(
      readLexroomConnectConfig({
        googleRedirectUri: "https://gateway.example/vera/google/callback",
        googleStateSecret: SECRET,
      }),
    ).toEqual({
      ok: true,
      settings: {
        connectUri: CONNECT_URI,
        stateSecret: SECRET,
        baseUrl: undefined,
      },
    });
  });

  it("rejects a connect URI that is not the Lexroom path", () => {
    expect(
      readLexroomConnectConfig({
        lexroomConnectUri: "https://gateway.example/vera/google/callback",
        googleStateSecret: SECRET,
      }),
    ).toEqual({
      ok: false,
      error: "lexroomConnectUri must use the path /vera/lexroom/connect.",
    });
  });
});

describe("lexroom connect state", () => {
  it("round-trips a signed state and rejects tampering", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const issued = createConnectState(SECRET, now);
    expect(readConnectState(SECRET, issued.state, now)).toEqual({ nonce: issued.nonce });
    expect(readConnectState(SECRET, `${issued.state}x`, now)).toBeNull();
    expect(
      readConnectState(SECRET, issued.state, new Date(issued.expiresAtMs + 1)),
    ).toBeNull();
  });
});

describe("prepareLexroomConnect", () => {
  it("returns connected when the saved bearer is still live", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const exp = Math.floor(now.getTime() / 1000) + 3600;
    const accessToken = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ exp })).toString("base64url"),
      "sig",
    ].join(".");
    await expect(
      prepareLexroomConnect({
        config: {
          googleRedirectUri: "https://gateway.example/vera/google/callback",
          googleStateSecret: SECRET,
        },
        now,
        account: {
          email: "lawyer@lexroom.ai",
          accessToken,
          accessExpiresAtMs: exp * 1000,
        },
        savePending: async () => {
          throw new Error("should not save pending when already connected");
        },
      }),
    ).resolves.toEqual({
      ok: true,
      connected: true,
      email: "lawyer@lexroom.ai",
    });
  });

  it("issues one connect URL when Lexroom is not linked", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    let saved: { nonce: string; expiresAtMs: number } | null = null;
    const result = await prepareLexroomConnect({
      config: {
        googleRedirectUri: "https://gateway.example/vera/google/callback",
        googleStateSecret: SECRET,
      },
      now,
      account: null,
      savePending: async (nonce, expiresAtMs) => {
        saved = { nonce, expiresAtMs };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.connected) {
      throw new Error("expected an ask");
    }
    expect(saved?.nonce).toBeTruthy();
    expect(result.ask.url.startsWith(`${CONNECT_URI}?state=`)).toBe(true);
    expect(result.ask.message).toContain(result.ask.url);
    const state = new URL(result.ask.url).searchParams.get("state") ?? "";
    expect(readConnectState(SECRET, state, now)?.nonce).toBe(saved?.nonce);
  });
});

function jwt(expSeconds: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url"),
    "sig",
  ].join(".");
}

const connectConfig = {
  googleRedirectUri: "https://gateway.example/vera/google/callback",
  googleStateSecret: SECRET,
};

describe("planLexroomConnect", () => {
  it("returns connected false and an ask when the stored token is rejected", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const exp = Math.floor(now.getTime() / 1000) + 3600;
    let cleared = 0;
    const result = await planLexroomConnect({
      config: connectConfig,
      now,
      account: {
        email: "matteo.mariani+verus@lexroom.ai",
        accessToken: jwt(exp),
        accessExpiresAtMs: exp * 1000,
      },
      savePending: async () => undefined,
      clearAccount: async () => {
        cleared += 1;
      },
      probeAccess: async () => "rejected",
    });
    expect(cleared).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      connected: false,
      reason: "token_rejected",
    });
    if (!result.ok || result.connected) {
      throw new Error("expected an ask");
    }
    expect(result.ask.url.startsWith(`${CONNECT_URI}?state=`)).toBe(true);
    expect(result.ask.message).toContain(result.ask.url);
  });

  it("clears an expired stored token without probing Lexroom", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const exp = Math.floor(now.getTime() / 1000) - 120;
    let probed = false;
    let cleared = false;
    const result = await planLexroomConnect({
      config: connectConfig,
      now,
      account: {
        email: "lawyer@lexroom.ai",
        accessToken: jwt(exp),
        accessExpiresAtMs: exp * 1000,
      },
      savePending: async () => undefined,
      clearAccount: async () => {
        cleared = true;
      },
      probeAccess: async () => {
        probed = true;
        return "live";
      },
    });
    expect(probed).toBe(false);
    expect(cleared).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      connected: false,
      reason: "token_expired",
    });
  });

  it("keeps a stored token when the liveness probe is unknown", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const exp = Math.floor(now.getTime() / 1000) + 3600;
    const result = await planLexroomConnect({
      config: connectConfig,
      now,
      account: {
        email: "lawyer@lexroom.ai",
        accessToken: jwt(exp),
        accessExpiresAtMs: exp * 1000,
      },
      savePending: async () => {
        throw new Error("should stay connected when the probe is unknown");
      },
      clearAccount: async () => {
        throw new Error("should not clear a token during an unknown probe");
      },
      probeAccess: async () => "unknown",
    });
    expect(result).toEqual({
      ok: true,
      connected: true,
      email: "lawyer@lexroom.ai",
    });
  });

  it("issues a first connect ask without a disconnect reason", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const result = await planLexroomConnect({
      config: connectConfig,
      now,
      account: null,
      savePending: async () => undefined,
      clearAccount: async () => {
        throw new Error("should not clear when nothing is stored");
      },
      probeAccess: async () => {
        throw new Error("should not probe when nothing is stored");
      },
    });
    if (!result.ok || result.connected) {
      throw new Error("expected a first-time ask");
    }
    expect(result.reason).toBeUndefined();
    expect(result.ask.url.startsWith(`${CONNECT_URI}?state=`)).toBe(true);
  });
});

describe("stored credential identity", () => {
  it("matches only the bearer Lexroom rejected", () => {
    expect(sameStoredAccessToken("old-token", "old-token")).toBe(true);
    expect(sameStoredAccessToken("new-token", "old-token")).toBe(false);
    expect(sameStoredAccessToken(null, "old-token")).toBe(false);
  });
});

describe("access token liveness", () => {
  it("reads exp from a JWT and applies skew", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const exp = Math.floor(now.getTime() / 1000) + 30;
    const accessToken = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ exp })).toString("base64url"),
      "x",
    ].join(".");
    expect(accessTokenExpiresAtMs(accessToken)).toBe(exp * 1000);
    expect(
      isLexroomAccessLive({
        accessToken,
        accessExpiresAtMs: exp * 1000,
        now,
      }),
    ).toBe(false);
    expect(
      buildLexroomConnectUrl({
        connectUri: CONNECT_URI,
        state: "abc.def",
      }),
    ).toBe(`${CONNECT_URI}?state=abc.def`);
  });
});
