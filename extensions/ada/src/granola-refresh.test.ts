import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { granolaConnectConfigFrom, prepareGranolaConnect } from "./granola-connect.js";
import { loadGranolaAccess } from "./granola-session.js";
import {
  ANNA,
  BRUNO,
  newMockGranola,
  openGranolaTestDb,
  signInThroughFlow,
  testApi,
} from "./granola-test-support.js";
import { executeAdaGranolaCall } from "./granola-tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = new Date("2026-10-20T09:00:00.000Z");
const at = (offsetMs: number) => NOW.getTime() + offsetMs;

async function setup() {
  const mock = newMockGranola();
  const store = openGranolaTestDb(tempDirs.make("ada-granola-refresh-"));
  mock.meetings.set("anna", [
    { id: "m1", title: "Rossi call", date: "2026-10-14", notes: "n", transcript: "t" },
  ]);
  await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now: NOW });
  await signInThroughFlow({ mock, db: store.db, owner: BRUNO, user: "bruno", now: NOW });
  const load = (owner: string, nowMs: number, renewWithinMs?: number) =>
    loadGranolaAccess({ db: store.db, owner, nowMs, renewWithinMs, fetchImpl: mock.fetch });
  return { mock, store, load };
}

describe("Granola token refresh", () => {
  it("keeps using a token that is still valid, and renews it before it expires", async () => {
    const { mock, store, load } = await setup();
    const first = await store.db.readAccount(ANNA);
    expect(await load(ANNA, at(30 * 60_000))).toMatchObject({
      ok: true,
      accessToken: first?.accessToken,
    });
    expect(mock.refreshes).toBe(0);

    const renewed = await load(ANNA, at(3_600_000 - 30_000));
    expect(renewed).toMatchObject({ ok: true });
    expect(mock.refreshes).toBe(1);
    const saved = await store.db.readAccount(ANNA);
    expect(saved?.accessToken).not.toBe(first?.accessToken);
    expect(saved?.refreshToken).not.toBe(first?.refreshToken);
    expect(saved?.accessExpiresAtMs).toBe(at(3_600_000 - 30_000) + 3_600_000);
    expect(saved?.connectedAtMs).toBe(first?.connectedAtMs);
    expect(mock.userOf(saved?.accessToken ?? "")).toBe("anna");
  });

  it("uses the rotated refresh token the next time, so the connection never lapses", async () => {
    const { mock, load } = await setup();
    for (let hour = 1; hour <= 3; hour += 1) {
      expect(await load(ANNA, at(hour * 3_600_000 - 10_000))).toMatchObject({ ok: true });
    }
    expect(mock.refreshes).toBe(3);
  });

  it("renews once when several calls find the token expired together", async () => {
    const { mock, load } = await setup();
    const results = await Promise.all([1, 2, 3].map(() => load(ANNA, at(3_600_001))));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.ok && result.accessToken)).size).toBe(1);
    expect(mock.refreshes).toBe(1);
  });

  it("deletes a sign-in Granola refuses for good, and touches no other number", async () => {
    const { mock, store, load } = await setup();
    mock.refreshFailure = "invalid_grant";
    expect(await load(ANNA, at(3_600_001))).toEqual({ ok: false, reason: "reconnect" });
    expect(await store.db.readAccount(ANNA)).toBeNull();
    expect(await store.db.readAccount(BRUNO)).not.toBeNull();
    expect(await load(ANNA, at(3_600_002))).toEqual({ ok: false, reason: "not_connected" });
  });

  it("keeps the sign-in when Granola is only unavailable, and renews once it is back", async () => {
    const { mock, store, load } = await setup();
    mock.refreshFailure = "server_error";
    expect(await load(ANNA, at(3_600_001))).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.db.readAccount(ANNA)).not.toBeNull();
    mock.refreshFailure = null;
    expect(await load(ANNA, at(3_700_000))).toMatchObject({ ok: true });
  });

  it("asks for a new link when Granola no longer knows Ada's client", async () => {
    const { mock, store, load } = await setup();
    mock.clients.clear();
    expect(await load(ANNA, at(3_600_001))).toEqual({ ok: false, reason: "reconnect" });
    expect(await store.db.readClient()).toBeNull();
    expect(await store.db.readAccount(ANNA)).toBeNull();

    // The other number's tokens were issued to the same client, so it needs a link as well.
    expect(await load(BRUNO, at(3_600_001))).toEqual({ ok: false, reason: "reconnect" });
  });

  it("does not overwrite a sign-in made while a refresh was in flight", async () => {
    const { mock, store, load } = await setup();
    const stale = await store.db.readAccount(ANNA);
    await signInThroughFlow({
      mock,
      db: store.db,
      owner: ANNA,
      user: "anna",
      now: new Date(at(1000)),
    });
    const fresh = await store.db.readAccount(ANNA);
    expect(
      await store.db.updateTokensIfStill(ANNA, stale!, {
        accessToken: "late-access-token",
        accessExpiresAtMs: null,
      }),
    ).toBe(false);
    expect((await store.db.readAccount(ANNA))?.accessToken).toBe(fresh?.accessToken);
    expect(await load(ANNA, at(2000))).toMatchObject({ ok: true, accessToken: fresh?.accessToken });
  });

  it("tells the model to offer a reconnect when the saved sign-in is gone", async () => {
    const { mock, store } = await setup();
    mock.refreshFailure = "invalid_grant";
    mock.expireAccessTokens("anna");
    const result = await executeAdaGranolaCall(
      ANNA,
      testApi(),
      { tool: "list_meetings" },
      undefined,
      {
        db: store.db,
        fetchImpl: mock.fetch,
        now: new Date(at(3_600_001)),
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "not_connected" });
    expect((result as { error: string }).error).toContain("ada_granola_connect");
    expect((result as { error: string }).error).toContain("only after they agree");
  });

  it("does not end a connection over a failure that is not Granola voiding the consent", async () => {
    const { mock, store, load } = await setup();
    mock.refreshFailure = "gateway_page";
    expect(await load(ANNA, at(3_600_001))).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.db.readAccount(ANNA)).not.toBeNull();
  });

  it("reads the sign-in again inside the renewal, so a spent refresh token is never presented twice", async () => {
    const { mock, store, load } = await setup();
    const stale = await store.db.readAccount(ANNA);
    expect(await load(ANNA, at(3_600_001))).toMatchObject({ ok: true });
    expect(mock.refreshes).toBe(1);

    // This caller read the row before the renewal above finished.
    let reads = 0;
    const lagging = {
      ...store.db,
      readAccount: async (owner: string) => (reads++ === 0 ? stale : store.db.readAccount(owner)),
    };
    const result = await loadGranolaAccess({
      db: lagging,
      owner: ANNA,
      nowMs: at(3_600_002),
      fetchImpl: mock.fetch,
    });
    expect(result).toMatchObject({ ok: true });
    expect(mock.refreshes).toBe(1);
  });

  it("keeps renewing tokens issued to an earlier registration after the redirect URI changes", async () => {
    const { mock, store, load } = await setup();
    const first = await store.db.readClient();
    const moved = granolaConnectConfigFrom({
      googleRedirectUri: "https://ada.example.org/ada/google/callback",
      googleStateSecret: "state-secret-test-value",
    });
    await prepareGranolaConnect({
      owner: "393334444444",
      config: moved,
      db: store.db,
      now: NOW,
      fetchImpl: mock.fetch,
    });
    expect(mock.registrations).toBe(2);
    const second = await store.db.readClient();
    expect(second?.clientId).not.toBe(first?.clientId);
    expect(await store.db.readClientById(first?.clientId ?? "")).toMatchObject({
      redirectUri: "https://vera.example/ada/granola/callback",
    });

    expect(await load(ANNA, at(3_600_001))).toMatchObject({ ok: true });
    expect((await store.db.readAccount(ANNA))?.clientId).toBe(first?.clientId);
  });

  it("reads expires_in sent as a string", async () => {
    const mock = newMockGranola();
    mock.expiresInAsString = true;
    const store = openGranolaTestDb(tempDirs.make("ada-granola-string-"));
    await signInThroughFlow({ mock, db: store.db, owner: ANNA, user: "anna", now: NOW });
    expect((await store.db.readAccount(ANNA))?.accessExpiresAtMs).toBe(at(3_600_000));
  });
});
