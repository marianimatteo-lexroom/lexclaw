import { describe, expect, it } from "vitest";
import { veraGoogleWorkerUrl } from "./google-account.js";
import {
  buildGoogleConnectUrl,
  createConnectState,
  googleConnectMessage,
  prepareGoogleConnect,
  readConnectState,
  readGoogleConnectConfig,
  GOOGLE_CONNECT_SCOPES,
} from "./google-connect.js";

const NOW = new Date("2026-10-09T07:40:00.000Z");
const CONFIG = {
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/vera/google/callback",
  googleStateSecret: "state-secret-test-value",
};

describe("readGoogleConnectConfig", () => {
  it("accepts the public callback and a localhost callback", () => {
    expect(readGoogleConnectConfig(CONFIG).ok).toBe(true);
    expect(
      readGoogleConnectConfig({
        ...CONFIG,
        googleRedirectUri: "http://127.0.0.1:18789/vera/google/callback",
      }).ok,
    ).toBe(true);
  });

  it("rejects a public http callback and a short state secret", () => {
    expect(
      readGoogleConnectConfig({
        ...CONFIG,
        googleRedirectUri: "http://gateway.example/vera/google/callback",
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

describe("connect state", () => {
  it("round-trips a signed state and rejects tampering and expiry", () => {
    const issued = createConnectState(CONFIG.googleStateSecret, NOW);
    expect(readConnectState(CONFIG.googleStateSecret, issued.state, NOW)).toEqual({
      nonce: issued.nonce,
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
      config: CONFIG,
      now: NOW,
      accountEmail: null,
      savePending: async (nonce, expiresAtMs) => {
        pending.push({ nonce, expiresAtMs });
      },
    });
    expect(pending).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (!result.ok || result.connected) {
      return;
    }
    const url = new URL(result.ask.url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.googleRedirectUri);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_CONNECT_SCOPES]);
    expect(result.ask.services).toEqual(["gmail", "google_calendar"]);
    expect(result.ask.message).toBe(googleConnectMessage(result.ask.url));
    expect(result.ask.message).toContain("Gmail and Google Calendar");
    expect(result.ask.message).toContain(result.ask.url);
    expect(
      buildGoogleConnectUrl({
        clientId: CONFIG.googleClientId,
        redirectUri: CONFIG.googleRedirectUri,
        state: url.searchParams.get("state") ?? "",
      }),
    ).toBe(result.ask.url);
  });

  it("does not mint a link when the account is already connected", async () => {
    let saved = false;
    const result = await prepareGoogleConnect({
      config: CONFIG,
      now: NOW,
      accountEmail: "lawyer@example.com",
      savePending: async () => {
        saved = true;
      },
    });
    expect(saved).toBe(false);
    expect(result).toEqual({
      ok: true,
      connected: true,
      email: "lawyer@example.com",
      services: ["gmail", "google_calendar"],
    });
  });
});

describe("veraGoogleWorkerUrl", () => {
  it("resolves the bundled worker next to the plugin entry", () => {
    expect(veraGoogleWorkerUrl("/opt/lexroom/vera/index.js").pathname).toBe(
      "/opt/lexroom/vera/src/google-account.worker.js",
    );
  });
});
