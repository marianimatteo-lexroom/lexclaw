/**
 * Serializes the collect passes of one number: the poll, the Gmail push route, the 07:40 slot,
 * the catch-up, and the inbound release all read that number's diff baseline and write its held
 * plan, so two of them interleaving would double-send or lose a hold. Different numbers have
 * their own memory and accounts, so a slow pass for one never holds up another's.
 */
const tails = new Map<string, Promise<unknown>>();
/** The waiting coalescible run of each key; a key is the number whose pass it is. */
const queuedCoalescible = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier exclusive run of the same `key` settles. A `coalesce` caller that finds
 * another coalescible run of the same `key` still waiting shares that run instead of queuing a
 * duplicate, so a burst of polls or push notifications for one number costs one trailing pass,
 * and one number's pass is never dropped because another's is waiting.
 */
export function runCollectExclusive<T>(
  fn: () => Promise<T>,
  options: { coalesce?: boolean; key?: string } = {},
): Promise<T> {
  const key = options.key ?? "";
  const waiting = options.coalesce ? queuedCoalescible.get(key) : undefined;
  if (waiting) {
    return waiting as Promise<T>;
  }
  const run = (tails.get(key) ?? Promise.resolve()).then(() => {
    if (queuedCoalescible.get(key) === run) {
      queuedCoalescible.delete(key);
    }
    return fn();
  });
  if (options.coalesce) {
    queuedCoalescible.set(key, run);
  }
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
  return run;
}
