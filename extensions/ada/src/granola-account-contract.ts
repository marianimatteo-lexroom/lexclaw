/** One number's Granola sign-in: the OAuth tokens its own consent produced. */
export type GranolaAccountRecord = {
  accessToken: string;
  refreshToken: string | null;
  /** Null when the server did not say; the token is then used until Granola answers 401. */
  accessExpiresAtMs: number | null;
  scope: string | null;
  /** The OAuth client the tokens were issued to: a refresh must present the same one. */
  clientId: string;
  connectedAtMs: number;
};

/** What identifies one saved sign-in: a reconnect changes it. */
export type GranolaAccountStamp = Pick<GranolaAccountRecord, "refreshToken" | "connectedAtMs">;

export type GranolaRefreshedTokens = {
  accessToken: string;
  accessExpiresAtMs: number | null;
  /** A refresh token Granola rotated; absent when it did not. */
  refreshToken?: string;
};

/** The OAuth client Ada registered once with Granola (dynamic client registration). */
export type GranolaClientRecord = {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  registeredAtMs: number;
  secretExpiresAtMs: number | null;
};

export type GranolaPending = { codeVerifier: string; clientId: string };

/** One owner's view of the Granola store: every call acts for that number only. */
export type GranolaAccountStore = {
  replacePending(nonce: string, expiresAtMs: number, pending: GranolaPending): Promise<void>;
  /** Spends the link's state: the PKCE verifier once, and null when it is unknown, spent or expired. */
  consumePending(nonce: string, nowMs: number): Promise<GranolaPending | null>;
  upsertAccount(account: GranolaAccountRecord): Promise<void>;
  readAccount(): Promise<GranolaAccountRecord | null>;
  clearAccount(): Promise<void>;
  /** Saves refreshed tokens only while the row is still the one `expected` names. */
  updateTokensIfStill(
    expected: GranolaAccountStamp,
    tokens: GranolaRefreshedTokens,
  ): Promise<boolean>;
  clearAccountIfStill(expected: GranolaAccountStamp): Promise<boolean>;
  /** True at most once in 24 hours: the reminder is then owed until `settleReminder`. */
  claimReconnectReminder(nowMs: number): Promise<boolean>;
  /** True while a claimed reminder has not been delivered, for 72 hours from the claim. */
  reminderOwed(nowMs: number): Promise<boolean>;
  /** The reminder went out (or is no longer wanted). */
  settleReminder(): Promise<void>;
};

/** The whole store; every operation names the owner it acts for. */
export type GranolaAccountDb = {
  replacePending(
    owner: string,
    nonce: string,
    expiresAtMs: number,
    pending: GranolaPending,
  ): Promise<void>;
  consumePending(owner: string, nonce: string, nowMs: number): Promise<GranolaPending | null>;
  upsertAccount(owner: string, account: GranolaAccountRecord): Promise<void>;
  readAccount(owner: string): Promise<GranolaAccountRecord | null>;
  clearAccount(owner: string): Promise<void>;
  updateTokensIfStill(
    owner: string,
    expected: GranolaAccountStamp,
    tokens: GranolaRefreshedTokens,
  ): Promise<boolean>;
  clearAccountIfStill(owner: string, expected: GranolaAccountStamp): Promise<boolean>;
  claimReconnectReminder(owner: string, nowMs: number): Promise<boolean>;
  reminderOwed(owner: string, nowMs: number): Promise<boolean>;
  settleReminder(owner: string): Promise<void>;
  /** Owners with a saved sign-in, for the background keep-alive. */
  listOwners(): Promise<string[]>;
  /** The registration new links use. */
  readClient(): Promise<GranolaClientRecord | null>;
  /** Any registration still held, so tokens issued to an older one can be renewed. */
  readClientById(clientId: string): Promise<GranolaClientRecord | null>;
  /** Makes `client` the one new links use and keeps the earlier registrations. */
  saveClient(client: GranolaClientRecord): Promise<void>;
  /** Drops one registration, for when Granola no longer knows it. */
  clearClient(clientId: string): Promise<void>;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type AdaGranolaOperations = {
  replacePending: Operation<
    { owner: string; nonce: string; expiresAtMs: number; pending: GranolaPending },
    undefined
  >;
  consumePending: Operation<{ owner: string; nonce: string; nowMs: number }, GranolaPending | null>;
  upsertAccount: Operation<{ owner: string; account: GranolaAccountRecord }, undefined>;
  readAccount: Operation<{ owner: string }, GranolaAccountRecord | null>;
  clearAccount: Operation<{ owner: string }, undefined>;
  updateTokensIfStill: Operation<
    { owner: string; expected: GranolaAccountStamp; tokens: GranolaRefreshedTokens },
    boolean
  >;
  clearAccountIfStill: Operation<{ owner: string; expected: GranolaAccountStamp }, boolean>;
  claimReconnectReminder: Operation<{ owner: string; nowMs: number }, boolean>;
  listOwners: Operation<undefined, string[]>;
  reminderOwed: Operation<{ owner: string; nowMs: number }, boolean>;
  settleReminder: Operation<{ owner: string }, undefined>;
  readClient: Operation<undefined, GranolaClientRecord | null>;
  readClientById: Operation<{ clientId: string }, GranolaClientRecord | null>;
  saveClient: Operation<{ client: GranolaClientRecord }, undefined>;
  clearClient: Operation<{ clientId: string }, undefined>;
};

/** A number is reminded to reconnect at most once in this long. */
export const GRANOLA_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A reminder that could not go out waits this long for the number's next message. */
export const GRANOLA_REMINDER_OWED_MS = 72 * 60 * 60 * 1000;
