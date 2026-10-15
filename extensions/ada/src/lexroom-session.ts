import type { LexroomAccountRecord, LexroomAccountStore } from "./lexroom-account-contract.js";
import type { LexroomLog } from "./lexroom-client.js";
import { isLexroomAccessLive } from "./lexroom-connect.js";
import { loginLexroomAccount } from "./lexroom-login.js";

/** How long a "needs a one-time code" answer is reused instead of asking Lexroom again. */
const MFA_RETRY_AFTER_MS = 5 * 60 * 1000;

type SilentLogin =
  | { ok: true; accessToken: string; accessExpiresAtMs: number | null }
  | { ok: false; reason: "invalid_credentials" | "mfa_required" | "unavailable" };

/** The same `POST /v1/login` the lexroom-bot client uses, with the saved email and password. */
async function signInSilently(params: {
  email: string;
  password: string;
  baseUrl?: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<SilentLogin> {
  const result = await loginLexroomAccount(params);
  if (result.ok) {
    return {
      ok: true,
      accessToken: result.accessToken,
      accessExpiresAtMs: result.accessExpiresAtMs,
    };
  }
  return {
    ok: false,
    reason: result.reason === "lexroom_error" ? "unavailable" : result.reason,
  };
}

export type RenewFailure = {
  reason: "invalid_credentials" | "mfa_required" | "no_password" | "unavailable";
  /** Text for the agent. The first three mean the lawyer must reconnect. */
  error: string;
};

const FAILURE_TEXT: Record<RenewFailure["reason"], string> = {
  invalid_credentials:
    "Lexroom no longer accepts the saved email and password. Call ada_lexroom_connect and send that link.",
  mfa_required:
    "This Lexroom account requires a one-time code (MFA) at every sign-in, which Ada cannot enter, so she cannot renew the connection. Use a Lexroom account without MFA.",
  no_password: "The Lexroom connection expired. Call ada_lexroom_connect and send that link.",
  unavailable:
    "Ada could not renew the Lexroom sign-in because Lexroom did not answer. Try again shortly.",
};

export function renewFailure(reason: RenewFailure["reason"]): RenewFailure {
  return { reason, error: FAILURE_TEXT[reason] };
}

export function needsReconnect(failure: RenewFailure): boolean {
  return failure.reason !== "unavailable";
}

type RenewDeps = {
  store: LexroomAccountStore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log: LexroomLog;
  now: Date;
  /** Why a new token is needed, for the log. */
  why: "expired" | "rejected";
};

export type RenewResult =
  | { ok: true; account: LexroomAccountRecord }
  | ({ ok: false } & RenewFailure);

const inFlight = new Map<string, Promise<RenewResult>>();
const mfaBlockedUntil = new Map<string, number>();

/** Removes the saved account, but only if it still holds the credential that failed. */
export async function clearAccountIfStill(
  store: LexroomAccountStore,
  accessToken: string,
  log: LexroomLog,
  reason: string,
): Promise<void> {
  const current = await store.readAccount();
  if (current && current.accessToken === accessToken) {
    await store.clearAccount();
    log("account.cleared", { reason });
  }
}

async function renew(account: LexroomAccountRecord, deps: RenewDeps): Promise<RenewResult> {
  const { store, log } = deps;
  const fail = (reason: RenewFailure["reason"]): RenewResult => ({
    ok: false,
    ...renewFailure(reason),
  });
  if (!account.password) {
    log("relogin.skipped", { why: deps.why, reason: "no_saved_password" });
    return fail("no_password");
  }
  const blockedUntil = mfaBlockedUntil.get(account.email) ?? 0;
  if (blockedUntil > deps.now.getTime()) {
    log("relogin.skipped", { why: deps.why, reason: "mfa_required" });
    return fail("mfa_required");
  }
  const startedAt = Date.now();
  log("relogin.start", { why: deps.why });
  const login = await signInSilently({
    email: account.email,
    password: account.password,
    baseUrl: deps.baseUrl,
    fetchImpl: deps.fetchImpl ?? fetch,
    signal: deps.signal,
  });
  const ms = Date.now() - startedAt;
  if (login.ok) {
    const renewed = {
      ...account,
      accessToken: login.accessToken,
      accessExpiresAtMs: login.accessExpiresAtMs,
    };
    await store.upsertAccount(renewed);
    mfaBlockedUntil.delete(account.email);
    log("relogin.ok", {
      why: deps.why,
      ms,
      tokenExpiresInSec:
        login.accessExpiresAtMs === null
          ? -1
          : Math.round((login.accessExpiresAtMs - Date.now()) / 1000),
    });
    return { ok: true, account: renewed };
  }
  if (login.reason === "invalid_credentials") {
    await clearAccountIfStill(store, account.accessToken, log, "relogin_invalid_credentials");
  }
  if (login.reason === "mfa_required") {
    mfaBlockedUntil.set(account.email, deps.now.getTime() + MFA_RETRY_AFTER_MS);
  }
  log("relogin.failed", { why: deps.why, reason: login.reason, ms });
  return fail(login.reason);
}

/**
 * Signs in again with the saved email and password and saves the new token. Callers holding
 * the same stale token share one sign-in. A wrong password clears the account; an account
 * that needs a one-time code, or has no saved password, cannot be renewed and is reported.
 */
export function renewLexroomAccount(
  account: LexroomAccountRecord,
  deps: RenewDeps,
): Promise<RenewResult> {
  const pending = inFlight.get(account.accessToken);
  if (pending) {
    return pending;
  }
  const running = renew(account, deps)
    .catch((error: unknown): RenewResult => {
      deps.log("relogin.failed", {
        why: deps.why,
        reason: "store_error",
        error: (error instanceof Error ? error.message : "unknown").slice(0, 160),
      });
      return { ok: false, ...renewFailure("unavailable") };
    })
    .finally(() => {
      inFlight.delete(account.accessToken);
    });
  inFlight.set(account.accessToken, running);
  return running;
}

/** The saved account with a token good for at least another minute, renewing it if needed. */
export async function ensureUsableAccount(
  account: LexroomAccountRecord,
  deps: Omit<RenewDeps, "why">,
): Promise<RenewResult> {
  if (isLexroomAccessLive({ ...account, now: deps.now })) {
    return { ok: true, account };
  }
  return await renewLexroomAccount(account, { ...deps, why: "expired" });
}
