import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAccountRecord, GoogleAccountStore } from "./google-account-contract.js";
import { handleAdaGoogleCallback } from "./google-callback.js";
import { googleConnectMessage, prepareGoogleConnect } from "./google-connect.js";
import { prepareLexroomConnect } from "./lexroom-connect.js";
import { expandShortLink } from "./short-link-test-support.js";
import { handleAdaShortLink } from "./short-links-http.js";
import { mintShortLink, resolveShortLink } from "./short-links.js";

const NOW = new Date("2026-10-09T07:40:00.000Z");
const OWNER = "393331111111";
const GOOGLE_CONFIG = {
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://vera.example/vera/google/callback",
  googleStateSecret: "state-secret-test-value",
};

function response() {
  const headers = new Map<string, string>();
  return {
    statusCode: 0,
    headers,
    body: "",
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(body = "") {
      this.body = body;
    },
  };
}

function open(kind: "g" | "l", code: string, now: Date, method = "GET") {
  const res = response();
  handleAdaShortLink(
    { method, url: `/${kind}/${code}` } as IncomingMessage,
    res as unknown as ServerResponse,
    kind,
    now,
  );
  return res;
}

async function mintGoogle(owner = OWNER) {
  const result = await prepareGoogleConnect({
    owner,
    config: GOOGLE_CONFIG,
    now: NOW,
    account: null,
    savePending: async () => {},
  });
  if (!result.ok || result.connected) {
    throw new Error("expected an ask");
  }
  return result.ask;
}

describe("short connect links", () => {
  it("sends a short link on the public origin instead of the Google URL", async () => {
    const ask = await mintGoogle();
    expect(ask.url).toMatch(/^https:\/\/vera\.example\/g\/[A-Za-z0-9_-]{10}$/u);
    expect(ask.message).toBe(googleConnectMessage(ask.url));
    expect(ask.message).toContain(ask.url);
    expect(ask.message).not.toContain("accounts.google.com");
    expect(ask.message).not.toContain("state=");
  });

  it("redirects to the full Google URL, keeping the signed state", async () => {
    const ask = await mintGoogle();
    const res = open("g", ask.url.split("/").pop() ?? "", NOW);
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe(GOOGLE_CONFIG.googleRedirectUri);
    expect(location.searchParams.get("state")?.split(".")).toHaveLength(2);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(open("g", ask.url.split("/").pop() ?? "", NOW, "HEAD").statusCode).toBe(302);
  });

  it("answers an unknown, malformed or wrong-kind code with a friendly Italian page", async () => {
    const ask = await mintGoogle();
    const code = ask.url.split("/").pop() ?? "";
    for (const res of [
      open("g", "AAAAAAAAAA", NOW),
      open("g", "x", NOW),
      open("l", code, NOW),
      open("g", code, NOW, "POST"),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.headers.get("location")).toBeUndefined();
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.body).toContain('lang="it"');
      expect(res.body).toContain("Link scaduto");
      expect(res.body).toContain("chiedi ad Ada un nuovo link");
      expect(res.body).not.toMatch(/Error|stack|node_modules/iu);
    }
  });

  it("expires with the signed state", async () => {
    const ask = await mintGoogle();
    const code = ask.url.split("/").pop() ?? "";
    const expiresAtMs = NOW.getTime() + 30 * 60 * 1000;
    expect(open("g", code, new Date(expiresAtMs - 1)).statusCode).toBe(302);
    const late = open("g", code, new Date(expiresAtMs));
    expect(late.statusCode).toBe(404);
    expect(late.body).toContain("Link scaduto");
    expect(resolveShortLink("g", code, NOW)).toBeNull();
  });

  it("keeps one live code per number and kind, and the table bounded", async () => {
    const first = await mintGoogle();
    const second = await mintGoogle();
    expect(open("g", first.url.split("/").pop() ?? "", NOW).statusCode).toBe(404);
    expect(open("g", second.url.split("/").pop() ?? "", NOW).statusCode).toBe(302);

    const codes = new Set<string>();
    const expiresAtMs = NOW.getTime() + 60_000;
    const firstOfMany = mintShortLink({
      kind: "g",
      owner: "bulk-0",
      nonce: "n0",
      target: "https://example.com/0",
      expiresAtMs,
      now: NOW,
    });
    for (let i = 1; i < 2500; i += 1) {
      codes.add(
        mintShortLink({
          kind: "g",
          owner: `bulk-${i}`,
          nonce: `n${i}`,
          target: `https://example.com/${i}`,
          expiresAtMs,
          now: NOW,
        }),
      );
    }
    expect(codes.size).toBe(2499);
    expect(resolveShortLink("g", firstOfMany, NOW)).toBeNull();
    expect(resolveShortLink("g", [...codes].at(-1) ?? "", NOW)).toBe("https://example.com/2499");
  });

  it("serves Lexroom connect links under /l/ with the same state", async () => {
    const result = await prepareLexroomConnect({
      owner: OWNER,
      config: GOOGLE_CONFIG,
      now: NOW,
      account: null,
      savePending: async () => {},
    });
    if (!result.ok || result.connected) {
      throw new Error("expected an ask");
    }
    expect(result.ask.url).toMatch(/^https:\/\/vera\.example\/l\/[A-Za-z0-9_-]{10}$/u);
    const res = open("l", result.ask.url.split("/").pop() ?? "", NOW);
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/ada/lexroom/connect");
  });

  it("is spent when the OAuth callback consumes the state", async () => {
    const ask = await mintGoogle();
    const full = expandShortLink(ask.url);
    const state = full.searchParams.get("state") ?? "";
    const pending = new Set<string>();
    let account: GoogleAccountRecord | null = null;
    const store: GoogleAccountStore = {
      replacePending: async () => {},
      consumePending: async (nonce) => pending.delete(nonce),
      upsertAccount: async (next) => {
        account = next;
      },
      readAccount: async () => account,
      clearAccount: async () => {},
    };
    const nonce = JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString())
      .nonce as string;
    pending.add(nonce);
    const res = response();
    await handleAdaGoogleCallback(
      { method: "GET", url: `/vera/google/callback?code=c&state=${state}` } as IncomingMessage,
      res as unknown as ServerResponse,
      {
        config: GOOGLE_CONFIG,
        now: () => NOW,
        openStore: async () => store,
        exchange: vi.fn(async () => ({
          ok: true as const,
          token: {
            email: "a@example.com",
            refreshToken: "r",
            accessToken: "t",
            accessExpiresAtMs: NOW.getTime() + 1000,
          },
        })),
        log: { error() {} },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(open("g", ask.url.split("/").pop() ?? "", NOW).statusCode).toBe(404);
  });
});
