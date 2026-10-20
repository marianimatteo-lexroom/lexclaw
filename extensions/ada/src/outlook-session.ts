import type {
  OutlookAccountDb,
  OutlookAccountRecord,
  OutlookRefreshedTokens,
} from "./outlook-account-contract.js";
import { bindOutlookOwner } from "./outlook-account.js";
import { readOutlookApp, refreshOutlookTokens } from "./outlook-oauth.js";

/** An access token is renewed when it has less than this left. */
const ACCESS_SKEW_MS = 60_000;

export type OutlookAccess =
  | { ok: true; accessToken: string; account: OutlookAccountRecord }
  /**
   * `not_connected`: nothing saved. `reconnect`: Microsoft refused this person's consent for good,
   * so the saved sign-in was deleted and a new link is needed. `unavailable`: Microsoft could not
   * be reached or refused Ada's own client; the sign-in is kept and the next call tries again.
   * `disabled`: Ada has no Entra app registration configured.
   */
  | { ok: false; reason: "not_connected" | "reconnect" | "unavailable" | "disabled" };

type Options = {
  db: OutlookAccountDb;
  owner: string;
  nowMs: number;
  /** Renew when the token has less than this left; the keep-alive renews ahead of the poll. */
  renewWithinMs?: number;
  /** Graph just answered 401 to this token: renew it whatever its expiry says. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (message: string) => void;
};

// One renewal per number at a time: Microsoft rotates refresh tokens, so two at once would
// spend the same one twice.
const renewing = new Map<string, Promise<OutlookAccess>>();

function live(account: OutlookAccountRecord, nowMs: number, renewWithinMs: number): boolean {
  return account.accessExpiresAtMs > nowMs + renewWithinMs;
}

async function renew(options: Options, account: OutlookAccountRecord): Promise<OutlookAccess> {
  const app = readOutlookApp(options.env);
  if (!app) {
    return { ok: false, reason: "disabled" };
  }
  const store = bindOutlookOwner(options.db, options.owner);
  const expired = options.force === true || account.accessExpiresAtMs <= options.nowMs;
  const stillUsable = (): OutlookAccess =>
    expired
      ? { ok: false, reason: "unavailable" }
      : { ok: true, accessToken: account.accessToken, account };
  const refreshed = await refreshOutlookTokens({
    app,
    refreshToken: account.refreshToken,
    nowMs: options.nowMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
  if (!refreshed.ok) {
    options.log?.(
      `ada outlook refresh failed reason=${refreshed.reason} error=${refreshed.oauthError ?? "none"}`,
    );
    if (refreshed.reason === "invalid_grant" || refreshed.reason === "admin_consent") {
      // Only the row that failed: a reconnect during the refresh is a new sign-in.
      await store.clearAccountIfStill(account);
      return { ok: false, reason: "reconnect" };
    }
    return stillUsable();
  }
  const tokens: OutlookRefreshedTokens = {
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
  // The number reconnected (or disconnected) while Microsoft answered: that row wins.
  const current = await store.readAccount();
  return current
    ? { ok: true, accessToken: current.accessToken, account: current }
    : { ok: false, reason: "not_connected" };
}

/** A usable access token for one number, renewed with its refresh token when it is expiring. */
export async function loadOutlookAccess(options: Options): Promise<OutlookAccess> {
  if (!readOutlookApp(options.env)) {
    return { ok: false, reason: "disabled" };
  }
  const store = bindOutlookOwner(options.db, options.owner);
  const usable = async (): Promise<OutlookAccess | OutlookAccountRecord> => {
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
  const started = (async (): Promise<OutlookAccess> => {
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
