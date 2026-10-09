/** One lawyer per Vera install. The morning run has no WhatsApp sender id. */
export const VERA_GOOGLE_ACCOUNT_ID = "lawyer";

export type GoogleAccountRecord = {
  email: string;
  refreshToken: string;
  accessToken: string | null;
  accessExpiresAtMs: number | null;
  connectedAtMs: number;
  /** Space-separated Google scopes. Null is a connection from before send was requested. */
  scopes: string | null;
};

export type GoogleAccountStore = {
  replacePending(nonce: string, expiresAtMs: number): Promise<void>;
  consumePending(nonce: string, nowMs: number): Promise<boolean>;
  upsertAccount(account: GoogleAccountRecord): Promise<void>;
  readAccount(): Promise<GoogleAccountRecord | null>;
  clearAccount(): Promise<void>;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type VeraGoogleOperations = {
  replacePending: Operation<{ nonce: string; expiresAtMs: number }, undefined>;
  consumePending: Operation<{ nonce: string; nowMs: number }, boolean>;
  upsertAccount: Operation<GoogleAccountRecord, undefined>;
  readAccount: Operation<undefined, GoogleAccountRecord | null>;
  clearAccount: Operation<undefined, undefined>;
};
