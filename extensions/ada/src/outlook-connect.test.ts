import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConnectState } from "./connect-state.js";
import { bindOutlookOwner } from "./outlook-account.js";
import {
  OUTLOOK_CALLBACK_PATH,
  outlookConnectConfigFrom,
  outlookStateKey,
  prepareOutlookConnect,
  readOutlookConnectConfig,
} from "./outlook-connect.js";
import { readOutlookApp } from "./outlook-oauth.js";
import {
  ANNA,
  BRUNO,
  callbackDeps,
  newMockMicrosoft,
  openOutlookTestDb,
  openShortLink,
  OUTLOOK_ENV,
  OUTLOOK_PLUGIN_CONFIG,
  REDIRECT_URI,
  signInThroughFlow,
  visitCallback,
  type MockMicrosoft,
} from "./outlook-test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = new Date("2026-10-20T09:00:00.000Z");
const MINUTE = 60_000;
const config = outlookConnectConfigFrom(OUTLOOK_PLUGIN_CONFIG);

let mock: MockMicrosoft;
let store: ReturnType<typeof openOutlookTestDb>;
beforeEach(() => {
  mock = newMockMicrosoft();
  store = openOutlookTestDb(tempDirs.make("ada-outlook-connect-"));
});
afterEach(() => store.close());

async function link(owner = ANNA, now = NOW) {
  const ask = await prepareOutlookConnect({ owner, config, db: store.db, now, env: OUTLOOK_ENV });
  if (!ask.ok || ask.connected) {
    throw new Error("expected a link");
  }
  return ask.ask;
}

describe("the Outlook connect link", () => {
  it("is a short Ada link whose target is Microsoft's PKCE sign-in for the Entra app", async () => {
    const ask = await link();
    expect(ask.url).toMatch(/^https:\/\/vera\.example\/o\/[A-Za-z0-9_-]{10}$/u);
    expect(ask.message).toContain(ask.url);
    const target = new URL(openShortLink(ask.url, NOW).headers.location ?? "");
    expect(target.origin + target.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      client_id: "app-client-id",
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      response_mode: "query",
      scope: "offline_access openid email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite",
      code_challenge_method: "S256",
    });
    expect(target.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(OUTLOOK_CALLBACK_PATH).toBe("/ada/outlook/callback");
  });

  it("names the number that asked, signed with a key no other connect link shares", async () => {
    const ask = await link(BRUNO);
    const target = new URL(openShortLink(ask.url, NOW).headers.location ?? "");
    const state = target.searchParams.get("state") ?? "";
    const secret = readOutlookConnectConfig(config);
    expect(
      secret.ok && readConnectState(outlookStateKey(secret.settings.stateSecret), state, NOW),
    ).toMatchObject({
      owner: BRUNO,
    });
    expect(readConnectState(OUTLOOK_PLUGIN_CONFIG.googleStateSecret, state, NOW)).toBeNull();
  });

  it("uses the tenant from ADA_MS_TENANT and defaults to common", async () => {
    expect(readOutlookApp(OUTLOOK_ENV)?.tenant).toBe("common");
    expect(
      readOutlookApp({ ...OUTLOOK_ENV, ADA_MS_TENANT: "contoso.onmicrosoft.com" })?.tenant,
    ).toBe("contoso.onmicrosoft.com");
    expect(readOutlookApp({ ...OUTLOOK_ENV, ADA_MS_TENANT: "../evil?x=" })).toBeNull();
  });

  it("expires after 30 minutes, in the link and in the signed state", async () => {
    const ask = await link();
    const target = new URL(openShortLink(ask.url, NOW).headers.location ?? "");
    expect(openShortLink(ask.url, new Date(NOW.getTime() + 29 * MINUTE)).statusCode).toBe(302);
    expect(openShortLink(ask.url, new Date(NOW.getTime() + 31 * MINUTE)).statusCode).toBe(404);

    const late = new Date(NOW.getTime() + 31 * MINUTE);
    const back = mock.signIn(target.href, "anna");
    const page = await visitCallback(back, callbackDeps({ db: store.db, mock, now: late }));
    expect(page.statusCode).toBe(400);
    expect(page.body).toContain("Link expired");
    expect(await bindOutlookOwner(store.db, ANNA).readAccount()).toBeNull();
  });

  it("works once: a second redirect with the same state is refused, and so is the short link", async () => {
    const ask = await link();
    const target = openShortLink(ask.url, NOW).headers.location ?? "";
    const back = mock.signIn(target, "anna");
    const deps = callbackDeps({ db: store.db, mock, now: NOW });
    expect((await visitCallback(back, deps)).statusCode).toBe(200);
    expect(openShortLink(ask.url, NOW).statusCode).toBe(404);
    const again = mock.signIn(target, "anna");
    const second = await visitCallback(again, deps);
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain("Link expired");
  });

  it("is replaced by a newer link for the same number", async () => {
    const first = await link();
    const second = await link();
    expect(openShortLink(first.url, NOW).statusCode).toBe(404);
    expect(openShortLink(second.url, NOW).statusCode).toBe(302);
  });

  it("is not issued to someone already connected, unless forced", async () => {
    await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now: NOW });
    const connected = await prepareOutlookConnect({
      owner: ANNA,
      config,
      db: store.db,
      now: NOW,
      env: OUTLOOK_ENV,
      fetchImpl: mock.fetch,
    });
    expect(connected).toEqual({ ok: true, connected: true, email: "anna@contoso.example" });
    const forced = await prepareOutlookConnect({
      owner: ANNA,
      config,
      db: store.db,
      now: NOW,
      force: true,
      env: OUTLOOK_ENV,
    });
    expect(forced).toMatchObject({ ok: true, connected: false });
  });
});

