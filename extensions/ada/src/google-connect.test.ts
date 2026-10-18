import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adaGoogleWorkerUrl } from "./google-account.js";
import {
  buildGoogleConnectUrl,
  CALENDAR_EVENTS_SCOPE,
  canWriteCalendar,
  coversConnectScopes,
  createConnectState,
  googleConnectMessage,
  prepareGoogleConnect,
  readConnectState,
  readGoogleConnectConfig,
  GOOGLE_CONNECT_SCOPES,
} from "./google-connect.js";
import { expandShortLink } from "./short-link-test-support.js";

const NOW = new Date("2026-10-09T07:40:00.000Z");
const CONFIG = {
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/ada/google/callback",
  googleStateSecret: "state-secret-test-value",
};

describe("readGoogleConnectConfig", () => {
  it("accepts the public callback and a localhost callback", () => {
    expect(readGoogleConnectConfig(CONFIG).ok).toBe(true);
    expect(
      readGoogleConnectConfig({
        ...CONFIG,
        googleRedirectUri: "http://127.0.0.1:18789/ada/google/callback",
      }).ok,
    ).toBe(true);
  });

  it("still accepts the pre-rename /vera/google/callback registered in Google Cloud", () => {
    expect(
      readGoogleConnectConfig({
        ...CONFIG,
        googleRedirectUri: "https://gateway.example/vera/google/callback",
      }).ok,
    ).toBe(true);
  });

  it("rejects a public http callback and a short state secret", () => {
    expect(
      readGoogleConnectConfig({
        ...CONFIG,
        googleRedirectUri: "http://gateway.example/ada/google/callback",
      }),
    ).toMatchObject({ ok: false });
    expect(readGoogleConnectConfig({ ...CONFIG, googleStateSecret: "too-short" })).toMatchObject({
      ok: false,
    });
    expect(readGoogleConnectConfig({})).toMatchObject({
      ok: false,
      error: expect.stringContaining("googleClientId"),
    });
  });
});

const OWNER = "393331111111";

describe("connect state", () => {
  it("names the number that asked for the link and rejects a state that names no one", () => {
    const secret = CONFIG.googleStateSecret;
    const issued = createConnectState(secret, NOW, OWNER);
    expect(readConnectState(secret, issued.state, NOW)).toEqual({
      nonce: issued.nonce,
      owner: OWNER,
    });
    const payload = (owner: unknown) =>
      Buffer.from(JSON.stringify({ nonce: issued.nonce, exp: issued.expiresAtMs, owner })).toString(
        "base64url",
      );
    const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");
    const legacy = payload(undefined);
    expect(readConnectState(secret, `${legacy}.${sign(legacy)}`, NOW)).toBeNull();
    const notANumber = payload("lawyer");
    expect(readConnectState(secret, `${notANumber}.${sign(notANumber)}`, NOW)).toBeNull();
    const forged = payload("393332222222");
    expect(readConnectState(secret, `${forged}.${issued.state.split(".")[1]}`, NOW)).toBeNull();
  });

  it("round-trips a signed state and rejects tampering and expiry", () => {
    const issued = createConnectState(CONFIG.googleStateSecret, NOW, OWNER);
    expect(readConnectState(CONFIG.googleStateSecret, issued.state, NOW)).toEqual({
      nonce: issued.nonce,
      owner: OWNER,
    });
    const tampered = `${issued.state.slice(0, -1)}${issued.state.endsWith("a") ? "b" : "a"}`;
    expect(readConnectState(CONFIG.googleStateSecret, tampered, NOW)).toBeNull();
    expect(
      readConnectState(CONFIG.googleStateSecret, issued.state, new Date(issued.expiresAtMs + 1)),
    ).toBeNull();
  });
});

describe("prepareGoogleConnect", () => {
  it("asks for Gmail and Google Calendar with one Google link", async () => {
    const pending: Array<{ nonce: string; expiresAtMs: number }> = [];
    const result = await prepareGoogleConnect({
      owner: OWNER,
      config: CONFIG,
      now: NOW,
      account: null,
      savePending: async (nonce, expiresAtMs) => {
        pending.push({ nonce, expiresAtMs });
      },
    });
    expect(pending).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (!result.ok || result.connected) {
      return;
    }
    expect(result.ask.url).toMatch(/^https:\/\/gateway\.example\/g\/[\w-]{10}$/u);
    expect(result.ask.message).not.toContain("accounts.google.com");
    const url = expandShortLink(result.ask.url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.googleRedirectUri);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_CONNECT_SCOPES]);
    expect([...GOOGLE_CONNECT_SCOPES]).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    expect(result.ask.services).toEqual(["gmail", "google_calendar", "gmail_send"]);
    expect(result.ask.message).toContain("add calendar events you confirm");
    expect(result.ask.message).toBe(googleConnectMessage(result.ask.url));
    expect(result.ask.message).toContain("Gmail and Google Calendar");
    expect(result.ask.message).toContain(result.ask.url);
    expect(
      buildGoogleConnectUrl({
        clientId: CONFIG.googleClientId,
        redirectUri: CONFIG.googleRedirectUri,
        state: url.searchParams.get("state") ?? "",
      }),
    ).toBe(url.toString());
  });

  it("does not mint a link when the account can already send mail and edit events", async () => {
    let saved = false;
    const result = await prepareGoogleConnect({
      owner: OWNER,
      config: CONFIG,
      now: NOW,
      account: {
        email: "lawyer@example.com",
        scopes:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events",
      },
      savePending: async () => {
        saved = true;
      },
    });
    expect(saved).toBe(false);
    expect(result).toEqual({
      ok: true,
      connected: true,
      email: "lawyer@example.com",
      services: ["gmail", "google_calendar", "gmail_send"],
    });
  });

  it("asks again when the saved connection cannot send mail", async () => {
    const result = await prepareGoogleConnect({
      owner: OWNER,
      config: CONFIG,
      now: NOW,
      account: { email: "lawyer@example.com", scopes: null },
      savePending: async () => {},
    });
    expect(result.ok && !result.connected && result.ask.message).toContain("cannot send mail yet");
  });
});

describe("a connection that only holds the old read-only calendar scope", () => {
  const oldScopes =
    "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly";

  it("is offered a fresh link that asks for the calendar permission", async () => {
    const result = await prepareGoogleConnect({
      owner: OWNER,
      config: CONFIG,
      now: NOW,
      account: { email: "lawyer@example.com", scopes: oldScopes },
      savePending: async () => {},
    });
    expect(result.ok && !result.connected && result.ask.message).toContain(
      "fresh permission to add and change calendar events",
    );
    expect(canWriteCalendar(oldScopes)).toBe(false);
    expect(canWriteCalendar(null)).toBe(false);
    expect(canWriteCalendar(`${oldScopes} ${CALENDAR_EVENTS_SCOPE}`)).toBe(true);
  });

  it("is not accepted as a new grant when Google omits the events scope", () => {
    expect(coversConnectScopes(oldScopes)).toBe(false);
    expect(coversConnectScopes(`${oldScopes} ${CALENDAR_EVENTS_SCOPE}`)).toBe(true);
  });
});

describe("adaGoogleWorkerUrl", () => {
  it("resolves the bundled worker next to the plugin entry", () => {
    expect(adaGoogleWorkerUrl("/opt/lexroom/ada/index.js").pathname).toBe(
      "/opt/lexroom/ada/src/google-account.worker.js",
    );
  });
});
