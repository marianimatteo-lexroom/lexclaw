import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accessTokenExpiresAtMs,
  buildLexroomConnectUrl,
  createConnectState,
  isLexroomAccessLive,
  prepareLexroomConnect,
  readConnectState,
  readLexroomConnectConfig,
} from "./lexroom-connect.js";

const SECRET = "0123456789abcdef";
const CONNECT_URI = "https://gateway.example/ada/lexroom/connect";

describe("lexroom connect config", () => {
  it("derives the connect URI from the Google redirect origin", () => {
    expect(
      readLexroomConnectConfig({
        googleRedirectUri: "https://gateway.example/ada/google/callback",
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

  it.each(["/ada/lexroom/connect", "/vera/lexroom/connect"])(
    "accepts the connect path %s, including the pre-rename one saved in older config",
    (pathname) => {
      expect(
        readLexroomConnectConfig({
          lexroomConnectUri: `https://gateway.example${pathname}`,
          googleStateSecret: SECRET,
        }),
      ).toMatchObject({ ok: true });
    },
  );

  it("rejects a connect URI that is not the Lexroom path", () => {
    expect(
      readLexroomConnectConfig({
        lexroomConnectUri: "https://gateway.example/ada/google/callback",
        googleStateSecret: SECRET,
      }),
    ).toEqual({
      ok: false,
      error: "lexroomConnectUri must use the path /ada/lexroom/connect or /vera/lexroom/connect.",
    });
  });
});

const OWNER = "393331111111";

describe("lexroom connect state", () => {
  it("names the number that asked for the link and rejects a state that names no one", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const issued = createConnectState(SECRET, now, OWNER);
    expect(readConnectState(SECRET, issued.state, now)).toEqual({
      nonce: issued.nonce,
      owner: OWNER,
    });
    const payload = (owner: unknown) =>
      Buffer.from(JSON.stringify({ nonce: issued.nonce, exp: issued.expiresAtMs, owner })).toString(
        "base64url",
      );
    const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("base64url");
    const legacy = payload(undefined);
    expect(readConnectState(SECRET, `${legacy}.${sign(legacy)}`, now)).toBeNull();
    const forged = payload("393332222222");
    expect(readConnectState(SECRET, `${forged}.${issued.state.split(".")[1]}`, now)).toBeNull();
  });

  it("round-trips a signed state and rejects tampering", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const issued = createConnectState(SECRET, now, OWNER);
    expect(readConnectState(SECRET, issued.state, now)).toEqual({
      nonce: issued.nonce,
      owner: OWNER,
    });
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
        owner: OWNER,
        config: {
          googleRedirectUri: "https://gateway.example/ada/google/callback",
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
      owner: OWNER,
      config: {
        googleRedirectUri: "https://gateway.example/ada/google/callback",
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
    expect(readConnectState(SECRET, state, now)).toMatchObject({
      nonce: saved?.nonce,
      owner: OWNER,
    });
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