describe("the Outlook callback", () => {
  it("saves the tokens for the number named in the state, encrypted, and confirms to that number only", async () => {
    const notified: string[] = [];
    const ask = await link(ANNA);
    const back = mock.signIn(openShortLink(ask.url, NOW).headers.location ?? "", "anna");
    const page = await visitCallback(
      back,
      callbackDeps({
        db: store.db,
        mock,
        now: NOW,
        notifyConnected: async (owner) => {
          notified.push(owner);
          return { ok: true };
        },
      }),
    );
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Connected");
    expect(page.body).toContain("anna@contoso.example");
    expect(notified).toEqual([ANNA]);
    const saved = await bindOutlookOwner(store.db, ANNA).readAccount();
    expect(saved).toMatchObject({
      email: "anna@contoso.example",
      scope: expect.stringContaining("Mail.Send"),
      connectedAtMs: NOW.getTime(),
      accessExpiresAtMs: NOW.getTime() + 3600_000,
    });
    expect(saved?.refreshToken).toMatch(/^rt-anna-/u);
    expect(await bindOutlookOwner(store.db, BRUNO).readAccount()).toBeNull();
  });

  it("proves the PKCE verifier and the confidential client to Microsoft", async () => {
    await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now: NOW });
    const exchange = mock.requests.find((request) => request.url.endsWith("/oauth2/v2.0/token"));
    const form = new URLSearchParams(exchange?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe("app-client-secret");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("refuses a consent that lacks a permission Ada needs", async () => {
    mock.grantedScope = "openid email profile User.Read Mail.ReadWrite offline_access";
    const page = await signInThroughFlow({
      mock,
      db: store.db,
      owner: ANNA,
      user: "anna",
      now: NOW,
    });
    expect(page.statusCode).toBe(400);
    expect(page.body).toContain("Approval needed");
    expect(await bindOutlookOwner(store.db, ANNA).readAccount()).toBeNull();
  });

  it("says plainly that the IT admin must approve the app when the redirect carries AADSTS65001", async () => {
    const adminNotices: string[] = [];
    mock.authorizeError = {
      error: "access_denied",
      description:
        "AADSTS65001: The user or administrator has not consented to use the application.",
    };
    const ask = await link(ANNA);
    const back = mock.signIn(openShortLink(ask.url, NOW).headers.location ?? "", "anna");
    const page = await visitCallback(
      back,
      callbackDeps({
        db: store.db,
        mock,
        now: NOW,
        notifyAdminConsent: async (owner) => {
          adminNotices.push(owner);
          return { ok: true };
        },
      }),
    );
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Admin approval needed");
    expect(page.body).toContain("IT administrator");
    expect(adminNotices).toEqual([ANNA]);
    expect(await bindOutlookOwner(store.db, ANNA).readAccount()).toBeNull();
  });

  it.each([
    ["consent_required", "AADSTS65001"],
    ["interaction_required", "AADSTS90094: The grant requires admin permission."],
  ])("recognizes the admin-consent signal %s", async (error, description) => {
    mock.authorizeError = { error, description };
    const ask = await link(ANNA);
    const back = mock.signIn(openShortLink(ask.url, NOW).headers.location ?? "", "anna");
    const page = await visitCallback(back, callbackDeps({ db: store.db, mock, now: NOW }));
    expect(page.body).toContain("Admin approval needed");
  });

  it("recognizes the admin-consent failure of the token exchange, notifies once, and does not loop", async () => {
    const adminNotices: string[] = [];
    mock.exchangeFailure = "admin_consent";
    const ask = await link(ANNA);
    const back = mock.signIn(openShortLink(ask.url, NOW).headers.location ?? "", "anna");
    const page = await visitCallback(
      back,
      callbackDeps({
        db: store.db,
        mock,
        now: NOW,
        notifyAdminConsent: async (owner) => {
          adminNotices.push(owner);
          return { ok: true };
        },
      }),
    );
    expect(page.body).toContain("Admin approval needed");
    expect(adminNotices).toEqual([ANNA]);
    // A request for another link is answered with the reason, not with a link that fails the same way.
    const retry = await prepareOutlookConnect({
      owner: ANNA,
      config,
      db: store.db,
      now: new Date(NOW.getTime() + MINUTE),
      env: OUTLOOK_ENV,
    });
    expect(retry).toMatchObject({ ok: false, reason: "admin_consent_required" });
    // Once the person says the admin approved it, force issues a link again.
    const forced = await prepareOutlookConnect({
      owner: ANNA,
      config,
      db: store.db,
      now: new Date(NOW.getTime() + MINUTE),
      force: true,
      env: OUTLOOK_ENV,
    });
    expect(forced).toMatchObject({ ok: true, connected: false });
    // Someone else's number is unaffected.
    expect(
      await prepareOutlookConnect({
        owner: BRUNO,
        config,
        db: store.db,
        now: NOW,
        env: OUTLOOK_ENV,
      }),
    ).toMatchObject({ ok: true, connected: false });
  });

  it("shows a plain retry page when the person declines", async () => {
    mock.authorizeError = {
      error: "access_denied",
      description: "AADSTS65004: The user declined.",
    };
    const ask = await link(ANNA);
    const back = mock.signIn(openShortLink(ask.url, NOW).headers.location ?? "", "anna");
    const page = await visitCallback(back, callbackDeps({ db: store.db, mock, now: NOW }));
    expect(page.body).toContain("Not connected");
    expect(page.body).not.toContain("Admin approval needed");
  });

  it("is disabled, and says so, without the Entra app registration", async () => {
    const result = await prepareOutlookConnect({
      owner: ANNA,
      config,
      db: store.db,
      now: NOW,
      env: {},
    });
    expect(result).toMatchObject({ ok: false, reason: "not_configured" });
    const log = vi.fn();
    const page = await visitCallback(
      new URL("https://vera.example/ada/outlook/callback?code=x&state=y"),
      {
        ...callbackDeps({ db: store.db, mock, now: NOW }),
        env: { ADA_MS_CLIENT_ID: "only-the-id" },
        log: { error: log },
      },
    );
    expect(page.statusCode).toBe(503);
    expect(log).toHaveBeenCalled();
    expect(readOutlookApp({})).toBeNull();
    expect(readOutlookApp({ ADA_MS_CLIENT_ID: "id", ADA_MS_CLIENT_SECRET: "  " })).toBeNull();
  });

  it("reads the VERA_ spelling of the variables, as every Ada variable does", () => {
    expect(
      readOutlookApp({ VERA_MS_CLIENT_ID: "legacy-id", VERA_MS_CLIENT_SECRET: "legacy-secret" }),
    ).toMatchObject({ clientId: "legacy-id", clientSecret: "legacy-secret" });
  });
});
