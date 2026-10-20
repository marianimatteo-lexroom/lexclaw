/** One number's Outlook sign-in: the Microsoft identity platform tokens its own consent produced. */
export type OutlookAccountRecord = {
  email: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAtMs: number;
  /** Space-separated scopes the token response granted. */
  scope: string | null;
  connectedAtMs: number;
};

/** What identifies one saved sign-in: a reconnect changes it, and so does every refresh. */
export type OutlookAccountStamp = Pick<OutlookAccountRecord, "refreshToken" | "connectedAtMs">;

export type OutlookRefreshedTokens = {
  accessToken: string;
  accessExpiresAtMs: number;
  /** Microsoft rotates the refresh token on use; absent when it did not. */
  refreshToken?: string;
};

/** What a connect link in progress needs back: the PKCE verifier. */
export type OutlookPending = { codeVerifier: string };

/** One owner's view of the Outlook store: every call acts for that number only. */
export type OutlookAccountStore = {
  replacePending(nonce: string, expiresAtMs: number, pending: OutlookPending): Promise<void>;
  /** Spends the link's state: the PKCE verifier once, and null when it is unknown, spent or expired. */
  consumePending(nonce: string, nowMs: number): Promise<OutlookPending | null>;
  upsertAccount(account: OutlookAccountRecord): Promise<void>;
  readAccount(): Promise<OutlookAccountRecord | null>;
  clearAccount(): Promise<void>;
  /** Saves refreshed tokens only while the row is still the one `expected` names. */
  updateTokensIfStill(
    expected: OutlookAccountStamp,
    tokens: OutlookRefreshedTokens,
  ): Promise<boolean>;
  clearAccountIfStill(expected: OutlookAccountStamp): Promise<boolean>;
  /** True at most once in 24 hours: the reminder is then owed until `settleReminder`. */
  claimReconnectReminder(nowMs: number): Promise<boolean>;
  /** True while a claimed reminder has not been delivered, for 72 hours from the claim. */
  reminderOwed(nowMs: number): Promise<boolean>;
  /** The reminder went out (or is no longer wanted). */
  settleReminder(): Promise<void>;
};

/** The whole store; every operation names the owner it acts for. */
export type OutlookAccountDb = {
  replacePending(
    owner: string,
    nonce: string,
    expiresAtMs: number,
    pending: OutlookPending,
  ): Promise<void>;
  consumePending(owner: string, nonce: string, nowMs: number): Promise<OutlookPending | null>;
  upsertAccount(owner: string, account: OutlookAccountRecord): Promise<void>;
  readAccount(owner: string): Promise<OutlookAccountRecord | null>;
  clearAccount(owner: string): Promise<void>;
  updateTokensIfStill(
    owner: string,
    expected: OutlookAccountStamp,
    tokens: OutlookRefreshedTokens,
  ): Promise<boolean>;
  clearAccountIfStill(owner: string, expected: OutlookAccountStamp): Promise<boolean>;
  claimReconnectReminder(owner: string, nowMs: number): Promise<boolean>;
  reminderOwed(owner: string, nowMs: number): Promise<boolean>;
  settleReminder(owner: string): Promise<void>;
  /** Owners with a saved sign-in, for the background collector and keep-alive. */
  listOwners(): Promise<string[]>;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type AdaOutlookOperations = {
  replacePending: Operation<
    { owner: string; nonce: string; expiresAtMs: number; pending: OutlookPending },
    undefined
  >;
  consumePending: Operation<{ owner: string; nonce: string; nowMs: number }, OutlookPending | null>;
  upsertAccount: Operation<{ owner: string; account: OutlookAccountRecord }, undefined>;
  readAccount: Operation<{ owner: string }, OutlookAccountRecord | null>;
  clearAccount: Operation<{ owner: string }, undefined>;
  updateTokensIfStill: Operation<
    { owner: string; expected: OutlookAccountStamp; tokens: OutlookRefreshedTokens },
    boolean
  >;
  clearAccountIfStill: Operation<{ owner: string; expected: OutlookAccountStamp }, boolean>;
  claimReconnectReminder: Operation<{ owner: string; nowMs: number }, boolean>;
  reminderOwed: Operation<{ owner: string; nowMs: number }, boolean>;
  settleReminder: Operation<{ owner: string }, undefined>;
  listOwners: Operation<undefined, string[]>;
};

/** A number is reminded to reconnect at most once in this long. */
export const OUTLOOK_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A reminder that could not go out waits this long for the number's next message. */
export const OUTLOOK_REMINDER_OWED_MS = 72 * 60 * 60 * 1000;
