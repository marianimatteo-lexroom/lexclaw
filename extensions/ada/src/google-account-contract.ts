/**
 * The storage key of the single row saved before accounts belonged to a number. It is only read
 * to move that row to the configured lawyer's number and is never an owner.
 */
export const LEGACY_GOOGLE_ACCOUNT_ID = "lawyer";

export type GoogleAccountRecord = {
  email: string;
  refreshToken: string;
  accessToken: string | null;
  accessExpiresAtMs: number | null;
  connectedAtMs: number;
  /** Space-separated Google scopes. Null is a connection from before send was requested. */
  scopes: string | null;
};

/** What identifies one saved sign-in: a reconnect or a move to another number changes it. */
export type GoogleAccountStamp = Pick<GoogleAccountRecord, "refreshToken" | "connectedAtMs">;

export type GoogleRefreshedTokens = {
  accessToken: string;
  accessExpiresAtMs: number;
  /** A refresh token Google rotated; absent when it did not. */
  refreshToken?: string;
};

/** One owner's view of the Google account store: every call acts for that number only. */
export type GoogleAccountStore = {
  replacePending(nonce: string, expiresAtMs: number): Promise<void>;
  consumePending(nonce: string, nowMs: number): Promise<boolean>;
  /** When the connect link last issued to this number expires, or null when none is waiting. */
  pendingExpiresAt(): Promise<number | null>;
  upsertAccount(account: GoogleAccountRecord): Promise<void>;
  readAccount(): Promise<GoogleAccountRecord | null>;
  clearAccount(): Promise<void>;
  /** Saves refreshed tokens only while the row is still the one `expected` names; false when it changed. */
  updateTokensIfStill(
    expected: GoogleAccountStamp,
    tokens: GoogleRefreshedTokens,
  ): Promise<boolean>;
  /** Removes the row only while it is still the one `expected` names; false when it changed. */
  clearAccountIfStill(expected: GoogleAccountStamp): Promise<boolean>;
};

/** The whole store; every operation names the owner it acts for. */
export type GoogleAccountDb = {
  replacePending(owner: string, nonce: string, expiresAtMs: number): Promise<void>;
  consumePending(owner: string, nonce: string, nowMs: number): Promise<boolean>;
  pendingExpiresAt(owner: string): Promise<number | null>;
  upsertAccount(owner: string, account: GoogleAccountRecord): Promise<void>;
  readAccount(owner: string): Promise<GoogleAccountRecord | null>;
  clearAccount(owner: string): Promise<void>;
  updateTokensIfStill(
    owner: string,
    expected: GoogleAccountStamp,
    tokens: GoogleRefreshedTokens,
  ): Promise<boolean>;
  clearAccountIfStill(owner: string, expected: GoogleAccountStamp): Promise<boolean>;
  /** Owners that have a connected Google account, for the background collector. */
  listOwners(): Promise<string[]>;
  /** Moves the pre-per-number row to `owner`; true when a row moved. */
  adoptLegacy(owner: string): Promise<boolean>;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type AdaGoogleOperations = {
  replacePending: Operation<{ owner: string; nonce: string; expiresAtMs: number }, undefined>;
  consumePending: Operation<{ owner: string; nonce: string; nowMs: number }, boolean>;
  pendingExpiresAt: Operation<{ owner: string }, number | null>;
  upsertAccount: Operation<{ owner: string; account: GoogleAccountRecord }, undefined>;
  readAccount: Operation<{ owner: string }, GoogleAccountRecord | null>;
  clearAccount: Operation<{ owner: string }, undefined>;
  updateTokensIfStill: Operation<
    { owner: string; expected: GoogleAccountStamp; tokens: GoogleRefreshedTokens },
    boolean
  >;
  clearAccountIfStill: Operation<{ owner: string; expected: GoogleAccountStamp }, boolean>;
  listOwners: Operation<undefined, string[]>;
  adoptLegacy: Operation<{ owner: string }, boolean>;
};
