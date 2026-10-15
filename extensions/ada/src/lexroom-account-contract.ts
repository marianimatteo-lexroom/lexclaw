/** One lawyer per Ada install. Research runs may have no WhatsApp sender id. */
export const ADA_LEXROOM_ACCOUNT_ID = "lawyer";

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

export type LexroomAccountStore = {
  replacePending(nonce: string, expiresAtMs: number): Promise<void>;
  hasPending(nonce: string, nowMs: number): Promise<boolean>;
  consumePending(nonce: string, nowMs: number): Promise<boolean>;
  upsertAccount(account: LexroomAccountRecord): Promise<void>;
  readAccount(): Promise<LexroomAccountRecord | null>;
  clearAccount(): Promise<void>;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type AdaLexroomOperations = {
  replacePending: Operation<{ nonce: string; expiresAtMs: number }, undefined>;
  hasPending: Operation<{ nonce: string; nowMs: number }, boolean>;
  consumePending: Operation<{ nonce: string; nowMs: number }, boolean>;
  upsertAccount: Operation<LexroomAccountRecord, undefined>;
  readAccount: Operation<undefined, LexroomAccountRecord | null>;
  clearAccount: Operation<undefined, undefined>;
};
