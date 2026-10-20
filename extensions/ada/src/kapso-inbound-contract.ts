/**
 * One Kapso webhook request that was acknowledged and not yet handled to the end. The raw body
 * and the signature headers are kept as received, so replaying it is the same request the
 * channel plugin would have got, and the channel plugin checks the signature again.
 */
export type SpooledWebhook = {
  id: number;
  /** The sender's digits: webhooks of one sender are handled one at a time, in arrival order. */
  senderKey: string;
  headers: Record<string, string>;
  bodyBase64: string;
  receivedAtMs: number;
  /** Failed hand-offs so far, across restarts. */
  attempts: number;
  /** When Ada's reply to it went out; a saved webhook that was answered is never replayed. */
  answeredAtMs: number | null;
};

export type NewSpooledWebhook = Omit<SpooledWebhook, "id" | "attempts" | "answeredAtMs">;

export type KapsoInboundDb = {
  /** Saves the webhook and returns its id; ids grow, so the id order is the arrival order. */
  spool(entry: NewSpooledWebhook): Promise<number>;
  /** Everything not yet handled, oldest first. */
  listSpooled(): Promise<SpooledWebhook[]>;
  /** Counts one failed hand-off and returns the new total. */
  noteAttempt(id: number): Promise<number>;
  /** Records that the reply to this webhook went out, so a restart does not hand it over again. */
  markAnswered(id: number, atMs: number): Promise<void>;
  unspool(id: number): Promise<void>;
};

type Operation<Input, Output> = { input: Input; output: Output };

export type AdaKapsoInboundOperations = {
  spool: Operation<{ entry: NewSpooledWebhook }, number>;
  listSpooled: Operation<undefined, SpooledWebhook[]>;
  noteAttempt: Operation<{ id: number }, number>;
  markAnswered: Operation<{ id: number; atMs: number }, undefined>;
  unspool: Operation<{ id: number }, undefined>;
};
