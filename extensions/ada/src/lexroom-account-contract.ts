/**
 * The storage key of the single row saved before accounts belonged to a number. It is only read
 * to move that row to the configured lawyer's number and is never an owner.
 */
export const LEGACY_LEXROOM_ACCOUNT_ID = "lawyer";

export type LexroomAccountRecord = {
  email: string;
  accessToken: string;
  /**
   * The lawyer's Lexroom password, encrypted at rest, so Ada can sign in again when the token
   * expires. Empty for MFA accounts (a one-time code is needed every time) and for sign-ins
   * saved before passwords were kept.
   */
  password: string;
  /** Empty when Lexroom login did not return a refresh token. */
  refreshToken: string;
  accessExpiresAtMs: number | null;
  connectedAtMs: number;
};

/** One owner's view of the Lexroom account store: every call acts for that number only. */
export type LexroomAccountStore = {
  replacePending(nonce: string, expiresAtMs: number): Promise<void>;
  hasPending(nonce: string, nowMs: number): Promise<boolean>;
  consumePending(nonce: string, nowMs: number): Promise<boolean>;
  upsertAccount(account: LexroomAccountRecord): Promise<void>;
  readAccount(): Promise<LexroomAccountRecord | null>;
  clearAccount(): Promise<void>;
};

/** The whole store; every operation names the owner it acts for. */
export type LexroomAccountDb = {
  replacePending(owner: string, nonce: string, expiresAtMs: number): Promise<void>;
  hasPending(owner: string, nonce: string, nowMs: number): Promise<boolean>;
  consumePending(owner: string, nonce: string, nowMs: number): Promise<boolean>;
  upsertAccount(owner: string, account: LexroomAccountRecord): Promise<void>;
  readAccount(owner: string): Promise<LexroomAccountRecord | null>;
  clearAccount(owner: string): Promise<void>;
  /** Moves the pre-per-number row to `owner`; true when a row moved. */
  adoptLegacy(owner: string): Promise<boolean>;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type AdaLexroomOperations = {
  replacePending: Operation<{ owner: string; nonce: string; expiresAtMs: number }, undefined>;
  hasPending: Operation<{ owner: string; nonce: string; nowMs: number }, boolean>;
  consumePending: Operation<{ owner: string; nonce: string; nowMs: number }, boolean>;
  upsertAccount: Operation<{ owner: string; account: LexroomAccountRecord }, undefined>;
  readAccount: Operation<{ owner: string }, LexroomAccountRecord | null>;
  clearAccount: Operation<{ owner: string }, undefined>;
  adoptLegacy: Operation<{ owner: string }, boolean>;
};
