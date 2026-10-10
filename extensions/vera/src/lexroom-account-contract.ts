/** One lawyer per Vera install. Research runs may have no WhatsApp sender id. */
export const VERA_LEXROOM_ACCOUNT_ID = "lawyer";

export type LexroomAccountRecord = {
  email: string;
  accessToken: string;
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

export type VeraLexroomOperations = {
  replacePending: Operation<{ nonce: string; expiresAtMs: number }, undefined>;
  hasPending: Operation<{ nonce: string; nowMs: number }, boolean>;
  consumePending: Operation<{ nonce: string; nowMs: number }, boolean>;
  upsertAccount: Operation<LexroomAccountRecord, undefined>;
  readAccount: Operation<undefined, LexroomAccountRecord | null>;
  clearAccount: Operation<undefined, undefined>;
};
