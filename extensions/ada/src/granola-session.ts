import type {
  GranolaAccountDb,
  GranolaAccountRecord,
  GranolaRefreshedTokens,
} from "./granola-account-contract.js";
import { bindGranolaOwner } from "./granola-account.js";
import { discoverGranolaEndpoints, refreshGranolaTokens } from "./granola-oauth.js";

/** Granola's access token is renewed when it has less than this left. */
const ACCESS_SKEW_MS = 60_000;

export type GranolaAccess =
  | { ok: true; accessToken: string; account: GranolaAccountRecord }
  /**
   * `not_connected`: nothing saved. `reconnect`: Granola refused this person's consent for good, so
   * the saved sign-in was deleted and a new link is needed. `unavailable`: Granola could not be
   * reached; the sign-in is kept and the next call tries again.
   */
  | { ok: false; reason: "not_connected" | "reconnect" | "unavailable" };

type Options = {
  db: GranolaAccountDb;
  owner: string;
  nowMs: number;
  /** Renew when the token has less than this left; the keep-alive renews ahead of the poll. */
  renewWithinMs?: number;
  /** Granola just answered 401 to this token: renew it whatever its expiry says. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (message: string) => void;
};

// One renewal per number at a time: Granola rotates refresh tokens, so two at once would
// spend the same one twice.
const renewing = new Map<string, Promise<GranolaAccess>>();

function live(account: GranolaAccountRecord, nowMs: number, renewWithinMs: number): boolean {
  return account.accessExpiresAtMs === null || account.accessExpiresAtMs > nowMs + renewWithinMs;
}

async function renew(options: Options, account: GranolaAccountRecord): Promise<GranolaAccess> {
  const store = bindGranolaOwner(options.db, options.owner);
  const expired =
    options.force === true ||
    (account.accessExpiresAtMs !== null && account.accessExpiresAtMs <= options.nowMs);
  const forget = async (): Promise<GranolaAccess> => {
    await store.clearAccountIfStill(account);
    return { ok: false, reason: "reconnect" };
  };
  if (!account.refreshToken) {
    // Nothing to renew with: usable until it expires, then a new link is the only way.
    return expired ? forget() : { ok: true, accessToken: account.accessToken, account };
  }
  const stillUsable = (): GranolaAccess =>
    expired
      ? { ok: false, reason: "unavailable" }
      : { ok: true, accessToken: account.accessToken, account };
  const endpoints = await discoverGranolaEndpoints({
    fetchImpl: options.fetchImpl,
    nowMs: options.nowMs,
    signal: options.signal,
  });
  if (!endpoints) {
    return stillUsable();
  }
  const client = await options.db.readClientById(account.clientId);
  if (!client) {
    // The tokens belong to a registration Ada no longer holds, so they can never be renewed.
    return forget();
  }
  const refreshed = await refreshGranolaTokens({
    endpoints,
    client,
    refreshToken: account.refreshToken,
    nowMs: options.nowMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
  if (!refreshed.ok) {
    options.log?.(
      `ada granola refresh failed reason=${refreshed.reason} error=${refreshed.oauthError ?? "none"}`,
    );
    if (refreshed.reason === "invalid_client") {
      await options.db.clearClient(client.clientId);
      return forget();
    }
    return refreshed.reason === "invalid_grant" ? forget() : stillUsable();
  }
  const tokens: GranolaRefreshedTokens = {
    accessToken: refreshed.tokens.accessToken,
    accessExpiresAtMs: refreshed.tokens.accessExpiresAtMs,
    ...(refreshed.tokens.refreshToken ? { refreshToken: refreshed.tokens.refreshToken } : {}),
  };
  if (await store.updateTokensIfStill(account, tokens)) {
    return {
      ok: true,
      accessToken: tokens.accessToken,
      account: {
        ...account,
        accessToken: tokens.accessToken,
        accessExpiresAtMs: tokens.accessExpiresAtMs,
        refreshToken: tokens.refreshToken ?? account.refreshToken,
      },
    };
  }
  // The number reconnected (or disconnected) while Granola answered: that row wins.
  const current = await store.readAccount();
  return current
    ? { ok: true, accessToken: current.accessToken, account: current }
    : { ok: false, reason: "not_connected" };
}

/** A usable access token for one number, renewed with its refresh token when it is expiring. */
export async function loadGranolaAccess(options: Options): Promise<GranolaAccess> {
  const store = bindGranolaOwner(options.db, options.owner);
  const usable = async (): Promise<GranolaAccess | GranolaAccountRecord> => {
    const account = await store.readAccount();
    if (!account) {
      return { ok: false, reason: "not_connected" };
    }
    return options.force !== true &&
      live(account, options.nowMs, options.renewWithinMs ?? ACCESS_SKEW_MS)
      ? { ok: true, accessToken: account.accessToken, account }
      : account;
  };
  const first = await usable();
  if ("ok" in first) {
    return first;
  }
  const running = renewing.get(options.owner);
  if (running) {
    return running;
  }
  const started = (async (): Promise<GranolaAccess> => {
    // Read again inside the one renewal: a renewal that finished while this call was starting
    // has already rotated the refresh token, and the one read above is spent.
    const current = await usable();
    return "ok" in current ? current : renew(options, current);
  })().finally(() => {
    renewing.delete(options.owner);
  });
  renewing.set(options.owner, started);
  return started;
}
